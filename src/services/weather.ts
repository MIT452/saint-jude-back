import { findPlace } from './geo.js';

type Meteo = { current?: Record<string, number | string> };

async function getJson(url: string): Promise<Meteo | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    return res.ok ? ((await res.json()) as Meteo) : null;
  } catch {
    return null;
  }
}

export async function meteoPour(lieu: string) {
  const p = await findPlace(lieu);
  if (!p) return { erreur: 'Lieu inconnu dans la table places' };
  const [air, mer] = await Promise.all([
    getJson(
      `https://api.open-meteo.com/v1/forecast?latitude=${p.latitude}&longitude=${p.longitude}&current=temperature_2m,wind_speed_10m,precipitation`
    ),
    getJson(
      `https://marine-api.open-meteo.com/v1/marine?latitude=${p.latitude}&longitude=${p.longitude}&current=wave_height,wave_period`
    ),
  ]);
  return { lieu: p.name, air: air?.current ?? null, mer: mer?.current ?? null };
}