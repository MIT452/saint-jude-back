// src/ai/agent.ts
// Assistant conversationnel : mémoire de dialogue + outils (lecture et réservation) + RAG.
// Principe : le modèle PROPOSE, le backend VÉRIFIE et EXÉCUTE. Le modèle ne peut jamais
// enregistrer une réservation : il prépare un brouillon, le client clique sur « Confirmer ».

import { chat, safeError, type Msg } from './llm.js';
import { tools, toolDefs } from './tools.js';
import { findRelevantTools } from './jit.js';
import { defaultKnowledge, retrieveKnowledge } from './rag.js';
import {
  loadConv,
  newPendingExpiry,
  publicPending,
  saveConv,
  trim,
  PAYMENT_LABEL,
  PAYMENT_METHODS,
  type Conv,
  type Pending,
  type PaymentMethod,
} from './state.js';
import type { VerifyInput, VerifyResult } from '../routes/ai.js'; // types seulement : pas d'import circulaire

const MAX_STEPS = Number(process.env.AI_MAX_STEPS ?? 6);
const MAX_HISTORY = Number(process.env.AI_MAX_HISTORY ?? 20);
const TZ = 'Indian/Antananarivo';

/** Fonctions du backend injectées par la route (évite que agent.ts importe routes/ai.ts). */
export interface AgentDeps {
  verifyTrip: (input: VerifyInput) => Promise<VerifyResult>;
  parseRelativeDate: (text: string) => { dateStr: string; formatted: string; ambiguous: boolean } | null;
  getKnownPlaces: () => Promise<string[]>;
}

interface Ctx {
  conv: Conv;
  deps: AgentDeps;
}

