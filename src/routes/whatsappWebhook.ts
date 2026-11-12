// src/routes/whatsappWebhook.ts
import { Router, type NextFunction, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import { pool } from '../db.js';
import { formatReservationList } from '../utils/whatsappFormat.js';

export const whatsappWebhookRouter = Router();

const GRAPH_VERSION = 'v25.0';
const CONTEXT_TTL_MS = 30 * 60_000;
const SEEN_TTL_MS = 10 * 60_000;
const RATE_LIMIT_PER_MIN = 12;
const MAX_MESSAGES = 4;

// Secret généré à chaque démarrage : sert uniquement à l'appel interne vers /chat
const INTERNAL_SECRET = crypto.randomBytes(24).toString('hex');

const APP_CONFIRM_MESSAGE =
  'Pour confirmer et enregistrer cette réservation, connectez-vous à l’application Saint-Jude. ' +
  'Ici, je peux vérifier les voyages, les tarifs et préparer votre demande.';

const ADMIN_ONLY_MESSAGE =
  '🔒 Cette information est réservée aux administrateurs. ' +
  'Votre numéro doit être enregistré dans votre profil Saint-Jude (champ téléphone) avec un rôle administrateur.';

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Conserve le corps brut : nécessaire pour vérifier la signature de Meta. */
export function saveRawBody(req: any, _res: any, buf: Buffer) {
  req.rawBody = buf;
}

/** Réserve l'accès à POST /chat aux appels internes (boucle locale + secret). */
export function internalChatOnly(req: Request, res: Response, next: NextFunction) {
  const addr = req.socket.remoteAddress ?? '';
  const loopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  const given = String(req.get('x-internal-secret') ?? '');
  if (!loopback || req.method !== 'POST' || req.path !== '/chat' || !safeEqual(given, INTERNAL_SECRET)) {
    return res.status(404).json({ error: 'Route API introuvable' });
  }
  next();
}

/* =========================================================
   Mémoire de conversation par numéro (perdue au redémarrage du serveur)
========================================================= */
interface ConversationState {
  draft: Record<string, unknown>;
  quoted: boolean; // le dernier message proposait de confirmer la réservation
  at: number;
}
const conversations = new Map<string, ConversationState>();
const seen = new Map<string, number>(); // ids de messages déjà traités (Meta peut renvoyer)
const rate = new Map<string, number[]>(); // horodatages récents par numéro

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of conversations) if (now - v.at > CONTEXT_TTL_MS) conversations.delete(k);
  for (const [k, t] of seen) if (now - t > SEEN_TTL_MS) seen.delete(k);
  for (const [k, v] of rate) if (!v.some((t) => now - t < 60_000)) rate.delete(k);
}, 60_000).unref?.();

const normalize = (s: string) =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/’/g, "'").toLowerCase().trim();

