import { Router } from 'express';
import type { PoolClient, QueryResultRow } from 'pg';
import { v4 as uuid } from 'uuid';
import { pool } from '../db.js';

/*
 * POST /api/fuelconsumptions/refuel
 *
 * Enregistre un plein ET son mouvement de caisse (débit) dans UNE transaction :
 * si l'un des deux échoue, rien n'est écrit.
 *
 * Corps attendu : { tripId, quantity, fuelPrice, fuelType?, confirm? }
 *  - erreurs bloquantes  -> 400 { error }
 *  - anomalies probables -> 409 { needsConfirmation: true, warnings: string[] }
 *    (le front redemande confirmation puis renvoie la même requête avec confirm: true)
 */

export const fuelRouter = Router();

// Les colonnes réelles sont lues une fois dans information_schema, pour ne jamais
// insérer une colonne qui n'existe pas (la structure exacte des tables varie).
const columnCache = new Map<string, Set<string>>();
async function tableColumns(table: string): Promise<Set<string>> {
  const hit = columnCache.get(table);
  if (hit) return hit;
  const { rows } = await pool.query<{ column_name: string }>(
    'SELECT column_name FROM information_schema.columns WHERE table_name = $1',
    [table]
  );
  const set = new Set(rows.map((r) => r.column_name));
  if (set.size > 0) columnCache.set(table, set);
  return set;
}

const q = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

async function insertRow(
  client: PoolClient,
  table: string,
  values: Record<string, unknown>
): Promise<QueryResultRow> {
  const existing = await tableColumns(table);
  const columns = Object.keys(values).filter((c) => existing.has(c) && values[c] !== undefined);
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await client.query(
    `INSERT INTO ${q(table)} (${columns.map(q).join(', ')}) VALUES (${placeholders}) RETURNING *`,
    columns.map((c) => values[c])
  );
  return rows[0];
}

const fmt = (n: number) => Math.round(n).toLocaleString('fr-FR');

fuelRouter.post('/refuel', async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const tripId = String(body.tripId ?? '').trim();
  const quantity = Number(body.quantity);
  const fuelPrice = Number(body.fuelPrice);
  const fuelType = String(body.fuelType ?? '').trim() || 'Gasoil';
  const confirm = body.confirm === true;
  const sessionUser = (req as unknown as { user?: { id?: string } }).user;
  const userId = String(sessionUser?.id ?? body.userId ?? '');

  // ---- Contrôles bloquants -------------------------------------------------
  if (!tripId) return res.status(400).json({ error: 'Veuillez sélectionner un voyage.' });
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return res.status(400).json({ error: 'La quantité doit être supérieure à 0.' });
  }
  if (!Number.isFinite(fuelPrice) || fuelPrice <= 0) {
    return res.status(400).json({ error: 'Le prix par litre doit être supérieur à 0.' });
  }

  try {
    const boatCols = await tableColumns('boats');
    const fuelCols = await tableColumns('fuelconsumptions');
    const tankSelect = boatCols.has('tankCapacity') ? 'b."tankCapacity"::float AS tank' : 'NULL::float AS tank';

    const tripRes = await pool.query(
      `SELECT t.id, t."boatId", t."from", t."to", b.name AS "boatName", ${tankSelect}
         FROM trips t LEFT JOIN boats b ON b.id = t."boatId"
        WHERE t.id = $1`,
      [tripId]
    );
    if (tripRes.rows.length === 0) return res.status(404).json({ error: 'Voyage introuvable.' });
    const trip = tripRes.rows[0] as {
      id: string; boatId: string; from: string; to: string; boatName: string | null; tank: number | null;
    };

    if (trip.tank && quantity > trip.tank) {
      return res.status(400).json({
        error: `Quantité impossible : ${fmt(quantity)} L dépasse la capacité du réservoir (${fmt(trip.tank)} L).`,
      });
    }

    // ---- Contrôles de vraisemblance (avertissements à confirmer) -------------
    const warnings: string[] = [];

    const priceRes = await pool.query(
      `SELECT AVG("fuelPrice")::float AS avg, COUNT(*)::int AS n
         FROM fuelconsumptions
        WHERE "fuelType" = $1 AND "fuelPrice" > 0
          AND "createdAt"::timestamptz >= now() - interval '90 days'`,
      [fuelType]
    );
    const { avg: avgPrice, n: nPrice } = priceRes.rows[0] as { avg: number | null; n: number };
    if (avgPrice && nPrice >= 3 && Math.abs(fuelPrice - avgPrice) / avgPrice > 0.3) {
      warnings.push(
        `Prix de ${fmt(fuelPrice)} Ar/L très éloigné de la moyenne des 90 derniers jours (${fmt(avgPrice)} Ar/L).`
      );
    }

    if (fuelCols.has('quantity')) {
      const qtyRes = await pool.query(
        `SELECT AVG(f.quantity)::float AS avg, COUNT(*)::int AS n
           FROM fuelconsumptions f JOIN trips t ON t.id = f."tripId"
          WHERE t."boatId" = $1 AND f.quantity > 0`,
        [trip.boatId]
      );
      const { avg: avgQty, n: nQty } = qtyRes.rows[0] as { avg: number | null; n: number };
      if (avgQty && nQty >= 3 && Math.abs(quantity - avgQty) / avgQty > 0.4) {
        warnings.push(
          `Quantité de ${fmt(quantity)} L très éloignée de la moyenne de ce bateau (${fmt(avgQty)} L par plein).`
        );
      }

      const dupRes = await pool.query(
        `SELECT 1 FROM fuelconsumptions
          WHERE "tripId" = $1 AND quantity = $2
            AND "createdAt"::timestamptz >= now() - interval '24 hours' LIMIT 1`,
        [tripId, quantity]
      );
      if (dupRes.rows.length > 0) {
        warnings.push('Un plein identique (même voyage, même quantité) a déjà été saisi dans les dernières 24 h.');
      }
    }

    if (warnings.length > 0 && !confirm) {
      return res.status(409).json({ needsConfirmation: true, warnings });
    }

    // ---- Transaction : plein + mouvement de caisse ---------------------------
    const now = new Date().toISOString();
    const cost = Math.round(quantity * fuelPrice * 100) / 100;
    const route = `${trip.from} → ${trip.to}`;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const fuel = await insertRow(client, 'fuelconsumptions', {
        id: uuid(),
        tripId,
        quantity,
        fuelType,
        fuelPrice,
        cost,
        userId,
        createdAt: now,
      });

      const cashMovement = await insertRow(client, 'cashmovements', {
        id: uuid(),
        designation: `Carburant – ${trip.boatName ?? 'bateau'} (${route})`,
        credit: 0,
        debit: cost,
        type: 'debit',
        tripId,
        userId,
        date: now,
      });

      await client.query('COMMIT');
      res.status(201).json({ fuel, cashMovement, warnings });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(err);
    const e = err as { message?: string; code?: string };
    res.status(500).json({ error: "Erreur lors de l'enregistrement du plein.", message: e?.message, code: e?.code });
  }
});