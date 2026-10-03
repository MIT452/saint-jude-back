import { pool } from '../db.js';

export type Place = { name: string; latitude: number; longitude: number };

export async function findPlace(name: string): Promise<Place | null> {
  const { rows } = await pool.query(
    `SELECT name, latitude::float AS latitude, longitude::float AS longitude
     FROM places WHERE lower(name) = lower($1)`,
    [name]
  );
  return rows[0] ?? null;
}

export function haversineKm(a: Place, b: Place) {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export async function distanceEntre(depart: string, arrivee: string, vitesseKmh = 20) {
  const a = await findPlace(depart);
  const b = await findPlace(arrivee);
  if (!a || !b) return { erreur: 'Lieu inconnu dans la table places' };
  const km = Math.round(haversineKm(a, b) * 10) / 10;
  return { km, heures: Math.round((km / vitesseKmh) * 10) / 10, vitesseKmh, methode: 'ligne droite' };
}

// Trajet terrestre (camion, taxi-brousse) via le serveur public OSRM (démonstration uniquement)
export async function routeTerrestre(depart: string, arrivee: string) {
  const a = await findPlace(depart);
  const b = await findPlace(arrivee);
  if (!a || !b) return { erreur: 'Lieu inconnu dans la table places' };
  const url = `https://router.project-osrm.org/route/v1/driving/${a.longitude},${a.latitude};${b.longitude},${b.latitude}?overview=false`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return { erreur: `OSRM a répondu ${res.status}` };
  const data = (await res.json()) as { routes?: { distance: number; duration: number }[] };
  const r = data.routes?.[0];
  if (!r) return { erreur: 'Aucun itinéraire routier trouvé' };
  return { km: Math.round(r.distance / 100) / 10, minutes: Math.round(r.duration / 60) };
}