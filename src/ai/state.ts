// src/ai/state.ts
// Mémoire de conversation (PostgreSQL / Neon) : historique + réservation en attente.
// La table est créée automatiquement au premier appel : rien à exécuter dans Neon.

import { randomUUID } from 'node:crypto';
import { pool } from '../db.js';
import type { Msg } from './llm.js';

/** Mode de paiement choisi par le client dans le chat. */
export const PAYMENT_METHODS = ['CAISSE', 'BANQUE', 'CREDIT'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_LABEL: Record<PaymentMethod, string> = {
  CAISSE: 'Caisse',
  BANQUE: 'Banque',
  CREDIT: 'Crédit',
};

/** Réservation préparée par l'IA, en attente du clic « Confirmer » (jamais enregistrée par l'IA). */
export interface Pending {
  depart: string;
  arrivee: string;
  date: string; // AAAA-MM-JJ
  quantite: number;
  poidsTotalKg: number;
  marchandise: string;
  unite?: string;
  prix?: number; // informatif : le prix est recalculé par reserveTrip à la confirmation
  boatName?: string;
  /**
   * Choix du client. Optionnel dans le type pour rester compatible avec les anciens brouillons
   * déjà en base : la route /confirm doit utiliser 'CAISSE' si la valeur est absente.
   */
  paymentMethod?: PaymentMethod;
  expiresAt: number; // timestamp ms
}

export interface Conv {
  id: string;
  userId: string | null;
  /** Uniquement les messages user / assistant (texte). Les échanges d'outils ne sont pas stockés. */
  messages: Msg[];
  pending: Pending | null;
}

const PENDING_TTL_MS = 30 * 60_000; // un brouillon oublié expire après 30 min
const MAX_STORED = 40; // messages gardés en base
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const newPendingExpiry = () => Date.now() + PENDING_TTL_MS;

let tableReady = false;
async function ensureTable() {
  if (tableReady) return;
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ai_conversations (
       id         UUID PRIMARY KEY,
       user_id    TEXT,
       messages   JSONB NOT NULL DEFAULT '[]'::jsonb,
       pending    JSONB,
       updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ai_conv_user ON ai_conversations(user_id)`);
  tableReady = true;
}

const isLive = (p: Pending | null | undefined): p is Pending =>
  !!p && typeof p.expiresAt === 'number' && p.expiresAt > Date.now();

/** Charge la conversation. Un utilisateur ne peut ouvrir que SA conversation. */
export async function loadConv(id: string | undefined, userId: string | null): Promise<Conv> {
  await ensureTable();
  if (id && UUID_RE.test(id)) {
    const { rows } = await pool.query(
      'SELECT id, user_id, messages, pending FROM ai_conversations WHERE id = $1',
      [id],
    );
    const r = rows[0];
    if (r && (r.user_id ?? null) === userId) {
      return {
        id: String(r.id),
        userId,
        messages: Array.isArray(r.messages) ? r.messages : [],
        pending: isLive(r.pending) ? r.pending : null,
      };
    }
  }
  return { id: randomUUID(), userId, messages: [], pending: null };
}

export async function saveConv(c: Conv) {
  await ensureTable();
  await pool.query(
    `INSERT INTO ai_conversations (id, user_id, messages, pending, updated_at)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, now())
     ON CONFLICT (id) DO UPDATE
       SET messages = $3::jsonb, pending = $4::jsonb, updated_at = now()`,
    [c.id, c.userId, JSON.stringify(c.messages.slice(-MAX_STORED)), c.pending ? JSON.stringify(c.pending) : null],
  );
  // ménage occasionnel : conversations inactives depuis 30 jours
  if (Math.random() < 0.01) {
    pool
      .query(`DELETE FROM ai_conversations WHERE updated_at < now() - interval '30 days'`)
      .catch(() => undefined);
  }
}

/**
 * Réclame le brouillon de façon atomique : deux clics « Confirmer » simultanés
 * ne peuvent pas créer deux réservations (le second reçoit null).
 */
export async function claimPending(id: string, userId: string | null): Promise<Pending | null> {
  await ensureTable();
  if (!UUID_RE.test(id)) return null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT pending FROM ai_conversations
       WHERE id = $1 AND user_id IS NOT DISTINCT FROM $2 FOR UPDATE`,
      [id, userId],
    );
    const pending = rows[0]?.pending as Pending | null | undefined;
    if (!isLive(pending)) {
      await client.query('COMMIT');
      return null;
    }
    await client.query(`UPDATE ai_conversations SET pending = NULL, updated_at = now() WHERE id = $1`, [id]);
    await client.query('COMMIT');
    return pending;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Garde les N derniers messages sans commencer par une réponse orpheline. */
export function trim(messages: Msg[], max: number): Msg[] {
  let m = messages.slice(-max);
  while (m.length && m[0].role !== 'user') m = m.slice(1);
  return m;
}

/** Vue publique du brouillon pour l'interface (aucune donnée interne). */
export function publicPending(p: Pending | null) {
  if (!p) return null;
  return {
    marchandise: p.marchandise,
    quantite: p.quantite,
    unite: p.unite ?? null,
    poidsTotalKg: p.poidsTotalKg,
    depart: p.depart,
    arrivee: p.arrivee,
    date: p.date,
    prix: p.prix ?? null,
    bateau: p.boatName ?? null,
    modePaiement: p.paymentMethod ?? null,
    modePaiementLabel: p.paymentMethod ? PAYMENT_LABEL[p.paymentMethod] : null,
  };
}