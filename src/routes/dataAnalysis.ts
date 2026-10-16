import { Router, type Request, type Response } from 'express';
import { pool } from '../db.js';

export const dataAnalysisRouter = Router();

/* =========================
   OUTILS
========================= */

// Les dates sont stockées en texte (date, depart, embarkDate) : ce cast ne plante pas
// si une valeur n'est pas au format AAAA-MM-JJ, il renvoie NULL pour cette ligne.
const safeDate = (column: string) =>
  `(CASE WHEN ${column} ~ '^\\d{4}-\\d{2}-\\d{2}' THEN LEFT(${column}, 10)::date END)`;

// Réservations valides = ni annulées ni refusées
const NOT_CANCELLED = `UPPER(r.status) NOT LIKE 'ANNUL%' AND UPPER(r.status) NOT LIKE 'REFUS%'`;

const pad = (n: number) => String(n).padStart(2, '0');
const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// Période : par défaut du 1er du mois jusqu'à aujourd'hui
const getRange = (query: Request['query']): [string, string] => {
  const now = new Date();
  const from =
    typeof query.from === 'string' && query.from
      ? query.from
      : fmt(new Date(now.getFullYear(), now.getMonth(), 1));
  const to = typeof query.to === 'string' && query.to ? query.to : fmt(now);
  return [from, to];
};

const fail = (res: Response, label: string, error: unknown) => {
  console.error(`[data-analysis] ${label}`, error);
  return res.status(500).json({ message: `Erreur analyse ${label}` });
};

/* =========================
   1) CAISSE : crédits, débits, solde net + courbe par jour
   GET /api/analytics/cash?from=AAAA-MM-JJ&to=AAAA-MM-JJ
========================= */
dataAnalysisRouter.get('/cash', async (req, res) => {
  try {
    const [from, to] = getRange(req.query);
    const day = safeDate('c."date"');

    const totals = await pool.query(
      `SELECT COALESCE(SUM(c."credit"), 0)::float AS credits,
              COALESCE(SUM(c."debit"), 0)::float AS debits
       FROM cashmovements c
       WHERE ${day} BETWEEN $1 AND $2`,
      [from, to]
    );

    const daily = await pool.query(
      `SELECT to_char(${day}, 'YYYY-MM-DD') AS day,
              COALESCE(SUM(c."credit"), 0)::float AS credits,
              COALESCE(SUM(c."debit"), 0)::float AS debits
       FROM cashmovements c
       WHERE ${day} BETWEEN $1 AND $2
       GROUP BY ${day}
       ORDER BY ${day}`,
      [from, to]
    );

    const { credits, debits } = totals.rows[0];
    return res.json({ credits, debits, net: credits - debits, daily: daily.rows });
  } catch (error) {
    return fail(res, 'caisse', error);
  }
});

/* =========================
   2) CARBURANT PAR BATEAU (la 1re ligne = plus gros consommateur)
   GET /api/analytics/fuel/by-boat
   Le carburant est lié au bateau via fuelconsumptions.tripId -> trips.boatId
========================= */
dataAnalysisRouter.get('/fuel/by-boat', async (req, res) => {
  try {
    const [from, to] = getRange(req.query);
    const { rows } = await pool.query(
      `SELECT b.name AS boat,
              COALESCE(SUM(f."quantity"), 0)::float AS liters,
              COALESCE(SUM(f."cost"), 0)::float AS cost
       FROM fuelconsumptions f
       JOIN trips t ON t.id = f."tripId"
       JOIN boats b ON b.id = t."boatId"
       WHERE f."createdAt"::date BETWEEN $1 AND $2
       GROUP BY b.name
       ORDER BY liters DESC`,
      [from, to]
    );
    return res.json(rows);
  } catch (error) {
    return fail(res, 'carburant par bateau', error);
  }
});

/* =========================
   3) CARBURANT PAR TRAJET
   GET /api/analytics/fuel/by-trip
========================= */
dataAnalysisRouter.get('/fuel/by-trip', async (req, res) => {
  try {
    const [from, to] = getRange(req.query);
    const { rows } = await pool.query(
      `SELECT t."from" || ' → ' || t."to" AS trip,
              COALESCE(SUM(f."quantity"), 0)::float AS liters,
              COALESCE(SUM(f."cost"), 0)::float AS cost
       FROM fuelconsumptions f
       JOIN trips t ON t.id = f."tripId"
       WHERE f."createdAt"::date BETWEEN $1 AND $2
       GROUP BY t."from", t."to"
       ORDER BY liters DESC`,
      [from, to]
    );
    return res.json(rows);
  } catch (error) {
    return fail(res, 'carburant par trajet', error);
  }
});

/* =========================
   4) RÉSERVATIONS : statuts, clients, annulations, places restantes
   GET /api/analytics/reservations
========================= */
dataAnalysisRouter.get('/reservations', async (req, res) => {
  try {
    const [from, to] = getRange(req.query);
    const resDay = safeDate('r."date"');
    const tripDay = safeDate('t."depart"');

    const byStatus = await pool.query(
      `SELECT r.status, COUNT(*)::int AS total
       FROM reservations r
       WHERE ${resDay} BETWEEN $1 AND $2
       GROUP BY r.status
       ORDER BY total DESC`,
      [from, to]
    );

    const clients = await pool.query(
      `SELECT COUNT(DISTINCT r."clientTel")::int AS clients
       FROM reservations r
       WHERE ${resDay} BETWEEN $1 AND $2`,
      [from, to]
    );

    // Places restantes = capacité du bateau - quantité réservée (hors annulées/refusées)
    const places = await pool.query(
      `SELECT t.id,
              t."from" || ' → ' || t."to" AS trip,
              b.name AS boat,
              COALESCE(b.capacity, 0)::int AS capacity,
              GREATEST(0, COALESCE(b.capacity, 0)
                - COALESCE(SUM(r."quantity") FILTER (WHERE ${NOT_CANCELLED}), 0))::int AS places_left
       FROM trips t
       LEFT JOIN boats b ON b.id = t."boatId"
       LEFT JOIN reservations r ON r."tripId" = t.id
       WHERE ${tripDay} BETWEEN $1 AND $2
       GROUP BY t.id, t."from", t."to", t.depart, b.name, b.capacity
       ORDER BY t.depart`,
      [from, to]
    );

    const cancelled = byStatus.rows
      .filter((row) => /^(ANNUL|REFUS)/i.test(row.status ?? ''))
      .reduce((sum, row) => sum + row.total, 0);

    return res.json({
      byStatus: byStatus.rows,
      clients: clients.rows[0].clients,
      cancelled,
      places: places.rows,
    });
  } catch (error) {
    return fail(res, 'réservations', error);
  }
});

/* =========================
   5) MARCHANDISES : quantités, recettes, poids, mouvements
   GET /api/analytics/goods
========================= */
dataAnalysisRouter.get('/goods', async (req, res) => {
  try {
    const [from, to] = getRange(req.query);
    const day = safeDate('g."embarkDate"');
    const { rows } = await pool.query(
      `SELECT g."itemName" AS good,
              COALESCE(SUM(g."quantity"), 0)::float AS quantity,
              COALESCE(SUM(g."totalPrice"), 0)::float AS revenue,
              COALESCE(SUM(g."totalWeight"), 0)::float AS weight,
              COUNT(*)::int AS movements
       FROM goods g
       WHERE ${day} BETWEEN $1 AND $2
       GROUP BY g."itemName"
       ORDER BY revenue DESC`,
      [from, to]
    );
    return res.json(rows);
  } catch (error) {
    return fail(res, 'marchandises', error);
  }
});