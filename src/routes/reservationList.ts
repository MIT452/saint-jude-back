import { Router, type Request, type Response } from 'express';
import { pool } from '../db.js';
import { isAdminUser } from './reservationGuard.js';

const router = Router();

/**
 * GET /api/my-reservations[?userId=...]
 *  - client : toujours SES réservations (le paramètre userId est ignoré) ;
 *  - admin : toutes, ou celles du client demandé via ?userId=.
 * Le format de réponse est celui de ReservationRecord (frontend).
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const user = res.locals.sessionUser as { id?: string | number; role?: string } | undefined;
    if (!user?.id) return res.status(401).json({ error: 'Non connecté' });

    const wanted = typeof req.query.userId === 'string' && req.query.userId ? req.query.userId : null;
    const userId = isAdminUser(user) ? wanted : String(user.id); // null = tous (admin seulement)

    const { rows } = await pool.query(
      `SELECT r.id, r."userId"::text AS user_id, r."clientName", r."clientTel", r.quantity, r.weight,
              r."totalPrice", r.status, r.date AS created_at,
              to_char(t.depart::timestamp, 'YYYY-MM-DD"T"HH24:MI:SS') AS trip_date,
              t."from" AS dep, t."to" AS dest, t."boatId" AS boat_id, b.name AS boat_name,
              g."itemName", g.types
       FROM reservations r
       LEFT JOIN trips t ON t.id = r."tripId"
       LEFT JOIN boats b ON b.id = t."boatId"
       LEFT JOIN LATERAL (
         SELECT "itemName", types FROM goods WHERE "reservationId" = r.id LIMIT 1
       ) g ON TRUE
       WHERE ($1::text IS NULL OR r."userId"::text = $1)
       ORDER BY r.date DESC NULLS LAST
       LIMIT 500`,
      [userId],
    );

    return res.json(
      rows.map((r) => {
        const qty = Number(r.quantity) || 1;
        const kg = Number(r.weight) || 0;
        const price = Number(r.totalPrice) || 0;
        return {
          id: String(r.id),
          userId: r.user_id ?? undefined,
          clientName: r.clientName ?? '',
          clientPhone: r.clientTel ?? '',
          clientEmail: '',
          departure: r.dep ?? '',
          destination: r.dest ?? '',
          date: r.trip_date ?? '',
          boatId: r.boat_id ? String(r.boat_id) : '',
          boatName: r.boat_name ?? '',
          passengers: qty,
          cargo: r.itemName ?? '',
          cargoType: r.types ?? r.itemName ?? '',
          unitWeightKg: Math.round((kg / qty) * 100) / 100,
          totalWeightKg: kg,
          unitPrice: Math.round((price / qty) * 100) / 100,
          totalPrice: price,
          communication: 'none',
          status: String(r.status ?? ''),
          createdAt: r.created_at ? new Date(r.created_at).toISOString() : '',
          source: 'serveur',
        };
      }),
    );
  } catch (error) {
    console.error('Erreur GET /api/my-reservations:', error);
    return res.status(500).json({ error: 'Erreur lors du chargement des réservations' });
  }
});

export default router;