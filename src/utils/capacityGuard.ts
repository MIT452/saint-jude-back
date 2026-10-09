import type { Request, Response, NextFunction } from 'express';
import { pool } from '../db.js';

const INACTIVE = ['REFUSEE', 'REFUSÉE', 'ANNULEE', 'ANNULÉE', 'CANCELLED', 'NO_SHOW', 'NO-SHOW'];

export async function checkCapacity(req: Request, res: Response, next: NextFunction) {
  const tripId = req.body?.tripId;
  const quantity = Number(req.body?.quantity);

  if (typeof tripId !== 'string' || !tripId.trim()) {
    return res.status(400).json({ error: 'tripId requis' });
  }
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return res.status(400).json({ error: 'Quantité invalide' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT (b.capacity - COALESCE(SUM(r.quantity), 0))::float AS restant
       FROM trips t
       JOIN boats b ON b.id = t."boatId"
       LEFT JOIN reservations r
         ON r."tripId" = t.id AND r.status <> ALL($2::text[])
       WHERE t.id = $1
       GROUP BY b.capacity`,
      [tripId.trim(), INACTIVE]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Trajet introuvable' });
    if (rows[0].restant < quantity) {
      return res.status(409).json({ error: 'Plus assez de places sur ce trajet', restant: rows[0].restant });
    }
    return next();
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Erreur de vérification de capacité' });
  }
}