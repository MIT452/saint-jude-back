import { pool } from '../db'; // adapter

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function priceFor(opts: {
  type: string; weightKg: number; requestedTotal?: number; overrideReason?: string;
}) {
  const { rows } = await pool.query(
    `SELECT price_per_kg, tolerance_min, tolerance_max FROM tariffs
     WHERE goods_type = $1 AND valid_from <= CURRENT_DATE
     ORDER BY valid_from DESC LIMIT 1`, [opts.type.trim().toLowerCase()]);
  if (!rows[0]) throw new HttpError(422, `Aucun tarif défini pour « ${opts.type} »`);

  const ref = Number(rows[0].price_per_kg);
  const computed = Math.round(ref * opts.weightKg);
  if (opts.requestedTotal == null) return { total: computed, flag: null, reason: null };

  const perKg = opts.requestedTotal / opts.weightKg;
  const outOfRange = perKg < ref * Number(rows[0].tolerance_min)
                  || perKg > ref * Number(rows[0].tolerance_max);

  if (outOfRange && !opts.overrideReason?.trim()) {
    throw new HttpError(422,
      `Prix hors barème : ${Math.round(perKg)} Ar/kg pour ${opts.type} (barème ${ref} Ar/kg). ` +
      `Une justification est obligatoire.`);
  }
  return {
    total: opts.requestedTotal,
    flag: outOfRange ? 'HORS_BAREME' : null,
    reason: outOfRange ? opts.overrideReason!.trim() : null,
  };
}