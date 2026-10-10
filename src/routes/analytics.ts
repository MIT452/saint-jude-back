import { Router } from 'express';
import { pool } from '../db.js';

export const analyticsRouter = Router();

// Taux de remplissage et revenus par trajet
analyticsRouter.get('/fill-rate', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT t.id AS trip_id, t."from", t."to",
             to_char(t.depart::date, 'YYYY-MM-DD') AS day,
             b.name AS boat, b.capacity,
             COALESCE(SUM(r.weight) FILTER (
               WHERE UPPER(r.status) NOT LIKE 'ANNUL%' AND UPPER(r.status) NOT LIKE 'REFUS%'), 0) AS kg_booked,
             COALESCE(SUM(r."totalPrice") FILTER (
               WHERE UPPER(r.status) NOT LIKE 'ANNUL%' AND UPPER(r.status) NOT LIKE 'REFUS%'), 0) AS revenue,
             COUNT(r.id) AS nb_reservations
      FROM trips t
      LEFT JOIN boats b ON t."boatId" = b.id
      LEFT JOIN reservations r ON r."tripId" = t.id
      GROUP BY t.id, b.name, b.capacity
      ORDER BY t.depart DESC
      LIMIT 50
    `);

    const data = rows.map((r) => {
      const capacity = Number(r.capacity) || 0;
      const kg = Number(r.kg_booked) || 0;
      return {
        ...r,
        capacity,
        kg_booked: kg,
        revenue: Number(r.revenue) || 0,
        fill_rate: capacity > 0 ? Math.min(1, kg / capacity) : 0,
      };
    });

    return res.json(data);
  } catch (error) {
    console.error('[analytics]', error);
    return res.status(500).json({ error: 'Erreur lors du calcul analytique' });
  }
});