/* =========================================================
   Prompt système
========================================================= */
const todayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const todayLong = () =>
  new Intl.DateTimeFormat('fr-FR', {
    timeZone: TZ,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date());

function buildSystemPrompt(ctx: Ctx, places: string[], documents: string, boatsData = ''): string {
  const p = ctx.conv.pending;
  const pendingText = p
    ? `\nRÉSERVATION EN ATTENTE DE CONFIRMATION (déjà préparée) : ${p.quantite} ${p.unite ?? 'unité(s)'} de ${p.marchandise}, ${p.poidsTotalKg} kg, ${p.depart} → ${p.arrivee}, le ${p.date}${p.prix ? `, ${p.prix} Ar` : ''}. ${p.paymentMethod ? ` Mode de paiement choisi : ${PAYMENT_LABEL[p.paymentMethod]}.` : ' Mode de paiement NON choisi : demande-le au client (Caisse, Banque ou Crédit).'} Le client doit cliquer sur « Confirmer » seulement une fois le mode de paiement choisi. Si le client change un élément, appelle de nouveau preparer_reservation.`
    : '';

  const boatsText = boatsData
    ? `DONNÉES BATEAUX (lues dans la base, seule source de vérité) :\n${boatsData}\nPour toute question sur les bateaux, réponds uniquement avec ces données. Un bateau est disponible seulement si son état est « Disponible » ; « En maintenance » et « Hors service » ne le sont pas. Ne dis « aucun bateau » que si cette liste est vide.\n\n`
    : '';

  return `Tu es l'assistant de Saint-Jude, entreprise de transport maritime à Madagascar. Tu aides les clients à consulter les voyages, les tarifs et les bateaux, et à préparer des réservations de marchandises.

DATE : aujourd'hui nous sommes le ${todayLong()} (${todayIso()}), fuseau de Madagascar.
PORTS CONNUS : ${places.join(', ') || 'aucun'}.

LANGUE ET STYLE
- Réponds dans la langue du client (français, malgache ou anglais). Si le message est mélangé, prends la langue dominante.
- 1 à 3 phrases courtes, ton chaleureux et poli.
- Pour énumérer des bateaux, des voyages ou des réservations : une liste avec « - », un élément par ligne, le nom en **gras**, puis capacité et état, par exemple « - **Arcanum** : 5000 tonnes, Disponible ».
- Mets toujours une espace entre les mots et les nombres (« 5000 tonnes », jamais « 5000tonnes »).
- Les montants sont en Ariary (Ar). Entana = marchandise, kilao = kg, eny = oui, tsia = non.

CONVERSATION
- Tu te souviens de toute la conversation : ne redemande JAMAIS une information déjà donnée.
- Si une information manque, pose UNE seule question à la fois.
- Informations nécessaires pour une réservation : marchandise, quantité (et unité : sac, colis...), poids, port de départ, port d'arrivée, date.
- Si le client donne un poids par unité (« 50 kg chacun »), calcule le poids total toi-même. Si c'est ambigu (« 3 sacs, 100 kg »), demande s'il s'agit du poids de chaque sac ou du total.
- Pour toute date relative (« demain », « vendredi », « rahampitso »), appelle convertir_date. Si le résultat est ambigu, demande confirmation de la date au client.
- Tu peux répondre normalement aux salutations et à la conversation courante, puis ramener la discussion vers le transport.

PAIEMENT
- Après le récapitulatif, demande UNE fois : « Comment souhaitez-vous payer : Caisse, Banque ou Crédit ? ». Dès que le client répond, appelle choisir_mode_paiement (caisse, espèces = CAISSE ; banque, virement = BANQUE ; crédit = CREDIT). Ne devine jamais le mode.
- Caisse : le client règle à la caisse. Banque : le client règle par virement. Crédit : la demande reste « En attente » jusqu'à validation par l'équipe ; ne promets JAMAIS qu'un crédit est accordé.
- Ne dis pas au client de cliquer sur « Confirmer » tant que le mode de paiement n'est pas choisi.

RÈGLES STRICTES
- Aucun prix, horaire, disponibilité, nombre de places ou nom de bateau sans avoir appelé l'outil correspondant (ou sans l'avoir lu dans les DONNÉES BATEAUX ci-dessous). N'invente jamais un chiffre.
- Pour lister_bateaux, n'utilise PAS le paramètre etat : appelle l'outil sans argument, puis lis l'état de chaque bateau dans le résultat.
- Avant de proposer une réservation, vérifie le trajet avec verifier_trajet ou preparer_reservation.
- Tu ne peux PAS enregistrer une réservation. preparer_reservation crée seulement un récapitulatif ; le client doit cliquer sur le bouton « Confirmer ». Ne dis JAMAIS qu'une réservation est enregistrée, et ne prétends jamais l'avoir annulée.
- Tu ne gères que le transport de marchandises. Pour un billet passager, explique poliment que ce n'est pas encore possible par le chat.
- Si un outil renvoie une erreur ou aucun résultat, dis-le honnêtement et propose une alternative (autre date, autre trajet).
- Si la question n'a aucun rapport avec le transport maritime, dis-le poliment et brièvement.${pendingText}

${boatsText}Contexte documentaire (à utiliser seulement s'il est pertinent) :
${documents || 'Aucun document pertinent.'}`;
}

/* =========================================================
   Outils de réservation (validation manuelle : on ne fait jamais confiance au modèle)
========================================================= */
const asText = (v: unknown, max = 80) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

const asNum = (v: unknown, max: number) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(',', '.')) : NaN;
  return Number.isFinite(n) && n > 0 && n <= max ? n : undefined;
};

