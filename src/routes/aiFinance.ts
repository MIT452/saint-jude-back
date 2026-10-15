// src/routes/aiFinance.ts
// Assistant financier SAINT-JUDE : caisse + consommation de carburant.
//
// Principe : le backend CALCULE (SQL + JS), Groq EXPLIQUE.
//  - le modèle ne reçoit jamais d'accès à Neon et n'exécute aucun SQL ;
//  - le modèle ne reçoit que des chiffres déjà calculés et autorisés pour l'utilisateur ;
//  - il ne peut ni créer, ni modifier, ni supprimer un mouvement.
//
// Montage (dans src/routes/ai.ts, avant `export default aiRouter`) :
//   import { financeRouter } from './aiFinance.js';
//   aiRouter.use('/finance', financeRouter);
// → POST /api/ai/finance/chat   et   GET /api/ai/finance/status
// L'authentification est celle déjà appliquée à aiRouter (res.locals.sessionUser).

import { Router, type Request, type Response, type NextFunction } from 'express';
import { pool } from '../db.js';
import { chatText, safeError, currentProviderInfo, type Msg } from '../ai/llm.js';

export const financeRouter = Router();

const BUILD = 'finance-ai-2026-10-15';
console.info(`[IA-FIN] aiFinance.ts chargé (build ${BUILD})`);

type Db = { query: (text: string, values?: any[]) => Promise<{ rows: any[] }> };
const db = pool as unknown as Db;

/* =========================================================
   Rate limiter : 20 requêtes / minute par IP
========================================================= */
const hits = new Map<string, number[]>();
function limiter(req: Request, res: Response, next: NextFunction) {
  const now = Date.now();
  const ip = req.ip ?? 'inconnu';
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= 20) {
    return res.status(429).json({ error: 'Trop de requêtes, réessayez dans une minute.' });
  }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (!v.some((t) => now - t < 60_000)) hits.delete(k);
  }
  next();
}

/* =========================================================
   Outils généraux
========================================================= */
const TZ = 'Indian/Antananarivo';
const strip = (s: string) =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const todayLocal = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const addDays = (isoDate: string, n: number) => {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const daysBetween = (a: string, b: string) =>
  Math.round((new Date(`${b}T12:00:00Z`).getTime() - new Date(`${a}T12:00:00Z`).getTime()) / 86_400_000);
const isoDay = (y: number, m0: number, d: number) => new Date(Date.UTC(y, m0, d, 12)).toISOString().slice(0, 10);

const nf = (n: number) => Math.round(n).toLocaleString('fr-FR');
const ar = (n: number) => `${nf(n)} Ar`;
const r2 = (n: number) => Math.round(n * 100) / 100;
const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
const median = (a: number[]) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const h = Math.floor(s.length / 2);
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};
// Les noms de tables/colonnes viennent d'information_schema, jamais de l'utilisateur
const qi = (s: string) => `"${s.replace(/"/g, '""')}"`;

/* =========================================================
   Période (français courant)
========================================================= */
interface Period {
  start?: string; // AAAA-MM-JJ inclus
  end?: string; // AAAA-MM-JJ exclu
  label: string;
}

const MONTHS = [
  'janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre',
];

