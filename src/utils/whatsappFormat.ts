// src/utils/whatsappFormat.ts
// Mise en forme stylisée des réservations pour WhatsApp (gras *...*, icônes par statut).
// Renvoie une liste de messages courts : au-delà de quelques lignes, WhatsApp affiche « Read more ».

export interface ReservationLine {
  id: string;
  clientName?: string | null;
  departure?: string | null;
  destination?: string | null;
  date?: string | Date | null;
  quantity?: number | string | null;
  weightKg?: number | string | null;
  totalPrice?: number | string | null;
  status?: string | null;
  paymentStatus?: boolean | string | number | null; // vrai = payé, faux = à payer, absent = non affiché
}

export interface FormatOptions {
  title?: string; // ex. « Réservations en attente »
  defaultStatus?: string; // statut utilisé si la ligne n'en a pas
  emptyText?: string;
  footer?: string;
  maxChars?: number; // taille maximale d'un message (1200 par défaut)
  cardsPerMessage?: number; // nombre maximal de cartes par message (5 par défaut)
  hotAmount?: number; // à partir de ce montant (Ar) : 🔥 (1 000 000 par défaut)
  highAmount?: number; // à partir de ce montant (Ar) : 💎 (500 000 par défaut)
  showTotal?: boolean; // ajoute le montant total dans l'en-tête
}

const TIMEZONE = 'Indian/Antananarivo';
const SEPARATOR = '━━━━━━━━━━━━━━';

const plain = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

