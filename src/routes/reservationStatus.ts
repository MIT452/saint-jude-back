import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';

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

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT
        id,
        status,
        date,
        quantity,
        weight::float AS weight,
        "totalPrice"::float AS totalPrice,
        "amountPaid"::float AS amountPaid,
        "amountToPay"::float AS amountToPay,
        "paymentStatus" AS paymentStatus,
        "tripId" AS tripId,
        "userId" AS userId
       FROM reservations
       WHERE id = $1`,
      [req.params.id]
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

  try {
    const current = await pool.query('SELECT status FROM reservations WHERE id = $1', [req.params.id]);
    if (current.rows.length === 0) {
      return res.status(404).json({ error: 'Réservation introuvable' });
    }

    const currentStatus: string = current.rows[0].status;
    if (currentStatus !== nextStatus && !(ALLOWED_TRANSITIONS[currentStatus] ?? []).includes(nextStatus)) {
      return res.status(409).json({ error: `Transition ${currentStatus} → ${nextStatus} interdite` });
    }

    const { rows } = await pool.query(
      `UPDATE reservations
       SET status = $1
       WHERE id = $2
       RETURNING id, status`,
      [nextStatus, req.params.id]
    );

    return res.json({ id: rows[0].id, status: rows[0].status });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Erreur lors de la mise à jour du statut' });
  }
});

export default router;