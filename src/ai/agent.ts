// src/ai/agent.ts
// Assistant conversationnel : mémoire de dialogue + outils (lecture et réservation) + RAG.
// Principe : le modèle PROPOSE, le backend VÉRIFIE et EXÉCUTE. Le modèle ne peut jamais
// enregistrer une réservation : il prépare un brouillon, le client clique sur « Confirmer ».

import { pool } from '../db.js';
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

function buildSystemPrompt(
  ctx: Ctx,
  places: string[],
  documents: string,
  boatsData = '',
  firstName: string | null = null,
): string {
  const p = ctx.conv.pending;
  const pendingText = p
    ? `\nRÉSERVATION EN ATTENTE DE CONFIRMATION (déjà préparée) : ${p.quantite} ${p.unite ?? 'unité(s)'} de ${p.marchandise}, ${p.poidsTotalKg} kg, ${p.depart} → ${p.arrivee}, le ${p.date}${p.prix ? `, ${p.prix} Ar` : ''}. ${p.paymentMethod ? `Mode de paiement choisi : ${PAYMENT_LABEL[p.paymentMethod]}.` : 'Mode de paiement NON choisi : demande-le au client (Caisse, Banque ou Crédit).'} Le client doit cliquer sur « Confirmer » seulement une fois le mode de paiement choisi. Si le client change un élément, appelle de nouveau preparer_reservation.`
    : '';

  const boatsText = boatsData
    ? `DONNÉES BATEAUX (lues dans la base, seule source de vérité) :\n${boatsData}\nPour toute question sur les bateaux, réponds uniquement avec ces données. Un bateau est disponible seulement si son état est « Disponible » ; « En maintenance », « Hors service » et « Désarmé » ne le sont pas. Ne dis « aucun bateau » que si cette liste est vide.\n\n`
    : '';

  const clientText = firstName
    ? `\nLe client s'appelle ${firstName}. Utilise son prénom de temps en temps (salutation, remerciement), jamais à chaque phrase.`
    : '';

  return `Tu es l'assistant de Saint-Jude, entreprise de transport maritime à Madagascar. Tu parles comme un conseiller de comptoir aimable, qui connaît bien son métier : naturel, simple, posé. Tu aides les clients à consulter les voyages, les tarifs et les bateaux, et à préparer des réservations de marchandises. Si on te demande si tu es un humain, réponds simplement que tu es l'assistant virtuel de Saint-Jude.

DATE : aujourd'hui nous sommes le ${todayLong()} (${todayIso()}), fuseau de Madagascar.
PORTS CONNUS : ${places.join(', ') || 'aucun'}.${clientText}

TON ET FAÇON DE PARLER
- Parle comme à un client au guichet : phrases courtes, mots simples, vouvoiement. Pas de ton administratif, pas de « N'hésitez pas à… », pas de « Je suis là pour vous aider ».
- Réagis d'abord à ce que le client vient de dire (« Très bien », « D'accord », « Compris », « Parfait »), puis avance. Varie ces débuts d'une réponse à l'autre : ne commence jamais deux réponses de suite par le même mot.
- Réponds à la question posée AVANT de poser la tienne.
- Si le client semble contrarié, déçu ou pressé, reconnais-le en une demi-phrase (« Je comprends, c'est embêtant. ») avant de proposer une solution.
- Quand c'est impossible (pas de voyage, bateau indisponible), dis-le franchement, explique en quelques mots pourquoi, puis propose TOUJOURS une alternative concrète tirée des données (prochains départs réels, autre bateau). Ne demande jamais au client de deviner une date au hasard : appelle prochains_voyages.
- Les messages courts ou avec des fautes (« pourq », « bato », « combient ») : devine le sens le plus probable à partir de la conversation. « Pourquoi ? » veut dire : explique ta dernière réponse avec les données déjà obtenues. Si le sens reste vraiment incertain, demande gentiment de préciser.
- Pose UNE seule question à la fois, seulement si elle est nécessaire. Ne redemande JAMAIS une information déjà donnée et ne répète jamais une question déjà posée.
- Pas d'emoji, sauf si le client en utilise.

EXEMPLES DE TON (à imiter pour la manière, jamais pour le contenu : ne recopie ni nom, ni chiffre)
- Client : « salut » → « Bonjour ! Qu'est-ce que vous souhaitez envoyer aujourd'hui ? »
- Client : « pourquoi ? » après un « pas de voyage » → « Parce qu'aucun départ n'est programmé sur ce trajet pour le moment. Voici les prochains départs que j'ai trouvés… » (puis tu appelles prochains_voyages et tu présentes les vrais résultats).
- Client : « c'est trop cher » → « Je comprends. Le tarif dépend du poids et du trajet. On peut regarder une autre date pour comparer, si vous voulez. »
- Client : « ok merci » → « Avec plaisir ! Si vous avez besoin d'autre chose, dites-moi. »

LANGUE ET MISE EN FORME
- Réponds dans la langue du client (français, malgache ou anglais). Si le message est mélangé, prends la langue dominante.
- 1 à 3 phrases courtes. Pour énumérer des bateaux, des voyages ou des réservations : une liste avec « - », un élément par ligne, le nom en **gras**, puis le détail, par exemple « - **Arcanum** : 5 000 tonnes, Disponible ».
- Mets toujours une espace entre les mots et les nombres (« 5 000 tonnes », jamais « 5000tonnes »).
- Les montants sont en Ariary (Ar). Entana = marchandise, kilao = kg, eny = oui, tsia = non.

CONVERSATION
- Tu te souviens de toute la conversation.
- Informations nécessaires pour une réservation : marchandise, quantité (et unité : sac, colis...), poids, port de départ, port d'arrivée, date.
- Si le client donne un poids par unité (« 50 kg chacun »), calcule le poids total toi-même. Si c'est ambigu (« 3 sacs, 100 kg »), demande s'il s'agit du poids de chaque sac ou du total.
- Pour toute date relative (« demain », « vendredi », « rahampitso »), appelle convertir_date. Si le résultat est ambigu, demande confirmation de la date au client.
- Tu peux répondre normalement aux salutations et à la conversation courante, puis ramener doucement la discussion vers le transport.

PAIEMENT
- Après le récapitulatif, demande UNE fois : « Comment souhaitez-vous payer : Caisse, Banque ou Crédit ? ». Dès que le client répond, appelle choisir_mode_paiement (caisse, espèces = CAISSE ; banque, virement = BANQUE ; crédit = CREDIT). Ne devine jamais le mode.
- Caisse : le client règle à la caisse. Banque : le client règle par virement. Crédit : la demande reste « En attente » jusqu'à validation par l'équipe ; ne promets JAMAIS qu'un crédit est accordé.
- Ne dis pas au client de cliquer sur « Confirmer » tant que le mode de paiement n'est pas choisi.

RÈGLES STRICTES
- Aucun prix, horaire, disponibilité, nombre de places ou nom de bateau sans avoir appelé l'outil correspondant (ou sans l'avoir lu dans les DONNÉES BATEAUX ci-dessous). N'invente jamais un chiffre.
- Pour lister_bateaux, n'utilise PAS le paramètre etat : appelle l'outil sans argument, puis lis l'état de chaque bateau dans le résultat.
- Avant de proposer une réservation, vérifie le trajet avec verifier_trajet ou preparer_reservation. Si le trajet n'existe pas à cette date, appelle prochains_voyages pour proposer de vrais départs.
- Tu ne peux PAS enregistrer une réservation. preparer_reservation crée seulement un récapitulatif ; le client doit cliquer sur le bouton « Confirmer ». Ne dis JAMAIS qu'une réservation est enregistrée, et ne prétends jamais l'avoir annulée.
- Tu ne gères que le transport de marchandises. Pour un billet passager, explique poliment que ce n'est pas encore possible par le chat.
- Si un outil renvoie une erreur ou aucun résultat, dis-le honnêtement et propose une alternative (autre date, autre trajet).
- Si la question n'a aucun rapport avec le transport maritime, dis-le poliment et brièvement.${pendingText}

${boatsText}Contexte documentaire (à utiliser seulement s'il est pertinent) :
${documents || 'Aucun document pertinent.'}`;
}

