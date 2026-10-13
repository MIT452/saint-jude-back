// src/routes/ai.ts
import { Router, type Request, type Response, type NextFunction } from 'express';
import { pool } from '../db.js';

export const aiRouter = Router();

// Marqueur de version : visible dans les logs et dans GET /api/ai/status
// → permet de vérifier que le serveur exécute bien CE fichier.
const BUILD = 'ai-2026-10-13-boats-fix';
console.info(`[IA] ai.ts chargé (build ${BUILD})`);

// Accès base minimal : fonctionne avec `pool` comme avec un client de transaction
type Db = { query: (text: string, values?: any[]) => Promise<{ rows: any[] }> };
const defaultDb = pool as unknown as Db;

/* =========================================================
   Rate limiter : 10 requêtes / minute par IP
   (derrière Render, ajouter app.set('trust proxy', 1) dans server.ts,
    sinon tous les utilisateurs partagent la même IP et la même limite)
========================================================= */
const hits = new Map<string, number[]>();
export function aiRequestLimiter(req: Request, res: Response, next: NextFunction) {
  const now = Date.now();
  const ip = req.ip ?? 'inconnu';
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= 10) {
    return res.status(429).json({ error: 'Trop de requêtes, réessayez dans une minute.' });
  }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) {
    for (const [k, v] of hits) {
      if (!v.some((t) => now - t < 60_000)) hits.delete(k);
    }
  }
  next();
}

/* =========================================================
   Dates (fuseau de Madagascar)
========================================================= */
const TZ = 'Indian/Antananarivo';
const DAY_NAMES = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const MONTH_NAMES = [
  'janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre',
];

const strip = (s: string) =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

const todayLocal = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date()); // YYYY-MM-DD

const addDays = (isoDate: string, n: number) => {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const formatFr = (isoDate: string) =>
  new Date(`${isoDate}T12:00:00Z`).toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

const formatFrShort = (isoDate: string) =>
  new Date(`${isoDate}T12:00:00Z`).toLocaleDateString('fr-FR', {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });

/** Construit YYYY-MM-DD en refusant les dates impossibles (31 février...). */
function buildIso(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/** null si aucune date ; ambiguous = « vendredi » dit un vendredi. */
export function parseRelativeDate(
  text: string,
): { dateStr: string; formatted: string; ambiguous: boolean } | null {
  const t = strip(text);
  const today = todayLocal();
  let target: string | null = null;
  let ambiguous = false;

  // Jour/mois (+ année facultative) → date ; sans année, on prend la prochaine occurrence
  const fromParts = (day: number, month: number, yearStr?: string) => {
    if (yearStr) {
      const y = yearStr.length === 2 ? 2000 + Number(yearStr) : Number(yearStr);
      return buildIso(y, month, day);
    }
    const y = Number(today.slice(0, 4));
    const candidate = buildIso(y, month, day);
    return candidate && candidate < today ? buildIso(y + 1, month, day) : candidate;
  };

  const isoMatch = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoMatch) target = buildIso(+isoMatch[1], +isoMatch[2], +isoMatch[3]);

  if (!target) {
    if (/apres[- ]demain/.test(t)) target = addDays(today, 2);
    else if (/\bdemain\b/.test(t)) target = addDays(today, 1);
    else if (/aujourd/.test(t)) target = today;
  }

  if (!target) {
    const inDays = t.match(/\bdans\s+(\d{1,2})\s+jours?\b/);
    if (inDays) target = addDays(today, +inDays[1]);
  }

  // « 15 octobre », « 12 octobre 2026 »
  if (!target) {
    const textual = t.match(
      new RegExp(`\\b(\\d{1,2})(?:er)?\\s+(${MONTH_NAMES.join('|')})(?:\\s+(\\d{4}))?\\b`),
    );
    if (textual) target = fromParts(+textual[1], MONTH_NAMES.indexOf(textual[2]) + 1, textual[3]);
  }

  // « 12/10/2026 », « 12-10 » (jamais « 10.5 kg » : le point n'est accepté qu'avec l'année)
  if (!target) {
    const numeric =
      t.match(/\b(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?\b(?!\s*(?:kg|kilos?|tonnes?))/) ??
      t.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/);
    if (numeric) target = fromParts(+numeric[1], +numeric[2], numeric[3]);
  }

  if (!target) {
    const m = t.match(new RegExp(`\\b(${DAY_NAMES.join('|')})\\b(\\s+prochain)?`));
    if (m) {
      const todayIdx = new Date(`${today}T12:00:00Z`).getUTCDay();
      let diff = (DAY_NAMES.indexOf(m[1]) - todayIdx + 7) % 7;
      if (diff === 0) {
        diff = 7;
        ambiguous = !m[2];
      }
      target = addDays(today, diff);
    }
  }

  return target ? { dateStr: target, formatted: formatFr(target), ambiguous } : null;
}

/* =========================================================
   Vérification trajets / capacité / tarifs (source de vérité)
========================================================= */
export interface VerifyInput {
  depart: string;
  arrivee: string;
  date: string; // YYYY-MM-DD
  poidsTotalKg?: number;
  quantite?: number; // places / colis : la capacité d'un bateau (boats.capacity) est en places
  passagers?: number;
  tripId?: string; // restreint la vérification à un voyage précis (après verrouillage)
}

export interface VerifyResult {
  available: boolean;
  totalPrice?: number;
  tripId?: string;
  boatName?: string;
  message?: string;
}

// % et _ saisis par l'utilisateur sont échappés : ce ne sont pas des jokers
const likeParam = (s: string) => `%${s.trim().toLowerCase().replace(/[\\%_]/g, '\\$&')}%`;

// Les voyages annulés ne sont jamais proposés
const TRIP_ACTIVE = `UPPER(COALESCE(t.status, '')) NOT LIKE 'ANNUL%'`;

const TRIP_FILTER = `LOWER(t."from") LIKE $1 ESCAPE '\\' AND LOWER(t."to") LIKE $2 ESCAPE '\\' AND ${TRIP_ACTIVE}`;

// reservations."paymentStatus" est un booléen (affiché f / t) : false = non payé
const PAYMENT_STATUS_INIT = false;

// Capacité en PLACES (somme des quantités), comme le garde-fou de server.ts (capacityGuard.ts).
// Les réservations refusées, annulées ou no-show ne consomment pas de place.
const USED_SQL = `COALESCE((SELECT SUM(r.quantity) FROM reservations r
                    WHERE r."tripId" = t.id
                      AND UPPER(COALESCE(r.status, '')) NOT IN
                        ('REFUSEE', 'REFUSÉE', 'ANNULEE', 'ANNULÉE', 'CANCELLED', 'NO_SHOW', 'NO-SHOW')), 0)`;

export async function verifyTrip(i: VerifyInput, db: Db = defaultDb): Promise<VerifyResult> {
  if (i.date < todayLocal()) {
    return { available: false, message: 'La date demandée est déjà passée.' };
  }

  const params = [likeParam(i.depart), likeParam(i.arrivee), i.date];

  const { rows: allRows } = await db.query(
    `SELECT t.id, t."pricePerKg" AS price_per_kg, b.name AS boat_name, b.capacity, ${USED_SQL} AS used
     FROM trips t
     LEFT JOIN boats b ON t."boatId" = b.id
     WHERE ${TRIP_FILTER} AND t.depart::date = $3::date
       AND (b.id IS NULL OR LOWER(COALESCE(b.state, '')) NOT LIKE '%maintenance%')
     ORDER BY t.depart ASC`,
    params,
  );
  const rows = i.tripId ? allRows.filter((r) => String(r.id) === String(i.tripId)) : allRows;

  if (rows.length === 0) {
    const next = await db.query(
      `SELECT to_char(t.depart::date, 'YYYY-MM-DD') AS day
       FROM trips t
       WHERE ${TRIP_FILTER} AND t.depart::date > $3::date
       ORDER BY t.depart ASC LIMIT 1`,
      params,
    );
    return {
      available: false,
      message: next.rows[0]
        ? `Aucun voyage entre ${i.depart} et ${i.arrivee} le ${formatFr(i.date)}. Le prochain départ est le ${formatFr(next.rows[0].day)}.`
        : `Aucun voyage trouvé entre ${i.depart} et ${i.arrivee}.`,
    };
  }

  const needKg = i.poidsTotalKg ?? 0;
  const needQty = i.quantite ?? 0;
  const trip = rows.find(
    (r) => r.capacity == null || Number(r.capacity) - Number(r.used) >= needQty,
  );
  if (!trip) {
    const left = Math.max(0, Number(rows[0].capacity) - Number(rows[0].used));
    return {
      available: false,
      message: `Le navire est complet pour cette date : il reste ${left} place(s) pour ${needQty} demandée(s).`,
    };
  }

  const pricePerKg = Number(trip.price_per_kg);
  if (needKg > 0 && !(pricePerKg > 0)) {
    return { available: false, message: 'Le tarif de ce voyage n’est pas encore défini.' };
  }

  return {
    available: true,
    tripId: trip.id,
    boatName: trip.boat_name ?? undefined,
    totalPrice: needKg > 0 ? needKg * pricePerKg : undefined,
  };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isRealIsoDate = (s: string) =>
  ISO_DATE.test(s) && buildIso(+s.slice(0, 4), +s.slice(5, 7), +s.slice(8, 10)) === s;

function readVerifyBody(body: any): { value: VerifyInput } | { error: string } {
  const depart = typeof body?.depart === 'string' ? body.depart.trim() : '';
  const arrivee = typeof body?.arrivee === 'string' ? body.arrivee.trim() : '';
  const date = typeof body?.date === 'string' ? body.date.trim() : '';
  if (depart.length < 2 || depart.length > 80 || arrivee.length < 2 || arrivee.length > 80) {
    return { error: 'depart et arrivee requis (2 à 80 caractères)' };
  }
  if (!isRealIsoDate(date)) return { error: 'date requise au format AAAA-MM-JJ' };

  let poidsTotalKg: number | undefined;
  if (body?.poidsTotalKg !== undefined && body?.poidsTotalKg !== null) {
    poidsTotalKg = Number(body.poidsTotalKg);
    if (!Number.isFinite(poidsTotalKg) || poidsTotalKg <= 0 || poidsTotalKg > 1_000_000) {
      return { error: 'poidsTotalKg invalide' };
    }
  }
  let passagers: number | undefined;
  if (body?.passagers !== undefined && body?.passagers !== null) {
    passagers = Number(body.passagers);
    if (!Number.isInteger(passagers) || passagers < 1 || passagers > 1000) {
      return { error: 'passagers invalide' };
    }
  }
  let quantite: number | undefined;
  if (body?.quantite !== undefined && body?.quantite !== null) {
    quantite = Number(body.quantite);
    if (!Number.isInteger(quantite) || quantite < 1 || quantite > 100_000) {
      return { error: 'quantite invalide' };
    }
  }
  return { value: { depart, arrivee, date, poidsTotalKg, quantite, passagers } };
}

aiRouter.post('/verify', aiRequestLimiter, async (req: Request, res: Response) => {
  try {
    const parsed = readVerifyBody(req.body);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });
    return res.json(await verifyTrip(parsed.value));
  } catch (error) {
    console.error('Erreur /verify:', error);
    return res.status(500).json({ error: 'Erreur lors de la vérification' });
  }
});

