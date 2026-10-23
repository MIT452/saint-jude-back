import type { NextFunction, Request, Response } from 'express';
import { pool } from '../db.js';

/**
 * Qui est administrateur ? Comparaison sans accents ni majuscules.
 * Ajoutez ici les valeurs réelles de la colonne « role » si besoin.
 */
const ADMIN_ROLES = ['proprietaire', 'admin', 'administrateur', 'owner'];

const norm = (v: unknown) =>
  String(v ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

export const isAdminUser = (user: unknown): boolean =>
  ADMIN_ROLES.includes(norm((user as { role?: unknown } | undefined)?.role));

/**
 * Protège /api/reservations (route générique + statut) :
 *  - admin : tout est autorisé ;
 *  - client : voit et touche uniquement SES réservations, et ne peut que les annuler.
 * À monter AVANT reservationStatusRouter et la route générique dans server.ts.
 */
export async function reservationAccessGuard(req: Request, res: Response, next: NextFunction) {
  try {
    const user = res.locals.sessionUser as { id?: string | number; role?: string } | undefined;
    if (!user?.id) return res.status(401).json({ error: 'Non connecté' });
    if (isAdminUser(user)) return next();

    const userId = String(user.id);
    const parts = req.path.split('/').filter(Boolean); // [] | [id] | [id, 'status']

    if (parts[0] === 'ai') return next(); // proposition IA : autre routeur

    // Niveau « collection » : /api/reservations
    if (parts.length === 0) {
      if (req.method === 'POST') {
        // Le propriétaire est toujours l'utilisateur connecté, jamais une valeur envoyée par le navigateur
        req.body = { ...(req.body ?? {}), userId };
        return next();
      }
      if (req.method === 'GET') {
        const { rows } = await pool.query(
          `SELECT * FROM reservations WHERE "userId"::text = $1 ORDER BY date DESC NULLS LAST`,
          [userId],
        );
        return res.json(rows);
      }
      return res.status(403).json({ error: 'Action réservée à l’administrateur' });
    }

    // Niveau « une réservation » : vérifier qu'elle appartient au client
    const owner = await pool.query(`SELECT "userId"::text AS uid FROM reservations WHERE id::text = $1`, [
      parts[0],
    ]);
    if (owner.rows.length === 0) return next(); // introuvable : le routeur répondra 404
    if (owner.rows[0].uid !== userId) return res.status(403).json({ error: 'Accès refusé' });

    if (req.method === 'GET' && parts.length === 1) return next();
    if (req.method === 'PATCH' && parts[1] === 'status' && req.body?.status === 'ANNULEE') return next();

    return res.status(403).json({ error: 'Action réservée à l’administrateur' });
  } catch (error) {
    console.error('reservationAccessGuard:', error);
    return res.status(500).json({ error: 'Erreur de contrôle d’accès' });
  }
}