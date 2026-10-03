import { Router, type Request, type Response, type NextFunction } from 'express';
import { runAgent } from '../ai/agent.js';

export const aiRouter = Router();

// Limite simple : 10 requêtes par minute et par IP (le LLM consomme beaucoup de CPU)
const hits = new Map<string, number[]>();
function limiter(req: Request, res: Response, next: NextFunction) {
  const now = Date.now();
  const ip = req.ip ?? 'inconnu';
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= 10) return res.status(429).json({ error: 'Trop de requêtes' });
  recent.push(now);
  hits.set(ip, recent);
  next();
}

aiRouter.post('/chat', limiter, async (req, res) => {
  const question = String(req.body?.question ?? '').trim().slice(0, 500);
  if (!question) return res.status(400).json({ error: 'question requise' });
  try {
    res.json({ reponse: await runAgent(question) });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: 'Assistant indisponible' });
  }
});