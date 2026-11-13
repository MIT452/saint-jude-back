// src/ai/agent.ts
// Assistant conversationnel : mémoire de dialogue + outils (lecture et réservation) + RAG.
// Principe : le modèle PROPOSE, le backend VÉRIFIE et EXÉCUTE. Le modèle ne peut jamais
// enregistrer une réservation : il prépare un brouillon, le client clique sur « Confirmer ».

import { pool } from '../db.js';
import { chat, safeError, type ChatOptions, type Msg } from './llm.js';
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
const MAX_HISTORY = Number(process.env.AI_MAX_HISTORY ?? 10);
const TZ = 'Indian/Antananarivo';

// Réglages de conversation. Quota Groq limité (TPM) : raisonnement bas et réponses courtes
// pour consommer moins de tokens par appel.
const CHAT_OPTS: ChatOptions = {
  temperature: Number(process.env.AI_TEMPERATURE ?? 0.5),
  maxTokens: 350,
  reasoning: 'low',
};

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
   Utilitaires de texte
========================================================= */
const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’‘]/g, "'")
    .toLowerCase()
    .trim();

const nbr = (n: number) => n.toLocaleString('fr-FR').replace(/[\u202f\u00a0]/g, ' ');

/**
 * Dernier filet de sécurité sur la réponse envoyée au client :
 * - espaces fines / insécables (rendues presque invisibles par certaines polices) → espace normale
 * - mots collés aux nombres (« tarif1500Ar/kg », « restantes4978 ») → espaces rétablies
 * - grands nombres suivis d'une unité → « 1 500 Ar »
 */
function polish(text: string): string {
  return text
    .replace(/[\u202f\u00a0\u2009\u2007]/g, ' ')
    .replace(/([A-Za-zÀ-ÿ]{2,})(\d)/g, '$1 $2')
    .replace(/(\d)(Ar|kg|[A-Za-zÀ-ÿ]{3,})/g, '$1 $2')
    .replace(/\b(\d{4,9})(?= (?:Ar|kg|tonnes?|places?)\b)/g, (n) => nbr(Number(n)))
    .replace(/([.!?])(?=[A-ZÀ-ÝÉÈÊ])/g, '$1 ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* =========================================================
   Ancrage dans la base : tout fait cité doit venir de Neon (ou avoir été dit dans la conversation)
========================================================= */
const compact = (s: string) => norm(s).replace(/[^a-z0-9]/g, '');
const MONTHS_NORM = ['janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre'];

/** Clés « jour/mois » des dates écrites dans un texte (AAAA-MM-JJ, JJ/MM/AAAA, « 15 novembre »). */
function dateKeys(text: string): Set<string> {
  const keys = new Set<string>();
  const t = norm(text);
  for (const m of t.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) keys.add(`${Number(m[3])}/${Number(m[2])}`);
  for (const m of t.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b/g)) keys.add(`${Number(m[1])}/${Number(m[2])}`);
  for (const m of t.matchAll(/\b(\d{1,2})(?:er)?\s+(janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre)\b/g)) {
    keys.add(`${Number(m[1])}/${MONTHS_NORM.indexOf(m[2]) + 1}`);
  }
  return keys;
}

/** Heures écrites dans un texte (08:00, 08h, 8 h 30) sous la forme « h:m ». */
function timeKeys(text: string): Set<string> {
  const keys = new Set<string>();
  for (const m of text.matchAll(/\b(\d{1,2})\s?(?:h|:)\s?(\d{2})?\b/gi)) {
    keys.add(`${Number(m[1])}:${Number(m[2] ?? 0)}`);
  }
  return keys;
}

/** Nombres (chiffres seuls) présents dans un texte, avec ou sans espaces de milliers. */
function numberSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\d[\d\u202f\u00a0 ]*\d|\d/g)) out.add(m[0].replace(/\D/g, ''));
  for (const m of text.matchAll(/\d+/g)) out.add(m[0]);
  return out;
}

/**
 * Éléments d'une réponse qui ne figurent ni dans la base lue ni dans la conversation :
 * dates, heures, montants / places / tonnes, nom de navire. Liste vide = réponse ancrée.
 */
