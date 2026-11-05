import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import { flushOutbox } from './ai.js';
import { notificationsEnabled } from '../services/notifications.js';

const router = Router();

// Valeurs autorisées par la contrainte chk_reservation_status de la base
const statusSchema = z.object({
  status: z.enum(['EN_ATTENTE', 'CONFIRMEE', 'REFUSEE', 'ANNULEE', 'NO_SHOW', 'TERMINEE']),
  reason: z.string().trim().max(300).optional(), // motif (utile pour un refus)
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

// Notification : écrite dans l'outbox puis envoyée (e-mail / WhatsApp / n8n).
// En "meilleur effort" : une erreur ici ne casse jamais le changement de statut.
async function queueNotification(
  eventType: string,
  reservationId: string,
  userId: string | null,
  motif?: string,
) {
  if (!notificationsEnabled()) return;
  try {
    const { rows } = await pool.query(
      `SELECT r."clientName" AS client_nom, r.quantity AS quantite, r.weight::float AS poids_kg,
              r."totalPrice"::float AS total,
              t."from" AS depart, t."to" AS arrivee,
              to_char(t.depart::date, 'YYYY-MM-DD') AS date,
              b.name AS navire
       FROM reservations r
       LEFT JOIN trips t ON t.id = r."tripId"
       LEFT JOIN boats b ON b.id = t."boatId"
       WHERE r.id = $1`,
      [reservationId],
    );

    // Contact du client : requête séparée, si elle échoue on notifie quand même l'admin
    let contact: { email?: string; tel?: string } = {};
    if (userId) {
      try {
        const u = await pool.query(`SELECT email, tel FROM "user" WHERE id = $1`, [userId]);
        contact = { email: u.rows[0]?.email ?? undefined, tel: u.rows[0]?.tel ?? undefined };
      } catch (err) {
        console.warn('Contact client introuvable (colonnes "user" ?) :', err);
      }
    }

    const payload = {
      numero: reservationId.slice(0, 8),
      ...(rows[0] ?? {}),
      email: contact.email ?? '',
      telephone: contact.tel ?? '',
      motif: motif ?? '',
    };

    await pool.query(
      `INSERT INTO notification_outbox (event, reservation_id, payload)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (event, reservation_id) DO NOTHING`,
      [eventType, reservationId, JSON.stringify(payload)],
    );
    void flushOutbox(); // sans attendre : une lenteur d'envoi ne retarde pas la réponse
  } catch (error) {
    console.error('Notification non mise en file:', error);
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
  const reason = parsed.data.reason;
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
      await recordReservationEvent(reservationId, eventType, {
        reservationId,
        previousStatus: currentStatus,
        nextStatus,
        userId,
        tripId,
        totalPrice,
        reason: reason ?? null,
        updatedBy: res.locals.sessionUser?.id ?? null,
        updatedAt: new Date().toISOString(),
      });

      await queueNotification(eventType, reservationId, userId ?? null, reason);
    }

    return res.json({ id: rows[0].id, status: rows[0].status });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Erreur lors de la mise à jour du statut' });
  }
});

export default router;