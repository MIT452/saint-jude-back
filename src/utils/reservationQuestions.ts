// src/utils/reservationQuestions.ts
// Répond aux QUESTIONS sur les réservations (« qui a fait réservation aujourd'hui ? »,
// « combien de réservations en attente ? »...) à partir de Neon, sans jamais lancer une
// nouvelle réservation. Renvoie null si le message n'est pas une question de ce type.

import { pool } from '../db.js';
import { formatReservationList, type ReservationLine } from './whatsappFormat.js';

export interface Viewer {
  id: string | null; // identifiant du compte (table "user"), null si numéro inconnu
  isAdmin: boolean;
}

const TIMEZONE = 'Indian/Antananarivo';
const MAX_ROWS = 20;

const strip = (s: string) =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[’']/g, "'").trim();

const dayInTz = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(d);

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// Madagascar = UTC+3 toute l'année : début de journée en instant précis
const startOfDay = (iso: string) => `${iso}T00:00:00+03:00`;

type Period = 'today' | 'yesterday' | 'week' | 'month' | null;
type StatusFilter = 'pending' | 'confirmed' | 'cancelled' | null;

const isReservationInfoQuestion = (qn: string): boolean => {
  if (!/\breserv\w*/.test(qn)) return false;

  // Phrases de réservation : on laisse le bot habituel les traiter
  if (/\b(je veux|je voudrais|je souhaite|j'aimerais|faire une reservation|nouvelle reservation|ajouter une reservation|reserver)\b/.test(qn)) {
    return false;
  }

  return /\b(qui|combien|liste|lister|quelles?|quels?|voir|affiche\w*|montre\w*|derniere?s?|dernier|y a[- ]t[- ]il|existe|mes)\b/.test(qn)
    || /\breservations?\s+(en attente|confirmee?s?|annulee?s?|refusee?s?|d'aujourd'hui|du jour|d'hier)\b/.test(qn);
};

function detectPeriod(qn: string): Period {
  if (/aujourd|ce jour|du jour|\bandroany\b/.test(qn)) return 'today';
  if (/\bhier\b/.test(qn)) return 'yesterday';
  if (/cette semaine|7 derniers jours|semaine/.test(qn)) return 'week';
  if (/ce mois|du mois/.test(qn)) return 'month';
  return null;
}

function detectStatus(qn: string): StatusFilter {
  if (/attente|pending/.test(qn)) return 'pending';
  if (/annul/.test(qn)) return 'cancelled';
  if (/confirm/.test(qn)) return 'confirmed';
  return null;
}

function periodRange(period: Period): { from: string; to: string; label: string } | null {
  const today = dayInTz(new Date());
  switch (period) {
    case 'today':
      return { from: startOfDay(today), to: startOfDay(addDays(today, 1)), label: "faites aujourd'hui" };
    case 'yesterday':
      return { from: startOfDay(addDays(today, -1)), to: startOfDay(today), label: 'faites hier' };
    case 'week':
      return { from: startOfDay(addDays(today, -6)), to: startOfDay(addDays(today, 1)), label: 'des 7 derniers jours' };
    case 'month':
      return { from: startOfDay(`${today.slice(0, 8)}01`), to: startOfDay(addDays(today, 1)), label: 'de ce mois' };
    default:
      return null;
  }
}

const STATUS_LABEL: Record<Exclude<StatusFilter, null>, string> = {
  pending: 'en attente',
  confirmed: 'confirmées',
  cancelled: 'annulées',
};

/**
 * @returns null si ce n'est pas une question sur les réservations,
 *          sinon la liste des messages WhatsApp à envoyer (déjà mis en forme).
 */
export async function answerReservationQuestion(question: string, viewer: Viewer): Promise<string[] | null> {
  const qn = strip(question);
  if (!isReservationInfoQuestion(qn)) return null;

  if (!viewer.id && !viewer.isAdmin) {
    return [
      "🔒 Je ne retrouve pas votre compte avec ce numéro WhatsApp.\nConnectez-vous sur l'application SAINT-JUDE ou vérifiez le numéro de votre profil.",
    ];
  }

  const period = detectPeriod(qn);
  const status = detectStatus(qn);
  const range = periodRange(period);
  const wantsCount = /\bcombien\b/.test(qn);

  const params: unknown[] = [];
  const where: string[] = [];

  if (!viewer.isAdmin) {
    params.push(viewer.id);
    where.push(`r."userId" = $${params.length}`);
  }
  if (range) {
    params.push(range.from);
    where.push(`r."date" >= $${params.length}::timestamptz`);
    params.push(range.to);
    where.push(`r."date" < $${params.length}::timestamptz`);
  }
  if (status === 'pending') where.push(`UPPER(COALESCE(r.status, '')) LIKE '%ATTENTE%'`);
  if (status === 'confirmed') where.push(`UPPER(COALESCE(r.status, '')) LIKE 'CONFIRM%'`);
  if (status === 'cancelled') where.push(`UPPER(COALESCE(r.status, '')) LIKE 'ANNUL%'`);

  const { rows } = await pool.query(
    `SELECT r.id, r."clientName", r.quantity, r.weight, r."totalPrice", r.status, r."paymentStatus",
            t."from" AS departure, t."to" AS destination, t.depart AS trip_date
       FROM reservations r
       LEFT JOIN trips t ON r."tripId" = t.id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY r."date" DESC
      LIMIT ${MAX_ROWS + 1}`,
    params,
  );

  const capped = rows.length > MAX_ROWS;
  const shown = rows.slice(0, MAX_ROWS);

  const parts = ['Réservations'];
  if (status) parts.push(STATUS_LABEL[status]);
  if (range) parts.push(range.label);
  if (!viewer.isAdmin) parts.push('(vos réservations)');
  const title = parts.join(' ');

  const emptyText = `😌 *${title}*\nAucune réservation trouvée.`;

  if (wantsCount && shown.length > 0) {
    const count = capped ? `plus de ${MAX_ROWS}` : String(shown.length);
    const intro = `📊 *${count}* réservation(s) ${[status ? STATUS_LABEL[status] : '', range?.label ?? ''].filter(Boolean).join(' ')}`.trim();
    const lines: ReservationLine[] = shown.map(toLine);
    const [first, ...rest] = formatReservationList(lines, { title, showTotal: true, emptyText });
    return [`${intro}\n\n${first}`, ...rest];
  }

  return formatReservationList(shown.map(toLine), {
    title,
    showTotal: true,
    emptyText,
    footer: capped ? `ℹ️ Affichage des ${MAX_ROWS} plus récentes.` : undefined,
  });
}

function toLine(r: Record<string, any>): ReservationLine {
  return {
    id: String(r.id),
    clientName: r.clientName,
    departure: r.departure,
    destination: r.destination,
    date: r.trip_date,
    quantity: r.quantity,
    weightKg: r.weight,
    totalPrice: r.totalPrice,
    status: r.status,
    paymentStatus: r.paymentStatus,
  };
}