/* =========================================================
   Voyages à venir (lus dans Neon) : outil prochains_voyages et réponse de secours
========================================================= */
const likeParam = (s: string) => `%${s.trim().toLowerCase().replace(/[\\%_]/g, '\\$&')}%`;
const frDate = (iso: string) => iso.split('-').reverse().join('/');
const nbr = (n: number) => n.toLocaleString('fr-FR').replace(/[\u202f\u00a0]/g, ' ');

// Bateau utilisable : ni en maintenance, ni hors service, ni désarmé, ni en construction
const BOAT_USABLE = `(b.id IS NULL OR (
  LOWER(COALESCE(b.state, '')) NOT LIKE '%maintenance%'
  AND LOWER(COALESCE(b.state, '')) NOT LIKE '%hors%'
  AND LOWER(COALESCE(b.state, '')) NOT LIKE '%désarm%'
  AND LOWER(COALESCE(b.state, '')) NOT LIKE '%desarm%'
  AND LOWER(COALESCE(b.state, '')) NOT LIKE '%construction%'
))`;

// Places déjà prises (réservations confirmées ou en attente), comme le contrôle de capacité
const USED_SQL = `COALESCE((SELECT SUM(r.quantity) FROM reservations r
                    WHERE r."tripId" = t.id
                      AND UPPER(COALESCE(r.status, '')) NOT IN
                        ('REFUSEE', 'REFUSÉE', 'ANNULEE', 'ANNULÉE', 'CANCELLED', 'NO_SHOW', 'NO-SHOW')), 0)`;

