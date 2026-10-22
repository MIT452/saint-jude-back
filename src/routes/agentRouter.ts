// src/routes/agentRouter.ts
// Routes de l'assistant conversationnel :
//   POST /api/ai/agent/chat     conversation (aucun effet sur les réservations)
//   POST /api/ai/agent/confirm  action humaine : enregistre la réservation préparée
//   POST /api/ai/agent/cancel   abandonne le brouillon
// Les fonctions du backend sont injectées depuis ai.ts (pas d'import circulaire).

import { Router, type NextFunction, type Request, type Response } from 'express';
import { runAgent, type AgentDeps } from '../ai/agent.js';
import { claimPending, loadConv, publicPending, saveConv } from '../ai/state.js';
import type { ReserveInput, ReserveOutcome, SessionUserLite } from './ai.js';

interface Deps extends AgentDeps {
  reserveTrip: (input: ReserveInput, user?: SessionUserLite) => Promise<ReserveOutcome>;
  limiter: (req: Request, res: Response, next: NextFunction) => unknown;
}

const userIdOf = (res: Response): string | null => {
  const u = res.locals.sessionUser as SessionUserLite | undefined;
  return u?.id ? String(u.id) : null;
};

export function createAgentRouter(deps: Deps) {
  const router = Router();

  router.post('/chat', deps.limiter, async (req: Request, res: Response) => {
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!message || message.length > 1000) return res.status(400).json({ error: 'Message invalide' });
    const conversationId = typeof req.body?.conversationId === 'string' ? req.body.conversationId : undefined;

    try {
      const out = await runAgent({ conversationId, message, userId: userIdOf(res) }, deps);
      return res.json(out);
    } catch (error) {
      console.error('[agent/chat]', error);
      return res.status(500).json({ error: "L'assistant est momentanément indisponible." });
    }
  });

  router.post('/confirm', deps.limiter, async (req: Request, res: Response) => {
    const conversationId = typeof req.body?.conversationId === 'string' ? req.body.conversationId : '';
    const userId = userIdOf(res);
    if (!conversationId) return res.status(400).json({ ok: false, error: 'conversationId requis' });

    try {
      // Réclamation atomique : un double clic ne crée qu'une seule réservation
      const p = await claimPending(conversationId, userId);
      if (!p) {
        return res.status(409).json({ ok: false, error: 'Aucune réservation à confirmer (elle a peut-être expiré).' });
      }

      const sessionUser = res.locals.sessionUser as SessionUserLite | undefined;
      let outcome: ReserveOutcome;
      try {
        outcome = await deps.reserveTrip(
          {
            depart: p.depart,
            arrivee: p.arrivee,
            date: p.date,
            quantite: p.quantite,
            poidsTotalKg: p.poidsTotalKg,
            marchandise: p.marchandise,
            unite: p.unite,
          },
          sessionUser,
        );
      } catch (error) {
        // rien n'a été enregistré : on remet le brouillon pour pouvoir réessayer
        const conv = await loadConv(conversationId, userId);
        conv.pending = p;
        await saveConv(conv);
        throw error;
      }

      const conv = await loadConv(conversationId, userId);

      if (!outcome.ok) {
        conv.messages.push({
          role: 'assistant',
          content: `La réservation n'a pas pu être enregistrée : ${outcome.message}`,
        });
        await saveConv(conv);
        return res.status(409).json({ ok: false, error: outcome.message });
      }

      const reply = `Votre réservation a été enregistrée sous le numéro #${outcome.id.slice(0, 8)} avec le statut « En attente ». Montant à payer : ${outcome.price.toLocaleString('fr-FR')} Ar.`;
      // le modèle saura, au prochain message, que la réservation existe
      conv.messages.push({ role: 'assistant', content: reply });
      await saveConv(conv);

      return res.status(201).json({
        ok: true,
        reply,
        reservationId: outcome.id,
        reservation: outcome.reservation,
        pending: null,
      });
    } catch (error) {
      console.error('[agent/confirm]', error);
      return res.status(500).json({ ok: false, error: 'Réservation non enregistrée.' });
    }
  });

  router.post('/cancel', deps.limiter, async (req: Request, res: Response) => {
    const conversationId = typeof req.body?.conversationId === 'string' ? req.body.conversationId : '';
    if (!conversationId) return res.status(400).json({ error: 'conversationId requis' });
    try {
      const conv = await loadConv(conversationId, userIdOf(res));
      if (conv.pending) {
        conv.pending = null;
        conv.messages.push({ role: 'assistant', content: 'Le brouillon de réservation a été abandonné à la demande du client.' });
        await saveConv(conv);
      }
      return res.json({ ok: true, pending: publicPending(null) });
    } catch (error) {
      console.error('[agent/cancel]', error);
      return res.status(500).json({ error: 'Annulation impossible.' });
    }
  });

  return router;
}