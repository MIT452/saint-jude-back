import { Router, type Request, type Response } from 'express';
import {
  calculateCapacity,
  classifyIntent,
  extractEntities,
  getCapabilityStatus,
  normalizeDate,
  validateReservation,
} from '../ai/capabilities.js';

const router = Router();

router.post('/classify', (req: Request, res: Response) => {
  const message = String(req.body?.message ?? '');
  res.json({ intent: classifyIntent(message), message });
});

router.post('/extract', (req: Request, res: Response) => {
  const message = String(req.body?.message ?? '');
  const entities = extractEntities(message);
  res.json({ entities, date: normalizeDate(message) });
});

router.post('/capacity', (req: Request, res: Response) => {
  const result = calculateCapacity(
    Number(req.body?.capacity ?? 0),
    Number(req.body?.reserved ?? 0),
    Number(req.body?.requested ?? 0)
  );
  res.json(result);
});

router.post('/validate', (req: Request, res: Response) => {
  res.json(validateReservation(req.body ?? {}));
});

router.get('/status', (_req: Request, res: Response) => {
  res.json(getCapabilityStatus());
});

export default router;
