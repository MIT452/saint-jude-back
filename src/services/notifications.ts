// src/services/notifications.ts
// Envoi direct des notifications : e-mail (Brevo) et WhatsApp (API Cloud de Meta).
// Utilisé par flushOutbox (ai.ts) quand N8N_WEBHOOK_URL n'est pas défini.
//  - Client : coordonnées du compte propriétaire de la réservation (payload.email / payload.telephone,
//    lus dans Neon par requireAuth). Jamais un nom ou un numéro saisi dans le chat.
//  - Administrateur : ligne unique de la table notification_settings (page « Configuration »),
//    avec repli sur ADMIN_EMAIL / ADMIN_WHATSAPP si rien n'y est configuré.

import { pool } from '../db.js';

type Payload = Record<string, any>;
type Msg = { subject: string; text: string };

const env = (k: string) => (process.env[k] ?? '').trim();

export const emailEnabled = () => Boolean(env('BREVO_API_KEY') && env('MAIL_FROM'));
export const whatsappEnabled = () =>
  Boolean(env('WHATSAPP_TOKEN') && env('WHATSAPP_PHONE_NUMBER_ID'));
export const directNotificationsEnabled = () => emailEnabled() || whatsappEnabled();
export const notificationsEnabled = () => Boolean(env('N8N_WEBHOOK_URL')) || directNotificationsEnabled();

const money = (n: unknown) => `${Number(n || 0).toLocaleString('fr-FR')} Ar`;

function details(p: Payload): string {
  const goods = [p.quantite, p.unite, p.marchandise].filter(Boolean).join(' ');
  return [
    p.client_nom && `Client : ${p.client_nom}`,
    goods && `Marchandise : ${goods}${p.poids_kg ? ` (${p.poids_kg} kg)` : ''}`,
    (p.depart || p.arrivee) && `Trajet : ${p.depart ?? '?'} → ${p.arrivee ?? '?'}`,
    p.date && `Date : ${p.date}`,
    p.navire && `Navire : ${p.navire}`,
    p.total ? `Montant : ${money(p.total)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Contenu des messages selon l'événement : admin et/ou client. */
function buildMessages(event: string, p: Payload): { admin?: Msg; client?: Msg } {
  const ref = `#${p.numero ?? ''}`;
  const hello = `Bonjour${p.client_nom ? ` ${p.client_nom}` : ''},`;
  const d = details(p);

  switch (event) {
    case 'reservation.pending':
      return {
        admin: {
          subject: `Nouvelle demande de réservation ${ref}`,
          text: `Bonjour,\n\nUne nouvelle demande est à traiter.\n\n${d}\n\nAction : vérifier la disponibilité et le tarif, puis accepter ou refuser.`,
        },
        client: {
          subject: `Votre demande ${ref} est enregistrée`,
          text: `${hello}\n\nVotre demande de réservation ${ref} a bien été enregistrée.\n\n${d}\n\nElle est en attente de validation par notre équipe. Nous vous informerons dès qu'une décision sera prise.`,
        },
      };
    case 'reservation.confirmed':
      return {
        admin: {
          subject: `Réservation ${ref} confirmée`,
          text: `La réservation ${ref} est confirmée.\n\n${d}`,
        },
        client: {
          subject: `Réservation ${ref} confirmée`,
          text: `${hello}\n\nVotre réservation ${ref} est confirmée.\n\n${d}\n\nRetrouvez-la dans votre espace client.`,
        },
      };
    case 'reservation.refused':
      return {
        client: {
          subject: `Réservation ${ref} refusée`,
          text: `${hello}\n\nNous sommes désolés, votre demande ${ref} n'a pas pu être acceptée.${p.motif ? `\nMotif : ${p.motif}` : ''}\n\nVous pouvez contacter notre équipe ou effectuer une nouvelle demande.`,
        },
      };
    case 'reservation.cancelled':
      return {
        admin: { subject: `Réservation ${ref} annulée`, text: `La réservation ${ref} a été annulée.\n\n${d}` },
        client: {
          subject: `Réservation ${ref} annulée`,
          text: `${hello}\n\nVotre réservation ${ref} a été annulée.\n\n${d}`,
        },
      };
    default:
      return {}; // no_show, completed, etc. : pas de message
  }
}

/** Numéro malgache → format international sans « + » (ex. 0341234567 → 261341234567). */
export function normalizePhone(raw: unknown): string | null {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('261')) return d;
  if (d.startsWith('0')) return `261${d.slice(1)}`;
  if (d.length === 9) return `261${d}`;
  return d;
}

