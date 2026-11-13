// src/utils/adminCommands.ts
// Commandes du bot WhatsApp : aide, résumé (jour/semaine/mois), bateaux, voyages.
// Toutes les données viennent de Neon (jamais inventées). Le résumé est réservé aux administrateurs.

import { pool } from '../db.js';
import type { Viewer } from './reservationQuestions.js';

export type CommandKind = 'help' | 'summary' | 'boats' | 'trips';

export const ADMIN_ONLY_TEXT =
  '🔒 Cette information est réservée aux administrateurs. ' +
  'Votre numéro doit être enregistré dans votre profil Saint-Jude (champ téléphone) avec un rôle administrateur.';

const TIMEZONE = 'Indian/Antananarivo';
const SEP = '━━━━━━━━━━━━━━';
const CARDS_PER_MESSAGE = 5;

const strip = (s: string) =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[’']/g, "'").trim();

const clean = (s: unknown) => String(s ?? '').replace(/[*_~`]/g, '').trim();
const nbr = (n: number) => n.toLocaleString('fr-FR').replace(/[\u202f\u00a0]/g, ' ');
const dayInTz = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(d);
const frDate = (iso: string) => iso.split('-').reverse().join('/');

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const daysBetween = (fromIso: string, toIso: string) =>
  Math.round((Date.parse(`${toIso}T12:00:00Z`) - Date.parse(`${fromIso}T12:00:00Z`)) / 86_400_000);

// Madagascar = UTC+3 toute l'année : début de journée en instant précis
const startOfDay = (iso: string) => `${iso}T00:00:00+03:00`;

/* =========================================================
   Reconnaissance des commandes (sans base de données)
========================================================= */
// Une demande d'envoi ou de réservation ne doit jamais être prise pour une commande d'information
const BOOKING_INTENT =
  /\b(je veux|je voudrais|je souhaite|j'aimerais|reserv\w*|envoyer|expedier|transporter|acheminer|colis|sacs?|cartons?|caisses?|kg|kilos?|tonnes?)\b/;

export function matchCommand(text: string): CommandKind | null {
  const qn = strip(text);

  if (
    /^(aide|help|menu|commandes?|\?|aide \/ guide|que peux[- ]tu faire|quelles? commandes?|quelles sont les commandes)\s*[?.!]*$/.test(
      qn,
    )
  ) {
    return 'help';
  }

  const wantsSummary = /\b(resume|bilan|rapport|fais le point|faire le point|point du jour|tableau de bord|dashboard)\b/.test(qn);
  if (wantsSummary && !/\b(ma|mon|mes|je veux|envoyer|expedier|colis)\b/.test(qn)) return 'summary';

  if (/\b(bateaux?|batos?|navires?)\b/.test(qn) && !BOOKING_INTENT.test(qn)) return 'boats';

  if (/\b(voyages?|trajets?|departs?|horaires?)\b/.test(qn) && !BOOKING_INTENT.test(qn)) {
    const asks =
      /\b(aujourd\w*|demain|hier|semaine|mois|prochains?|disponibles?|programmes?|liste|quels?|quelles?|combien|y a|voir|affiche\w*|montre\w*)\b/.test(
        qn,
      ) || qn.split(/\s+/).length <= 4;
    if (asks) return 'trips';
  }
  return null;
}

type Period = 'today' | 'tomorrow' | 'yesterday' | 'week' | 'month' | null;

function detectPeriod(qn: string): Period {
  if (/demain|rahampitso/.test(qn)) return 'tomorrow';
  if (/\bhier\b/.test(qn)) return 'yesterday';
  if (/aujourd|ce jour|du jour|\bandroany\b/.test(qn)) return 'today';
  if (/semaine/.test(qn)) return 'week';
  if (/\bmois\b/.test(qn)) return 'month';
  return null;
}

/* =========================================================
   Aide
========================================================= */
function helpMessage(viewer: Viewer): string[] {
  const common = [
    '🚢 *Bateaux et voyages*',
    '• « Bateaux disponibles »',
    "• « Voyages d'aujourd'hui », « voyages de demain »",
    '• « Prochains voyages Toamasina »',
    '',
    '📦 *Envoyer une marchandise*',
    '• « Je veux envoyer 50 sacs de riz de Fianarantsoa à Toliara »',
  ];

  if (viewer.isAdmin) {
    return [
      [
        '🤖 *SAINT-JUDE IA · Aide*',
        SEP,
        'Parlez normalement, je comprends les phrases libres. Exemples :',
        '',
        '📊 *Rapports* (administrateurs)',
        '• « Résumé du jour », « bilan de la semaine », « rapport du mois »',
        '',
        '📋 *Réservations*',
        '• « Réservations en attente »',
        "• « Qui a fait réservation aujourd'hui ? »",
        '• « Combien de réservations confirmées ? »',
        '• « Réservations annulées cette semaine »',
        '',
        ...common,
        '',
        SEP,
        '✅ Toutes les données viennent de la base SAINT-JUDE.',
      ].join('\n'),
    ];
  }

  return [
    [
      '🤖 *SAINT-JUDE IA · Aide*',
      SEP,
      'Parlez normalement, je comprends les phrases libres. Exemples :',
      '',
      '📋 *Mes réservations*',
      '• « Mes réservations »',
      '• « Mes réservations en attente »',
      '',
      ...common,
      '',
      SEP,
      "ℹ️ Pour confirmer ou modifier une réservation, utilisez l'application Saint-Jude.",
    ].join('\n'),
  ];
}

/* =========================================================
   Résumé des réservations (administrateurs)
========================================================= */
function summaryRange(p: Exclude<Period, 'tomorrow' | null>): { fromIso: string; toIso: string; label: string } {
  const today = dayInTz(new Date());
  switch (p) {
    case 'yesterday':
      return { fromIso: addDays(today, -1), toIso: today, label: 'hier' };
    case 'week':
      return { fromIso: addDays(today, -6), toIso: addDays(today, 1), label: '7 derniers jours' };
    case 'month':
      return { fromIso: `${today.slice(0, 8)}01`, toIso: addDays(today, 1), label: 'ce mois' };
    default:
      return { fromIso: today, toIso: addDays(today, 1), label: "aujourd'hui" };
  }
}

const SUMMARY_SQL = `
  SELECT COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE UPPER(COALESCE(status, '')) LIKE '%ATTENTE%')::int AS pending,
         COUNT(*) FILTER (WHERE UPPER(COALESCE(status, '')) LIKE 'CONFIRM%')::int AS confirmed,
         COUNT(*) FILTER (WHERE UPPER(COALESCE(status, '')) LIKE 'ANNUL%')::int AS cancelled,
         COUNT(*) FILTER (WHERE UPPER(COALESCE(status, '')) LIKE 'REFUS%')::int AS refused,
         COALESCE(SUM("totalPrice") FILTER (WHERE UPPER(COALESCE(status, '')) NOT LIKE 'ANNUL%'
                                              AND UPPER(COALESCE(status, '')) NOT LIKE 'REFUS%'), 0) AS amount,
         COALESCE(SUM(quantity) FILTER (WHERE UPPER(COALESCE(status, '')) NOT LIKE 'ANNUL%'
                                          AND UPPER(COALESCE(status, '')) NOT LIKE 'REFUS%'), 0) AS qty,
         COALESCE(SUM(weight) FILTER (WHERE UPPER(COALESCE(status, '')) NOT LIKE 'ANNUL%'
                                        AND UPPER(COALESCE(status, '')) NOT LIKE 'REFUS%'), 0) AS kg
    FROM reservations
   WHERE "date" >= $1::timestamptz AND "date" < $2::timestamptz`;

async function buildSummary(text: string): Promise<string[]> {
  const detected = detectPeriod(strip(text));
  const period = detected === 'tomorrow' || detected === null ? 'today' : detected;
  const range = summaryRange(period);
  const len = Math.max(1, daysBetween(range.fromIso, range.toIso));
  const prevFromIso = addDays(range.fromIso, -len);
  const today = dayInTz(new Date());

  const [cur, prev, pendingAll, tripsToday] = await Promise.all([
    pool.query(SUMMARY_SQL, [startOfDay(range.fromIso), startOfDay(range.toIso)]),
    pool.query(SUMMARY_SQL, [startOfDay(prevFromIso), startOfDay(range.fromIso)]),
    pool.query(`SELECT COUNT(*)::int AS n FROM reservations WHERE UPPER(COALESCE(status, '')) LIKE '%ATTENTE%'`),
    pool.query(
      `SELECT COUNT(*)::int AS n FROM trips t
        WHERE t.depart::date = $1::date AND UPPER(COALESCE(t.status, '')) NOT LIKE 'ANNUL%'`,
      [today],
    ),
  ]);

  const c = cur.rows[0];
  const p = prev.rows[0];
  const delta = Number(c.total) - Number(p.total);
  const trend = delta > 0 ? `📈 +${delta}` : delta < 0 ? `📉 ${delta}` : '➖ stable';

  const periodText =
    len === 1 ? `${range.label} (${frDate(range.fromIso)})` : `${range.label} (${frDate(range.fromIso)} au ${frDate(addDays(range.toIso, -1))})`;
  const time = new Date().toLocaleTimeString('fr-FR', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit' });

  const lines = [
    '📊 *RAPPORT DES RÉSERVATIONS*',
    `📅 Période : ${periodText}`,
    SEP,
    `🧾 Total : *${c.total}*  ${trend} vs période précédente (${p.total})`,
    `⏳ En attente : *${c.pending}*`,
    `✅ Confirmées : *${c.confirmed}*`,
    `❌ Annulées : *${c.cancelled}*`,
  ];
  if (Number(c.refused) > 0) lines.push(`🚫 Refusées : *${c.refused}*`);
  lines.push(
    SEP,
    `💰 Montant (hors annulées/refusées) : *${nbr(Number(c.amount))} Ar*`,
    `📦 Colis : ${nbr(Number(c.qty))} · ⚖️ ${nbr(Number(c.kg))} kg`,
    SEP,
    `🔔 À traiter : *${pendingAll.rows[0].n}* réservation(s) en attente au total`,
    `🚢 Voyages aujourd'hui : *${tripsToday.rows[0].n}*`,
    '',
    `✅ Données vérifiées dans la base SAINT-JUDE le ${frDate(today)} à ${time}.`,
  );
  return [lines.join('\n')];
}