// Retire les caractères qui casseraient la mise en forme WhatsApp (* _ ~ `)
const clean = (s: unknown) => String(s ?? '').replace(/[*_~`]/g, '').trim();

// Espaces insécables (toLocaleString fr-FR) remplacés par de vrais espaces
const nbr = (n: number) => n.toLocaleString('fr-FR').replace(/[\u202f\u00a0]/g, ' ');

const toNum = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// L'ordre compte : « en attente de confirmation » doit être reconnu comme « en attente »
const STATUSES: Array<{ re: RegExp; icon: string; label: string }> = [
  { re: /annul/, icon: '❌', label: 'Annulée' },
  { re: /refus|rejet/, icon: '🚫', label: 'Refusée' },
  { re: /attente|pending|valider/, icon: '⏳', label: 'En attente' },
  { re: /confirm|\bvalid/, icon: '✅', label: 'Confirmée' },
  { re: /termin|livr|complet/, icon: '🏁', label: 'Terminée' },
];

function statusOf(status?: string | null) {
  if (!status || !status.trim()) return null;
  const k = plain(status);
  return STATUSES.find((s) => s.re.test(k)) ?? { icon: '📌', label: clean(status) };
}

const dayInTz = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(d);

/** Date du jour à Madagascar, au format AAAA-MM-JJ. */
const todayIso = () => dayInTz(new Date());

/** Convertit une date (texte ou Date) en AAAA-MM-JJ (jour de Madagascar), ou null si illisible. */
function toIso(d?: string | Date | null): string | null {
  if (!d) return null;
  if (d instanceof Date) return Number.isNaN(d.getTime()) ? null : dayInTz(d);

  const s = String(d).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) {
    // Avec fuseau (Z ou +hh:mm) : on convertit vers le jour de Madagascar
    if (/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(s)) {
      const parsed = new Date(s);
      return Number.isNaN(parsed.getTime()) ? s.slice(0, 10) : dayInTz(parsed);
    }
    return s.slice(0, 10); // heure locale sans fuseau : on garde le jour tel quel
  }
  return null;
}

const frDate = (iso: string) => iso.split('-').reverse().join('/');

/** Ligne de date avec repère : passé, aujourd'hui, demain. */
function dateLine(d?: string | Date | null): string {
  const iso = toIso(d);
  if (!iso) return `📅 ${d ? clean(d) : '-'}`;

  const today = todayIso();
  const tomorrow = dayInTz(new Date(Date.now() + 86_400_000));

  let tag = '';
  if (iso < today) tag = '  ⚠️ passé';
  else if (iso === today) tag = "  🔔 aujourd'hui";
  else if (iso === tomorrow) tag = '  🔜 demain';
  return `📅 ${frDate(iso)}${tag}`;
}

/** Paiement : 💚 payé, 🟠 à payer, vide si inconnu. */
function payTag(v: ReservationLine['paymentStatus']): string {
  if (v === null || v === undefined || v === '') return '';
  if (v === true || v === 1) return '  💚 Payé';
  if (v === false || v === 0) return '  🟠 À payer';
  const k = plain(String(v)).trim();
  if (['true', 't', '1', 'oui', 'paye', 'payee'].includes(k)) return '  💚 Payé';
  if (['false', 'f', '0', 'non', 'impaye', 'a payer'].includes(k)) return '  🟠 À payer';
  return '';
}

/** Une réservation sous forme de carte (sans « # »). */
export function formatReservationCard(r: ReservationLine, opts: FormatOptions = {}): string {
  const st = statusOf(r.status ?? opts.defaultStatus);
  const icon = st?.icon ?? '📌';
  const label = st ? ` · ${st.label}` : '';
  const ref = String(r.id ?? '').slice(0, 8);
  const qty = toNum(r.quantity);
  const kg = toNum(r.weightKg);
  const price = toNum(r.totalPrice);

  const hotLimit = opts.hotAmount ?? 1_000_000;
  const highLimit = opts.highAmount ?? 500_000;
  let moneyIcon = '💰';
  let hot = '';
  if (price !== null && price >= hotLimit) {
    moneyIcon = '💎';
    hot = ' 🔥';
  } else if (price !== null && price >= highLimit) {
    moneyIcon = '💎';
  }

  const lines = [
    `${icon} *${clean(r.clientName) || 'Client'}*${label}`,
    `🚢 ${clean(r.departure) || '?'} ➜ ${clean(r.destination) || '?'}`,
    dateLine(r.date),
  ];

  const load = [qty !== null ? `📦 Qté ${nbr(qty)}` : '', kg !== null ? `⚖️ ${nbr(kg)} kg` : '']
    .filter(Boolean)
    .join(' · ');
  if (load) lines.push(load);

  if (price !== null) lines.push(`${moneyIcon} ${nbr(price)} Ar${hot}${payTag(r.paymentStatus)}`);
  if (ref) lines.push(`🔖 Réf. ${ref}`);
  return lines.join('\n');
}

/** Liste complète, découpée en messages courts. */
export function formatReservationList(items: ReservationLine[], opts: FormatOptions = {}): string[] {
  const title = opts.title ?? 'Réservations';
  const max = Math.min(opts.maxChars ?? 1200, 3900);
  const perMessage = Math.max(1, opts.cardsPerMessage ?? 5);

  if (items.length === 0) return [opts.emptyText ?? `😌 *${title}*\nAucune réservation pour le moment.`];

  let summary = '';
  if (opts.showTotal) {
    const sum = items.reduce((acc, r) => acc + (toNum(r.totalPrice) ?? 0), 0);
    summary = `\n💰 Total : *${nbr(sum)} Ar*`;
  }

  const header = (suite: boolean) =>
    `📋 *${title}* (${items.length})${suite ? ' · suite' : summary}\n${SEPARATOR}`;

  const messages: string[] = [];
  let current = header(false);
  let cardsInCurrent = 0;

  for (const r of items) {
    const card = formatReservationCard(r, opts);
    if (cardsInCurrent > 0 && (cardsInCurrent >= perMessage || current.length + card.length + 2 > max)) {
      messages.push(current);
      current = header(true);
      cardsInCurrent = 0;
    }
    current += `\n\n${card}`;
    cardsInCurrent += 1;
  }

  if (opts.footer) current += `\n\n${SEPARATOR}\n${opts.footer}`;
  messages.push(current);
  return messages;
}