/* =========================================================
   Draft : le contexte vient du navigateur, donc on ne lui fait pas confiance.
   On ne garde que des valeurs simples et validées ; tripId, prix et totaux
   sont toujours recalculés par le serveur.
========================================================= */
interface Draft {
  cargoType?: string;
  unit?: string;
  quantity?: number;
  weightKg?: number;
  weightMode?: 'unit' | 'total';
  unitWeightKg?: number;
  totalWeightKg?: number;
  departure?: string;
  destination?: string;
  dateExact?: string;
  dateFormatted?: string;
  dateToConfirm?: boolean;
  asked?: 'cargoType' | 'destination' | 'departure' | 'quantity' | 'weight' | 'weightMode' | 'date';
  awaitingConfirm?: boolean;
  tripId?: string;
  estimatedPrice?: number;
  boatName?: string;
  confirmedByUser?: boolean;
}

const ASKED_VALUES = ['cargoType', 'destination', 'departure', 'quantity', 'weight', 'weightMode', 'date'];

const cleanStr = (v: unknown, max = 80) =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;

const cleanNum = (v: unknown, max = 1_000_000) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 && n <= max ? n : undefined;
};

function sanitizeDraft(raw: unknown): Draft {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const d: Draft = {};

  d.cargoType = cleanStr(r.cargoType, 60);
  d.unit = cleanStr(r.unit, 20);
  const qty = cleanNum(r.quantity, 100_000);
  if (qty !== undefined && Number.isInteger(qty)) d.quantity = qty;
  d.weightKg = cleanNum(r.weightKg);
  if (r.weightMode === 'unit' || r.weightMode === 'total') d.weightMode = r.weightMode;
  d.departure = cleanStr(r.departure);
  d.destination = cleanStr(r.destination);

  const date = cleanStr(r.dateExact, 10);
  if (date && isRealIsoDate(date)) {
    d.dateExact = date;
    d.dateFormatted = formatFr(date);
  }
  if (typeof r.asked === 'string' && ASKED_VALUES.includes(r.asked)) d.asked = r.asked as Draft['asked'];
  d.awaitingConfirm = r.awaitingConfirm === true;
  d.dateToConfirm = r.dateToConfirm === true;
  return d;
}

const hasDraftContent = (d: Draft) =>
  !!(d.cargoType || d.departure || d.destination || d.quantity || d.weightKg || d.dateExact);

// Signature des données utiles : sert à savoir si le message a apporté une information
const dataSig = (d: Draft) =>
  JSON.stringify([d.cargoType, d.unit, d.quantity, d.weightKg, d.weightMode, d.departure, d.destination, d.dateExact]);

let placesCache = { at: 0, list: [] as string[] };