const asIsoDate = (v: unknown) => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  const d = new Date(`${v}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v ? v : undefined;
};

const reservationToolDefs = [
  {
    type: 'function',
    function: {
      name: 'convertir_date',
      description:
        "Convertit une date dite par le client (demain, vendredi, 15 octobre, rahampitso...) en AAAA-MM-JJ. Retourne ambigue=true si le jour dit est celui d'aujourd'hui.",
      parameters: {
        type: 'object',
        properties: { texte: { type: 'string' } },
        required: ['texte'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'verifier_trajet',
      description:
        "Vérifie dans la base s'il existe un voyage entre deux ports à une date, avec la capacité restante et le tarif calculé. À appeler avant de donner un prix ou une disponibilité.",
      parameters: {
        type: 'object',
        properties: {
          depart: { type: 'string' },
          arrivee: { type: 'string' },
          date: { type: 'string', description: 'AAAA-MM-JJ' },
          quantite: { type: 'integer', description: 'nombre de colis / sacs / places' },
          poids_total_kg: { type: 'number', description: 'poids TOTAL en kg' },
        },
        required: ['depart', 'arrivee', 'date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'preparer_reservation',
      description:
        "Prépare SANS l'enregistrer une réservation de marchandises, après vérification du trajet. À appeler quand TOUT est connu. Le client devra cliquer sur Confirmer.",
      parameters: {
        type: 'object',
        properties: {
          marchandise: { type: 'string' },
          unite: { type: 'string', description: 'sac, colis, carton...' },
          quantite: { type: 'integer' },
          poids_total_kg: { type: 'number', description: 'poids TOTAL en kg' },
          depart: { type: 'string' },
          arrivee: { type: 'string' },
          date: { type: 'string', description: 'AAAA-MM-JJ' },
        },
        required: ['marchandise', 'quantite', 'poids_total_kg', 'depart', 'arrivee', 'date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'choisir_mode_paiement',
      description:
        "Enregistre le mode de paiement choisi par le client pour la réservation déjà préparée. À appeler seulement après que le client a répondu Caisse, Banque ou Crédit.",
      parameters: {
        type: 'object',
        properties: { mode: { type: 'string', enum: ['CAISSE', 'BANQUE', 'CREDIT'] } },
        required: ['mode'],
      },
    },
  },
];

const RESERVATION_TOOLS = new Set(reservationToolDefs.map((d) => d.function.name));

async function runReservationTool(name: string, a: Record<string, unknown>, ctx: Ctx): Promise<unknown> {
  if (name === 'convertir_date') {
    const r = ctx.deps.parseRelativeDate(String(a.texte ?? ''));
    if (!r) return { erreur: 'Date non reconnue : demande au client de la préciser.' };
    return { date: r.dateStr, lisible: r.formatted, ambigue: r.ambiguous };
  }

  if (name === 'choisir_mode_paiement') {
    const mode = String(a.mode ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .trim();
    if (!(PAYMENT_METHODS as readonly string[]).includes(mode)) {
      return { erreur: 'mode invalide : CAISSE, BANQUE ou CREDIT' };
    }
    if (!ctx.conv.pending) return { erreur: "Aucune réservation préparée : prépare d'abord la réservation." };
    ctx.conv.pending.paymentMethod = mode as PaymentMethod;
    ctx.conv.pending.expiresAt = newPendingExpiry();
    return {
      statut: 'EN_ATTENTE_CONFIRMATION',
      mode_paiement: mode,
      consigne:
        mode === 'CREDIT'
          ? "Dis au client que sa demande de crédit sera enregistrée « En attente » et validée par l'équipe, puis de cliquer sur Confirmer. Rien n'est enregistré."
          : 'Rappelle le mode choisi et dis au client de cliquer sur Confirmer. Rien n’est enregistré.',
    };
  }

  const depart = asText(a.depart);
  const arrivee = asText(a.arrivee);
  const date = asIsoDate(a.date);
  if (!depart || !arrivee) return { erreur: 'depart et arrivee requis' };
  if (!date) return { erreur: 'date invalide : utilise convertir_date puis le format AAAA-MM-JJ' };

  const poids = a.poids_total_kg === undefined ? undefined : asNum(a.poids_total_kg, 1_000_000);
  if (a.poids_total_kg !== undefined && poids === undefined) return { erreur: 'poids_total_kg invalide' };
  const qteRaw = a.quantite === undefined ? undefined : asNum(a.quantite, 100_000);
  const quantite = qteRaw !== undefined && Number.isInteger(qteRaw) ? qteRaw : undefined;
  if (a.quantite !== undefined && quantite === undefined) return { erreur: 'quantite invalide (entier positif)' };

  const result = await ctx.deps.verifyTrip({ depart, arrivee, date, poidsTotalKg: poids, quantite });

  if (name === 'verifier_trajet') {
    return result.available
      ? {
          disponible: true,
          bateau: result.boatName ?? null,
          tarif_par_kg: result.pricePerKg ?? null,
          prix_total: result.totalPrice ?? null,
        }
      : { disponible: false, message: result.message };
  }

  // preparer_reservation
  const marchandise = asText(a.marchandise, 60);
  if (!marchandise) return { erreur: 'marchandise requise' };
  if (!poids || !quantite) return { erreur: 'quantite et poids_total_kg requis' };
  if (!result.available) {
    ctx.conv.pending = null;
    return { disponible: false, message: result.message };
  }

  const pending: Pending = {
    depart: result.from ?? depart,
    arrivee: result.to ?? arrivee,
    date,
    quantite,
    poidsTotalKg: poids,
    marchandise,
    unite: asText(a.unite, 20),
    prix: result.totalPrice,
    boatName: result.boatName,
    paymentMethod: ctx.conv.pending?.paymentMethod, // conservé si le client modifie un autre élément
    expiresAt: newPendingExpiry(),
  };
  ctx.conv.pending = pending;
  return {
    statut: 'EN_ATTENTE_CONFIRMATION',
    resume: {
      marchandise,
      quantite,
      poids_total_kg: poids,
      depart: pending.depart,
      arrivee: pending.arrivee,
      date,
      bateau: pending.boatName ?? null,
      prix_total: pending.prix ?? null,
      mode_paiement: pending.paymentMethod ?? null,
    },
    consigne: pending.paymentMethod
      ? 'Présente ce récapitulatif au client et dis-lui de cliquer sur le bouton Confirmer. Rien n’est enregistré.'
      : 'Présente ce récapitulatif, puis demande au client : Caisse, Banque ou Crédit ? Rien n’est enregistré.',
  };
}

/* =========================================================
   Boucle agent conversationnelle
========================================================= */
export interface AgentInput {
  conversationId?: string;
  message: string;
  userId: string | null;
}

export interface AgentOutput {
  conversationId: string;
  reply: string;
  pending: ReturnType<typeof publicPending>;
}

/* =========================================================
   Réponse « bateaux » calculée par le code (le modèle ne peut pas se tromper)
========================================================= */
const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

/** Détecte le mode de paiement dit par le client (null si absent ou ambigu). */
function detectPayment(message: string): PaymentMethod | null {
  const t = norm(message);
  const found: PaymentMethod[] = [];
  if (/\b(caisse|cash|especes?)\b/.test(t)) found.push('CAISSE');
  if (/\b(banque|bank|virement)\b/.test(t)) found.push('BANQUE');
  if (/\bcredit\b/.test(t)) found.push('CREDIT');
  return found.length === 1 ? found[0] : null;
}

type BoatRow = { name?: unknown; capacity?: unknown; state?: unknown };

const boatLine = (b: BoatRow) => `- **${String(b.name ?? 'Bateau')}** : ${String(b.capacity ?? '?')} tonnes, ${String(b.state ?? 'état inconnu')}`;

function boatsReply(rows: BoatRow[], message: string): string {
  if (!rows.length) return "Aucun bateau n'est enregistré pour le moment.";
  const wantsAvailable = /dispo/.test(norm(message));
  if (!wantsAvailable) return `Voici nos bateaux (${rows.length}) :\n${rows.map(boatLine).join('\n')}`;

  const free = rows.filter((b) => norm(String(b.state ?? '')) === 'disponible');
  const others = rows.filter((b) => norm(String(b.state ?? '')) !== 'disponible');
  if (!free.length) {
    return `Aucun bateau n'est disponible actuellement. Voici l'état de la flotte :\n${rows.map(boatLine).join('\n')}`;
  }
  const head = free.length === 1 ? 'Un bateau est disponible :' : `${free.length} bateaux sont disponibles :`;
  const tail = others.length ? `\n\nLes autres bateaux ne sont pas disponibles :\n${others.map(boatLine).join('\n')}` : '';
  return `${head}\n${free.map(boatLine).join('\n')}${tail}`;
}

// Questions sur les bateaux qui ne concernent PAS une réservation : on répond sans passer par le modèle
const BOOKING_WORDS = /(reserv|expedi|envoy|prix|tarif|trajet|voyage|date|demain|kilo|\bkg\b|\bsacs?\b|colis|port)/;

export async function runAgent(input: AgentInput, deps: AgentDeps): Promise<AgentOutput> {
  const conv = await loadConv(input.conversationId, input.userId);
  const ctx: Ctx = { conv, deps };
  conv.messages.push({ role: 'user', content: input.message });

  // Choix du mode de paiement détecté par le code : fiable, sans dépendre du modèle
  if (conv.pending && !conv.pending.paymentMethod) {
    const chosen = detectPayment(input.message);
    if (chosen) {
      conv.pending.paymentMethod = chosen;
      conv.pending.expiresAt = newPendingExpiry();
    }
  }

  const [places, documents] = await Promise.all([
    deps.getKnownPlaces().catch(() => [] as string[]),
    retrieveKnowledge(input.message, defaultKnowledge).catch(() => []),
  ]);
  const docText = documents.map((d) => `- ${d.title}: ${d.body}`).join('\n');

  // Outils de lecture choisis selon la question + outils de réservation toujours disponibles
  const relevant = new Set(
    findRelevantTools(
      input.message,
      Object.entries(tools).map(([name, tool]) => ({ name, description: tool.def.function.description })),
    ).map((t) => t.name),
  );

  // Question sur les bateaux : l'outil est toujours proposé ET la base est lue directement par le code
  const BOAT_RE = /\b(bateaux?|batos?|navires?|sambo)\b/i;
  const askedBoats = BOAT_RE.test(input.message);
  if (askedBoats && tools['lister_bateaux']) relevant.add('lister_bateaux');

  let boatsData = '';
  let boatRows: BoatRow[] | null = null;
  if (askedBoats && tools['lister_bateaux']) {
    try {
      // sans filtre : on lit TOUS les bateaux avec leur état réel
      const raw = await tools['lister_bateaux'].run({});
      if (Array.isArray(raw)) boatRows = raw as BoatRow[];
      boatsData = JSON.stringify(raw).slice(0, 3000);
    } catch (e) {
      console.error('[agent] lecture bateaux :', safeError(e));
    }
  }

  // Réponse directe : liste/disponibilité des bateaux, sans réservation en cours
  if (boatRows && !conv.pending && !BOOKING_WORDS.test(norm(input.message))) {
    const direct = boatsReply(boatRows, input.message);
    conv.messages.push({ role: 'assistant', content: direct });
    await saveConv(conv);
    console.log(JSON.stringify({ ai: 'direct', conv: conv.id, boats: boatRows.length }));
    return { conversationId: conv.id, reply: direct, pending: publicPending(conv.pending) };
  }

  const availableTools = [...toolDefs.filter((d) => relevant.has(d.function.name)), ...reservationToolDefs];

  // Les échanges d'outils vivent seulement dans ce tour ; l'historique stocké reste du texte propre.
  const turn: Msg[] = [
    { role: 'system', content: buildSystemPrompt(ctx, places, docText, boatsData) },
    ...trim(conv.messages, MAX_HISTORY),
  ];

  const t0 = Date.now();
  const used: string[] = [];
  let reply = '';

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const out = await chat(turn, availableTools);
      turn.push(out);

      if (!out.tool_calls?.length) {
        reply = (out.content || '').trim();
        break;
      }

      for (const call of out.tool_calls) {
        const name = call.function.name;
        used.push(name);
        let result: unknown;
        try {
          const args = call.function.arguments ?? {};
          if (RESERVATION_TOOLS.has(name)) result = await runReservationTool(name, args, ctx);
          else if (tools[name]) result = await tools[name].run(args);
          else result = { erreur: 'Outil inconnu' };
        } catch (e) {
          console.error(`[agent] outil ${name} :`, safeError(e));
          result = { erreur: "Échec de l'outil" };
        }
        turn.push({ role: 'tool', tool_name: name, content: JSON.stringify(result).slice(0, 4000) });
      }
    }
  } catch (e) {
    console.error('[agent] LLM :', safeError(e));
    reply = "Je rencontre un problème technique pour le moment. Pouvez-vous réessayer dans un instant ?";
  }

  if (!reply) reply = "Je n'ai pas pu terminer la demande. Pouvez-vous la reformuler ?";

  // Garde-fou : l'IA ne peut jamais annoncer un enregistrement (seule la route /confirm le fait)
  if (/\b(enregistr[ée]e?|r[ée]serv[ée]e?)\b/i.test(reply) && /(c'est fait|a [ée]t[ée]|est bien|ai (bien )?enregistr)/i.test(reply)) {
    reply = conv.pending
      ? "Votre réservation est prête mais pas encore enregistrée : cliquez sur « Confirmer » pour la valider."
      : "Rien n'a été enregistré pour le moment. Dites-moi ce que vous souhaitez envoyer.";
  }

  // Garde-fou paiement : tant que le mode n'est pas choisi, le code pose la question lui-même
  if (conv.pending && !conv.pending.paymentMethod) {
    reply = reply.replace(/[^.!?\n]*Confirmer[^.!?\n]*[.!?]?/gi, '').trim();
    reply = `${reply}\n\nComment souhaitez-vous payer : **Caisse**, **Banque** ou **Crédit** ?`.trim();
  }

  conv.messages.push({ role: 'assistant', content: reply });
  await saveConv(conv);

  console.log(JSON.stringify({ ai: 'ok', conv: conv.id, ms: Date.now() - t0, tools: used }));
  return { conversationId: conv.id, reply, pending: publicPending(conv.pending) };
}

/* =========================================================
   Ancien agent « une question → une réponse texte » (sans mémoire, sans réservation).
   Utilisé par orchestration.ts.
========================================================= */
const ONE_SHOT_SYSTEM = `Tu es l'assistant de Saint-Jude, une application de transport maritime à Madagascar.
Réponds en français, de façon courte.
Pour toute donnée chiffrée, appelle un outil. N'invente jamais de chiffres.
Les montants sont en Ariary.`;

export async function runOneShotAgent(question: string): Promise<string> {
  const documents = await retrieveKnowledge(question, defaultKnowledge).catch(() => []);
  const relevant = new Set(
    findRelevantTools(
      question,
      Object.entries(tools).map(([name, tool]) => ({ name, description: tool.def.function.description })),
    ).map((t) => t.name),
  );
  const availableToolDefs = toolDefs.filter((d) => relevant.has(d.function.name));
  const context = documents.map((d) => `- ${d.title}: ${d.body}`).join('\n');

  const messages: Msg[] = [
    {
      role: 'system',
      content: `${ONE_SHOT_SYSTEM}\nUtilise ce contexte documentaire s'il est pertinent :\n${context || 'Aucun document pertinent.'}`,
    },
    { role: 'user', content: question },
  ];

  for (let tour = 0; tour < 5; tour++) {
    const reply = await chat(messages, availableToolDefs);
    messages.push(reply);
    if (!reply.tool_calls?.length) return reply.content;

    for (const call of reply.tool_calls) {
      const name = call.function.name;
      let result: unknown;
      try {
        const tool = tools[name];
        result = tool ? await tool.run(call.function.arguments ?? {}) : { erreur: 'Outil inconnu' };
      } catch (e) {
        console.error(e);
        result = { erreur: "Échec de l'outil" };
      }
      messages.push({ role: 'tool', tool_name: name, content: JSON.stringify(result).slice(0, 4000) });
    }
  }
  return "Je n'ai pas pu terminer la demande.";
}