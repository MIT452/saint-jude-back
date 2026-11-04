import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { pool } from '../db.js';
import { emitPosition } from '../realtime.js';

export function buildLatestPositionResponse(rows: Array<Record<string, unknown>> | []) {
  return rows.length === 0 ? null : rows[0];
}

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

// Dernière position de plusieurs bateaux en UN seul appel : un bateau sans position est
// simplement absent de la réponse (pas de 404 répétés dans la console du navigateur).
// À déclarer avant '/:boatId/latest'.
positionsRouter.get('/latest', async (req, res) => {
  const ids = String(req.query.boatIds ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .slice(0, 50);
  if (ids.length === 0) return res.json([]);
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON ("boatId") "boatId", latitude::float AS latitude, longitude::float AS longitude,
              speed::float AS speed, "createdAt"
       FROM positions WHERE "boatId" = ANY($1::text[])
       ORDER BY "boatId", "createdAt" DESC`,
      [ids]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur lors de la lecture' });
  }
});

positionsRouter.get('/:boatId/latest', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT latitude::float AS latitude, longitude::float AS longitude, speed::float AS speed, "createdAt"
       FROM positions WHERE "boatId" = $1 ORDER BY "createdAt" DESC LIMIT 1`,
      [req.params.boatId]
    );

    res.json(buildLatestPositionResponse(rows));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur lors de la lecture' });
  }
});