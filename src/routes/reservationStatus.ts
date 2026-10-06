import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';

const router = Router();

const statusSchema = z.object({
  status: z.enum(['PENDING', 'CONFIRMED', 'CANCELLED', 'CONFIRMEE']),
});

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
  try {
    const { status } = statusSchema.parse(req.body);
    const normalizedStatus = status === 'CONFIRMEE' ? 'CONFIRMED' : status;
    const { rows } = await pool.query(
      `UPDATE reservations
       SET status = $1
       WHERE id = $2
       RETURNING id, status`,
      [normalizedStatus, req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Réservation introuvable' });
    }

    return res.json({ id: rows[0].id, status: rows[0].status });
  } catch (error) {
    console.error(error);
    return res.status(400).json({
      error: error instanceof Error ? error.message : 'Statut invalide',
    });
  }
});

export default router;
