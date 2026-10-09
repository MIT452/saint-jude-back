import { Router, type Request, type Response, type NextFunction } from 'express';
import { pool } from '../db.js';

export const aiRouter = Router();

/* =========================================================
   Rate limiter : 10 requêtes / minute par IP
========================================================= */
const hits = new Map<string, number[]>();
export function aiRequestLimiter(req: Request, res: Response, next: NextFunction) {
  const now = Date.now();
  const ip = req.ip ?? 'inconnu';
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= 10) return res.status(429).json({ error: 'Trop de requêtes, réessayez dans une minute.' });
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (!v.some((t) => now - t < 60_000)) hits.delete(k);
  }
  next();
}

/* =========================================================
   Dates (fuseau de Madagascar, pas celui du serveur)
========================================================= */
const TZ = 'Indian/Antananarivo';
const DAY_NAMES = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

const strip = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const todayLocal = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date()); // YYYY-MM-DD
const addDays = (isoDate: string, n: number) => {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const formatFr = (isoDate: string) =>
  new Date(`${isoDate}T12:00:00Z`).toLocaleDateString('fr-FR', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });

/** null si le texte ne contient aucune date ; ambiguous = « vendredi » dit un vendredi. */
export function parseRelativeDate(text: string): { dateStr: string; formatted: string; ambiguous: boolean } | null {
  const t = strip(text);
  const today = todayLocal();
  let target: string | null = null;
  let ambiguous = false;

  const isoMatch = t.match(/\b\d{4}-\d{2}-\d{2}\b/);
  if (isoMatch) target = isoMatch[0];
  else if (/apres[- ]demain/.test(t)) target = addDays(today, 2);
  else if (/\bdemain\b/.test(t)) target = addDays(today, 1);
  else if (/aujourd/.test(t)) target = today;
  else {
    const m = t.match(new RegExp(`\\b(${DAY_NAMES.join('|')})\\b(\\s+prochain)?`));
    if (m) {
      const todayIdx = new Date(`${today}T12:00:00Z`).getUTCDay();
      let diff = (DAY_NAMES.indexOf(m[1]) - todayIdx + 7) % 7;
      if (diff === 0) { diff = 7; ambiguous = !m[2]; }
      target = addDays(today, diff);
    }
  }
  return target ? { dateStr: target, formatted: formatFr(target), ambiguous } : null;
}

/* =========================================================
   Vérification trajets / capacité / tarifs (source de vérité : la base)
========================================================= */
export interface VerifyInput {
  depart: string;
  arrivee: string;
  date: string; // YYYY-MM-DD
  poidsTotalKg?: number;
  passagers?: number;
}
export interface VerifyResult {
  available: boolean;
  totalPrice?: number;
  tripId?: string;
  boatName?: string;
  message?: string;
}

const TRIP_FILTER = `LOWER(t."from") LIKE $1 AND LOWER(t."to") LIKE $2`;

