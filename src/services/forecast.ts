// Prévision de série hebdomadaire par lissage exponentiel double (Holt).
// Choix volontairement simple et explicable : adapté aux petits volumes, avec intervalle
// de confiance et erreur de backtest (MAE / MAPE) calculés sur la série elle-même.

export interface WeeklyPoint {
  week: string; // lundi de la semaine, AAAA-MM-JJ
  value: number;
}

export interface ForecastPoint {
  week: string;
  value: number;
  low: number;
  high: number;
}

export interface ForecastResult {
  method: string;
  n: number;
  horizon: number;
  mae: number;
  mape: number | null; // en %, null si aucune valeur observée > 0
  forecast: ForecastPoint[];
}

const round1 = (x: number) => Math.round(x * 10) / 10;

function addDays(isoDay: string, days: number): string {
  const d = new Date(`${isoDay}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Comble les semaines sans réservation par 0 entre la première et la dernière semaine. */
export function fillWeeks(points: WeeklyPoint[]): WeeklyPoint[] {
  if (points.length === 0) return [];
  const byWeek = new Map(points.map((p) => [p.week, p.value]));
  const out: WeeklyPoint[] = [];
  const last = points[points.length - 1].week;
  for (let w = points[0].week; w <= last; w = addDays(w, 7)) {
    out.push({ week: w, value: byWeek.get(w) ?? 0 });
  }
  return out;
}

export function holtForecast(points: WeeklyPoint[], horizon = 4, alpha = 0.4, beta = 0.2): ForecastResult {
  const y = points.map((p) => p.value);
  if (y.length < 4) throw new Error('Série trop courte (4 semaines minimum)');

  let level = y[0];
  let trend = (y[3] - y[0]) / 3;
  const errors: number[] = [];
  const pct: number[] = [];

  for (let t = 1; t < y.length; t++) {
    const predicted = level + trend;
    errors.push(y[t] - predicted);
    if (y[t] > 0) pct.push(Math.abs(y[t] - predicted) / y[t]);
    const previousLevel = level;
    level = alpha * y[t] + (1 - alpha) * (level + trend);
    trend = beta * (level - previousLevel) + (1 - beta) * trend;
  }

  const mae = errors.reduce((s, e) => s + Math.abs(e), 0) / errors.length;
  const sd = Math.sqrt(errors.reduce((s, e) => s + e * e, 0) / Math.max(1, errors.length - 2));
  const lastWeek = points[points.length - 1].week;

  const forecast: ForecastPoint[] = [];
  for (let h = 1; h <= horizon; h++) {
    const value = Math.max(0, level + h * trend);
    const half = 1.96 * sd * Math.sqrt(h);
    forecast.push({
      week: addDays(lastWeek, 7 * h),
      value: round1(value),
      low: round1(Math.max(0, value - half)),
      high: round1(value + half),
    });
  }

  return {
    method: 'Holt (lissage exponentiel double)',
    n: y.length,
    horizon,
    mae: round1(mae),
    mape: pct.length ? round1((pct.reduce((s, p) => s + p, 0) / pct.length) * 100) : null,
    forecast,
  };
}