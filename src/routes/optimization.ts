import { Router } from 'express';
import { findPlace, haversineKm, type Place } from '../services/geo.js';
import { cheminMaritime } from '../services/graph.js';

export const optimizationRouter = Router();

function totalKm(path: Place[]) {
  let t = 0;
  for (let i = 0; i < path.length - 1; i++) t += haversineKm(path[i], path[i + 1]);
  return t;
}

// Étape 1 : à chaque pas, aller à l'escale la plus proche
function plusProche(start: Place, rest: Place[]) {
  const ordre = [start];
  const left = [...rest];
  while (left.length) {
    const last = ordre[ordre.length - 1];
    let bi = 0;
    let bd = Infinity;
    left.forEach((p, i) => {
      const d = haversineKm(last, p);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    });
    ordre.push(left.splice(bi, 1)[0]);
  }
  return ordre;
}

// Étape 2 : améliorer en inversant des portions du parcours (2-opt)
function deuxOpt(path: Place[]) {
  let best = path;
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 1; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        const cand = [...best.slice(0, i), ...best.slice(i, j + 1).reverse(), ...best.slice(j + 1)];
        if (totalKm(cand) < totalKm(best) - 1e-9) {
          best = cand;
          improved = true;
        }
      }
    }
  }
  return best;
}

// POST /api/optimization/order  { "depart": "Mahajanga", "escales": ["Nosy Be", "Antsiranana"] }
optimizationRouter.post('/order', async (req, res) => {
  const depart = String(req.body?.depart ?? '').trim();
  const escales: string[] = Array.isArray(req.body?.escales)
    ? req.body.escales.map((e: unknown) => String(e).trim()).filter(Boolean).slice(0, 12)
    : [];
  if (!depart || escales.length === 0) {
    return res.status(400).json({ error: 'depart et escales (tableau non vide) requis' });
  }
  try {
    const start = await findPlace(depart);
    const found = await Promise.all(escales.map((e) => findPlace(e)));
    const inconnus = [...(start ? [] : [depart]), ...escales.filter((_, i) => !found[i])];
    if (!start || inconnus.length > 0) {
      return res.status(404).json({ error: 'Lieu inconnu dans la table places', inconnus });
    }
    const ordre = deuxOpt(plusProche(start, found as Place[]));
    res.json({
      ordre: ordre.map((p) => p.name),
      km: Math.round(totalKm(ordre) * 10) / 10,
      methode: 'ligne droite, plus proche voisin puis 2-opt',
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur lors du calcul de l'ordre" });
  }
});

// GET /api/optimization/path?depart=Mahajanga&arrivee=Nosy%20Be  (graphe maritime sea_legs)
optimizationRouter.get('/path', async (req, res) => {
  const depart = String(req.query.depart ?? '').trim();
  const arrivee = String(req.query.arrivee ?? '').trim();
  if (!depart || !arrivee) return res.status(400).json({ error: 'depart et arrivee requis' });
  try {
    res.json(await cheminMaritime(depart, arrivee));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur lors du calcul du chemin' });
  }
});