async function sendEmail(to: string, m: Msg, senderName?: string | null) {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': env('BREVO_API_KEY'),
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { name: (senderName ?? '').trim() || env('MAIL_FROM_NAME') || 'SAINT-JUDE', email: env('MAIL_FROM') },
      to: [{ email: to }],
      subject: m.subject,
      textContent: m.text,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Brevo ${res.status}: ${(await res.text()).slice(0, 150)}`);
}

async function sendWhatsApp(to: string, p: Payload) {
  // WhatsApp impose un template approuvé pour écrire en premier : hello_world pour les tests.
  const template: Record<string, unknown> = {
    name: env('WHATSAPP_TEMPLATE') || 'hello_world',
    language: { code: env('WHATSAPP_TEMPLATE_LANG') || 'en_US' },
  };
  if (env('WHATSAPP_TEMPLATE_PARAMS') === '1') {
    template.components = [
      {
        type: 'body',
        parameters: [p.numero, `${p.depart ?? '-'} → ${p.arrivee ?? '-'}`, p.date].map((v) => ({
          type: 'text',
          text: String(v ?? '-'),
        })),
      },
    ];
  }
  const version = env('WHATSAPP_API_VERSION') || 'v23.0';
  const res = await fetch(`https://graph.facebook.com/${version}/${env('WHATSAPP_PHONE_NUMBER_ID')}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('WHATSAPP_TOKEN')}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template', template }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${(await res.text()).slice(0, 150)}`);
}

/** Message de test envoyé depuis la page Configuration (bouton « Envoyer un message de test »). */
export async function sendTestMessage(channel: 'email' | 'whatsapp', to: string, senderName?: string | null) {
  if (channel === 'email') {
    if (!emailEnabled()) throw new Error('E-mail non configuré sur le serveur (BREVO_API_KEY, MAIL_FROM)');
    await sendEmail(
      to,
      {
        subject: 'Test de notification SAINT-JUDE',
        text: 'Ceci est un message de test : la configuration des notifications fonctionne.',
      },
      senderName,
    );
    return;
  }
  if (!whatsappEnabled()) throw new Error('WhatsApp non configuré sur le serveur (WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID)');
  const phone = normalizePhone(to);
  if (!phone) throw new Error('Numéro WhatsApp invalide');
  await sendWhatsApp(phone, { numero: 'TEST', depart: '-', arrivee: '-', date: '-' });
}

/* =========================================================
   Paramètres de notification (table notification_settings, ligne unique)
========================================================= */
interface SettingsRow {
  admin_email: string | null;
  admin_whatsapp: string | null;
  mail_from_name: string | null;
  email_enabled: boolean | null;
  whatsapp_enabled: boolean | null;
  client_email_enabled: boolean | null;
  client_whatsapp_enabled: boolean | null;
  events: unknown;
}

// Événements du système → événements cochés dans la page « Configuration »
const SETTINGS_EVENT: Record<string, string> = {
  'reservation.confirmed': 'reservation.auto_approved',
  'reservation.pending': 'reservation.manual_review',
  'reservation.refused': 'reservation.rejected',
};

function eventAllowed(row: SettingsRow, event: string): boolean {
  const mapped = SETTINGS_EVENT[event];
  if (!mapped) return true;
  let list: unknown = row.events;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      list = null;
    }
  }
  if (!Array.isArray(list)) return true;
  return list.includes(mapped);
}