function parsePeriod(question: string): Period | null {
  const t = strip(question).replace(/’/g, "'");
  const today = todayLocal();
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7)) - 1;

  if (/aujourd/.test(t)) return { start: today, end: addDays(today, 1), label: 'aujourd’hui' };
  if (/\bhier\b/.test(t)) return { start: addDays(today, -1), end: today, label: 'hier' };

  const nd = t.match(/(\d{1,3})\s+derniers?\s+jours?/);
  if (nd) {
    const n = Math.min(Math.max(Number(nd[1]), 1), 366);
    return { start: addDays(today, -(n - 1)), end: addDays(today, 1), label: `les ${n} derniers jours` };
  }

  const dow = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7; // lundi = 0
  const weekStart = addDays(today, -dow);
  if (/semaine (derniere|passee|precedente)/.test(t)) {
    return { start: addDays(weekStart, -7), end: weekStart, label: 'la semaine dernière' };
  }
  if (/(cette|la) semaine/.test(t)) {
    return { start: weekStart, end: addDays(weekStart, 7), label: 'cette semaine' };
  }
  if (/mois (dernier|precedent|passe)/.test(t)) {
    return { start: isoDay(y, m - 1, 1), end: isoDay(y, m, 1), label: 'le mois dernier' };
  }
  if (/(ce|le) mois/.test(t)) {
    return { start: isoDay(y, m, 1), end: isoDay(y, m + 1, 1), label: 'ce mois' };
  }
  if (/annee (derniere|passee)/.test(t)) {
    return { start: isoDay(y - 1, 0, 1), end: isoDay(y, 0, 1), label: `l’année ${y - 1}` };
  }
  if (/(cette annee|l'annee en cours)/.test(t)) {
    return { start: isoDay(y, 0, 1), end: isoDay(y + 1, 0, 1), label: `l’année ${y}` };
  }

  const mm = t.match(new RegExp(`\\b(${MONTHS.join('|')})(?:\\s+(\\d{4}))?\\b`));
  if (mm) {
    const idx = MONTHS.indexOf(mm[1]);
    const year = mm[2] ? Number(mm[2]) : idx > m ? y - 1 : y;
    return { start: isoDay(year, idx, 1), end: isoDay(year, idx + 1, 1), label: `${mm[1]} ${year}` };
  }
  return null;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
function sanitizePeriod(raw: unknown): Period | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const label = typeof r.label === 'string' ? r.label.slice(0, 60) : 'période choisie';
  const start = typeof r.start === 'string' && ISO.test(r.start) ? r.start : undefined;
  const end = typeof r.end === 'string' && ISO.test(r.end) ? r.end : undefined;
  return { start, end, label };
}

function previousPeriod(p: Period): Period | null {
  if (!p.start || !p.end) return null;
  const len = daysBetween(p.start, p.end);
  if (len <= 0 || len > 400) return null;
  return { start: addDays(p.start, -len), end: p.start, label: 'la période précédente de même durée' };
}

/* =========================================================
   Détection automatique du schéma (tables/colonnes réelles de Neon)
   Variables facultatives pour forcer les noms : CASH_TABLE, FUEL_TABLE, USERS_TABLE
========================================================= */
interface Cols { [lower: string]: string } // minuscule -> nom réel
interface Schema {
  cash?: { table: string; id?: string; designation: string; credit: string; debit: string; date: string; userId?: string };
  fuel?: { table: string; id?: string; userId?: string; tripId: string; fuelType: string; fuelPrice: string; cost: string; date?: string; qty?: string };
  users?: { table: string; id: string; name: string; lastName: string; role?: string };
  tables: string[];
}

let schemaCache: { at: number; value: Schema } | null = null;