const isYes = (s: string) => /^(oui|ok|d'accord|confirme|confirmer|valide|valider|eny)\b/.test(normalize(s));

function allowByRate(from: string): boolean {
  const now = Date.now();
  const recent = (rate.get(from) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= RATE_LIMIT_PER_MIN) {
    rate.set(from, recent);
    return false;
  }
  recent.push(now);
  rate.set(from, recent);
  return true;
}

/* =========================================================
   Administrateurs : identifiés par leur numéro WhatsApp (signé par Meta)
   Rôles acceptés : variable WHATSAPP_ADMIN_ROLES (séparés par des virgules),
   sinon admin, administrateur, proprietaire, owner. Accents et majuscules ignorés.
========================================================= */
const ADMIN_ROLES = (process.env.WHATSAPP_ADMIN_ROLES ?? 'admin,administrateur,proprietaire,owner')
  .split(',')
  .map((r) => normalize(r))
  .filter(Boolean);

/** Retourne l'administrateur si le numéro correspond à UN SEUL compte, dont le rôle est admin. */
async function findAdminByPhone(from: string): Promise<{ name: string } | null> {
  const digits = from.replace(/\D/g, '');
  if (digits.length < 9) return null;
  const tail = digits.slice(-9);

  const { rows } = await pool.query(
    `SELECT name, "lastName", role FROM "user"
     WHERE LENGTH(regexp_replace(COALESCE(tel, ''), '\\D', '', 'g')) >= 9
       AND RIGHT(regexp_replace(COALESCE(tel, ''), '\\D', '', 'g'), 9) = $1
     LIMIT 3`,
    [tail],
  );
  // Deux comptes avec le même numéro : on refuse (aucune élévation de droits possible)
  if (rows.length !== 1) return null;

  const role = normalize(String(rows[0].role ?? ''));
  if (!ADMIN_ROLES.includes(role)) return null;
  return { name: `${rows[0].name ?? ''} ${rows[0].lastName ?? ''}`.trim() };
}

/* =========================================================
   Réservations en attente : cartes stylisées avec icônes
   (lecture seule, sans téléphone ni e-mail)
========================================================= */
const nbr = (n: number) => n.toLocaleString('fr-FR').replace(/[\u202f\u00a0]/g, ' ');

async function answerPendingReservations(): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT r.id, r."clientName", r.quantity, r.weight, r."totalPrice",
            r.status, r."paymentStatus",
            t."from" AS departure, t."to" AS destination,
            to_char(t.depart::date, 'YYYY-MM-DD') AS date,
            COUNT(*) OVER () AS total
     FROM reservations r
     LEFT JOIN trips t ON r."tripId" = t.id
     WHERE UPPER(REPLACE(COALESCE(r.status, ''), ' ', '_')) IN ('EN_ATTENTE', 'PENDING')
     ORDER BY t.depart ASC NULLS LAST
     LIMIT 40`,
  );

  if (rows.length === 0) return ['😌 *Réservations en attente*\nAucune réservation en attente pour le moment.'];

  const total = Number(rows[0].total);
  const hidden = total - rows.length;
  const sum = rows.reduce((acc, r) => acc + (Number.isFinite(Number(r.totalPrice)) ? Number(r.totalPrice) : 0), 0);

  const footer =
    total === rows.length
      ? `💰 Montant total : *${nbr(sum)} Ar*`
      : `📊 ${rows.length} sur ${total} affichées`;

  let messages = formatReservationList(
    rows.map((r) => ({
      id: String(r.id),
      clientName: r.clientName,
      departure: r.departure,
      destination: r.destination,
      date: r.date,
      quantity: r.quantity,
      weightKg: r.weight,
      totalPrice: r.totalPrice,
      status: r.status,
      paymentStatus: r.paymentStatus,
    })),
    { title: 'Réservations en attente', defaultStatus: 'En attente', footer },
  );

  if (messages.length > MAX_MESSAGES) {
    messages = messages.slice(0, MAX_MESSAGES);
    messages[MAX_MESSAGES - 1] += '\n\n… La suite est dans l’application Saint-Jude.';
  } else if (hidden > 0) {
    messages[messages.length - 1] += `\n\n… et ${hidden} autre(s) dans l’application Saint-Jude.`;
  }
  return messages;
}

/* =========================================================
   Envoi d'un message texte (réponse libre : possible 24 h après le message du client)
========================================================= */
async function sendText(to: string, body: string): Promise<void> {
  const token = (process.env.WHATSAPP_TOKEN ?? '').trim();
  const phoneId = (process.env.WHATSAPP_PHONE_NUMBER_ID ?? '').trim();
  if (!token || !phoneId) {
    console.error('[WhatsApp] WHATSAPP_TOKEN ou WHATSAPP_PHONE_NUMBER_ID manquant');
    return;
  }
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: body.slice(0, 4000), preview_url: false },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    console.warn(`[WhatsApp] envoi refusé (${res.status}) : ${err.slice(0, 300)}`);
  }
}

/* =========================================================
   Traitement d'un message reçu
========================================================= */
async function processMessage(from: string, id: string, text: string): Promise<void> {
  if (seen.has(id)) return;
  seen.set(id, Date.now());

  if (!allowByRate(from)) {
    console.warn(`[WhatsApp] trop de messages de ***${from.slice(-3)} : ignoré`);
    return;
  }

  const prev = conversations.get(from);
  const state: ConversationState =
    prev && Date.now() - prev.at < CONTEXT_TTL_MS ? prev : { draft: {}, quoted: false, at: Date.now() };

  // Le client dit « oui » après le devis : la confirmation se fait dans l'application
  if (state.quoted && isYes(text)) {
    await sendText(from, APP_CONFIRM_MESSAGE);
    return;
  }

  // « Réservations en attente » : réservé aux administrateurs identifiés par leur numéro
  const n = normalize(text);
  if (/reservation/.test(n) && /(attente|pending|a valider)/.test(n)) {
    let answers: string[] = ['⚠️ Je n’ai pas pu consulter les réservations pour le moment. Réessayez dans un instant.'];
    try {
      const admin = await findAdminByPhone(from);
      console.info(`[WhatsApp] réservations en attente demandées par ***${from.slice(-3)} : admin=${admin ? 'oui' : 'non'}`);
      answers = admin ? await answerPendingReservations() : [ADMIN_ONLY_MESSAGE];
    } catch (err) {
      console.warn(`[WhatsApp] consultation des réservations impossible : ${(err as Error).message}`);
    }
    // Envoi dans l'ordre : chaque message attend la fin du précédent
    for (const part of answers) await sendText(from, part);
    return;
  }

  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  let reply = 'Désolé, une erreur est survenue. Réessayez dans un instant.';
  let nextDraft: Record<string, unknown> = state.draft;
  let quoted = false;

  try {
    const r = await fetch(`http://127.0.0.1:${port}/internal/whatsapp-ai/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': INTERNAL_SECRET,
        'x-forwarded-for': from, // limite de débit par numéro de téléphone
      },
      body: JSON.stringify({ question: text, context: { currentContext: state.draft } }),
      signal: AbortSignal.timeout(40_000),
    });

    if (r.status === 429) {
      reply = 'Vous envoyez trop de messages. Réessayez dans une minute.';
    } else if (r.ok) {
      const data = (await r.json()) as { reply?: string; updatedContext?: Record<string, any> };
      const ctx = data.updatedContext ?? {};
      quoted = ctx.awaitingConfirm === true;
      // Pas de réservation depuis WhatsApp : on remplace la question de confirmation
      reply = (data.reply ?? reply).replace(
        /Souhaitez-vous confirmer cette réservation\s*\?/g,
        'Pour la confirmer, connectez-vous à l’application Saint-Jude.',
      );
      nextDraft = { ...ctx, awaitingConfirm: false };
    } else {
      console.warn(`[WhatsApp] /chat a répondu ${r.status}`);
    }
  } catch (err) {
    console.warn(`[WhatsApp] appel /chat impossible : ${(err as Error).message}`);
  }

  conversations.set(from, { draft: nextDraft, quoted, at: Date.now() });
  await sendText(from, reply);
}

