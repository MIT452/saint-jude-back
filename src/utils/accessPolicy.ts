import type { RequestHandler } from 'express';
import type { SessionUser } from './authSession.js';

export type Operation = 'read' | 'create' | 'update' | 'delete';
export type RoleKey =
  | 'admin'
  | 'manager'
  | 'gestionnaire'
  | 'comptable'
  | 'caissier'
  | 'capitaine'
  | 'inconnu';

const norm = (value: unknown) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

const STAFF_ROLES: RoleKey[] = ['manager', 'gestionnaire', 'comptable', 'caissier', 'capitaine'];

/** Rôle texte de la base -> clé technique (sans accents ni majuscules). Même vocabulaire que le front. */
export const roleKey = (role: unknown): RoleKey => {
  const r = norm(role);
  if (['proprietaire', 'owner', 'admin', 'administrateur', 'directeur'].includes(r)) return 'admin';
  if (r === 'captain') return 'capitaine';
  if ((STAFF_ROLES as string[]).includes(r)) return r as RoleKey;
  return 'inconnu'; // ex. anciens comptes « Agent » : aucun droit sur les modules
};

type ModulePolicy = Partial<Record<Operation, RoleKey[]>>;

const MANAGERS: RoleKey[] = ['manager', 'gestionnaire'];
const FUEL_ROLES: RoleKey[] = ['manager', 'gestionnaire', 'comptable', 'capitaine'];

/**
 * MATRICE DES DROITS : miroir de PERMISSIONS dans le front (src/data/service.ts).
 * Le Propriétaire / Admin / Directeur ont toujours tous les droits.
 * Un rôle absent de la liste d'une opération n'y a pas accès.
 * Les réservations ne sont pas ici : elles restent gérées par reservationAccessGuard.
 */
export const POLICY: Record<string, ModulePolicy> = {
  goods: { read: STAFF_ROLES, create: MANAGERS, update: MANAGERS, delete: ['manager'] },
  trips: { read: STAFF_ROLES, create: MANAGERS, update: MANAGERS, delete: MANAGERS },
  boats: { read: STAFF_ROLES, create: MANAGERS, update: MANAGERS, delete: [] },
  cashmovements: {
    read: STAFF_ROLES,
    create: STAFF_ROLES,
    update: ['manager', 'gestionnaire', 'comptable', 'caissier'],
    delete: [],
  },
  fuelconsumptions: { read: FUEL_ROLES, create: FUEL_ROLES, update: FUEL_ROLES, delete: [] },
};

const OPERATION_BY_METHOD: Record<string, Operation> = {
  POST: 'create',
  PUT: 'update',
  PATCH: 'update',
  DELETE: 'delete',
};

export const isAllowed = (user: Pick<SessionUser, 'role'> | undefined, moduleName: string, op: Operation): boolean => {
  const key = roleKey(user?.role);
  if (key === 'admin') return true;
  return (POLICY[moduleName]?.[op] ?? []).includes(key);
};

/** report (défaut) : on journalise les refus simulés ; enforce : on renvoie 403. */
const isEnforced = () => (process.env.ACCESS_MODE ?? 'report').trim().toLowerCase() === 'enforce';

/**
 * À placer après requireAuth et audit(...), juste avant le routeur du module.
 * En mode enforce, le refus 403 est enregistré comme échec par le journal d'audit.
 */
export const access = (moduleName: string): RequestHandler => {
  return (request, response, next) => {
    const user = response.locals.sessionUser as SessionUser | undefined;
    const op = OPERATION_BY_METHOD[request.method] ?? 'read';

    if (isAllowed(user, moduleName, op)) {
      next();
      return;
    }

    if (isEnforced()) {
      response.status(403).json({ error: 'Accès refusé pour votre rôle.' });
      return;
    }

    console.warn(
      `[access] refus simulé : rôle "${user?.role ?? '?'}" -> ${op} ${request.baseUrl}${request.path} (module ${moduleName})`,
    );
    next();
  };
};