async function getKnownPlaces(): Promise<string[]> {
  if (placesCache.list.length && Date.now() - placesCache.at < 60_000) {
    return placesCache.list;
  }
  const { rows } = await defaultDb.query(
    `SELECT DISTINCT "from" AS name FROM trips
     UNION
     SELECT DISTINCT "to" AS name FROM trips`,
  );
  const list = rows
    .map((r) => String(r.name ?? '').trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  placesCache = { at: Date.now(), list };
  return list;
}

/* =========================================================
   Extraction déterministe (fallback et compléments)
========================================================= */
const NUM_WORDS: Record<string, number> = {
  un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5,
  six: 6, sept: 7, huit: 8, neuf: 9, dix: 10,
  onze: 11, douze: 12, quinze: 15, vingt: 20, trente: 30,
  cinquante: 50, cent: 100,
};
const NUM_FR = ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix'];
const say = (n: number) => (n >= 0 && n <= 10 ? NUM_FR[n] : String(n));

const UNIT =
  '(?:colis|sacs?|cartons?|caisses?|f[uû]ts?|bidons?|palettes?|paquets?|bo[iî]tes?|bouteilles?|balles?|ballots?|tonneaux?|conteneurs?|valises?|bagages?)';
const END = `(?![\\p{L}\\p{N}'’-])`;
const BOUNDARY =
  '(?:à|a|au|aux|vers|depuis|de|du|pour|le|la|les|l|un|une|et|ou|avec|sans|sur|dans|en|pesant|chacun|chacune|chaque|par|total|poids|kg|kilos?|tonnes?|demain|apr[eè]s|aujourd|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)';
const WORD = `\\p{L}[\\p{L}'’-]*`;
const GOODS = `((?!${BOUNDARY}${END})${WORD}(?:\\s+(?!${BOUNDARY}${END})${WORD}){0,2})`;

function digitize(t: string): string {
  const names = Object.keys(NUM_WORDS)
    .filter((k) => k !== 'un' && k !== 'une')
    .join('|');
  return t
    .replace(new RegExp(`\\b(${names})(?=\\s+[a-zà-ÿ])`, 'gi'), (_m, w: string) =>
      String(NUM_WORDS[w.toLowerCase()]),
    )
    .replace(new RegExp(`\\b(?:un|une)(?=\\s+${UNIT}${END})`, 'giu'), '1');
}

function singular(u: string): string {
  const s = u.toLowerCase();
  if (s === 'colis') return s;
  if (s.endsWith('eaux')) return s.slice(0, -1);
  return s.length > 3 && s.endsWith('s') ? s.slice(0, -1) : s;
}

const pluralize = (u: string, n: number) =>
  n <= 1 || u === 'colis' || /[sx]$/.test(u) ? u : u.endsWith('eau') ? `${u}x` : `${u}s`;

const possessive = (m: string) => (/[sx]$/i.test(m) ? `vos ${m}` : `votre ${m}`);

function extractGoods(textLower: string, places: string[]) {
  const t = digitize(textLower);
  const out: { cargoType?: string; unit?: string; quantity?: number } = {};
  const isPlace = (g: string) => places.some((p) => strip(g).includes(strip(p)));

  const um = t.match(new RegExp(`(?:(\\d+)\\s*)?\\b(${UNIT})${END}`, 'iu'));
  if (um) {
    out.unit = singular(um[2]);
    if (um[1]) out.quantity = parseInt(um[1], 10);
  }

  const a = t.match(
    new RegExp(
      `\\b${UNIT}${END}\\s+(?:de\\s+|d['’]\\s*)(?:(?:la\\s+|le\\s+|les\\s+|l['’]\\s*|des\\s+|du\\s+))?${GOODS}`,
      'iu',
    ),
  );
  if (a && !isPlace(a[1])) out.cargoType = a[1].trim();

  if (!out.cargoType) {
    const b = t.match(
      new RegExp(
        `\\b(?:envoyer|exp[ée]dier|transporter|acheminer)\\s+(?:\\d+\\s*(?:${UNIT}\\s*)?(?:de\\s+\\d+(?:[.,]\\d+)?\\s*(?:kg|kilos?)\\s*(?:chacun|chacune)?\\s*)?)?(?:(?:de\\s+|d['’]\\s*))?(?:(?:du\\s+|de la\\s+|de l['’]\\s*|des\\s+|le\\s+|la\\s+|les\\s+|l['’]\\s*|un\\s+|une\\s+|mon\\s+|ma\\s+|mes\\s+))?${GOODS}`,
        'iu',
      ),
    );
    if (b && !isPlace(b[1]) && !new RegExp(`^${UNIT}${END}`, 'iu').test(b[1])) {
      out.cargoType = b[1].trim();
    }
  }
  return out;
}

function extractRoute(
  text: string,
  places: string[],
  d: Draft,
  expecting?: Draft['asked'],
) {
  const t = strip(text).replace(/’/g, "'");
  const found: Array<{ place: string; index: number; role?: 'departure' | 'destination' }> = [];
  const taken: Array<[number, number]> = [];

  for (const place of places) {
    const key = strip(place).replace(/’/g, "'");
    const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`(?:^|[^\\p{L}\\p{N}])(${esc})(?=$|[^\\p{L}\\p{N}])`, 'u').exec(t);
    if (!m) continue;
    const index = m.index + m[0].length - m[1].length;
    const end = index + key.length;
    if (taken.some(([s, e]) => index < e && end > s)) continue;
    taken.push([index, end]);
    const before = t.slice(0, index).replace(/\s+/g, ' ').trimEnd();
    const role =
      /(?:^|\s)(?:de|depuis)$|(?:^|\s)d'$/.test(before)
        ? 'departure'
        : /(?:^|\s)(?:a|vers|pour|jusqu'a|au)(?:\s+(?:aller|rendre))?$/.test(before)
          ? 'destination'
          : undefined;
    found.push({ place, index, role });
  }

  found.sort((x, y) => x.index - y.index);
  let departure = found.find((f) => f.role === 'departure')?.place;
  let destination = found.find((f) => f.role === 'destination')?.place;

  for (const f of found.filter((x) => !x.role)) {
    if (expecting === 'departure' && !departure) departure = f.place;
    else if (expecting === 'destination' && !destination) destination = f.place;
    else if (!departure && !d.departure) departure = f.place;
    else if (!destination && !d.destination) destination = f.place;
  }
  return { departure, destination };
}

function found1(places: string[], loneNorm: string): string | undefined {
  return places.find(
    (p) => strip(p).replace(/’/g, "'") === loneNorm.replace(/’/g, "'"),
  );
}

const isYes = (t: string) =>
  /^(oui|ok|d'accord|confirme|confirmer|valide|valider)\b/.test(strip(t));
const isNo = (t: string) =>
  /^(non|no|nope|modifier|changer|corriger)\b/.test(strip(t));
const isCancelIntent = (t: string) =>
  /^(annule|annuler|stop|laisse tomber|abandonne|abandonner|abandon)\b/.test(strip(t));
const isRestartIntent = (t: string) =>
  /^(recommence|recommencer|reset|nouvelle demande|autre demande)\b/.test(strip(t));

/** Salutation seule (« bonjour », « bonjours », « salut ! »…) : ce n'est PAS une réponse à la question. */
const isPureGreeting = (t: string) =>
  /^(bonjour|bonjours|bonsoir|salut|coucou|hello|hi|allo|salam)(\s+(a tous|tout le monde|madame|monsieur))?[\s!?.,;]*$/.test(
    strip(t),
  );

/** Bavardage (« tu vas bien ? », « ça va », « merci »…) : pas une réponse à la question en cours. */
const isSmallTalk = (t: string) =>
  /^(tu vas bien|vous allez bien|ca va|ca va bien|comment (ca va|vas[- ]tu|tu vas|allez[- ]vous|vous allez)|merci|merci beaucoup|ok merci|super|cool)[\s!?.,;]*$/.test(
    strip(t),
  );

const looksLikeQuestion = (t: string) =>
  /\?\s*$/.test(t) ||
  /^(combien|quel|quels|quelle|quelles|y a[- ]t[- ]il|est[- ]ce|ou |quand|comment|pourquoi|a quelle|c'est quoi|qu'est|peux[- ]tu|pouvez[- ]vous|donne|liste|affiche|montre|dis[- ]moi|et le|et la|et les)/.test(
    strip(t).replace(/’/g, "'"),
  );

// Une demande de réservation contient ces mots : ce n'est pas une simple question d'information
const RESERVATION_WORDS =
  /\b(reserver|envoyer|expedier|transporter|acheminer|colis|sacs?|cartons?|caisses?|kg|kilos?|tonnes?|passagers?)\b/;
// Tolère les fautes courantes : « bato », « combient », « combiens »
const BOAT_WORDS = /\b(bateaux?|batos?|navires?)\b/;
const COUNT_WORDS = /\b(combien[st]?|nombre)\b/;
// Mots qui, avec « bateau », indiquent une question d'information (« existent », « liste »…)
const BOAT_INFO_WORDS = /liste|exist|dispon|maintenance|capacite|etat|statut/;
const TRIP_WORDS =
  /\b(voyage|voyages|trajet|trajets|depart|departs|horaire|horaires|prochain|prochains|tarif|tarifs|prix|cout|coute)\b/;

/** Mots d'une conversation, jamais d'une marchandise. */
const CHAT_WORDS = new Set([
  'tu', 'vous', 'je', 'moi', 'toi', 'comment', 'pourquoi', 'quoi', 'qui', 'quand', 'ca',
  'va', 'vas', 'vais', 'allez', 'est', 'es', 'suis', 'etes', 'bien', 'merci', 'svp',
]);

const NOT_CARGO = new Set([
  'bonjour', 'bonjours', 'bonsoir', 'salut', 'coucou', 'hello', 'hi', 'allo', 'salam',
  'merci', 'svp', 'ok', 'okay', 'oui', 'non', 'test', 'aide', 'help',
  'transport', 'marchandise', 'marchandises', 'reservation', 'reserver', 'billet', 'colis',
]);

/** Une marchandise plausible : ni salutation, ni oui/non, ni nom de port. */
const isValidCargo = (s: unknown, places: string[]): s is string => {
  if (typeof s !== 'string') return false;
  const k = strip(s).replace(/[^\p{L}\p{N}\s'-]/gu, '').trim();
  if (k.length < 3) return false;
  if (NOT_CARGO.has(k) || isPureGreeting(k) || isSmallTalk(k)) return false;
  if (/\?/.test(s)) return false;
  if (k.split(/\s+/).some((w) => CHAT_WORDS.has(w))) return false;
  if (places.some((p) => strip(p) === k)) return false;
  return true;
};

/** Ramène un nom de port renvoyé par le LLM à un port réellement connu. */
const resolvePlace = (v: unknown, places: string[]): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const k = strip(v);
  if (k.length < 3) return undefined;
  return (
    places.find((p) => strip(p) === k) ??
    places.find((p) => k.includes(strip(p)) || strip(p).includes(k))
  );
};

/** JSON tolérant : accepte du texte ou des ``` autour de l'objet. */
const parseJsonLoose = (raw: string): Record<string, any> => {
  try {
    return JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('Réponse LLM sans JSON');
    return JSON.parse(m[0]);
  }
};

function nextQuestion(d: Draft): { field: NonNullable<Draft['asked']>; text: string } | null {
  const goods = d.cargoType ? possessive(d.cargoType) : 'votre marchandise';
  const sendIt = d.cargoType && /[sx]$/i.test(d.cargoType) ? 'les envoyer' : 'l’envoyer';
  const unit = d.unit ?? 'unité';

  if (!d.cargoType) {
    return { field: 'cargoType', text: 'D’accord ! Quelle marchandise souhaitez-vous envoyer ?' };
  }
  if (!d.destination) {
    return {
      field: 'destination',
      text: `D’accord pour ${goods} ! Vers quelle destination souhaitez-vous ${sendIt} ?`,
    };
  }
  if (!d.departure) {
    return {
      field: 'departure',
      text: `D’accord ! Depuis quel port souhaitez-vous envoyer ${goods} ?`,
    };
  }
  if (!d.quantity) {
    return { field: 'quantity', text: 'Très bien. Quelle quantité souhaitez-vous envoyer ?' };
  }
  if (d.weightKg === undefined) {
    return {
      field: 'weight',
      text:
        d.quantity > 1
          ? `Compris pour ${say(d.quantity)} ${pluralize(unit, d.quantity)}. Connaissez-vous le poids de chaque ${unit} ou le poids total ?`
          : 'Quel est le poids de votre envoi (en kg) ?',
    };
  }
  if (d.quantity > 1 && !d.weightMode) {
    return {
      field: 'weightMode',
      text: `Les ${d.weightKg} kg correspondent-ils au poids de chaque ${unit} ou au poids total des ${d.quantity} ${pluralize(unit, d.quantity)} ?`,
    };
  }
  if (!d.dateExact) {
    const each =
      d.quantity > 1
        ? Math.round(((d.totalWeightKg ?? 0) / d.quantity) * 100) / 100
        : d.totalWeightKg;
    const ack =
      d.quantity > 1
        ? `Compris, ${say(d.quantity)} ${pluralize(unit, d.quantity)} de ${each} kg, soit ${d.totalWeightKg} kg au total.`
        : `Compris, ${d.totalWeightKg} kg.`;
    return {
      field: 'date',
      text: `${ack} Pour quelle date souhaitez-vous organiser le transport ?`,
    };
  }
  return null;
}

function computeTotals(d: Draft) {
  if (d.weightKg === undefined) {
    d.totalWeightKg = undefined;
    d.unitWeightKg = undefined;
    return;
  }
  if (!d.quantity || d.quantity === 1) {
    d.totalWeightKg = d.weightKg;
    d.unitWeightKg = d.weightKg;
  } else if (d.weightMode === 'unit') {
    d.unitWeightKg = d.weightKg;
    d.totalWeightKg = d.weightKg * d.quantity;
  } else if (d.weightMode === 'total') {
    d.totalWeightKg = d.weightKg;
    d.unitWeightKg = Math.round((d.weightKg / d.quantity) * 100) / 100;
  } else {
    d.totalWeightKg = undefined;
    d.unitWeightKg = undefined;
  }
}

/** Rappelle la question en cours après une réponse d'information. */
function withReminder(reply: string, d: Draft): string {
  if (!hasDraftContent(d)) return reply;
  if (d.awaitingConfirm) {
    return `${reply}\n\nVotre réservation attend toujours votre confirmation : souhaitez-vous la confirmer ?`;
  }
  const q = nextQuestion(d);
  return q ? `${reply}\n\nPour poursuivre votre réservation : ${q.text}` : reply;
}

/* =========================================================
   Réponses d'information lues dans PostgreSQL (aucune invention)
========================================================= */
const plural = (n: number, one: string, many: string) => (n > 1 ? many : one);

async function answerBoats(qn: string): Promise<string> {
  const { rows } = await defaultDb.query('SELECT * FROM boats ORDER BY name LIMIT 200');
  const boats = rows.map((b) => ({
    name: String(b.name ?? b.nom ?? 'Sans nom'),
    capacity: b.capacity ?? b.capacite ?? null,
    state: String(b.state ?? b.status ?? b.etat ?? '').trim(),
  }));
  if (boats.length === 0) return 'Aucun bateau n’est enregistré dans la base de données.';

  const wantsAvailable = /dispon/.test(qn);
  const wantsMaintenance = /maintenance|panne|repar/.test(qn);
  const asksCount = COUNT_WORDS.test(qn);
  const keyword = wantsAvailable ? 'dispon' : wantsMaintenance ? 'maintenance' : null;
  const selected = keyword ? boats.filter((b) => strip(b.state).includes(keyword)) : boats;

  const counts = new Map<string, number>();
  for (const b of boats) {
    const k = b.state || 'état non renseigné';
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const breakdown = Array.from(counts.entries())
    .map(([state, n]) => `${state} (${n})`)
    .join(', ');

  const line = (b: (typeof boats)[number]) =>
    `- ${b.name}${b.capacity != null ? ` — capacité : ${b.capacity}` : ''}${b.state ? ` — état : ${b.state}` : ''}`;

  const what = wantsAvailable ? 'disponible' : 'en maintenance';

  if (asksCount) {
    const n = selected.length;
    if (keyword) {
      if (n === 0) {
        return `Aucun bateau n’est indiqué comme ${what}. États enregistrés : ${breakdown}.`;
      }
      return `${n} ${plural(n, 'bateau est indiqué', 'bateaux sont indiqués')} comme ${what}${n > 1 && wantsAvailable ? 's' : ''}.\n${selected.slice(0, 10).map(line).join('\n')}`;
    }
    return `La base de données contient ${boats.length} ${plural(boats.length, 'bateau', 'bateaux')}. États : ${breakdown}.\n${boats.slice(0, 10).map(line).join('\n')}`;
  }

  if (selected.length === 0) {
    return `Aucun bateau ne correspond à ce critère. États enregistrés : ${breakdown}.`;
  }
  return `Voici les bateaux enregistrés${keyword ? ` (${what})` : ''} :\n${selected.slice(0, 20).map(line).join('\n')}`;
}

async function answerTrips(question: string, places: string[]): Promise<string> {
  const route = extractRoute(question, places, {}, undefined);
  const date = parseRelativeDate(question);

  const params: any[] = [];
  const where: string[] = [TRIP_ACTIVE];

  if (date) {
    params.push(date.dateStr);
    where.push(`t.depart::date = $${params.length}::date`);
  } else {
    params.push(todayLocal());
    where.push(`t.depart::date >= $${params.length}::date`);
  }

  if (route.departure && route.destination) {
    params.push(likeParam(route.departure));
    const a = params.length;
    params.push(likeParam(route.destination));
    const b = params.length;
    where.push(`LOWER(t."from") LIKE $${a} ESCAPE '\\' AND LOWER(t."to") LIKE $${b} ESCAPE '\\'`);
  } else if (route.departure || route.destination) {
    params.push(likeParam((route.departure ?? route.destination)!));
    const a = params.length;
    where.push(`(LOWER(t."from") LIKE $${a} ESCAPE '\\' OR LOWER(t."to") LIKE $${a} ESCAPE '\\')`);
  }

  const { rows } = await defaultDb.query(
    `SELECT to_char(t.depart::date, 'YYYY-MM-DD') AS day,
            to_char(t.depart::timestamp, 'HH24:MI') AS hour,
            t."from" AS dep, t."to" AS dest, t."pricePerKg" AS price_per_kg,
            b.name AS boat_name, b.capacity, ${USED_SQL} AS used
     FROM trips t
     LEFT JOIN boats b ON t."boatId" = b.id
     WHERE ${where.join(' AND ')}
     ORDER BY t.depart ASC
     LIMIT 8`,
    params,
  );

  if (rows.length === 0) {
    return date
      ? `Je ne trouve aucun voyage le ${date.formatted} pour cette demande.`
      : 'Je ne trouve aucun voyage à venir pour cette demande.';
  }

  const lines = rows.map((r) => {
    const hour = r.hour && r.hour !== '00:00' ? ` à ${r.hour}` : '';
    const boat = r.boat_name ? ` — navire ${r.boat_name}` : '';
    const price =
      Number(r.price_per_kg) > 0
        ? ` — tarif : ${Number(r.price_per_kg).toLocaleString('fr-FR')} Ar/kg`
        : '';
    const left =
      r.capacity != null
        ? ` — places restantes : ${Math.max(0, Number(r.capacity) - Number(r.used))}`
        : '';
    return `- ${formatFrShort(r.day)}${hour} : ${r.dep} → ${r.dest}${boat}${price}${left}`;
  });

  return `${date ? `Voyages du ${date.formatted}` : 'Prochains voyages'} :\n${lines.join('\n')}`;
}

/* =========================================================
   Colonnes de la table reservations (insertion adaptée au schéma réel)
========================================================= */
let reservationColsCache = { at: 0, cols: new Set<string>() };

async function getReservationColumns(db: Db): Promise<Set<string>> {
  if (reservationColsCache.cols.size && Date.now() - reservationColsCache.at < 600_000) {
    return reservationColsCache.cols;
  }
  const { rows } = await db.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'reservations'`,
  );
  reservationColsCache = { at: Date.now(), cols: new Set(rows.map((r) => String(r.column_name))) };
  return reservationColsCache.cols;
}

/* =========================================================
   LLM Provider (Ollama local / OpenAI ou Groq en prod)
========================================================= */
interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface LLMOptions {
  temperature?: number;
  maxTokens?: number;
  json?: boolean; // true par défaut : sortie JSON (extraction) ; false : texte libre
}

interface LLMProvider {
  readonly name: string;
  readonly model: string;
  chat(messages: ChatMessage[], options?: LLMOptions): Promise<string>;
}

const FETCH_TIMEOUT_MS = 25_000;

class OllamaProvider implements LLMProvider {
  readonly name = 'ollama';
  readonly model = process.env.OLLAMA_MODEL || 'llama3.2';

  async chat(messages: ChatMessage[], options: LLMOptions = {}) {
    // 127.0.0.1 au lieu de localhost (Node résout parfois localhost en IPv6 ::1,
    // alors qu'Ollama écoute seulement en IPv4 → « fetch failed »)
    const res = await fetch(`${process.env.OLLAMA_URL || 'http://127.0.0.1:11434'}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: false,
        ...(options.json === false ? {} : { format: 'json' }),
        options: {
          temperature: options.temperature ?? 0.05,
          num_predict: options.maxTokens ?? 512,
        },
      }),
      signal: AbortSignal.timeout(45_000),
    });

    if (!res.ok) throw new Error(`Ollama ${res.status}`);

    const data = (await res.json()) as { message?: { content?: string } };
    return data.message?.content ?? '';
  }
}