/* =========================================================
   Bateaux
========================================================= */
function boatStyle(state: string): { icon: string; kind: 'ok' | 'maint' | 'out' | 'idle' | 'build' | 'other' } {
  const k = strip(state);
  if (/maint|repar/.test(k)) return { icon: '🟠', kind: 'maint' };
  if (/hors|panne/.test(k)) return { icon: '🔴', kind: 'out' };
  if (/desarm/.test(k)) return { icon: '⚪', kind: 'idle' };
  if (/construction/.test(k)) return { icon: '🟡', kind: 'build' };
  if (/dispon|service/.test(k)) return { icon: '🟢', kind: 'ok' };
  return { icon: '🔹', kind: 'other' };
}

async function buildBoats(text: string): Promise<string[]> {
  const qn = strip(text);
  const { rows } = await pool.query('SELECT * FROM boats ORDER BY name LIMIT 100');
  const boats = rows.map((b: Record<string, any>) => ({
    name: clean(b.name ?? b.nom ?? 'Sans nom'),
    capacity: b.capacity ?? b.capacite ?? null,
    state: clean(b.state ?? b.status ?? b.etat ?? ''),
  }));

  if (boats.length === 0) return ['😌 *Bateaux*\nAucun bateau enregistré.'];

  let filter: 'ok' | 'maint' | 'out' | 'idle' | null = null;
  if (/dispon/.test(qn)) filter = 'ok';
  else if (/maint|panne|repar/.test(qn)) filter = 'maint';
  else if (/hors service/.test(qn)) filter = 'out';
  else if (/desarm/.test(qn)) filter = 'idle';

  const shown = filter ? boats.filter((b) => boatStyle(b.state).kind === filter) : boats;
  const title = filter
    ? ({ ok: 'Bateaux disponibles', maint: 'Bateaux en maintenance', out: 'Bateaux hors service', idle: 'Bateaux désarmés' } as const)[filter]
    : 'Bateaux';

  if (shown.length === 0) {
    const states = [...new Set(boats.map((b) => b.state || 'état non renseigné'))].join(', ');
    return [`😌 *${title}*\nAucun bateau dans cet état. États enregistrés : ${states}.`];
  }

  const counts = new Map<string, number>();
  for (const b of boats) {
    const icon = boatStyle(b.state).icon;
    counts.set(icon, (counts.get(icon) ?? 0) + 1);
  }
  const countLine = [...counts.entries()].map(([icon, n]) => `${icon} ${n}`).join(' · ');

  const cards = shown.map((b) => {
    const st = boatStyle(b.state);
    const cap = b.capacity !== null && b.capacity !== undefined && b.capacity !== '' ? ` · capacité ${nbr(Number(b.capacity))}` : '';
    return `${st.icon} *${b.name}* · ${b.state || 'état non renseigné'}${cap}`;
  });

  return [`🚢 *${title}* (${shown.length})\n${countLine}\n${SEP}\n${cards.join('\n')}`];
}

