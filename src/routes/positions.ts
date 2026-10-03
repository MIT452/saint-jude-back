import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { pool } from '../db.js';
import { emitPosition } from '../realtime.js';

export const positionsRouter = Router();

positionsRouter.post('/', async (req, res) => {
  const { boatId, latitude, longitude, speed } = req.body ?? {};
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (typeof boatId !== 'string' || !boatId || !(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180)) {
    return res.status(400).json({ error: 'boatId, latitude et longitude valides requis' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO positions (id, "boatId", latitude, longitude, speed)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, "boatId", latitude::float AS latitude, longitude::float AS longitude,
                 speed::float AS speed, "createdAt"`,
      [uuid(), boatId, lat, lon, speed == null ? null : Number(speed)]
    );
    emitPosition(rows[0]);
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur lors de l'enregistrement de la position" });
  }
});

positionsRouter.get('/:boatId/latest', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT latitude::float AS latitude, longitude::float AS longitude, speed::float AS speed, "createdAt"
       FROM positions WHERE "boatId" = $1 ORDER BY "createdAt" DESC LIMIT 1`,
      [req.params.boatId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Aucune position' });
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur lors de la lecture' });
  }
});