class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';
  readonly model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  constructor(
    private apiKey = process.env.OPENAI_API_KEY!,
    private baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  ) {}

  async chat(messages: ChatMessage[], options: LLMOptions = {}) {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: options.temperature ?? 0.05,
        max_tokens: options.maxTokens ?? 512,
        ...(options.json === false ? {} : { response_format: { type: 'json_object' } }),
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenAI ${res.status}: ${err.slice(0, 300)}`);
    }

    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content ?? '';
  }
}

class GroqProvider implements LLMProvider {
  readonly name = 'groq';
  readonly model = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';

  constructor(private apiKey = process.env.GROQ_API_KEY!) {}

  async chat(messages: ChatMessage[], options: LLMOptions = {}) {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: options.temperature ?? 0.05,
        max_tokens: options.maxTokens ?? 512,
        ...(options.json === false ? {} : { response_format: { type: 'json_object' } }),
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Groq ${res.status}: ${err.slice(0, 300)}`);
    }

    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content ?? '';
  }
}

function createLLMProvider(): LLMProvider {
  const provider = (process.env.AI_PROVIDER || '').toLowerCase();
  const env = process.env.NODE_ENV || 'development';

  if (provider === 'ollama') return new OllamaProvider();
  if (provider === 'groq' && process.env.GROQ_API_KEY) return new GroqProvider();
  if (provider === 'openai' && process.env.OPENAI_API_KEY) return new OpenAIProvider();

  // Fallback intelligent
  if (env === 'development') return new OllamaProvider();
  if (process.env.OPENAI_API_KEY) return new OpenAIProvider();
  if (process.env.GROQ_API_KEY) return new GroqProvider();

  return new OllamaProvider();
}