export async function verifyTrip(i: VerifyInput): Promise<VerifyResult> {
  const params = [`%${i.depart.toLowerCase()}%`, `%${i.arrivee.toLowerCase()}%`, i.date];

  const { rows } = await pool.query(
    `SELECT t.id, t.price_per_kg, b.name AS boat_name, b.capacity,
            COALESCE((SELECT SUM(r.weight) FROM reservations r
                      WHERE r."tripId" = t.id
                        AND UPPER(r.status) NOT LIKE 'ANNUL%'
                        AND UPPER(r.status) NOT LIKE 'CANCEL%'), 0) AS used
     FROM trips t
     LEFT JOIN boats b ON t."boatId" = b.id
     WHERE ${TRIP_FILTER} AND t.depart::date = $3::date
     ORDER BY t.depart ASC`,
    params,
  );

  // Aucun voyage ce jour-là → on propose le prochain départ
  if (rows.length === 0) {
    const next = await pool.query(
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

  // Capacité (marchandises uniquement)
  const needKg = i.poidsTotalKg ?? 0;
  const trip = rows.find((r) => r.capacity == null || Number(r.capacity) - Number(r.used) >= needKg);
  if (!trip) {
    const left = Math.max(0, Number(rows[0].capacity) - Number(rows[0].used));
    return {
      available: false,
      message: `Le navire est complet pour cette date : il reste ${left} kg pour ${needKg} kg demandés.`,
    };
  }

  // Tarif : jamais inventé (aucune valeur par défaut)
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

aiRouter.post('/verify', aiRequestLimiter, async (req: Request, res: Response) => {
  try {
    const { depart, arrivee, date, poidsTotalKg, passagers } = req.body ?? {};
    if (!depart || !arrivee || !date) return res.status(400).json({ error: 'depart, arrivee et date requis' });
    return res.json(await verifyTrip({ depart, arrivee, date, poidsTotalKg, passagers }));
  } catch (error) {
    console.error('Erreur /verify:', error);
    return res.status(500).json({ error: 'Erreur lors de la vérification' });
  }
});

/* =========================================================
   Dialogue /chat (marchandises) : le client parle librement.
   Rien n'est imposé : marchandise, unité, quantité, ports et dates
   viennent uniquement du client. Les ports sont lus en base.
========================================================= */
interface Draft {
  cargoType?: string; // texte libre (« vêtements », « farine »...)
  unit?: string; // texte libre, singulier
  quantity?: number;
  weightKg?: number; // poids tel que donné
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

let placesCache = { at: 0, list: [] as string[] };
async function getKnownPlaces(): Promise<string[]> {
  if (placesCache.list.length && Date.now() - placesCache.at < 60_000) return placesCache.list;
  const { rows } = await pool.query(`SELECT DISTINCT "from" AS name FROM trips UNION SELECT DISTINCT "to" AS name FROM trips`);
  const list = rows.map((r) => String(r.name ?? '').trim()).filter(Boolean).sort((a, b) => b.length - a.length);
  placesCache = { at: Date.now(), list };
  return list;
}

const NUM_WORDS: Record<string, number> = {
  un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10,
  onze: 11, douze: 12, quinze: 15, vingt: 20, trente: 30, cinquante: 50, cent: 100,
};
const NUM_FR = ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix'];
const say = (n: number) => (n >= 0 && n <= 10 ? NUM_FR[n] : String(n));

const UNIT = '(?:colis|sacs?|cartons?|caisses?|f[uû]ts?|bidons?|palettes?|paquets?|bo[iî]tes?|bouteilles?|balles?|ballots?|tonneaux?|conteneurs?|valises?|bagages?)';
const END = `(?![\\p{L}\\p{N}'’-])`;
const BOUNDARY =
  '(?:à|a|au|aux|vers|depuis|de|du|pour|le|la|les|l|un|une|et|ou|avec|sans|sur|dans|en|pesant|chacun|chacune|chaque|par|total|poids|kg|kilos?|tonnes?|demain|apr[eè]s|aujourd|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)';
const WORD = `\\p{L}[\\p{L}'’-]*`;
const GOODS = `((?!${BOUNDARY}${END})${WORD}(?:\\s+(?!${BOUNDARY}${END})${WORD}){0,2})`;

function digitize(t: string): string {
  const names = Object.keys(NUM_WORDS).filter((k) => k !== 'un' && k !== 'une').join('|');
  return t
    .replace(new RegExp(`\\b(${names})(?=\\s+[a-zà-ÿ])`, 'gi'), (_m, w: string) => String(NUM_WORDS[w.toLowerCase()]))
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

  // « 3 colis de <X> »
  const a = t.match(new RegExp(`\\b${UNIT}${END}\\s+(?:de\\s+|d['’]\\s*)(?:(?:la\\s+|le\\s+|les\\s+|l['’]\\s*|des\\s+|du\\s+))?${GOODS}`, 'iu'));
  if (a && !isPlace(a[1])) out.cargoType = a[1].trim();

  // « envoyer du <X> »
  if (!out.cargoType) {
    const b = t.match(
      new RegExp(
        `\\b(?:envoyer|exp[ée]dier|transporter|acheminer)\\s+(?:\\d+\\s*(?:${UNIT}\\s*)?(?:de\\s+\\d+(?:[.,]\\d+)?\\s*(?:kg|kilos?)\\s*(?:chacun|chacune)?\\s*)?)?(?:(?:de\\s+|d['’]\\s*))?(?:(?:du\\s+|de la\\s+|de l['’]\\s*|des\\s+|le\\s+|la\\s+|les\\s+|l['’]\\s*|un\\s+|une\\s+|mon\\s+|ma\\s+|mes\\s+))?${GOODS}`,
        'iu',
      ),
    );
    if (b && !isPlace(b[1]) && !new RegExp(`^${UNIT}${END}`, 'iu').test(b[1])) out.cargoType = b[1].trim();
  }
  return out;
}

function extractRoute(text: string, places: string[], d: Draft, expecting?: Draft['asked']) {
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
      /(?:^|\s)(?:de|depuis)$|(?:^|\s)d'$/.test(before) ? 'departure'
      : /(?:^|\s)(?:a|vers|pour|jusqu'a|au)(?:\s+(?:aller|rendre))?$/.test(before) ? 'destination'
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

const isYes = (t: string) => /^(oui|ok|d'accord|confirme|confirmer|valide|valider)\b/.test(strip(t));
const isNo = (t: string) => /^(non|no|nope|modifier|changer|corriger)\b/.test(strip(t));

function nextQuestion(d: Draft): { field: NonNullable<Draft['asked']>; text: string } | null {
  const goods = d.cargoType ? possessive(d.cargoType) : 'votre marchandise';
  const pron = d.cargoType && /[sx]$/i.test(d.cargoType) ? 'les ' : 'l’';
  const unit = d.unit ?? 'unité';
  if (!d.cargoType) return { field: 'cargoType', text: 'D’accord ! Quelle marchandise souhaitez-vous envoyer ?' };
  if (!d.destination) return { field: 'destination', text: `D’accord pour ${goods} ! Vers quelle destination souhaitez-vous ${pron}envoyer ?` };
  if (!d.departure) return { field: 'departure', text: `D’accord ! Depuis quel port souhaitez-vous envoyer ${goods} ?` };
  if (!d.quantity) return { field: 'quantity', text: 'Très bien. Quelle quantité souhaitez-vous envoyer ?' };
  if (d.weightKg === undefined) {
    return {
      field: 'weight',
      text: d.quantity > 1
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
    const each = d.quantity > 1 ? Math.round(((d.totalWeightKg ?? 0) / d.quantity) * 100) / 100 : d.totalWeightKg;
    const ack = d.quantity > 1
      ? `Compris, ${say(d.quantity)} ${pluralize(unit, d.quantity)} de ${each} kg, soit ${d.totalWeightKg} kg au total.`
      : `Compris, ${d.totalWeightKg} kg.`;
    return { field: 'date', text: `${ack} Pour quelle date souhaitez-vous organiser le transport ?` };
  }
  return null;
}

function computeTotals(d: Draft) {
  if (d.weightKg === undefined) return;
  if (!d.quantity || d.quantity === 1) { d.totalWeightKg = d.weightKg; d.unitWeightKg = d.weightKg; }
  else if (d.weightMode === 'unit') { d.unitWeightKg = d.weightKg; d.totalWeightKg = d.weightKg * d.quantity; }
  else if (d.weightMode === 'total') { d.totalWeightKg = d.weightKg; d.unitWeightKg = Math.round((d.weightKg / d.quantity) * 100) / 100; }
  else { d.totalWeightKg = undefined; d.unitWeightKg = undefined; }
}

aiRouter.post('/chat', aiRequestLimiter, async (req: Request, res: Response) => {
  try {
    const question = String(req.body?.question ?? '').trim();
    if (!question) return res.status(400).json({ error: 'Question requise' });

    let parsedContext: Record<string, any> = {};
    try {
      const raw = req.body?.context;
      if (raw) parsedContext = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch { /* contexte illisible : on repart d'un brouillon vide */ }

    const draft: Draft = { ...(parsedContext.currentContext ?? {}) };
    const text = question.toLowerCase();
    const places = await getKnownPlaces();
    let reply = '';
    let quoteSummary: Record<string, unknown> | null = null;

    // ---- Récapitulatif présenté : seul « oui » confirme (jamais un « oui » au milieu d'une phrase)
    if (draft.awaitingConfirm && isYes(question)) {
      const total = draft.totalWeightKg;
      if (!draft.tripId || !draft.departure || !draft.destination || !draft.dateExact || !total) {
        draft.awaitingConfirm = false;
        reply = 'Il manque des informations pour la réservation. Reprenons : ' + (nextQuestion(draft)?.text ?? 'pouvez-vous reformuler ?');
      } else {
        // Revérification juste avant l'enregistrement (la capacité a pu changer)
        const check = await verifyTrip({ depart: draft.departure, arrivee: draft.destination, date: draft.dateExact, poidsTotalKg: total });
        if (!check.available) {
          draft.awaitingConfirm = false;
          reply = check.message ?? 'Ce trajet n’est plus disponible.';
        } else {
          const clientName = String(req.body?.clientName ?? 'Client IA');
          const insertRes = await pool.query(
            `INSERT INTO reservations (id, "clientName", "tripId", quantity, weight, "totalPrice", status, "createdAt")
             VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'PENDING', NOW())
             RETURNING id;`,
            [clientName, check.tripId, draft.quantity || 1, total, check.totalPrice ?? 0],
          );
          reply = `Merci ! Votre réservation a été enregistrée avec succès sous le numéro #${String(insertRes.rows[0].id).slice(0, 8)}.`;
          draft.confirmedByUser = true;
          draft.awaitingConfirm = false;
        }
      }
      return res.json({ reply, reponse: reply, updatedContext: draft, quoteSummary });
    }
    if (draft.awaitingConfirm && isNo(question)) draft.awaitingConfirm = false; // correction : on fusionne ci-dessous

    // ---- Date relative ambiguë en attente (« Parlez-vous de vendredi 16 octobre ? »)
    if (draft.dateToConfirm) {
      if (isYes(question)) {
        draft.dateToConfirm = false;
        // la date reste celle proposée
      } else if (isNo(question) && !parseRelativeDate(question)) {
        draft.dateToConfirm = false;
        delete draft.dateExact; delete draft.dateFormatted;
      } else {
        draft.dateToConfirm = false; // nouvelle date donnée : traitée plus bas
      }
    }

    // ---- 1. Extraction : tout ce que le client donne, dans le désordre
    const before = { ...draft };
    const goods = extractGoods(text, places);
    if (goods.cargoType) draft.cargoType = goods.cargoType;
    else if (draft.asked === 'cargoType' && !draft.cargoType) {
      const bare = text.replace(/[.!?,;]+$/g, '').replace(/^(?:du|de la|de l['’]|des|de|d['’]|un|une|le|la|les)\s*/, '').trim();
      if (bare && bare.split(' ').length <= 3 && !/\d/.test(bare) && !isYes(bare) && !isNo(bare)) draft.cargoType = bare;
    }
    if (goods.unit) draft.unit = goods.unit;
    if (goods.quantity) draft.quantity = goods.quantity;

    const route = extractRoute(text, places, draft, draft.asked === 'departure' ? 'departure' : draft.asked === 'destination' ? 'destination' : undefined);
    if (route.departure) draft.departure = route.departure;
    if (route.destination) draft.destination = route.destination;

    const t = digitize(text);
    const w = t.match(/(\d+(?:[.,]\d+)?)\s*(kg|kilos?|tonnes?)/i);
    if (w) {
      const v = parseFloat(w[1].replace(',', '.')) * (/^t/i.test(w[2]) ? 1000 : 1);
      draft.weightKg = v;
      draft.weightMode = undefined;
    }
    if (/\bchacun|\bchacune|\bchaque\b|\bpar\s+\p{L}+/iu.test(t) && (w || draft.asked === 'weightMode')) draft.weightMode = 'unit';
    else if (/\btotal\b|au total|en tout/i.test(t) && (w || draft.asked === 'weightMode')) draft.weightMode = 'total';

    // Réponse courte à la dernière question posée (« 3 », « trois », « 20 »)
    const lone = strip(text).replace(/[.!?]+$/, '');
    const loneNum = /^\d{1,5}$/.test(lone) ? +lone : (NUM_WORDS[lone] as number | undefined);
    if (loneNum !== undefined && !w) {
      if (draft.asked === 'quantity') draft.quantity = loneNum;
      else if (draft.asked === 'weight') { draft.weightKg = loneNum; draft.weightMode = undefined; }
    }
    // « Mahajanga » seul, sans préposition
    if (!route.departure && !route.destination && draft.asked && /^(departure|destination)$/.test(draft.asked)) {
      const only = found1(places, lone);
      if (only) (draft.asked === 'departure' ? (draft.departure = only) : (draft.destination = only));
    }
    computeTotals(draft);

    // Date (convertie selon la date locale de Madagascar)
    const dateParsed = parseRelativeDate(text);
    if (dateParsed) {
      if (dateParsed.dateStr < todayLocal()) {
        delete draft.dateExact; delete draft.dateFormatted;
        draft.asked = 'date';
        reply = 'La date indiquée est déjà passée. Pour quelle date souhaitez-vous organiser le transport ?';
        return res.json({ reply, reponse: reply, updatedContext: draft, quoteSummary });
      }
      draft.dateExact = dateParsed.dateStr;
      draft.dateFormatted = dateParsed.formatted;
      if (dateParsed.ambiguous) {
        draft.dateToConfirm = true;
        draft.asked = 'date';
        reply = `Aujourd’hui, c’est déjà ${DAY_NAMES[new Date(`${todayLocal()}T12:00:00Z`).getUTCDay()]}. Parlez-vous de ${dateParsed.formatted} ?`;
        return res.json({ reply, reponse: reply, updatedContext: draft, quoteSummary });
      }
    }

    // Corrections signalées sans recommencer
    const changed: string[] = [];
    if (before.departure && draft.departure !== before.departure) changed.push(`départ : ${draft.departure}`);
    if (before.destination && draft.destination !== before.destination) changed.push(`destination : ${draft.destination}`);
    if (before.dateExact && draft.dateExact !== before.dateExact && draft.dateFormatted) changed.push(`date : ${draft.dateFormatted}`);
    if (before.cargoType && draft.cargoType !== before.cargoType) changed.push(`marchandise : ${draft.cargoType}`);
    if (before.quantity && draft.quantity !== before.quantity) changed.push(`quantité : ${draft.quantity}`);
    const prefix = changed.length ? `C’est corrigé (${changed.join(', ')}). ` : '';

    // ---- 2. Une seule question ciblée à la fois
    const q = nextQuestion(draft);
    if (q) {
      draft.asked = q.field;
      draft.awaitingConfirm = false;
      reply = `${prefix}${q.text}`;
      return res.json({ reply, reponse: reply, updatedContext: draft, quoteSummary });
    }

    // ---- 3. Tout est connu : le backend vérifie trajet, capacité et tarif AVANT d'annoncer un résultat
    draft.asked = undefined;
    const result = await verifyTrip({
      depart: draft.departure!,
      arrivee: draft.destination!,
      date: draft.dateExact!,
      poidsTotalKg: draft.totalWeightKg,
    });

    if (!result.available) {
      reply = `${prefix}${result.message ?? 'Ce trajet n’est pas disponible pour cette demande.'} Souhaitez-vous une autre date ou un autre trajet ?`;
      draft.awaitingConfirm = false;
    } else {
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

    return res.json({ reply, reponse: reply, updatedContext: draft, quoteSummary });
  } catch (error) {
    console.error('Erreur IA / Neon:', error);
    return res.status(500).json({ error: 'Erreur lors du traitement de la demande' });
  }
});

// Réponse « Mahajanga » seule : retrouve le port connu correspondant
function found1(places: string[], loneNorm: string): string | undefined {
  return places.find((p) => strip(p).replace(/’/g, "'") === loneNorm.replace(/’/g, "'"));
}

export default aiRouter;