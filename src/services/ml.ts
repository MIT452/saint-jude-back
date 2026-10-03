const ML_URL = process.env.ML_URL;

export async function prevoirCarburant(poidsKg: number, nbReservations: number) {
  if (!ML_URL) return { disponible: false, raison: 'Service ML non configuré' };
  try {
    const res = await fetch(`${ML_URL}/predict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ poids: poidsKg, nb: nbReservations }),
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok ? await res.json() : { disponible: false, raison: `ML a répondu ${res.status}` };
  } catch {
    return { disponible: false, raison: 'Service ML injoignable' };
  }
}