/* =========================================================
   Voyages
========================================================= */
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

async function fetchTrips(conds: string[], params: unknown[], limit: number) {
  const { rows } = await pool.query(
    `SELECT to_char(t.depart::date, 'YYYY-MM-DD') AS day,
            to_char(t.depart::timestamp, 'HH24:MI') AS hour,
            t."from" AS dep, t."to" AS dest, t."pricePerKg" AS price_per_kg,
            b.name AS boat_name, b.capacity, ${USED_SQL} AS used
       FROM trips t
       LEFT JOIN boats b ON t."boatId" = b.id
      WHERE UPPER(COALESCE(t.status, '')) NOT LIKE 'ANNUL%' AND ${BOAT_USABLE}
        ${conds.length ? `AND ${conds.join(' AND ')}` : ''}
      ORDER BY t.depart ASC
      LIMIT ${limit}`,
    params,
  );
  return rows as Array<Record<string, any>>;
}

function tripCard(r: Record<string, any>): string {
  const today = dayInTz(new Date());
  const tomorrow = addDays(today, 1);
  const tag =
    r.day < today ? '  ⚠️ passé' : r.day === today ? "  🔔 aujourd'hui" : r.day === tomorrow ? '  🔜 demain' : '';
  const hour = r.hour && r.hour !== '00:00' ? ` · ${r.hour}` : '';

  const lines = [`🚢 *${clean(r.dep)} ➜ ${clean(r.dest)}*`, `📅 ${frDate(r.day)}${hour}${tag}`];
  if (r.boat_name) lines.push(`⛴️ Navire ${clean(r.boat_name)}`);

  const extra: string[] = [];
  if (Number(r.price_per_kg) > 0) extra.push(`💰 ${nbr(Number(r.price_per_kg))} Ar/kg`);
  if (r.capacity !== null && r.capacity !== undefined) {
    extra.push(`🎟️ ${nbr(Math.max(0, Number(r.capacity) - Number(r.used)))} place(s) restante(s)`);
  }
  if (extra.length) lines.push(extra.join(' · '));
  return lines.join('\n');
}