interface TripInfo {
  date: string; // AAAA-MM-JJ
  heure: string | null;
  depart: string;
  arrivee: string;
  bateau: string | null;
  tarif_par_kg: number | null;
  places_restantes: number | null;
}

async function upcomingTrips(opts: { depart?: string; arrivee?: string; limit?: number }): Promise<TripInfo[]> {
  const params: unknown[] = [todayIso()];
  const conds = [
    `t.depart::date >= $1::date`,
    `UPPER(COALESCE(t.status, '')) NOT LIKE 'ANNUL%'`,
    BOAT_USABLE,
  ];
  if (opts.depart) {
    params.push(likeParam(opts.depart));
    conds.push(`LOWER(t."from") LIKE $${params.length} ESCAPE '\\'`);
  }
  if (opts.arrivee) {
    params.push(likeParam(opts.arrivee));
    conds.push(`LOWER(t."to") LIKE $${params.length} ESCAPE '\\'`);
  }
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 5), 1), 10);

  const { rows } = await pool.query(
    `SELECT to_char(t.depart::date, 'YYYY-MM-DD') AS day,
            to_char(t.depart::timestamp, 'HH24:MI') AS hour,
            t."from" AS dep, t."to" AS dest, t."pricePerKg" AS price_per_kg,
            b.name AS boat_name, b.capacity, ${USED_SQL} AS used
       FROM trips t
       LEFT JOIN boats b ON t."boatId" = b.id
      WHERE ${conds.join(' AND ')}
      ORDER BY t.depart ASC
      LIMIT ${limit}`,
    params,
  );

  return rows.map((r: Record<string, any>) => ({
    date: String(r.day),
    heure: r.hour && r.hour !== '00:00' ? String(r.hour) : null,
    depart: String(r.dep),
    arrivee: String(r.dest),
    bateau: r.boat_name ? String(r.boat_name) : null,
    tarif_par_kg: Number(r.price_per_kg) > 0 ? Number(r.price_per_kg) : null,
    places_restantes: r.capacity !== null && r.capacity !== undefined ? Math.max(0, Number(r.capacity) - Number(r.used)) : null,
  }));
}

