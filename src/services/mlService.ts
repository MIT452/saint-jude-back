const ML_API = "https://VOTRE-URL-DEPLOYEE"; // ← remplacez par l’URL réelle de votre service

export type ForecastPoint = {
  date: string;
  prevision: number;
  basse?: number;
  haute?: number;
};

function buildDemandHistory(reservations: any[]) {
  const byDay = new Map<string, number>();

  reservations.forEach((r) => {
    if (r.status === "Annulée") return;
    const date = (r.date || r.createdAt || r.dateReservation || "").toString().slice(0, 10);
    if (date && date.length >= 10) {
      byDay.set(date, (byDay.get(date) || 0) + 1);
    }
  });

  return Array.from(byDay.entries())
    .map(([date, value]) => ({ date, value }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function buildRevenueHistory(cashMouvement: any[], reservations: any[]) {
  const byDay = new Map<string, number>();

  if (cashMouvement?.length) {
    cashMouvement.forEach((m) => {
      const date = (m.date || m.createdAt || m.dateMouvement || "").toString().slice(0, 10);
      const credit = Number(m.credit || 0);
      if (date && credit > 0) {
        byDay.set(date, (byDay.get(date) || 0) + credit);
      }
    });
  } else {
    reservations.forEach((r) => {
      if (r.status === "Annulée") return;
      const date = (r.date || r.createdAt || r.dateReservation || "").toString().slice(0, 10);
      const amount = Number(r.amountPaid || 0) + Number(r.amountToPay || 0);
      if (date && amount > 0) {
        byDay.set(date, (byDay.get(date) || 0) + amount);
      }
    });
  }

  return Array.from(byDay.entries())
    .map(([date, value]) => ({ date, value }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function callForecast(
  history: { date: string; value: number }[],
  target: "demand" | "revenue",
  periods = 30
): Promise<ForecastPoint[]> {
  if (history.length < 14) return [];

  const res = await fetch(`${ML_API}/forecast`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ history, periods, target }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Erreur ML (${target}): ${res.status} – ${text}`);
  }

  return (await res.json()) as ForecastPoint[];
}

export async function getDemandForecast(reservations: any[], periods = 30) {
  const history = buildDemandHistory(reservations);
  return callForecast(history, "demand", periods);
}

export async function getRevenueForecast(
  cashMouvement: any[],
  reservations: any[],
  periods = 30
) {
  const history = buildRevenueHistory(cashMouvement, reservations);
  return callForecast(history, "revenue", periods);
}