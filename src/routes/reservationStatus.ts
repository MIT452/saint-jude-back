import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import { notifyN8n } from '../services/notify.js';

const router = Router();

// Valeurs autorisées par la contrainte chk_reservation_status de la base
const statusSchema = z.object({
  status: z.enum(['EN_ATTENTE', 'CONFIRMEE', 'REFUSEE', 'ANNULEE', 'NO_SHOW', 'TERMINEE']),
});

// Transitions autorisées (ANNULEE, REFUSEE, NO_SHOW, TERMINEE sont des états finaux)
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  EN_ATTENTE: ['CONFIRMEE', 'ANNULEE', 'REFUSEE'],
  CONFIRMEE: ['ANNULEE', 'TERMINEE', 'NO_SHOW'],
  ANNULEE: [],
  REFUSEE: [],
  NO_SHOW: [],
  TERMINEE: [],
};

// Événement métier émis pour chaque nouveau statut
const EVENT_BY_STATUS: Record<string, string> = {
  CONFIRMEE: 'reservation.confirmed',
  REFUSEE: 'reservation.refused',
  ANNULEE: 'reservation.cancelled',
  NO_SHOW: 'reservation.no_show',
  TERMINEE: 'reservation.completed',
};

// Historique : en "meilleur effort", ne doit jamais empêcher le changement de statut
async function recordReservationEvent(
  reservationId: string,
  eventType: string,
  payload: Record<string, unknown>,
) {
  try {
    await pool.query(
      `INSERT INTO reservation_events (reservation_id, event_type, payload)
       VALUES ($1, $2, $3::jsonb)`,
      [reservationId, eventType, JSON.stringify(payload)],
    );
  } catch (error) {
    console.error('Historique de réservation non enregistré:', error);
  }
}

// Le contrôle d'accès (admin / propriétaire de la réservation) est fait par
// reservationAccessGuard, monté juste avant ce routeur dans server.ts.

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT
        id,
        status,
        date,
        quantity,
        weight::float AS weight,
        "totalPrice"::float AS "totalPrice",
        "amountPaid"::float AS "amountPaid",
        "amountToPay"::float AS "amountToPay",
        "paymentStatus" AS "paymentStatus",
        "tripId" AS "tripId",
        "userId" AS "userId"
       FROM reservations
       WHERE id = $1`,
      [req.params.id],
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Réservation introuvable' });
    }

    return res.json(rows[0]);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Erreur lors de la lecture du statut de la réservation' });
  }
});

router.patch('/:id/status', async (req: Request, res: Response) => {
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Statut invalide',
      allowed: statusSchema.shape.status.options,
    });
  }

  const nextStatus = parsed.data.status;
  const reservationId = req.params.id;

  try {
    const current = await pool.query(
      `SELECT status, "tripId" AS "tripId", "userId" AS "userId", "totalPrice"::float AS "totalPrice"
       FROM reservations
       WHERE id = $1`,
      [reservationId],
    );

    if (current.rows.length === 0) {
      return res.status(404).json({ error: 'Réservation introuvable' });
    }

    const { status: currentStatus, tripId, userId, totalPrice } = current.rows[0];

    // Même statut : rien à faire, aucun événement ni notification
    if (currentStatus === nextStatus) {
      return res.json({ id: reservationId, status: currentStatus });
    }

    if (!(ALLOWED_TRANSITIONS[currentStatus] ?? []).includes(nextStatus)) {
      return res.status(409).json({ error: `Transition ${currentStatus} → ${nextStatus} interdite` });
    }

    // Mise à jour atomique : échoue si le statut a changé entre la lecture et l'écriture
    const { rows } = await pool.query(
      `UPDATE reservations
       SET status = $1
       WHERE id = $2 AND status = $3
       RETURNING id, status`,
      [nextStatus, reservationId, currentStatus],
    );

    if (rows.length === 0) {
      return res.status(409).json({ error: 'La réservation a été modifiée entre-temps, réessaie' });
    }

    const eventType = EVENT_BY_STATUS[nextStatus];
    if (eventType) {
      const updatedBy = res.locals.sessionUser?.id ?? null;
      const eventData = {
        reservationId,
        previousStatus: currentStatus,
        nextStatus,
        userId,
        tripId,
        totalPrice,
        updatedBy,
      };

      await recordReservationEvent(reservationId, eventType, {
        ...eventData,
        updatedAt: new Date().toISOString(),
      });

      // Pas de await : une lenteur de n8n ne doit pas retarder la réponse
      void notifyN8n(eventType, eventData);
    }

    return res.json({ id: rows[0].id, status: rows[0].status });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Erreur lors de la mise à jour du statut' });
  }
});

export default router;