async function discover(): Promise<Schema> {
  if (schemaCache && Date.now() - schemaCache.at < 600_000) return schemaCache.value;

  const { rows } = await db.query(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()`,
  );
  const tables = new Map<string, Cols>();
  for (const r of rows) {
    const t = String(r.table_name);
    const cols = tables.get(t) ?? {};
    cols[String(r.column_name).toLowerCase()] = String(r.column_name);
    tables.set(t, cols);
  }

  const findTable = (required: string[], forced?: string) => {
    if (forced && tables.has(forced)) return [forced, tables.get(forced)!] as const;
    for (const [name, cols] of [...tables.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (required.every((c) => cols[c])) return [name, cols] as const;
    }
    return null;
  };
  const first = (cols: Cols, names: string[]) => names.map((n) => cols[n]).find(Boolean);

  const schema: Schema = { tables: [...tables.keys()].sort() };

  const cash = findTable(['designation', 'credit', 'debit', 'date'], process.env.CASH_TABLE);
  if (cash) {
    const [table, c] = cash;
    schema.cash = {
      table,
      id: c['id'],
      designation: c['designation'],
      credit: c['credit'],
      debit: c['debit'],
      date: c['date'],
      userId: c['userid'],
    };
  }

  const fuel = findTable(['fuelprice', 'cost', 'fueltype', 'tripid'], process.env.FUEL_TABLE);
  if (fuel) {
    const [table, c] = fuel;
    schema.fuel = {
      table,
      id: c['id'],
      userId: c['userid'],
      tripId: c['tripid'],
      fuelType: c['fueltype'],
      fuelPrice: c['fuelprice'],
      cost: c['cost'],
      date: first(c, ['createdat', 'date']),
      qty: first(c, ['quantity', 'liters', 'litres', 'quantite', 'volume', 'liter']),
    };
  }

  const users = findTable(['id', 'name', 'lastname'], process.env.USERS_TABLE);
  if (users) {
    const [table, c] = users;
    schema.users = { table, id: c['id'], name: c['name'], lastName: c['lastname'], role: c['role'] };
  }

  schemaCache = { at: Date.now(), value: schema };
  return schema;
}

/* =========================================================
   Utilisateur et droits
   - Caisse : rôles de gestion (FINANCE_ROLES, séparés par des virgules)
   - Carburant : mêmes rôles + Capitaine (limité aux bateaux dont il fait partie)
========================================================= */
interface SessionUser { id?: string; role?: string; name?: string; lastName?: string }

const CASH_ROLES = new Set(
  (process.env.FINANCE_ROLES || 'admin,administrateur,gestionnaire,caissier,comptable,directeur,manager')
    .split(',')
    .map((r) => strip(r))
    .filter(Boolean),
);

async function resolveRole(user: SessionUser, schema: Schema): Promise<string> {
  if (user.role) return strip(String(user.role));
  const u = schema.users;
  if (u?.role && user.id) {
    const { rows } = await db.query(
      `SELECT ${qi(u.role)} AS role FROM ${qi(u.table)} WHERE ${qi(u.id)}::text = $1 LIMIT 1`,
      [String(user.id)],
    );
    return strip(String(rows[0]?.role ?? ''));
  }
  return '';
}

/* =========================================================
   Lecture des données (SQL paramétré, noms de colonnes issus d'information_schema)
========================================================= */
const MAX_ROWS = 5000;

function periodWhere(col: string, p: Period, params: any[]): string[] {
  const w: string[] = [];
  if (p.start) {
    params.push(p.start);
    w.push(`${col}::timestamp >= $${params.length}::date`);
  }
  if (p.end) {
    params.push(p.end);
    w.push(`${col}::timestamp < $${params.length}::date`);
  }
  return w;
}

interface CashRow { id: string | null; designation: string; credit: number; debit: number; at: string; who: string | null }

async function loadCash(schema: Schema, p: Period): Promise<CashRow[]> {
  const c = schema.cash!;
  const params: any[] = [];
  const where = periodWhere(`c.${qi(c.date)}`, p, params);
  const join =
    schema.users && c.userId
      ? `LEFT JOIN ${qi(schema.users.table)} u ON u.${qi(schema.users.id)}::text = c.${qi(c.userId)}::text`
      : '';
  const who =
    schema.users && c.userId
      ? `NULLIF(TRIM(CONCAT(u.${qi(schema.users.name)}, ' ', u.${qi(schema.users.lastName)})), '')`
      : 'NULL::text';

  const { rows } = await db.query(
    `SELECT ${c.id ? `c.${qi(c.id)}::text` : 'NULL::text'} AS id,
            c.${qi(c.designation)} AS designation,
            COALESCE(c.${qi(c.credit)}, 0)::numeric AS credit,
            COALESCE(c.${qi(c.debit)}, 0)::numeric AS debit,
            to_char(c.${qi(c.date)}::timestamp, 'YYYY-MM-DD HH24:MI') AS at,
            ${who} AS who
     FROM ${qi(c.table)} c ${join}
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY c.${qi(c.date)} DESC
     LIMIT ${MAX_ROWS}`,
    params,
  );
  return rows.map((r) => ({
    id: r.id ?? null,
    designation: String(r.designation ?? ''),
    credit: Number(r.credit) || 0,
    debit: Number(r.debit) || 0,
    at: String(r.at ?? ''),
    who: r.who ?? null,
  }));
}

interface FuelRow {
  id: string | null; type: string; price: number; cost: number; qty: number | null;
  at: string; uid: string | null; who: string | null; from: string | null; to: string | null; boat: string | null;
}

async function loadFuel(schema: Schema, p: Period, captainId?: string): Promise<FuelRow[]> {
  const f = schema.fuel!;
  const params: any[] = [];
  const where = f.date ? periodWhere(`f.${qi(f.date)}`, p, params) : [];

  if (captainId) {
    // Un Capitaine ne voit que les bateaux dont il fait partie de l'équipage (comme l'écran React)
    params.push(captainId);
    where.push(`b.crew IS NOT NULL AND POSITION($${params.length} IN b.crew::text) > 0`);
  }

  const join =
    schema.users && f.userId
      ? `LEFT JOIN ${qi(schema.users.table)} u ON u.${qi(schema.users.id)}::text = f.${qi(f.userId)}::text`
      : '';
  const who =
    schema.users && f.userId
      ? `NULLIF(TRIM(CONCAT(u.${qi(schema.users.name)}, ' ', u.${qi(schema.users.lastName)})), '')`
      : 'NULL::text';

  const { rows } = await db.query(
    `SELECT ${f.id ? `f.${qi(f.id)}::text` : 'NULL::text'} AS id,
            f.${qi(f.fuelType)} AS type,
            COALESCE(f.${qi(f.fuelPrice)}, 0)::numeric AS price,
            COALESCE(f.${qi(f.cost)}, 0)::numeric AS cost,
            ${f.qty ? `f.${qi(f.qty)}::numeric` : 'NULL::numeric'} AS qty,
            ${f.date ? `to_char(f.${qi(f.date)}::timestamp, 'YYYY-MM-DD HH24:MI')` : 'NULL::text'} AS at,
            ${f.userId ? `f.${qi(f.userId)}::text` : 'NULL::text'} AS uid,
            ${who} AS who,
            t."from" AS trip_from, t."to" AS trip_to, b.name AS boat
     FROM ${qi(f.table)} f
     LEFT JOIN trips t ON t.id::text = f.${qi(f.tripId)}::text
     LEFT JOIN boats b ON b.id::text = t."boatId"::text
     ${join}
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY ${f.date ? `f.${qi(f.date)}` : '1'} DESC
     LIMIT ${MAX_ROWS}`,
    params,
  );
  return rows.map((r) => ({
    id: r.id ?? null,
    type: String(r.type ?? 'non précisé'),
    price: Number(r.price) || 0,
    cost: Number(r.cost) || 0,
    qty: r.qty === null || r.qty === undefined ? null : Number(r.qty),
    at: String(r.at ?? ''),
    uid: r.uid ?? null,
    who: r.who ?? null,
    from: r.trip_from ?? null,
    to: r.trip_to ?? null,
    boat: r.boat ?? null,
  }));
}

/* =========================================================
   Calculs (source de vérité des chiffres)
========================================================= */
function summarizeCash(rows: CashRow[]) {
  const totalCredit = sum(rows.map((r) => r.credit));
  const totalDebit = sum(rows.map((r) => r.debit));
  const amount = (r: CashRow) => Math.max(r.credit, r.debit);
  const line = (r: CashRow) => ({
    date: r.at,
    designation: r.designation,
    credit: r.credit,
    debit: r.debit,
    caissier: r.who ?? 'inconnu',
  });

  const biggest = [...rows].sort((a, b) => amount(b) - amount(a)).slice(0, 5).map(line);
  const topDebits = [...rows].filter((r) => r.debit > 0).sort((a, b) => b.debit - a.debit).slice(0, 5).map(line);

  // Doublons possibles : même désignation + mêmes montants (à vérifier, pas une certitude)
  const groups = new Map<string, { n: number; r: CashRow; dates: string[] }>();
  for (const r of rows) {
    const key = `${strip(r.designation)}|${r.credit}|${r.debit}`;
    const g = groups.get(key) ?? { n: 0, r, dates: [] };
    g.n += 1;
    g.dates.push(r.at);
    groups.set(key, g);
  }
  const possibleDuplicates = [...groups.values()]
    .filter((g) => g.n > 1)
    .sort((a, b) => b.n - a.n)
    .slice(0, 5)
    .map((g) => ({ designation: g.r.designation, credit: g.r.credit, debit: g.r.debit, occurrences: g.n, dates: g.dates.slice(0, 4) }));

  // Montants inhabituels : > 3 × la médiane (au moins 6 mouvements pour avoir un sens)
  const amounts = rows.map(amount).filter((a) => a > 0);
  const med = median(amounts);
  const unusual =
    amounts.length >= 6 && med > 0
      ? [...rows].filter((r) => amount(r) > 3 * med).sort((a, b) => amount(b) - amount(a)).slice(0, 5).map(line)
      : [];

  return {
    count: rows.length,
    totalCredit,
    totalDebit,
    soldeNet: totalCredit - totalDebit,
    formule: `${nf(totalCredit)} − ${nf(totalDebit)} = ${nf(totalCredit - totalDebit)} Ar`,
    pourcentageEntrees: totalCredit + totalDebit > 0 ? Math.round((totalCredit / (totalCredit + totalDebit)) * 100) : 0,
    medianeMontant: Math.round(med),
    plusGrosMouvements: biggest,
    plusGrosDebits: topDebits,
    derniersMouvements: rows.slice(0, 5).map(line),
    doublonsPossibles: possibleDuplicates,
    montantsInhabituels: unusual,
    tronque: rows.length >= MAX_ROWS,
  };
}

interface Agg { n: number; cost: number; litres: number }
function aggregate(rows: Array<{ key: string; cost: number; litres: number }>) {
  const map = new Map<string, Agg>();
  for (const r of rows) {
    const a = map.get(r.key) ?? { n: 0, cost: 0, litres: 0 };
    a.n += 1;
    a.cost += r.cost;
    a.litres += r.litres;
    map.set(r.key, a);
  }
  return [...map.entries()]
    .sort((a, b) => b[1].cost - a[1].cost)
    .slice(0, 5)
    .map(([nom, a]) => ({ nom, depenses: Math.round(a.cost), litres: Math.round(a.litres), transactions: a.n }));
}

function summarizeFuel(rows: FuelRow[]) {
  const litresOf = (r: FuelRow) => (r.qty !== null ? r.qty : r.price > 0 ? r.cost / r.price : 0);
  const estimated = rows.some((r) => r.qty === null);
  const totalCost = sum(rows.map((r) => r.cost));
  const totalLitres = sum(rows.map(litresOf));
  const prep = rows.map((r) => ({
    r,
    litres: litresOf(r),
    route: r.from && r.to ? `${r.from} → ${r.to}` : 'trajet inconnu',
  }));

  // Anomalies possibles
  const anomalies: Array<{ type: string; detail: string }> = [];

  const byTypePrices = new Map<string, number[]>();
  for (const r of rows) if (r.price > 0) byTypePrices.set(r.type, [...(byTypePrices.get(r.type) ?? []), r.price]);
  for (const r of rows) {
    const prices = byTypePrices.get(r.type) ?? [];
    if (prices.length >= 3 && r.price > 0) {
      const med = median(prices);
      if (med > 0 && Math.abs(r.price - med) / med > 0.25) {
        anomalies.push({
          type: 'prix_par_litre_inhabituel',
          detail: `${r.at} — ${r.type} à ${nf(r.price)} Ar/L alors que la médiane est ${nf(med)} Ar/L (${r.boat ?? 'bateau inconnu'}, ${r.who ?? 'utilisateur inconnu'})`,
        });
      }
    }
  }

  const costs = rows.map((r) => r.cost).filter((c) => c > 0);
  const medCost = median(costs);
  if (costs.length >= 5 && medCost > 0) {
    for (const r of rows.filter((x) => x.cost > 2.5 * medCost).slice(0, 5)) {
      anomalies.push({
        type: 'depense_elevee',
        detail: `${r.at} — ${ar(r.cost)} (médiane ${ar(medCost)}) pour ${r.boat ?? 'bateau inconnu'}, ${r.from ?? '?'} → ${r.to ?? '?'}`,
      });
    }
  }

  const dup = new Map<string, FuelRow[]>();
  for (const r of rows) {
    const key = `${r.uid}|${r.from}|${r.to}|${r.boat}|${r.cost}|${r.type}`;
    dup.set(key, [...(dup.get(key) ?? []), r]);
  }
  for (const list of dup.values()) {
    if (list.length > 1) {
      anomalies.push({
        type: 'doublon_possible',
        detail: `${list.length} enregistrements identiques (${list[0].boat ?? 'bateau inconnu'}, ${ar(list[0].cost)}, ${list.map((x) => x.at).join(' / ')})`,
      });
    }
  }

  const missing = {
    sansTrajet: rows.filter((r) => !r.from || !r.to).length,
    sansPrixParLitre: rows.filter((r) => r.price <= 0).length,
  };

  return {
    transactions: rows.length,
    depensesTotales: Math.round(totalCost),
    litresTotaux: Math.round(totalLitres),
    litresEstimes: estimated,
    prixMoyenParLitre: totalLitres > 0 ? Math.round(totalCost / totalLitres) : 0,
    parTrajet: aggregate(prep.map((p) => ({ key: p.route, cost: p.r.cost, litres: p.litres }))),
    parBateau: aggregate(prep.map((p) => ({ key: p.r.boat ?? 'bateau inconnu', cost: p.r.cost, litres: p.litres }))),
    parUtilisateur: aggregate(prep.map((p) => ({ key: p.r.who ?? 'utilisateur inconnu', cost: p.r.cost, litres: p.litres }))),
    parTypeCarburant: aggregate(prep.map((p) => ({ key: p.r.type, cost: p.r.cost, litres: p.litres }))),
    anomaliesPossibles: anomalies.slice(0, 8),
    donneesManquantes: missing,
    tronque: rows.length >= MAX_ROWS,
  };
}

/* =========================================================
   Historique de conversation (jamais de confiance au navigateur)
========================================================= */
function sanitizeHistory(raw: unknown): Msg[] {
  if (!Array.isArray(raw)) return [];
  const out: Msg[] = [];
  for (const m of raw.slice(-8)) {
    const role = m?.role === 'assistant' ? 'assistant' : m?.role === 'user' ? 'user' : null;
    const content = typeof m?.content === 'string' ? m.content.slice(0, 1200) : '';
    if (role && content) out.push({ role, content });
  }
  return out;
}

/* =========================================================
   Prompt système
========================================================= */
const FINANCE_PROMPT = `Tu es l'assistant financier de SAINT-JUDE (transport maritime, Madagascar). Tu aides le gestionnaire à comprendre sa caisse et sa consommation de carburant.

RÈGLES STRICTES
- Réponds en français simple, de façon claire et courte (6 phrases maximum, sauf si on te demande plus de détails).
- Utilise UNIQUEMENT les chiffres du bloc « DONNÉES VÉRIFIÉES ». N'invente JAMAIS un montant, un total, un solde, une transaction, un bateau ou une date.
- Si l'information demandée n'est pas dans les données, dis-le clairement et indique ce qu'il manque.
- Précise toujours la période analysée.
- Explique les calculs avec leur formule (par exemple : solde net = total crédit − total débit).
- Distingue les FAITS VÉRIFIÉS des ANOMALIES POSSIBLES : une anomalie n'est jamais une accusation, c'est un point à vérifier.
- Pour le carburant, distingue la dépense (en Ar) de la consommation (en litres). Si « litresEstimes » est vrai, dis que les litres sont estimés (coût ÷ prix par litre).
- Si l'utilisateur dit qu'il ne comprend pas, reformule plus simplement avec un exemple chiffré, sans répéter la même phrase.
- Si la question est ambiguë, pose UNE question de précision.
- Tu ne peux ni créer, ni modifier, ni supprimer un mouvement de caisse. Si on te le demande, explique que cela se fait avec le bouton « Nouveau Mouvement ».
- Montants en Ar, avec séparateur d'espace (ex. 92 067 Ar). Pas de JSON dans ta réponse.
- Termine, quand c'est utile, par UNE action proposée (ex. « Vérifiez ces deux mouvements »).`;

/* =========================================================
   Réponse de secours (si Groq est indisponible) : 100 % déterministe
========================================================= */
function fallbackReply(facts: any): string {
  const parts: string[] = [`Période analysée : ${facts.periode.label}.`];
  const c = facts.caisse;
  if (c) {
    parts.push(
      `Caisse : crédit ${ar(c.totalCredit)}, débit ${ar(c.totalDebit)}, solde net ${ar(c.soldeNet)} (calcul : ${c.formule}).`,
    );
    if (c.doublonsPossibles?.length) parts.push(`${c.doublonsPossibles.length} doublon(s) possible(s) à vérifier.`);
  }
  const f = facts.carburant;
  if (f) {
    parts.push(`Carburant : ${ar(f.depensesTotales)} dépensés, environ ${nf(f.litresTotaux)} L${f.litresEstimes ? ' (estimés)' : ''}.`);
    if (f.parTrajet?.[0]) parts.push(`Trajet le plus coûteux : ${f.parTrajet[0].nom} (${ar(f.parTrajet[0].depenses)}).`);
    if (f.anomaliesPossibles?.length) parts.push(`${f.anomaliesPossibles.length} point(s) à vérifier.`);
  }
  parts.push('L’assistant IA est momentanément indisponible : ces chiffres sont calculés directement depuis votre base de données.');
  return parts.join(' ');
}

/* =========================================================
   POST /chat
========================================================= */
financeRouter.post('/chat', limiter, async (req: Request, res: Response) => {
  try {
    const user = res.locals.sessionUser as SessionUser | undefined;
    if (!user?.id) return res.status(401).json({ error: 'Authentification requise' });

    const question = String(req.body?.question ?? '').trim().slice(0, 1000);
    if (!question) return res.status(400).json({ error: 'Question requise' });

    const scopeRaw = String(req.body?.scope ?? 'auto');
    const scope = scopeRaw === 'cash' || scopeRaw === 'fuel' ? scopeRaw : 'auto';
    const history = sanitizeHistory(req.body?.history);

    const schema = await discover();
    const role = await resolveRole(user, schema);
    const canCash = CASH_ROLES.has(role);
    const isCaptain = role === 'capitaine';
    const canFuel = canCash || isCaptain;
    if (!canCash && !canFuel) {
      return res.status(403).json({ error: 'Votre rôle ne permet pas d’accéder à l’assistant financier.' });
    }

    // Quelles données faut-il ? (mots-clés + écran d'où vient la question)
    const qn = strip(question);
    const fuelKw = /carburant|litre|gasoil|gazoil|essence|consomm|bateau|navire|trajet|voyage/;
    const cashKw = /caisse|solde|credit|debit|mouvement|encaiss|decaiss|entree|sortie|argent|depense|recette/;
    let wantFuel = fuelKw.test(qn);
    let wantCash = cashKw.test(qn);
    if (scope === 'fuel') wantCash = /caisse|solde|credit|debit/.test(qn);
    if (scope === 'cash') wantFuel = /carburant|litre|gasoil|gazoil|essence|consomm/.test(qn);
    if (!wantFuel && !wantCash) {
      wantFuel = scope !== 'cash';
      wantCash = scope !== 'fuel';
    }

    const notes: string[] = [];
    if (wantCash && !canCash) {
      wantCash = false;
      notes.push('Les données de caisse ne sont pas accessibles pour le rôle de cet utilisateur : ne rien en dire.');
    }
    if (wantCash && !schema.cash) {
      wantCash = false;
      notes.push('La table des mouvements de caisse est introuvable dans la base : impossible de répondre sur la caisse.');
    }
    if (wantFuel && !canFuel) wantFuel = false;
    if (wantFuel && !schema.fuel) {
      wantFuel = false;
      notes.push('La table de consommation de carburant est introuvable dans la base : impossible de répondre sur le carburant.');
    }
    if (!wantCash && !wantFuel && !notes.length) {
      notes.push('Aucune donnée accessible pour cette question.');
    }

    // Période : celle de la question, sinon celle de la conversation, sinon tout l'historique
    const period: Period =
      parsePeriod(question) ?? sanitizePeriod(req.body?.period) ?? { label: 'toute la période enregistrée' };
    const prev = previousPeriod(period);
    const captainId = isCaptain && !canCash ? String(user.id) : undefined;

    const facts: Record<string, any> = {
      periode: { label: period.label, debut: period.start ?? null, finExclue: period.end ?? null },
      notes,
    };

    if (wantCash) {
      const rows = await loadCash(schema, period);
      facts.caisse = summarizeCash(rows);
      if (prev) {
        const p = summarizeCash(await loadCash(schema, prev));
        facts.caissePeriodePrecedente = { totalCredit: p.totalCredit, totalDebit: p.totalDebit, soldeNet: p.soldeNet, count: p.count };
      }
    }
    if (wantFuel) {
      const rows = await loadFuel(schema, period, captainId);
      facts.carburant = summarizeFuel(rows);
      if (captainId) notes.push('Les données de carburant sont limitées aux bateaux de cet utilisateur.');
      if (facts.carburant.litresEstimes) {
        notes.push('Les litres sont estimés (coût ÷ prix par litre) : la base ne contient pas de quantité mesurée.');
      }
      if (prev) {
        const p = summarizeFuel(await loadFuel(schema, prev, captainId));
        facts.carburantPeriodePrecedente = { depensesTotales: p.depensesTotales, litresTotaux: p.litresTotaux, transactions: p.transactions };
      }
    }

    if (!wantCash && !wantFuel) {
      return res.json({
        reply:
          'Je ne peux pas répondre à cette question avec les données auxquelles vous avez accès. Précisez si vous parlez de la caisse ou du carburant.',
        period,
        degraded: true,
      });
    }

    // Groq explique les chiffres déjà calculés
    const messages: Msg[] = [
      { role: 'system', content: `${FINANCE_PROMPT}\nDate du jour : ${todayLocal()} (fuseau Madagascar).` },
      {
        role: 'system',
        content: `DONNÉES VÉRIFIÉES (calculées par le serveur, seule source autorisée) :\n${JSON.stringify(facts).slice(0, 14000)}`,
      },
      ...history,
      { role: 'user', content: question },
    ];

    let reply: string;
    let degraded = false;
    try {
      reply = await chatText(messages, { temperature: 0.2, maxTokens: 600 });
    } catch (err) {
      console.warn(`[IA-FIN] LLM indisponible → réponse déterministe : ${safeError(err)}`);
      reply = fallbackReply(facts);
      degraded = true;
    }

    return res.json({ reply, period, facts, degraded, llm: degraded ? null : currentProviderInfo() });
  } catch (error) {
    console.error('[IA-FIN] Erreur /chat :', safeError(error));
    return res.status(500).json({ error: 'Erreur lors de l’analyse financière' });
  }
});

/* =========================================================
   GET /status : diagnostic (noms de tables/colonnes détectés, aucune donnée, aucune clé)
========================================================= */
financeRouter.get('/status', limiter, async (_req: Request, res: Response) => {
  try {
    const user = res.locals.sessionUser as SessionUser | undefined;
    if (!user?.id) return res.status(401).json({ error: 'Authentification requise' });
    const schema = await discover();
    const role = await resolveRole(user, schema);
    return res.json({
      ok: true,
      build: BUILD,
      role: role || '(non trouvé)',
      canCash: CASH_ROLES.has(role),
      canFuel: CASH_ROLES.has(role) || role === 'capitaine',
      cash: schema.cash ?? null,
      fuel: schema.fuel ?? null,
      users: schema.users ? { table: schema.users.table, hasRole: !!schema.users.role } : null,
      llm: currentProviderInfo(),
      keys: { groq: Boolean((process.env.GROQ_API_KEY || '').trim()), openai: Boolean((process.env.OPENAI_API_KEY || '').trim()) },
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: safeError(error) });
  }
});

export default financeRouter;