function ungrounded(reply: string, evidence: string): string[] {
  const allowed = `${evidence}\n${todayIso()}`;
  const okDates = dateKeys(allowed);
  const okTimes = timeKeys(allowed);
  const okNums = numberSet(allowed);
  const okText = compact(allowed);
  const bad = new Set<string>();

  for (const k of dateKeys(reply)) if (!okDates.has(k)) bad.add(`la date ${k}`);
  for (const k of timeKeys(reply)) if (!okTimes.has(k)) bad.add(`l'heure ${k.replace(':', ' h ')}`);

  const numAfter = /(\d[\d\u202f\u00a0 ]*\d)\s?(Ar|places?|tonnes?)\b/gi;
  const numBefore = /(?:restantes?|restent|reste|capacit[eé]|tarif|prix)\s*(?:de|:)?\s*(\d[\d\u202f\u00a0 ]*\d)/gi;
  for (const re of [numAfter, numBefore]) {
    for (const m of reply.matchAll(re)) {
      const digits = m[1].replace(/\D/g, '');
      if (digits.length >= 2 && !okNums.has(digits)) bad.add(`le nombre ${m[1].trim()}`);
    }
  }

  // Noms de navire écrits avec une majuscule (« navire Arcanum », « bateau Joy »)
  for (const m of reply.matchAll(/\b(?:navire|bateau)\s+\*{0,2}([A-ZÀ-Ý][A-Za-zÀ-ÿ0-9-]+)/g)) {
    if (!okText.includes(compact(m[1]))) bad.add(`le navire ${m[1]}`);
  }
  return [...bad];
}