let providerCache: LLMProvider | null = null;
function getProvider(): LLMProvider {
  if (!providerCache) providerCache = createLLMProvider();
  return providerCache;
}

const safeError = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).replace(/(gsk_|sk-)[A-Za-z0-9_-]+/g, '***').slice(0, 200);

/** Vérifie que le fournisseur IA répond (sans jamais renvoyer la clé). */
aiRouter.get('/status', aiRequestLimiter, async (_req: Request, res: Response) => {
  const provider = getProvider();
  const started = Date.now();
  const keys = {
    groq: Boolean(process.env.GROQ_API_KEY),
    openai: Boolean(process.env.OPENAI_API_KEY),
  };
  try {
    const out = await provider.chat(
      [
        { role: 'system', content: 'Réponds uniquement par le mot OK.' },
        { role: 'user', content: 'Test' },
      ],
      { temperature: 0, maxTokens: 5, json: false },
    );
    return res.json({
      ok: true,
      build: BUILD,
      provider: provider.name,
      model: provider.model,
      latencyMs: Date.now() - started,
      sample: out.trim().slice(0, 20),
      keys,
    });
  } catch (error) {
    return res.status(503).json({
      ok: false,
      build: BUILD,
      provider: provider.name,
      model: provider.model,
      latencyMs: Date.now() - started,
      error: safeError(error),
      keys,
    });
  }
});