/* =========================================================
   GET : vérification de l'adresse par Meta
========================================================= */
whatsappWebhookRouter.get('/', (req: Request, res: Response) => {
  const mode = String(req.query['hub.mode'] ?? '');
  const token = String(req.query['hub.verify_token'] ?? '');
  const challenge = String(req.query['hub.challenge'] ?? '');
  const expected = (process.env.WHATSAPP_VERIFY_TOKEN ?? '').trim();

  if (mode === 'subscribe' && expected && safeEqual(token, expected)) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

/* =========================================================
   POST : messages reçus (signature vérifiée avec META_APP_SECRET)
========================================================= */
whatsappWebhookRouter.post('/', (req: Request, res: Response) => {
  const secret = (process.env.META_APP_SECRET ?? '').trim();
  if (!secret) {
    console.error('[WhatsApp] META_APP_SECRET absent : webhook refusé');
    return res.sendStatus(503);
  }

  const raw = (req as any).rawBody as Buffer | undefined;
  const signature = String(req.get('x-hub-signature-256') ?? '');
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(raw ?? Buffer.alloc(0)).digest('hex')}`;
  if (!raw || !safeEqual(signature, expected)) {
    // Diagnostic sans secret : longueurs uniquement (une clé Meta fait 32 caractères)
    console.warn(
      `[WhatsApp] signature refusée : longueurClé=${secret.length} corpsBrut=${raw ? raw.length : 'absent'} ` +
        `entêteSignature=${signature ? signature.length : 'absent'} (attendu 71)`,
    );
    return res.sendStatus(401);
  }

  // Répondre tout de suite : Meta réessaie si la réponse tarde
  res.sendStatus(200);

  const entries: any[] = Array.isArray(req.body?.entry) ? req.body.entry : [];
  let count = 0;
  for (const entry of entries) {
    for (const change of entry?.changes ?? []) {
      for (const msg of change?.value?.messages ?? []) {
        const from = String(msg?.from ?? '');
        const id = String(msg?.id ?? '');
        if (!from || !id) continue;
        count += 1;

        if (msg.type === 'text' && typeof msg.text?.body === 'string') {
          const text = msg.text.body.trim().slice(0, 1000);
          if (text) void processMessage(from, id, text).catch((e) => console.warn('[WhatsApp]', e?.message));
        } else if (!seen.has(id)) {
          seen.set(id, Date.now());
          void sendText(from, 'Je ne traite pour l’instant que les messages texte.').catch(() => undefined);
        }
      }
    }
  }
  console.info(`[WhatsApp] webhook accepté : ${count} message(s)`);
});