/** null = table illisible ou vide (on se rabat alors sur les variables d'environnement). */
async function loadSettings(): Promise<SettingsRow | null> {
  try {
    const { rows } = await pool.query('SELECT * FROM notification_settings ORDER BY id LIMIT 1');
    return (rows[0] as SettingsRow | undefined) ?? null;
  } catch (err) {
    console.warn(`[notif] notification_settings illisible : ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Historique visible dans la page Configuration ; ne doit jamais faire échouer l'envoi. */
async function logSend(channel: 'email' | 'whatsapp', event: string, recipient: string, error: string | null) {
  try {
    await pool.query(
      `INSERT INTO notification_logs (channel, event, recipient, status, error)
       VALUES ($1, $2, $3, $4, $5)`,
      [channel, event, recipient, error ? 'failed' : 'sent', error],
    );
  } catch {
    /* journal facultatif */
  }
}

interface Job {
  key: string;
  run: () => Promise<void>;
  log?: { channel: 'email' | 'whatsapp'; to: string };
}

/**
 * Envoie les messages d'un événement. `already` = cibles déjà livrées (évite les doublons
 * quand une nouvelle tentative a lieu). Un destinataire sans adresse est simplement ignoré.
 */
export async function deliverNotification(event: string, p: Payload, already: string[] = []) {
  const msgs = buildMessages(event, p);
  const jobs: Job[] = [];

  const s = await loadSettings();
  const hasAdminConfig = Boolean(s && ((s.admin_email ?? '').trim() || (s.admin_whatsapp ?? '').trim()));

  // ---- Administrateur
  if (msgs.admin) {
    const m = msgs.admin;
    if (hasAdminConfig && s) {
      if (eventAllowed(s, event)) {
        const mail = (s.admin_email ?? '').trim();
        const wa = normalizePhone(s.admin_whatsapp);
        if (s.email_enabled && mail && emailEnabled()) {
          jobs.push({
            key: 'admin:email',
            run: () => sendEmail(mail, m, s.mail_from_name),
            log: { channel: 'email', to: mail },
          });
        }
        if (s.whatsapp_enabled && wa && whatsappEnabled()) {
          jobs.push({
            key: 'admin:whatsapp',
            run: () => sendWhatsApp(wa, p),
            log: { channel: 'whatsapp', to: wa },
          });
        }
      }
    } else {
      // Repli : rien n'est configuré dans la page, on utilise les variables Render
      const adminMail = env('ADMIN_EMAIL');
      const adminWa = normalizePhone(env('ADMIN_WHATSAPP'));
      if (emailEnabled() && adminMail) jobs.push({ key: 'admin:email', run: () => sendEmail(adminMail, m) });
      if (whatsappEnabled() && adminWa) jobs.push({ key: 'admin:whatsapp', run: () => sendWhatsApp(adminWa, p) });
    }
  }

  // ---- Client : coordonnées de son propre compte uniquement
  if (msgs.client) {
    const m = msgs.client;
    const clientMail = typeof p.email === 'string' ? p.email.trim() : '';
    const clientWa = normalizePhone(p.telephone);
    const mailAllowed = !s || s.client_email_enabled !== false;
    const waAllowed = !s || s.client_whatsapp_enabled !== false;
    if (mailAllowed && emailEnabled() && clientMail) {
      jobs.push({
        key: 'client:email',
        run: () => sendEmail(clientMail, m, s?.mail_from_name),
        log: { channel: 'email', to: clientMail },
      });
    }
    if (waAllowed && whatsappEnabled() && clientWa) {
      jobs.push({
        key: 'client:whatsapp',
        run: () => sendWhatsApp(clientWa, p),
        log: { channel: 'whatsapp', to: clientWa },
      });
    }
  }

  const sent: string[] = [];
  const failed: string[] = [];
  for (const job of jobs) {
    if (already.includes(job.key)) continue;
    try {
      await job.run();
      sent.push(job.key);
      if (job.log) await logSend(job.log.channel, event, job.log.to, null);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[notif] ${job.key} échoué : ${reason}`);
      failed.push(job.key);
      if (job.log) await logSend(job.log.channel, event, job.log.to, reason.slice(0, 200));
    }
  }
  return { sent, failed };
}