const SYSTEM_PROMPT = `Tu es l'assistant de réservation de Saint-Jude (transport maritime Madagascar).
Tu extrais UNIQUEMENT les informations fournies par le client. Tu n'inventes JAMAIS de prix, de disponibilité ou de date.

Réponds UNIQUEMENT en JSON strict :
{
  "cargoType": string | null,
  "unit": string | null,
  "quantity": number | null,
  "weightKg": number | null,
  "weightMode": "unit" | "total" | null,
  "departure": string | null,
  "destination": string | null,
  "dateText": string | null,
  "confidence": number
}

Règles strictes :
- Ne jamais inventer une valeur absente.
- Une salutation (« bonjour », « salut », « merci »…) n'est JAMAIS une marchandise : mets tout à null.
- cargoType = uniquement un produit réel (riz, sacs de ciment, meubles…), jamais « transport » ni « marchandise ».
- Si le client dit seulement un nom de port, place-le selon le contexte (departure ou destination).
- Si le client répond seulement par un nombre, place-le selon la question en cours (quantity ou weightKg).
- Les ports connus sont fournis dynamiquement.
- dateText = texte brut dit par le client ("demain", "vendredi prochain", "15 octobre"...).
`;

const GENERAL_PROMPT = `Tu es l'assistant de Saint-Jude, entreprise de transport maritime (passagers et marchandises) à Madagascar.
Réponds en français, en 1 à 3 phrases courtes, de façon claire et utile.
Tu n'as accès à AUCUNE donnée en temps réel : n'invente jamais de prix, d'horaire, de disponibilité, de numéro de réservation ni de chiffre. Pour ces informations, invite le client à préciser le trajet, la date et la marchandise afin que le système les vérifie, ou à poser une question sur les voyages, les tarifs ou les bateaux.
Si la question n'a aucun rapport avec le transport maritime ou Saint-Jude, dis poliment que tu ne peux aider que pour les réservations et le transport.
N'utilise pas de JSON.`;

async function answerGeneral(question: string, places: string[]): Promise<string | null> {
  try {
    const provider = getProvider();
    const out = await provider.chat(
      [
        {
          role: 'system',
          content: `${GENERAL_PROMPT}\nDate du jour : ${todayLocal()}. Ports connus : ${places.join(', ') || 'aucun'}.`,
        },
        { role: 'user', content: question },
      ],
      { temperature: 0.3, maxTokens: 300, json: false },
    );
    const text = out.trim();
    return text ? text.slice(0, 800) : null;
  } catch (err) {
    console.warn(`[IA] réponse générale indisponible : ${safeError(err)}`);
    return null;
  }
}

