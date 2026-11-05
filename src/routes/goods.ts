import { Router } from 'express';
import { pool } from '../db';
import { priceFor, HttpError } from '../services/pricing';

const router = Router();

router.post('/', async (req, res, next) => {
  try {
    const { reservationId, type, weightKg, quantity, totalPrice, overrideReason } = req.body;
    const price = await priceFor({ type, weightKg, requestedTotal: totalPrice, overrideReason });
    const { rows } = await pool.query(
      `INSERT INTO goods (reservation_id, type, weight_kg, quantity, total_price,
                          price_flag, price_override_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [reservationId, type.trim().toLowerCase(), weightKg, quantity,
       price.total, price.flag, price.reason]);
    res.status(201).json(rows[0]);
  } catch (e) { next(e); }
});

// POINT 2 : une seule source pour les cartes ET les filtres
router.get('/stats', async (_req, res, next) => {
  try {
    const { rows: [s] } = await pool.query(`
      SELECT
        count(DISTINCT r.id)::int AS reservations,
        count(g.id)::int          AS marchandises,
        count(DISTINCT r.id) FILTER (WHERE r.status = 'EN_ATTENTE')::int AS en_attente,
        count(DISTINCT r.id) FILTER (WHERE r.status = 'CONFIRMEE')::int  AS confirmees,
        count(DISTINCT r.id) FILTER (WHERE r.status = 'EN_TRANSIT')::int AS en_transit,
        count(DISTINCT r.id) FILTER (WHERE r.status = 'LIVREE')::int     AS livrees,
        count(DISTINCT r.id) FILTER (WHERE p.payment_status = 'IMPAYE')::int  AS impayees,
        count(DISTINCT r.id) FILTER (WHERE p.payment_status = 'PARTIEL')::int AS partiels,
        count(DISTINCT r.id) FILTER (WHERE p.payment_status = 'SOLDE')::int   AS soldees,
        COALESCE(SUM(g.total_price), 0)::numeric AS valeur_totale
      FROM reservations r
      LEFT JOIN goods g ON g.reservation_id = r.id
      LEFT JOIN v_reservation_payment p ON p.reservation_id = r.id`);
    const { rows: types } = await pool.query(
      `SELECT type, count(*)::int AS marchandises FROM goods GROUP BY type ORDER BY 2 DESC`);
    res.json({ ...s, types });
  } catch (e) { next(e); }
});

// POINT 4 : la liste renvoie directement les noms de ports (plus aucun code abrégé)
router.get('/', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT g.*, r.status AS logistic_status, p.payment_status,
             pf.name AS from_name, pt.name AS to_name, t.departure_at
      FROM goods g
      JOIN reservations r ON r.id = g.reservation_id
      JOIN trips t        ON t.id = r.trip_id
      JOIN places pf      ON pf.id = t.from_place_id   -- adapter les noms de colonnes
      JOIN places pt      ON pt.id = t.to_place_id
      LEFT JOIN v_reservation_payment p ON p.reservation_id = r.id
      ORDER BY t.departure_at DESC`);
    res.json(rows);
  } catch (e) { next(e); }
});

export default router;