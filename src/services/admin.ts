import { pool } from '../db.js';

// 034 96 706 06 / +261 34 96 706 06 / 261339670606  ->  261339670606
export function toE164MG(input: string): string | null {
  let d = input.replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = '261' + d.slice(1);
  return /^261\d{9}$/.test(d) ? d : null;
}

let cache: { phone: string | null; at: number } | null = null;
export const invalidateAdminCache = () => { cache = null; };

export async function getAdminPhone(): Promise<string | null> {
  if (cache && Date.now() - cache.at < 60_000) return cache.phone;
  const { rows } = await pool.query(
    `SELECT admin_whatsapp FROM notification_settings WHERE id = 1`
  );
  const phone = rows[0]?.admin_whatsapp ?? null;
  cache = { phone, at: Date.now() };
  return phone;
}

export async function isAdmin(from: string): Promise<boolean> {
  const admin = await getAdminPhone();
  return !!admin && toE164MG(from) === admin;
}