/* =========================================================
   Route /chat (hybride : base de données + LLM + déterministe)
========================================================= */
aiRouter.post('/chat', aiRequestLimiter, async (req: Request, res: Response) => {
  try {
    const question = String(req.body?.question ?? '').trim().slice(0, 1000);
    if (!question) {
      return res.status(400).json({ error: 'Question requise' });
    }
    console.info(`[IA] /chat build=${BUILD} question="${question.slice(0, 120)}"`);

    let parsedContext: Record<string, any> = {};
    try {
      const raw = req.body?.context;
      if (raw) parsedContext = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      /* contexte illisible → brouillon vide */
    }

    // Plusieurs noms de clé acceptés ; tout est revalidé par sanitizeDraft
    let draft: Draft = sanitizeDraft(
      parsedContext.currentContext ?? parsedContext.updatedContext ?? parsedContext.draft,
    );
    computeTotals(draft);

    const text = question.toLowerCase();
    const qn = strip(question).replace(/’/g, "'");
    const places = await getKnownPlaces();
    let quoteSummary: Record<string, unknown> | null = null;

    const send = (reply: string, extra: Record<string, unknown> = {}) =>
      res.json({ reply, reponse: reply, updatedContext: draft, quoteSummary, ...extra });

    // ---- A. Annuler / recommencer
    if (isRestartIntent(question)) {
      draft = {};
      const first = nextQuestion(draft)!;
      draft.asked = first.field;
      return send(`D’accord, on repart de zéro. ${first.text}`);
    }
    if (isCancelIntent(question)) {
      if (/reserv/.test(qn) && !hasDraftContent(draft) && !draft.awaitingConfirm) {
        return send(
          'Je ne peux pas annuler une réservation déjà enregistrée depuis ce chat. Ouvrez-la dans la liste des réservations pour demander son annulation.',
        );
      }
      draft = {};
      return send('D’accord, la demande est annulée. Aucune réservation n’a été créée.');
    }

    // ---- B. Confirmation oui/non du récapitulatif
    if (draft.awaitingConfirm && isYes(question)) {
      computeTotals(draft);
      const total = draft.totalWeightKg;

      if (!draft.departure || !draft.destination || !draft.dateExact || !total) {
        draft.awaitingConfirm = false;
        const q = nextQuestion(draft);
        if (q) draft.asked = q.field;
        return send(
          `Il manque des informations pour la réservation. Reprenons : ${q?.text ?? 'pouvez-vous reformuler ?'}`,
        );
      }

      const clientName = String(req.body?.clientName ?? '').trim().slice(0, 100) || 'Client IA';
      // requireAuth place l'utilisateur connecté ici : il devient le propriétaire (userId) de la réservation
      const sessionUser = res.locals.sessionUser as { id?: string } | undefined;
      const client = await pool.connect();
      const tx = client as unknown as Db;

      type Outcome = { ok: true; id: string; price: number } | { ok: false; message: string };
      let outcome: Outcome;
      try {
        await client.query('BEGIN');

        // 1) premier contrôle, puis verrou sur le voyage pour éviter les doubles réservations
        const first = await verifyTrip(
          {
            depart: draft.departure,
            arrivee: draft.destination,
            date: draft.dateExact,
            poidsTotalKg: total,
            quantite: draft.quantity || 1,
          },
          tx,
        );
        if (!first.available || !first.tripId) {
          outcome = { ok: false, message: first.message ?? 'Ce trajet n’est plus disponible.' };
        } else {
          await client.query('SELECT id FROM trips WHERE id = $1 FOR UPDATE', [first.tripId]);

          // 2) revérification sous verrou : la capacité est recalculée à jour
          const check = await verifyTrip(
            {
              depart: draft.departure,
              arrivee: draft.destination,
              date: draft.dateExact,
              poidsTotalKg: total,
              quantite: draft.quantity || 1,
              tripId: first.tripId,
            },
            tx,
          );
          if (!check.available || !check.tripId) {
            outcome = { ok: false, message: check.message ?? 'Ce trajet n’est plus disponible.' };
          } else {
            const price = check.totalPrice ?? 0;
            const cols = await getReservationColumns(tx);

            // Statut 'EN_ATTENTE' (attendu par le front). Le paiement démarre à 0 Ar (Crédit).
            const fields: Array<[string, unknown]> = [
              ['clientName', clientName],
              ['tripId', check.tripId],
              ['quantity', draft.quantity || 1],
              ['weight', total],
              ['totalPrice', price],
              ['status', 'EN_ATTENTE'],
            ];
            if (cols.has('amountPaid')) fields.push(['amountPaid', 0]);
            if (cols.has('amountToPay')) fields.push(['amountToPay', price]);
            // La table reservations n'a pas de "createdAt" : la date est dans la colonne "date"
            if (cols.has('date')) fields.push(['date', new Date().toISOString()]);
            if (cols.has('paymentStatus')) fields.push(['paymentStatus', PAYMENT_STATUS_INIT]);
            if (cols.has('userId') && sessionUser?.id) fields.push(['userId', sessionUser.id]);

            const names = fields.map(([n]) => `"${n}"`).join(', ');
            const slots = fields.map((_f, idx) => `$${idx + 1}`).join(', ');
            const insertRes = await client.query(
              `INSERT INTO reservations (id, ${names})
               VALUES (gen_random_uuid(), ${slots})
               RETURNING id;`,
              fields.map(([, v]) => v),
            );

            // Ligne goods : c'est elle qui alimente la colonne « Marchandise » du tableau des réservations
            const reservationId = String(insertRes.rows[0].id);
            const qty = draft.quantity || 1;
            const itemName = (draft.cargoType ?? 'Marchandise').replace(/^./, (c) => c.toUpperCase());
            await client.query(
              `INSERT INTO goods (id, "itemName", types, "embarkDate", quantity, "unitWeight", "totalWeight",
                                  "unitPrice", "totalPrice", "amountToPay", status, "reservationId", "userId", "tripId")
               VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, FALSE, $10, $11, $12)`,
              [
                itemName,
                draft.unit ?? null,
                draft.dateExact,
                qty,
                Math.round((total / qty) * 100) / 100,
                total,
                Math.round((price / qty) * 100) / 100,
                price,
                price,
                reservationId,
                sessionUser?.id ?? null,
                check.tripId,
              ],
            );

            outcome = { ok: true, id: reservationId, price };
          }
        }

        await client.query(outcome.ok ? 'COMMIT' : 'ROLLBACK');
      } catch (txError) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw txError;
      } finally {
        client.release();
      }

      if (!outcome.ok) {
        draft.awaitingConfirm = false;
        return send(`${outcome.message} Souhaitez-vous une autre date ou un autre trajet ?`);
      }

      draft = {};
      quoteSummary = null;
      return send(
        `Votre réservation a été enregistrée sous le numéro #${outcome.id.slice(0, 8)} avec le statut « En attente ». Montant à payer : ${outcome.price.toLocaleString('fr-FR')} Ar.`,
        { reservationCreated: true, reservationId: outcome.id },
      );
    }

    if (draft.awaitingConfirm && isNo(question)) {
      draft.awaitingConfirm = false;
      return send(
        'D’accord, rien n’est enregistré. Que souhaitez-vous modifier (trajet, date, quantité, poids, marchandise) ? Vous pouvez aussi dire « annuler ».',
      );
    }

    // ---- C. Confirmation date ambiguë
    if (draft.dateToConfirm) {
      if (isYes(question)) {
        draft.dateToConfirm = false;
      } else if (isNo(question) && !parseRelativeDate(question)) {
        draft.dateToConfirm = false;
        delete draft.dateExact;
        delete draft.dateFormatted;
      } else {
        draft.dateToConfirm = false;
      }
    }

    // ---- D. Salutation / bavardage : réponse polie puis question en cours
    if (isPureGreeting(question) || isSmallTalk(question)) {
      const q0 = nextQuestion(draft);
      if (q0) draft.asked = q0.field;
      const rest = q0 ? q0.text.replace(/^(D’accord|Très bien)[^!.]*[!.]\s*/, '') : '';
      const hello = isSmallTalk(question) ? 'Je vais bien, merci !' : 'Bonjour !';
      return send(
        rest
          ? `${hello} Je vous aide à préparer votre réservation. ${rest}`
          : `${hello} Dites-moi ce que vous souhaitez envoyer, vers où et à quelle date.`,
      );
    }

    // ---- E. Questions d'information : réponses lues dans PostgreSQL
    if (!RESERVATION_WORDS.test(qn)) {
      if (
        BOAT_WORDS.test(qn) &&
        (looksLikeQuestion(question) || COUNT_WORDS.test(qn) || BOAT_INFO_WORDS.test(qn))
      ) {
        try {
          return send(withReminder(await answerBoats(qn), draft));
        } catch (err) {
          console.error('[IA] bateaux :', err);
          return send('Je n’ai pas pu consulter la liste des bateaux pour le moment. Réessayez dans un instant.');
        }
      }
      if (TRIP_WORDS.test(qn) && looksLikeQuestion(question)) {
        try {
          return send(withReminder(await answerTrips(question, places), draft));
        } catch (err) {
          console.error('[IA] voyages :', err);
          return send('Je n’ai pas pu consulter les voyages pour le moment. Réessayez dans un instant.');
        }
      }
    }

    // ---- F. Extraction (LLM d’abord, fallback déterministe)
    const before: Draft = { ...draft };
    let dateText: string | null = null;
    let llmOk = false;

    try {
      const llm = getProvider();
      const asked = draft.asked ? `\nLa dernière question posée au client portait sur : ${draft.asked}.` : '';
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content: `${SYSTEM_PROMPT}\nPorts connus : ${places.join(', ')}${asked}`,
        },
        { role: 'user', content: question },
      ];
      const raw = await llm.chat(messages, { temperature: 0.05 });
      const extracted = parseJsonLoose(raw);
      console.info(`[IA] extraction OK (${llm.name}/${llm.model})`);

      // On valide ce que renvoie le LLM au lieu de lui faire confiance
      if (isValidCargo(extracted.cargoType, places)) draft.cargoType = extracted.cargoType.trim();
      if (typeof extracted.unit === 'string' && extracted.unit) draft.unit = singular(extracted.unit);
      const qty = Number(extracted.quantity);
      if (Number.isInteger(qty) && qty > 0 && qty <= 100_000) draft.quantity = qty;
      const wkg = Number(extracted.weightKg);
      if (Number.isFinite(wkg) && wkg > 0 && wkg <= 1_000_000) {
        draft.weightKg = wkg;
        draft.weightMode = undefined;
      }
      if (extracted.weightMode === 'unit' || extracted.weightMode === 'total') {
        draft.weightMode = extracted.weightMode;
      }
      const dep = resolvePlace(extracted.departure, places);
      const dest = resolvePlace(extracted.destination, places);
      if (dep) draft.departure = dep;
      if (dest) draft.destination = dest;

      // Un seul port donné en réponse à la question en cours → on le place selon le contexte
      if (!dep && !dest && (draft.asked === 'departure' || draft.asked === 'destination')) {
        const only = found1(places, strip(text).replace(/[.!?]+$/, ''));
        if (only) {
          if (draft.asked === 'departure') draft.departure = only;
          else draft.destination = only;
        }
      }

      if (typeof extracted.dateText === 'string') dateText = extracted.dateText;
      llmOk = true;
    } catch (err) {
      console.warn(`[IA] LLM indisponible → fallback déterministe : ${safeError(err)}`);
    }

    if (!llmOk) {
      const goods = extractGoods(text, places);
      if (isValidCargo(goods.cargoType, places)) draft.cargoType = goods.cargoType;
      else if (draft.asked === 'cargoType' && !draft.cargoType) {
        const bare = text
          .replace(/[.!?,;]+$/g, '')
          .replace(/^(?:du|de la|de l['’]|des|de|d['’]|un|une|le|la|les)\s*/, '')
          .trim();
        if (
          bare &&
          bare.split(' ').length <= 3 &&
          !/\d/.test(bare) &&
          !isYes(bare) &&
          !isNo(bare) &&
          isValidCargo(bare, places)
        ) {
          draft.cargoType = bare;
        }
      }
      if (goods.unit) draft.unit = goods.unit;
      if (goods.quantity) draft.quantity = goods.quantity;

      const route = extractRoute(
        text,
        places,
        draft,
        draft.asked === 'departure' ? 'departure' : draft.asked === 'destination' ? 'destination' : undefined,
      );
      if (route.departure) draft.departure = route.departure;
      if (route.destination) draft.destination = route.destination;

      const t = digitize(text);
      const w = t.match(/(\d+(?:[.,]\d+)?)\s*(kg|kilos?|tonnes?)/i);
      if (w) {
        const v = parseFloat(w[1].replace(',', '.')) * (/^t/i.test(w[2]) ? 1000 : 1);
        draft.weightKg = v;
        draft.weightMode = undefined;
      }
      if (/\bchacun|\bchacune|\bchaque\b|\bpar\s+\p{L}+/iu.test(t) && (w || draft.asked === 'weightMode')) {
        draft.weightMode = 'unit';
      } else if (/\btotal\b|au total|en tout/i.test(t) && (w || draft.asked === 'weightMode')) {
        draft.weightMode = 'total';
      }

      if (!route.departure && !route.destination && (draft.asked === 'departure' || draft.asked === 'destination')) {
        const only = found1(places, strip(text).replace(/[.!?]+$/, ''));
        if (only) {
          if (draft.asked === 'departure') draft.departure = only;
          else draft.destination = only;
        }
      }
    }

    // Réponse d'un seul nombre à la question en cours (quantité ou poids), quel que soit le chemin
    const lone = qn.replace(/[.!?]+$/, '');
    const loneNum = /^\d{1,6}(?:[.,]\d+)?$/.test(lone)
      ? parseFloat(lone.replace(',', '.'))
      : (NUM_WORDS[lone] as number | undefined);
    if (loneNum !== undefined && loneNum > 0) {
      if (draft.asked === 'quantity' && Number.isInteger(loneNum)) {
        draft.quantity = loneNum;
        draft.weightKg = before.weightKg;
        draft.weightMode = before.weightMode;
      } else if (draft.asked === 'weight') {
        draft.weightKg = loneNum;
        draft.weightMode = undefined;
        draft.quantity = before.quantity;
      }
    }

    // Réponse à « poids de chaque colis ou poids total ? »
    if (draft.asked === 'weightMode' && !draft.weightMode) {
      if (/\b(chaque|chacun|chacune|par\s+[a-z]+|l'unite)\b/.test(qn)) draft.weightMode = 'unit';
      else if (/\b(total|ensemble|en tout)\b/.test(qn)) draft.weightMode = 'total';
    }

    // Date : texte du LLM, sinon message brut
    const dateParsed = parseRelativeDate(dateText ?? '') ?? parseRelativeDate(question);
    if (dateParsed) {
      if (dateParsed.dateStr < todayLocal()) {
        delete draft.dateExact;
        delete draft.dateFormatted;
        draft.asked = 'date';
        return send('La date indiquée est déjà passée. Pour quelle date souhaitez-vous organiser le transport ?');
      }
      draft.dateExact = dateParsed.dateStr;
      draft.dateFormatted = dateParsed.formatted;
      if (dateParsed.ambiguous) {
        draft.dateToConfirm = true;
        draft.asked = 'date';
        return send(
          `Aujourd’hui, c’est déjà ${DAY_NAMES[new Date(`${todayLocal()}T12:00:00Z`).getUTCDay()]}. Parlez-vous de ${dateParsed.formatted} ?`,
        );
      }
    }

    computeTotals(draft);
    const draftChanged = dataSig(before) !== dataSig(draft);

    // ---- G. Aucune information utile et c'est une question → réponse pertinente, sans inventer
    if (!draftChanged && looksLikeQuestion(question)) {
      const answer =
        (await answerGeneral(question, places)) ??
        'Je n’ai pas bien compris votre question. Je peux préparer une réservation, consulter les voyages, les tarifs ou les bateaux.';
      return send(withReminder(answer, draft));
    }

    // Corrections signalées
    const changed: string[] = [];
    if (before.departure && draft.departure !== before.departure) changed.push(`départ : ${draft.departure}`);
    if (before.destination && draft.destination !== before.destination) changed.push(`destination : ${draft.destination}`);
    if (before.dateExact && draft.dateExact !== before.dateExact && draft.dateFormatted) {
      changed.push(`date : ${draft.dateFormatted}`);
    }
    if (before.cargoType && draft.cargoType !== before.cargoType) changed.push(`marchandise : ${draft.cargoType}`);
    if (before.quantity && draft.quantity !== before.quantity) changed.push(`quantité : ${draft.quantity}`);
    const prefix = changed.length ? `C’est corrigé (${changed.join(', ')}). ` : '';

    // ---- H. Une seule question ciblée
    const q = nextQuestion(draft);
    if (q) {
      const misunderstood = !draftChanged && !!draft.asked;
      draft.asked = q.field;
      draft.awaitingConfirm = false;
      const body = misunderstood
        ? `Je n’ai pas bien compris votre réponse. ${q.text.replace(/^(?:D’accord[^!]*!|Très bien\.)\s*/, '')}`
        : `${prefix}${q.text}`;
      return send(body);
    }

    // ---- I. Tout est connu → vérification SQL obligatoire
    draft.asked = undefined;
    const result = await verifyTrip({
      depart: draft.departure!,
      arrivee: draft.destination!,
      date: draft.dateExact!,
      poidsTotalKg: draft.totalWeightKg,
      quantite: draft.quantity || 1,
    });

    let reply: string;
    if (!result.available) {
      reply = `${prefix}${result.message ?? 'Ce trajet n’est pas disponible pour cette demande.'} Souhaitez-vous une autre date ou un autre trajet ?`;
      draft.awaitingConfirm = false;
    } else {
      // tripId, prix et navire sont informatifs ici : ils sont recalculés à la confirmation
      draft.tripId = result.tripId;
      draft.estimatedPrice = result.totalPrice ?? 0;
      draft.boatName = result.boatName;
      draft.awaitingConfirm = true;

      const boat = draft.boatName ? ` sur le navire ${draft.boatName}` : '';
      reply = `${prefix}J'ai vérifié nos disponibilités : un transport est disponible le ${draft.dateFormatted} entre ${draft.departure} et ${draft.destination}${boat}. Pour vos ${draft.totalWeightKg} kg de ${draft.cargoType}, le tarif calculé est de ${(result.totalPrice ?? 0).toLocaleString('fr-FR')} Ar. Souhaitez-vous confirmer cette réservation ?`;

      quoteSummary = {
        departure: draft.departure,
        destination: draft.destination,
        date: draft.dateFormatted,
        cargoDescription: draft.cargoType,
        quantity: draft.quantity,
        unit: draft.unit,
        unitWeightKg: draft.unitWeightKg,
        totalWeightKg: draft.totalWeightKg,
        estimatedPrice: result.totalPrice,
        available: true,
      };
    }

    return send(reply);
  } catch (error) {
    console.error('Erreur IA / Neon:', error);
    return res.status(500).json({ error: 'Erreur lors du traitement de la demande' });
  }
});

export default aiRouter;