/* =========================================================
   Compréhension du tour : le code aide le modèle à raisonner comme une personne
========================================================= */
const REFUSAL_RE = /^(non|nan|non merci|pas du tout|pas maintenant|laisse tomber|no|nope|tsia|tsy mila)[\s.!]*$/;
const YES_RE = /^(oui|ouais|yes|eny|ok|okay|d'accord|daccord|volontiers|bien sur|pourquoi pas)[\s.!]*$/;
const THANKS_RE = /^(merci|ok merci|merci beaucoup|misaotra|misaotra betsaka|thanks|thank you|super|parfait)[\s.!]*$/;
const WHY_RE = /^(pourq\w*|pourquoi\s*\??|why\??|nahoana\??|ahoana\??)[\s?.!]*$/;
// « que peux-je faire alors ? », « et maintenant ? », « comment faire ? » : le client demande des options
const ADVICE_RE =
  /(que (peux|puis|dois)|que faire|quoi faire|je fais quoi|et alors|^alors\s*\??$|et maintenant|comment faire|inona no azoko atao|inona no atao)/;

const wordSet = (s: string) => new Set(norm(s).split(/[^a-z0-9]+/).filter((w) => w.length > 2));

/** Part de mots communs entre deux textes (0 à 1), pour repérer une réponse répétée. */
function similarity(a: string, b: string): number {
  const A = wordSet(a);
  const B = wordSet(b);
  if (A.size < 6 || B.size < 6) return 0;
  let common = 0;
  for (const w of A) if (B.has(w)) common++;
  return common / Math.min(A.size, B.size);
}

function lastAssistantText(messages: Msg[]): string {
  const m = [...messages].reverse().find((x) => x.role === 'assistant');
  return m ? String(m.content ?? '') : '';
}

/** Consignes propres à ce tour : ce que le message court du client veut dire par rapport à ta dernière réponse. */
function turnHints(lastAssistant: string, current: string, hasPending: boolean): string {
  const hints: string[] = [];
  const t = norm(current);

  if (lastAssistant) {
    hints.push(
      `Ta dernière réponse au client était :\n"""${lastAssistant.slice(0, 600)}"""\nNe la répète pas, ne repropose pas les mêmes options et change ta façon de commencer.`,
    );
  }

  if (REFUSAL_RE.test(t)) {
    hints.push(
      hasPending
        ? "Le client refuse le récapitulatif en cours. N'insiste pas : demande simplement ce qu'il veut changer (date, quantité, trajet) ou s'il préfère abandonner."
        : "Le client REFUSE ta dernière proposition. N'insiste pas et ne la répète pas. Prends acte en quelques mots, sans dramatiser ni t'excuser, puis demande ce qui lui conviendrait mieux : un autre port, une autre date ou une autre marchandise. Ne propose pas une nouvelle ligne au hasard.",
    );
  } else if (WHY_RE.test(t)) {
    hints.push(
      "Le client demande POURQUOI : explique ta dernière réponse avec les faits déjà obtenus (sans refaire d'appel inutile) et reste cohérent avec ce que tu as dit.",
    );
  } else if (ADVICE_RE.test(t)) {
    hints.push(
      "Le client demande QUOI FAIRE maintenant. Ne répète PAS le constat que tu as déjà fait (par exemple l'absence de départ) : il le sait. Réponds comme un conseiller, en une ou deux phrases naturelles : donne les vraies possibilités (essayer un autre port de départ ou d'arrivée parmi ceux qui ont des départs, choisir une autre date, ou revenir plus tard), puis demande laquelle l'intéresse. Si tu as besoin de savoir quels ports ont des départs, appelle prochains_voyages. N'énumère pas des lignes sans rapport avec sa demande.",
    );
  } else if (THANKS_RE.test(t)) {
    hints.push('Le client te remercie ou clôt l’échange : réponds en une courte phrase chaleureuse, sans relancer.');
  } else if (YES_RE.test(t)) {
    hints.push(
      "Si ta dernière réponse contenait une question ou une proposition, le client l'ACCEPTE : avance à l'étape suivante (demande seulement l'information qui manque encore pour la réservation). Si ta dernière question offrait un CHOIX entre plusieurs options (« ou »), un simple « oui » ne choisit rien : demande-lui laquelle il prend, en nommant clairement les options. Sinon, c'est un simple accusé de réception.",
    );
  }
  return hints.join('\n\n');
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

function buildSystemPrompt(
  ctx: Ctx,
  places: string[],
  documents: string,
  boatsData = '',
  firstName: string | null = null,
  hints = '',
  tripsData = '',
): string {
  const p = ctx.conv.pending;
  const pendingText = p
    ? `\nRÉSERVATION EN ATTENTE DE CONFIRMATION (déjà préparée) : ${p.quantite} ${p.unite ?? 'unité(s)'} de ${p.marchandise}, ${p.poidsTotalKg} kg, ${p.depart} → ${p.arrivee}, le ${p.date}${p.prix ? `, ${p.prix} Ar` : ''}. ${p.paymentMethod ? `Mode de paiement choisi : ${PAYMENT_LABEL[p.paymentMethod]}.` : 'Mode de paiement NON choisi : demande-le au client (Caisse, Banque ou Crédit).'} Le client doit cliquer sur « Confirmer » seulement une fois le mode de paiement choisi. Si le client change un élément, appelle de nouveau preparer_reservation.`
    : '';

  const boatsText = boatsData
    ? `DONNÉES BATEAUX (lues dans la base, seule source de vérité) :\n${boatsData}\nPour toute question sur les bateaux, réponds uniquement avec ces données. Un bateau est disponible seulement si son état est « Disponible » ; « En maintenance », « Hors service » et « Désarmé » ne le sont pas. Ne dis « aucun bateau » que si cette liste est vide.\n\n`
    : '';

  const clientText = firstName
    ? `\nLe client s'appelle ${firstName}. Utilise son prénom rarement : une fois à l'accueil, éventuellement au remerciement final, jamais dans deux réponses de suite.`
    : '';

  const tripsText = tripsData
    ? `DONNÉES VOYAGES (lues dans la base Neon à l'instant, seule source de vérité) :\n${tripsData}\nPour toute question sur les voyages, départs, dates, tarifs ou places, réponds uniquement avec ces données (ou le résultat d'un outil). Ne cite jamais un voyage, une date, une heure, un tarif ou un nombre de places qui n'y figure pas. Si ces données ne contiennent rien sur la demande, dis-le simplement.\n\n`
    : '';

  const hintsText = hints ? `\n\nCONSIGNES POUR CE TOUR\n${hints}` : '';

  return `Tu es l'assistant de Saint-Jude, entreprise de transport maritime à Madagascar. Tu parles comme un conseiller de comptoir aimable, qui connaît bien son métier : naturel, simple, posé. Tu aides les clients à consulter les voyages, les tarifs et les bateaux, et à préparer des réservations de marchandises. Si on te demande si tu es un humain, réponds simplement que tu es l'assistant virtuel de Saint-Jude.

DATE : aujourd'hui nous sommes le ${todayLong()} (${todayIso()}), fuseau de Madagascar.
PORTS CONNUS : ${places.join(', ') || 'aucun'}.${clientText}

RAISONNER COMME UNE PERSONNE (avant chaque réponse, réfléchis à ces points)
1. Que veut vraiment le client ? Relis ses derniers messages. Une réponse courte (« non », « oui », « ok », « pourquoi ») répond à TA dernière question ou proposition : elle l'accepte, la refuse ou demande une explication.
2. Qu'est-ce que je sais déjà ? Ce que le client a déjà dit (marchandise, ports, poids, date) ne se redemande jamais.
3. Qu'est-ce que je ne sais pas ? Ne suppose jamais une date : si le client n'en a pas donné, ne parle pas de « aujourd'hui » et ne dis pas « aucun départ aujourd'hui ». Appelle prochains_voyages sur son trajet pour voir tous les départs à venir.
4. Mon alternative a-t-elle un lien avec sa demande ? Une alternative utile garde le même port de départ ou le même port d'arrivée. Si le résultat de l'outil indique qu'il n'y a aucun départ sur le trajet demandé et que seules d'AUTRES lignes existent, dis-le honnêtement : ce n'est pas le trajet demandé. Ne la présente pas comme une solution et demande plutôt si le client peut changer de port, de date ou de marchandise.
5. Suis-je cohérent ? Ne te contredis pas : si tu as dit qu'il n'y a pas de départ, n'affirme pas l'inverse sans nouvelle donnée. Ne repropose jamais une option que le client vient de refuser.
6. Est-ce que ça vient des outils ? Tout chiffre, date, nom de bateau ou tarif vient d'un outil. Sinon, tu ne le dis pas.
7. Ai-je déjà dit cette information ? Si oui, ne la répète pas : le client la connaît. Va directement à ce qui l'aide maintenant. Quand il demande « que faire alors ? », il veut des pistes concrètes, pas un rappel du problème.

TON ET FAÇON DE PARLER
- Parle comme à un client au guichet : phrases courtes, mots simples, vouvoiement, chaleureux sans excès. Pas de ton administratif, pas de « N'hésitez pas à… », pas de « Je suis là pour vous aider ».
- Réponds d'abord à ce que le client demande, puis, seulement si c'est nécessaire, pose UNE question. Une réponse sans question est parfaitement normale.
- Varie tes débuts de phrase et ta longueur : parfois une seule phrase, parfois deux. Ne commence jamais deux réponses de suite par le même mot (« Très bien », « D'accord », « Je comprends »…) et évite le schéma « constat + alternative + question » à chaque message.
- N'exprime de l'empathie (« c'est embêtant ») que si le client montre une vraie gêne, une déception ou de l'impatience. Un simple « non » n'est pas une gêne.
- Quand c'est impossible (pas de voyage, bateau indisponible), dis-le franchement, explique en quelques mots pourquoi, puis propose une alternative concrète tirée des données si elle a un lien avec la demande (voir point 4).
- Messages courts ou avec des fautes (« pourq », « bato », « combient ») : devine le sens le plus probable à partir de la conversation. Si le sens reste vraiment incertain, demande gentiment de préciser.
- Comportements attendus, à exprimer avec tes propres mots à chaque fois (ne recopie jamais une phrase d'un message précédent) : une salutation → tu salues brièvement et tu demandes ce que le client veut envoyer ; un remerciement → une courte phrase aimable ; un reproche sur le prix → tu expliques que le tarif dépend du poids et du trajet et tu proposes de comparer une autre date.
- Pas d'emoji, sauf si le client en utilise.

LANGUE ET MISE EN FORME
- Réponds dans la langue du client (français, malgache ou anglais). Si le message est mélangé, prends la langue dominante.
- 1 à 3 phrases courtes. Pour énumérer des bateaux, des voyages ou des réservations : une liste avec « - », un élément par ligne, le nom en **gras**, puis le détail, par exemple « - **Arcanum** : 5 000 tonnes, Disponible ».
- Écris toujours des espaces normales entre les mots et les nombres : « un tarif de 1 500 Ar/kg », « il reste 4 978 places ». Jamais « tarif1500Ar/kg » ni « restantes4978 ».
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
- Aucun prix, horaire, disponibilité, nombre de places ou nom de bateau sans avoir appelé l'outil correspondant (ou sans l'avoir lu dans les DONNÉES BATEAUX ou DONNÉES VOYAGES ci-dessous). N'invente jamais un chiffre.
- Chaque date, heure, tarif, nombre de places ou nom de navire de ta réponse doit venir de la base (DONNÉES ou outil) ou avoir été dit par le client. Sinon, ne l'écris pas. N'écris jamais d'exemple fictif (« par exemple le 15 novembre »).
- Tu ne connais que ce que la base contient. Si une information n'y est pas, dis simplement que tu ne la trouves pas, sans l'inventer.
- Pour lister_bateaux, n'utilise PAS le paramètre etat : appelle l'outil sans argument, puis lis l'état de chaque bateau dans le résultat.
- Avant de proposer une réservation, vérifie le trajet avec verifier_trajet ou preparer_reservation. Si le trajet n'existe pas à cette date, appelle prochains_voyages pour proposer de vrais départs.
- Tu ne peux PAS enregistrer une réservation. preparer_reservation crée seulement un récapitulatif ; le client doit cliquer sur le bouton « Confirmer ». Ne dis JAMAIS qu'une réservation est enregistrée, et ne prétends jamais l'avoir annulée.
- Tu ne gères que le transport de marchandises. Pour un billet passager, explique poliment que ce n'est pas encore possible par le chat.
- Si un outil renvoie une erreur ou aucun résultat, dis-le honnêtement et propose une alternative (autre date, autre trajet).
- Si la question n'a aucun rapport avec le transport maritime, dis-le poliment et brièvement.${pendingText}${hintsText}

${boatsText}${tripsText}Contexte documentaire (à utiliser seulement s'il est pertinent) :
${documents || 'Aucun document pertinent.'}`;
}

/* =========================================================
   Voyages à venir (lus dans Neon) : outil prochains_voyages et réponse de secours
========================================================= */
const likeParam = (s: string) => `%${s.trim().toLowerCase().replace(/[\\%_]/g, '\\$&')}%`;
const frDate = (iso: string) => iso.split('-').reverse().join('/');

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
        "Liste les prochains départs réels (date, heure, navire, tarif, places restantes), éventuellement entre deux ports. À appeler quand le client demande les voyages à venir, quand il n'a donné aucune date, ou quand aucun voyage n'existe à la date demandée. Si le trajet n'a aucun départ, le résultat indique les départs qui ont un lien avec la demande (même port de départ ou même port d'arrivée) ou, à défaut, d'autres lignes sans lien.",
      parameters: {
        type: 'object',
        properties: {
          depart: { type: ['string', 'null'], description: 'port de départ (facultatif)' },
          arrivee: { type: ['string', 'null'], description: "port d'arrivée (facultatif)" },
          limite: { type: ['integer', 'null'], description: 'nombre maximal de voyages (5 par défaut)' },
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
          quantite: { type: ['integer', 'null'], description: 'nombre de colis / sacs / places' },
          poids_total_kg: { type: ['number', 'null'], description: 'poids TOTAL en kg' },
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
          poids_total_kg: { type: ['number', 'null'], description: 'poids TOTAL en kg' },
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

/** Ports qui ont au moins un départ à venir (pour aider le client à choisir un autre port). */
async function upcomingPorts(): Promise<{ depart: string[]; arrivee: string[] }> {
  const { rows } = await pool.query(
    `SELECT DISTINCT t."from" AS dep, t."to" AS dest
       FROM trips t
       LEFT JOIN boats b ON t."boatId" = b.id
      WHERE t.depart::date >= $1::date
        AND UPPER(COALESCE(t.status, '')) NOT LIKE 'ANNUL%'
        AND ${BOAT_USABLE}
      LIMIT 50`,
    [todayIso()],
  );
  const dep = [...new Set(rows.map((r: Record<string, any>) => String(r.dep)))];
  const arr = [...new Set(rows.map((r: Record<string, any>) => String(r.dest)))];
  return { depart: dep, arrivee: arr };
}

/** Départs à venir avec un lien logique avec la demande : exact, puis même départ, puis même arrivée, puis les ports actifs. */
async function tripsWithContext(depart: string | undefined, arrivee: string | undefined, limite: number) {
  const exact = await upcomingTrips({ depart, arrivee, limit: limite });
  if (exact.length) return { lien: 'trajet demandé', voyages: exact };

  const result: Record<string, unknown> = {
    voyages: [],
    message: 'Aucun départ à venir sur le trajet demandé.',
  };

  let related = false;
  if (depart && arrivee) {
    const sameFrom = await upcomingTrips({ depart, limit: 3 });
    if (sameFrom.length) {
      result.meme_port_de_depart = sameFrom;
      related = true;
    }
    const sameTo = await upcomingTrips({ arrivee, limit: 3 });
    if (sameTo.length) {
      result.meme_port_d_arrivee = sameTo;
      related = true;
    }
  }

  if (!related) {
    const ports = await upcomingPorts();
    if (ports.depart.length) result.ports_avec_departs_a_venir = ports.depart;
    if (ports.arrivee.length) result.ports_avec_arrivees_a_venir = ports.arrivee;
  }

  result.consigne = related
    ? "Si tu as déjà annoncé dans la conversation qu'il n'y a pas de départ sur ce trajet, ne le répète pas. Propose UNE option liée à la demande (même port de départ ou même port d'arrivée) et demande si elle convient."
    : "Il n'y a aucun départ sur ce trajet et aucune ligne liée à la demande. Si tu l'as déjà dit dans la conversation, ne le répète pas. Ne cite aucune ligne précise. Pour aider, tu peux seulement nommer les ports qui ont des départs à venir (ports_avec_departs_a_venir) afin que le client choisisse un autre port, ou lui suggérer une autre date. Ne promets ni de programmer un voyage ni de le prévenir.";
  return result;
}

/**
 * Reconstitue le trajet en cours en relisant les messages du client, du plus ancien au plus récent.
 * Un message qui cite deux ports fixe départ ET arrivée ; un message qui n'en cite qu'un
 * (« oui toliara ») remplace le départ et garde l'arrivée déjà connue.
 */
function currentRoute(userMessages: string[], places: string[]): { depart?: string; arrivee?: string } {
  let depart: string | undefined;
  let arrivee: string | undefined;
  for (const m of userMessages) {
    const t = norm(m);
    const found = places
      .map((p) => ({ p, i: t.indexOf(norm(p)) }))
      .filter((x) => x.i >= 0)
      .sort((x, y) => x.i - y.i)
      .map((x) => x.p);
    if (found.length >= 2) {
      depart = found[0];
      arrivee = found[1];
    } else if (found.length === 1) {
      depart = found[0];
    }
  }
  return { depart, arrivee };
}

/**
 * Voyages lus dans Neon pour le trajet en cours de la conversation.
 * Injectés dans le prompt : le modèle répond avec des données réelles, pas de mémoire.
 */
async function tripsContext(userMessages: string[], places: string[]): Promise<string> {
  const current = userMessages[userMessages.length - 1] ?? '';
  const route = currentRoute(userMessages, places);

  const asked =
    Boolean(route.depart || route.arrivee) ||
    /(voyage|trajet|depart|prochain|date|prix|tarif|ligne|que peux|que faire|alors)/.test(norm(current));
  if (!asked) return '';

  try {
    const data = await tripsWithContext(route.depart, route.arrivee, 5);
    return JSON.stringify(data).slice(0, 3500);
  } catch (e) {
    console.error('[agent] lecture voyages :', safeError(e));
    return '';
  }
}

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
    return tripsWithContext(depart, arrivee, limite);
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
          conseil: 'Appelle prochains_voyages (avec les deux ports) pour proposer de vrais départs au client.',
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
      conseil: 'Appelle prochains_voyages (avec les deux ports) pour proposer de vrais départs au client.',
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
  if (!rows.length) return 'Je ne vois aucun bateau enregistré pour le moment.';
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
        note = mentioned.length
          ? ' Je ne vois aucun départ à venir sur ce trajet. Voici les prochains départs sur nos autres lignes :'
          : '';
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

/** Réponse de repli quand le modèle cite un fait absent de la base : uniquement des données réelles. */
async function groundedFallback(message: string, places: string[], boatRows: BoatRow[] | null): Promise<string> {
  const text = await fallbackReply(message, places, false, boatRows);
  if (/^Je n'arrive pas à (traiter|vous répondre à l'instant)/.test(text)) {
    return "Je préfère ne pas vous donner une information que je ne trouve pas dans notre base. Pouvez-vous me préciser le trajet ou la date qui vous intéresse ?";
  }
  return text
    .replace(/^Je n'arrive pas à vous répondre en détail à l'instant\.\s*/, '')
    .replace(/\n\nRéessayez dans un instant pour préciser votre demande\.$/, '')
    .trim();
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

/**
 * Un appel au modèle. llm.ts réessaie déjà certaines erreurs ; on réessaie ici une fois :
 * - les coupures réseau et les délais dépassés (attente de 1,5 s) ;
 * - les erreurs 429 de Groq (limite de tokens par minute) : on attend le délai indiqué par Groq.
 */
async function chatWithRetry(turn: Msg[], defs: ChatTools, opts: ChatOptions) {
  const MAX_TRIES = 3;
  for (let attempt = 1; ; attempt++) {
    try {
      return await chat(turn, defs, opts);
    } catch (e) {
      const msg = safeError(e);
      const isTimeout = /timeout|timed out|abort|fetch failed|ECONN|socket/i.test(msg);
      const is429 = /429|rate limit/i.test(msg);
      const isBadToolCall = /tool call validation failed|tool_use_failed/i.test(msg);
      if ((!isTimeout && !is429 && !isBadToolCall) || attempt >= MAX_TRIES) throw e;

      let wait = 1500;
      if (is429) {
        // Groq indique le délai en secondes (« 8.79s ») ou en millisecondes (« 877.5ms »)
        const m = msg.match(/try again in ([\d.]+)\s?(ms|s)\b/i);
        wait = m ? Math.ceil(Number(m[1]) * (m[2].toLowerCase() === 'ms' ? 1 : 1000)) + 500 : 8000;
        if (wait > 30000) throw e; // attente trop longue : le secours répondra
      }
      console.warn(`[agent] LLM : nouvelle tentative ${attempt}/${MAX_TRIES - 1} dans ${wait} ms`);
      await sleep(wait);
    }
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
    const direct = polish(boatsReply(boatRows, input.message));
    conv.messages.push({ role: 'assistant', content: direct });
    await saveConv(conv);
    console.log(JSON.stringify({ ai: 'direct', conv: conv.id, boats: boatRows.length }));
    return { conversationId: conv.id, reply: direct, pending: publicPending(conv.pending) };
  }

  // Voyages lus directement dans Neon (trajet en cours de la conversation) : jamais de mémoire du modèle
  const userTexts = conv.messages.filter((m) => m.role === 'user').slice(-12).map((m) => String(m.content ?? ''));
  const tripsData = await tripsContext(userTexts, places);

  // Preuves : tout ce que la réponse a le droit de citer (base lue, résultats d'outils, conversation)
  const evidence: string[] = [places.join(' '), boatsData, tripsData, JSON.stringify(conv.pending ?? {})];
  const evidenceText = () => `${evidence.join('\n')}\n${conv.messages.map((m) => String(m.content ?? '')).join('\n')}`;

  const availableTools = [...toolDefs.filter((d) => relevant.has(d.function.name)), ...reservationToolDefs];

  // Consignes de ce tour : que veut dire un « non » ou un « pourquoi » par rapport à ma dernière réponse
  const lastAssistant = lastAssistantText(conv.messages);
  const hints = turnHints(lastAssistant, input.message, Boolean(conv.pending));

  // Les échanges d'outils vivent seulement dans ce tour ; l'historique stocké reste du texte propre.
  const turn: Msg[] = [
    { role: 'system', content: buildSystemPrompt(ctx, places, docText, boatsData, firstName, hints, tripsData) },
    ...trim(conv.messages, MAX_HISTORY),
  ];

  const t0 = Date.now();
  const used: string[] = [];
  let reply = '';
  let degraded = false;
  let emptyRetried = false;
  let opts: ChatOptions = { ...CHAT_OPTS };

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const out = await chatWithRetry(turn, availableTools, opts);

      if (!out.tool_calls?.length) {
        const text = (out.content || '').trim();
        // Réponse vide (le raisonnement a consommé tous les tokens) : une nouvelle tentative avec plus de marge
        if (!text && !emptyRetried) {
          emptyRetried = true;
          opts = { ...opts, maxTokens: (opts.maxTokens ?? 350) * 2 };
          continue;
        }
        reply = text;
        break;
      }

      turn.push(out);
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
        evidence.push(JSON.stringify(result));
        turn.push({ role: 'tool', tool_name: name, content: JSON.stringify(result).slice(0, 4000) });
      }
    }
  } catch (e) {
    console.error('[agent] LLM :', safeError(e));
    degraded = true;
    reply = await fallbackReply(input.message, places, Boolean(conv.pending), boatRows);
  }

  // Anti-répétition : si la réponse ressemble trop à la précédente, on demande une autre approche
  // Désactivée par défaut : chaque relance coûte un appel complet (~3 500 tokens) sur un quota de 8 000/min.
  // Pour la réactiver : variable d'environnement AI_ANTI_REPEAT=1.
  if (process.env.AI_ANTI_REPEAT === '1' && !degraded && reply && lastAssistant && similarity(reply, lastAssistant) > 0.7) {
    try {
      turn.push({ role: 'assistant', content: reply });
      turn.push({
        role: 'user',
        content:
          "[Consigne interne] Ta réponse ressemble trop à la précédente. Réécris-la autrement : n'écris pas les mêmes options, ne reprends pas la même ouverture, ne pose pas la même question. Si le client a refusé ta proposition, demande ce qu'il préfère. Réponds uniquement par le nouveau message pour le client.",
      });
      const again = await chatWithRetry(turn, undefined, { ...CHAT_OPTS, temperature: 0.7 });
      const text = (again.content || '').trim();
      if (!again.tool_calls?.length && text) reply = text;
    } catch (e) {
      console.warn('[agent] anti-répétition ignorée :', safeError(e));
    }
  }

  // Ancrage : toute date, heure, tarif, nombre de places ou navire doit venir de Neon (ou de la conversation)
  if (!degraded && reply) {
    let bad = ungrounded(reply, evidenceText());
    if (bad.length) {
      console.warn('[agent] réponse non ancrée dans la base :', bad.join(', '));
      try {
        turn.push({ role: 'assistant', content: reply });
        turn.push({
          role: 'user',
          content: `[Consigne interne] Ces éléments de ta réponse ne viennent pas de la base de données : ${bad.join(', ')}. Réécris ta réponse sans eux : n'utilise que les DONNÉES VOYAGES, les DONNÉES BATEAUX ou ce que le client a dit. Si tu n'as pas l'information, dis simplement que tu ne la trouves pas dans la base. Réponds uniquement par le nouveau message pour le client.`,
        });
        const again = await chatWithRetry(turn, undefined, { ...CHAT_OPTS, temperature: 0.3 });
        const text = (again.content || '').trim();
        if (!again.tool_calls?.length && text) {
          reply = text;
          bad = ungrounded(reply, evidenceText());
        }
      } catch (e) {
        console.warn('[agent] correction ancrage ignorée :', safeError(e));
      }
      // Toujours pas ancrée : réponse construite par le code à partir de Neon uniquement
      if (bad.length) reply = await groundedFallback(input.message, places, boatRows);
    }
  }

  if (!reply) reply = "Je n'ai pas pu terminer la demande. Pouvez-vous la reformuler ?";

  if (!degraded) {
    // Garde-fou : l'IA ne peut jamais annoncer un enregistrement (seule la route /confirm le fait)
    if (/\b(enregistr[ée]e?|r[ée]serv[ée]e?)\b/i.test(reply) && /(c'est fait|a [ée]t[ée]|est bien|ai (bien )?enregistr)/i.test(reply)) {
      reply = conv.pending
        ? 'Votre réservation est prête mais pas encore enregistrée : cliquez sur « Confirmer » pour la valider.'
        : "Rien n'a été enregistré pour le moment. Dites-moi ce que vous souhaitez envoyer.";
    }

    // Garde-fou paiement : tant que le mode n'est pas choisi, le code pose la question lui-même
    if (conv.pending && !conv.pending.paymentMethod) {
      reply = reply.replace(/[^.!?\n]*Confirmer[^.!?\n]*[.!?]?/gi, '').trim();
      reply = `${reply}\n\nComment souhaitez-vous payer : **Caisse**, **Banque** ou **Crédit** ?`.trim();
    }
  }

  reply = polish(reply);

  // Une réponse de secours (panne du modèle) ne doit pas entrer dans l'historique :
  // elle fausserait le contexte et la consigne « ne répète pas ta dernière réponse » du tour suivant.
  if (!degraded) conv.messages.push({ role: 'assistant', content: reply });
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
    if (!reply.tool_calls?.length) return polish(reply.content);

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