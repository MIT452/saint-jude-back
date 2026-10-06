import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getReservationModel, planReservation } from '../ai/reservationPlanner.js';

export const normalizeReservationRequest = (body: unknown) => {
  const schema = z.object({
    message: z.string().trim().min(3).max(2000),
  });
  return schema.parse(body);
};

const router = Router();

router.post('/plan', async (req: Request, res: Response) => {
  try {
    const { message } = normalizeReservationRequest(req.body);
    const proposal = await planReservation(message);

    res.json({
      status: 'proposal',
      provider: getReservationModel(),
      proposal,
      message: 'La proposition est prête. Le front doit la valider puis l’envoyer à POST /api/reservations.',
    });
  } catch (error) {
    console.error(error);
    res.status(502).json({
      error: error instanceof Error ? error.message : 'Impossible de planifier la réservation',
    });
  }
});

export default router;