function chunkCards(title: string, cards: string[]): string[] {
  const messages: string[] = [];
  for (let i = 0; i < cards.length; i += CARDS_PER_MESSAGE) {
    const head = `📋 *${title}* (${cards.length})${i > 0 ? ' · suite' : ''}\n${SEP}`;
    messages.push(`${head}\n\n${cards.slice(i, i + CARDS_PER_MESSAGE).join('\n\n')}`);
  }
  return messages;
}

async function buildTrips(text: string): Promise<string[]> {
  const qn = strip(text);
  const period = detectPeriod(qn);
  const today = dayInTz(new Date());

  // Ports cités dans la question (noms lus dans Neon)
  const places = await pool.query(`SELECT DISTINCT "from" AS name FROM trips UNION SELECT DISTINCT "to" AS name FROM trips`);
  const mentioned = places.rows
    .map((r: Record<string, any>) => String(r.name ?? '').trim())
    .filter(Boolean)
    .map((name: string) => ({ name, i: qn.indexOf(strip(name)) }))
    .filter((x: { name: string; i: number }) => x.i >= 0)
    .sort((a: { i: number }, b: { i: number }) => a.i - b.i)
    .map((x: { name: string }) => x.name);

  const portConds: string[] = [];
  const portParams: unknown[] = [];
  if (mentioned.length >= 2) {
    portParams.push(mentioned[0], mentioned[1]);
    portConds.push(
      `((LOWER(t."from") = LOWER($1) AND LOWER(t."to") = LOWER($2)) OR (LOWER(t."from") = LOWER($2) AND LOWER(t."to") = LOWER($1)))`,
    );
  } else if (mentioned.length === 1) {
    portParams.push(mentioned[0]);
    portConds.push(`(LOWER(t."from") = LOWER($1) OR LOWER(t."to") = LOWER($1))`);
  }
  const portLabel = mentioned.length >= 2 ? ` ${mentioned[0]} ↔ ${mentioned[1]}` : mentioned.length === 1 ? ` · ${mentioned[0]}` : '';

  const n = portParams.length;
  const dayCond = (iso: string) => ({ cond: `t.depart::date = $${n + 1}::date`, params: [...portParams, iso] });
  const rangeCond = (fromIso: string, toIso: string) => ({
    cond: `t.depart::date >= $${n + 1}::date AND t.depart::date < $${n + 2}::date`,
    params: [...portParams, fromIso, toIso],
  });

  let title = 'Prochains voyages';
  let q: { cond: string; params: unknown[] };
  switch (period) {
    case 'today':
      title = "Voyages d'aujourd'hui";
      q = dayCond(today);
      break;
    case 'tomorrow':
      title = 'Voyages de demain';
      q = dayCond(addDays(today, 1));
      break;
    case 'yesterday':
      title = "Voyages d'hier";
      q = dayCond(addDays(today, -1));
      break;
    case 'week':
      title = 'Voyages des 7 prochains jours';
      q = rangeCond(today, addDays(today, 7));
      break;
    case 'month':
      title = 'Voyages des 30 prochains jours';
      q = rangeCond(today, addDays(today, 30));
      break;
    default:
      q = { cond: `t.depart::date >= $${n + 1}::date`, params: [...portParams, today] };
  }

  const rows = await fetchTrips([...portConds, q.cond], q.params, 10);
  if (rows.length > 0) return chunkCards(`${title}${portLabel}`, rows.map(tripCard));

  // Rien ce jour-là : on propose les prochains départs réels (même ports si cités)
  const next = await fetchTrips(
    [...portConds, `t.depart::date >= $${n + 1}::date`],
    [...portParams, today],
    3,
  );
  const none = `😌 *${title}${portLabel}*\nAucun voyage programmé.`;
  if (next.length === 0) return [none];
  return [none, ...chunkCards(`Prochains départs${portLabel}`, next.map(tripCard))];
}

/* =========================================================
   Point d'entrée
========================================================= */
export async function runCommand(kind: CommandKind, text: string, viewer: Viewer): Promise<string[]> {
  switch (kind) {
    case 'help':
      return helpMessage(viewer);
    case 'summary':
      return viewer.isAdmin ? buildSummary(text) : [ADMIN_ONLY_TEXT];
    case 'boats':
      return buildBoats(text);
    case 'trips':
      return buildTrips(text);
  }
}