const tripLine = (t: TripInfo) => {
  const extra = [
    t.bateau ? `navire ${t.bateau}` : '',
    t.tarif_par_kg ? `${nbr(t.tarif_par_kg)} Ar/kg` : '',
  ]
    .filter(Boolean)
    .join(', ');
  return `- **${t.depart} → ${t.arrivee}** : ${frDate(t.date)}${t.heure ? ` à ${t.heure}` : ''}${extra ? ` (${extra})` : ''}`;
};

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
      name: 'prochains_voyages',
      description:
        "Liste les prochains départs réels (date, heure, navire, tarif, places restantes), éventuellement entre deux ports. À appeler quand le client demande les voyages à venir, ou quand aucun voyage n'existe à la date demandée, pour lui proposer de vrais départs. Si le trajet n'a aucun départ, le résultat propose les autres départs depuis ce port ou les autres lignes.",
      parameters: {
        type: 'object',
        properties: {
          depart: { type: 'string', description: 'port de départ (facultatif)' },
          arrivee: { type: 'string', description: "port d'arrivée (facultatif)" },
          limite: { type: 'integer', description: 'nombre maximal de voyages (5 par défaut)' },
        },
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

  if (name === 'prochains_voyages') {
    const depart = asText(a.depart);
    const arrivee = asText(a.arrivee);
    const limite = a.limite === undefined ? 5 : (asNum(a.limite, 10) ?? 5);

    const voyages = await upcomingTrips({ depart, arrivee, limit: limite });
    if (voyages.length) return { voyages };

    const result: Record<string, unknown> = { voyages: [], message: 'Aucun départ à venir sur ce trajet.' };
    if (depart && arrivee) {
      const fromPort = await upcomingTrips({ depart, limit: 3 });
      if (fromPort.length) result.autres_departs_depuis_ce_port = fromPort;
    }
    if (!result.autres_departs_depuis_ce_port) {
      const network = await upcomingTrips({ limit: 3 });
      if (network.length) result.autres_lignes_disponibles = network;
    }
    return result;
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
      : {
          disponible: false,
          message: result.message,
          conseil: 'Appelle prochains_voyages pour proposer de vrais départs au client.',
        };
  }

  // preparer_reservation
  const marchandise = asText(a.marchandise, 60);
  if (!marchandise) return { erreur: 'marchandise requise' };
  if (!poids || !quantite) return { erreur: 'quantite et poids_total_kg requis' };
  if (!result.available) {
    ctx.conv.pending = null;
    return {
      disponible: false,
      message: result.message,
      conseil: 'Appelle prochains_voyages pour proposer de vrais départs au client.',
    };
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

const boatLine = (b: BoatRow) => {
  const cap =
    b.capacity !== null && b.capacity !== undefined && b.capacity !== '' && Number.isFinite(Number(b.capacity))
      ? `${nbr(Number(b.capacity))} tonnes`
      : 'capacité non renseignée';
  return `- **${String(b.name ?? 'Bateau')}** : ${cap}, ${String(b.state ?? 'état inconnu')}`;
};

function boatsReply(rows: BoatRow[], message: string): string {
  if (!rows.length) return "Je ne vois aucun bateau enregistré pour le moment.";
  const wantsAvailable = /dispo/.test(norm(message));
  if (!wantsAvailable) {
    const head = rows.length === 1 ? 'Nous avons un bateau :' : `Voici nos ${rows.length} bateaux :`;
    return `${head}\n${rows.map(boatLine).join('\n')}`;
  }

  const free = rows.filter((b) => norm(String(b.state ?? '')) === 'disponible');
  const others = rows.filter((b) => norm(String(b.state ?? '')) !== 'disponible');
  if (!free.length) {
    return `Pour le moment, aucun bateau n'est disponible. Voici l'état de la flotte :\n${rows.map(boatLine).join('\n')}`;
  }
  const head = free.length === 1 ? 'Un seul bateau est disponible :' : `${free.length} bateaux sont disponibles :`;
  const tail = others.length ? `\n\nLes autres ne sont pas disponibles pour le moment :\n${others.map(boatLine).join('\n')}` : '';
  return `${head}\n${free.map(boatLine).join('\n')}${tail}`;
}

// Questions sur les bateaux qui ne concernent PAS une réservation : on répond sans passer par le modèle
const BOOKING_WORDS = /(reserv|expedi|envoy|prix|tarif|trajet|voyage|date|demain|kilo|\bkg\b|\bsacs?\b|colis|port)/;

/* =========================================================
   Réponse de secours quand le modèle ne répond pas : toujours utile, jamais inventée
========================================================= */
async function fallbackReply(
  message: string,
  places: string[],
  hasPending: boolean,
  boatRows: BoatRow[] | null,
): Promise<string> {
  const t = norm(message);

  if (boatRows) return boatsReply(boatRows, message);

  const mentioned = places
    .map((p) => ({ p, i: t.indexOf(norm(p)) }))
    .filter((x) => x.i >= 0)
    .sort((x, y) => x.i - y.i)
    .map((x) => x.p);
  const wantsTrips = mentioned.length > 0 || /(voyage|trajet|depart|date|prix|tarif|propos|prochain)/.test(t);

  if (wantsTrips) {
    try {
      let trips: TripInfo[] = [];
      let note = '';
      if (mentioned.length >= 2) trips = await upcomingTrips({ depart: mentioned[0], arrivee: mentioned[1], limit: 3 });
      else if (mentioned.length === 1) trips = await upcomingTrips({ depart: mentioned[0], limit: 3 });
      else trips = await upcomingTrips({ limit: 3 });

      if (trips.length === 0) {
        trips = await upcomingTrips({ limit: 3 });
        note = mentioned.length ? " Je ne vois aucun départ à venir sur ce trajet. Voici les prochains départs sur nos autres lignes :" : '';
      }
      if (trips.length) {
        const intro = note || ' Voici les prochains départs que je trouve dans notre base :';
        return `Je n'arrive pas à vous répondre en détail à l'instant.${intro}\n${trips.map(tripLine).join('\n')}\n\nRéessayez dans un instant pour préciser votre demande.`;
      }
    } catch (e) {
      console.error('[agent] secours voyages :', safeError(e));
    }
  }

  if (hasPending) {
    return "Je n'arrive pas à vous répondre à l'instant. Votre demande est toujours en préparation et aucune réservation n'a été créée. Réessayez dans un instant.";
  }
  return "Je n'arrive pas à traiter votre message à l'instant. Pouvez-vous réessayer dans un moment ? Aucune réservation n'a été créée.";
}

/** Prénom du client connecté (pour une conversation plus naturelle). */
async function getFirstName(userId: string | null): Promise<string | null> {
  if (!userId) return null;
  try {
    const { rows } = await pool.query('SELECT name FROM "user" WHERE id = $1', [userId]);
    const first = String(rows[0]?.name ?? '').trim().split(/\s+/)[0] ?? '';
    const cleaned = first.replace(/[^\p{L}' -]/gu, '').slice(0, 30);
    return cleaned || null;
  } catch {
    return null;
  }
}

type ChatTools = Parameters<typeof chat>[1];

/** Un appel au modèle, avec une seule nouvelle tentative pour les pannes passagères (limite, délai, réseau). */
async function chatWithRetry(turn: Msg[], defs: ChatTools) {
  try {
    return await chat(turn, defs);
  } catch (e) {
    if (!/429|rate|timeout|timed out|abort|fetch failed|ECONN|\b5\d\d\b/i.test(safeError(e))) throw e;
    console.warn(`[agent] LLM : nouvelle tentative après « ${safeError(e)} »`);
    await sleep(1500);
    return chat(turn, defs);
  }
}

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

  const [places, documents, firstName] = await Promise.all([
    deps.getKnownPlaces().catch(() => [] as string[]),
    retrieveKnowledge(input.message, defaultKnowledge).catch(() => []),
    getFirstName(input.userId),
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
    { role: 'system', content: buildSystemPrompt(ctx, places, docText, boatsData, firstName) },
    ...trim(conv.messages, MAX_HISTORY),
  ];

  const t0 = Date.now();
  const used: string[] = [];
  let reply = '';
  let degraded = false;

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const out = await chatWithRetry(turn, availableTools);
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
    degraded = true;
    reply = await fallbackReply(input.message, places, Boolean(conv.pending), boatRows);
  }

  if (!reply) reply = "Je n'ai pas pu terminer la demande. Pouvez-vous la reformuler ?";

  if (!degraded) {
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
  }

  conv.messages.push({ role: 'assistant', content: reply });
  await saveConv(conv);

  console.log(JSON.stringify({ ai: degraded ? 'secours' : 'ok', conv: conv.id, ms: Date.now() - t0, tools: used }));
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