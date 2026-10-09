import { Router, type Request, type Response, type NextFunction } from 'express';
import { runAgent } from '../ai/agent.js';
import { pool } from '../db.js';

export const aiRouter = Router();

/* ==========================================================================
   1. LIMITER DE DÉBIT (10 requêtes / minute par IP)
   ========================================================================== */
const hits = new Map<string, number[]>();

export function aiRequestLimiter(req: Request, res: Response, next: NextFunction) {
  const now = Date.now();
  const ip = req.ip ?? 'inconnu';
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  
  if (recent.length >= 10) {
    return res.status(429).json({ error: 'Trop de requêtes, veuillez repasser dans une minute.' });
  }
  
  recent.push(now);
  hits.set(ip, recent);
  next();
}

/* ==========================================================================
   2. ROUTE POST /chat (AI Chatbot & Base de données Neon)
   ========================================================================== */
aiRouter.post('/chat', aiRequestLimiter, async (req: Request, res: Response) => {
  const question = String(req.body?.question ?? '').trim().slice(0, 500);
  if (!question) {
    return res.status(400).json({ error: 'Question requise' });
  }

  const contextStr = req.body?.context;
  let parsedContext: Record<string, any> = {};
  
  try {
    if (contextStr) {
      parsedContext = typeof contextStr === 'string' ? JSON.parse(contextStr) : contextStr;
    }
  } catch {
    // Si le contexte n'est pas du JSON valide, on garde un objet vide
  }

  let currentCtx = parsedContext.currentContext || {};
  const text = question.toLowerCase();

  try {
    let reply = '';
    let quoteSummary = null;

    // --- A. ESSAI D'EXÉCUTION VIA LE LLM / AGENT PRINCIPAL ---
    if (typeof runAgent === 'function') {
      try {
        const agentResult = await runAgent(question);
        if (agentResult) {
          reply = typeof agentResult === 'string' ? agentResult : agentResult.reponse || agentResult.reply;
        }
      } catch (agentErr) {
        console.warn('Agent IA principal indisponible, bascule sur la logique métier BD Neon:', agentErr);
      }
    }

    // --- B. TRAITEMENT STRUCTURÉ DE LA BASE NEON (Si l'agent renvoie vide ou en secours) ---
    if (!reply) {
      // 1. Extraire les villes
      const cities = ["antananarivo", "mahajanga", "toamasina", "antalaha", "sainte-marie", "fenerive", "maroantsetra"];
      const foundCities = cities.filter(c => text.includes(c));

      if (foundCities.length >= 2) {
        currentCtx.departure = foundCities[0].charAt(0).toUpperCase() + foundCities[0].slice(1);
        currentCtx.destination = foundCities[1].charAt(0).toUpperCase() + foundCities[1].slice(1);
      } else if (foundCities.length === 1) {
        if (!currentCtx.departure) {
          currentCtx.departure = foundCities[0].charAt(0).toUpperCase() + foundCities[0].slice(1);
        } else if (!currentCtx.destination && foundCities[0] !== currentCtx.departure.toLowerCase()) {
          currentCtx.destination = foundCities[0].charAt(0).toUpperCase() + foundCities[0].slice(1);
        }
      }

      // 2. Extraire la marchandise et la quantité
      if (text.includes("riz") || text.includes("colis") || text.includes("sac") || text.includes("marchandise")) {
        if (text.includes("riz")) currentCtx.cargoType = "riz";
        if (text.includes("colis")) currentCtx.cargoType = currentCtx.cargoType || "colis";

        const numMatch = text.match(/\b(\d+)\b/) || 
                         (text.includes("deux") ? [null, "2"] : null) || 
                         (text.includes("trois") ? [null, "3"] : null) ||
                         (text.includes("un") || text.includes("une") ? [null, "1"] : null);
        if (numMatch && numMatch[1]) {
          currentCtx.quantity = parseInt(numMatch[1], 10);
        }
      }

      // 3. Extraire le poids
      const weightMatch = text.match(/(\d+)\s*(kg|kilo|kilos)/i);
      if (weightMatch) {
        currentCtx.unitWeightKg = parseInt(weightMatch[1], 10);
        if (currentCtx.quantity) {
          currentCtx.totalWeightKg = currentCtx.quantity * currentCtx.unitWeightKg;
        }
      } else if (text.includes("chacun") && currentCtx.unitWeightKg && currentCtx.quantity) {
        currentCtx.totalWeightKg = currentCtx.quantity * currentCtx.unitWeightKg;
      }

      // 4. Interroger la base de données Neon
      let dbTripAvailable = false;
      let tripDetails: any = null;

      if (currentCtx.departure && currentCtx.destination) {
        const query = `
          SELECT t.id, t."from", t."to", t.depart, b.name AS boat_name, b.capacity
          FROM trips t
          LEFT JOIN boats b ON t."boatId" = b.id
          WHERE LOWER(t."from") LIKE $1 AND LOWER(t."to") LIKE $2
          ORDER BY t.depart ASC
          LIMIT 1;
        `;
        const values = [`%${currentCtx.departure.toLowerCase()}%`, `%${currentCtx.destination.toLowerCase()}%`];
        const dbResult = await pool.query(query, values);

        if (dbResult.rows.length > 0) {
          dbTripAvailable = true;
          tripDetails = dbResult.rows[0];
          currentCtx.tripId = tripDetails.id;
          currentCtx.boatName = tripDetails.boat_name;
          currentCtx.date = new Date(tripDetails.depart).toLocaleDateString('fr-FR');
        }
      }

      // 5. Générer la réponse adaptée
      if (text.includes("oui") || text.includes("confirme")) {
        if (currentCtx.departure && currentCtx.destination && dbTripAvailable) {
          reply = `Merci ! Votre confirmation a bien été prise en compte pour le trajet ${currentCtx.departure} → ${currentCtx.destination}.`;
          currentCtx.confirmedByUser = true;
        } else {
          reply = "Veuillez d'abord préciser les détails de votre trajet.";
        }
      } else if (!currentCtx.departure || !currentCtx.destination) {
        reply = "Bonjour ! Bienvenue chez SAINT-JUDE. De quelle ville souhaitez-vous envoyer vos marchandises et quelle est votre destination ?";
      } else if (!dbTripAvailable) {
        reply = `Je n'ai pas trouvé de voyage disponible dans notre base de données pour le trajet ${currentCtx.departure} → ${currentCtx.destination}. Souhaitez-vous rechercher une autre date ou destination ?`;
      } else if (!currentCtx.cargoType || !currentCtx.quantity) {
        reply = `Très bien, un voyage est disponible de ${currentCtx.departure} vers ${currentCtx.destination}. Que souhaitez-vous transporter et en quelle quantité ?`;
      } else if (!currentCtx.unitWeightKg && !currentCtx.totalWeightKg) {
        reply = `D'accord, ${currentCtx.quantity} ${currentCtx.cargoType}. Connaissez-vous le poids de chaque colis ou le poids total en kg ?`;
      } else {
        const totalWeight = currentCtx.totalWeightKg || (currentCtx.quantity * (currentCtx.unitWeightKg || 0));
        const estimatedPrice = totalWeight * 1500;

        currentCtx.totalWeightKg = totalWeight;
        currentCtx.estimatedPrice = estimatedPrice;

        reply = `J'ai vérifié dans la base de données : le trajet ${currentCtx.departure} → ${currentCtx.destination} est disponible le ${currentCtx.date} sur le navire ${currentCtx.boatName || 'Saint-Jude'}. Pour ${currentCtx.quantity} ${currentCtx.cargoType} (${totalWeight} kg au total), le tarif calculé est de ${estimatedPrice.toLocaleString('fr-FR')} Ar. Souhaitez-vous confirmer cette réservation ?`;

        quoteSummary = {
          departure: currentCtx.departure,
          destination: currentCtx.destination,
          date: currentCtx.date,
          cargoDescription: currentCtx.cargoType,
          quantity: currentCtx.quantity,
          unitWeightKg: currentCtx.unitWeightKg || Math.round(totalWeight / currentCtx.quantity),
          totalWeightKg: totalWeight,
          estimatedPrice,
          available: true
        };
      }
    }

    // --- C. RETOUR AU FRONTEND ---
    return res.json({
      reponse: reply,
      reply: reply,
      updatedContext: currentCtx,
      quoteSummary: quoteSummary
    });

  } catch (e) {
    console.error('Erreur globale /chat:', e);
    return res.status(502).json({ error: 'Assistant indisponible' });
  }
});

export default aiRouter;