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

/** Clé de la matrice : distingue Propriétaire, Administrateur et Agent. */
export type PolicyRole = RoleKey | 'proprietaire' | 'agent';

const norm = (value: unknown) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

const STAFF_ROLES: RoleKey[] = ['manager', 'gestionnaire', 'comptable', 'caissier', 'capitaine'];

/** Rôle texte de la base -> clé technique (inchangé : utilisé par les autres fichiers). */
export const roleKey = (role: unknown): RoleKey => {
  const r = norm(role);
  if (['proprietaire', 'owner', 'admin', 'administrateur', 'directeur'].includes(r)) return 'admin';
  if (r === 'captain') return 'capitaine';
  if ((STAFF_ROLES as string[]).includes(r)) return r as RoleKey;
  return 'inconnu';
};

/** Version fine : sépare Propriétaire / Administrateur / Agent. */
export const policyKey = (role: unknown): PolicyRole => {
  const r = norm(role);
  if (['proprietaire', 'owner', 'directeur'].includes(r)) return 'proprietaire';
  if (['admin', 'administrateur'].includes(r)) return 'admin';
  if (r === 'agent') return 'agent';
  return roleKey(role);
};

type ModulePolicy = Partial<Record<Operation, PolicyRole[]>>;

const MANAGERS: RoleKey[] = ['manager', 'gestionnaire'];
const FUEL_ROLES: RoleKey[] = ['manager', 'gestionnaire', 'comptable', 'capitaine'];
const WITH_AGENT: PolicyRole[] = [...STAFF_ROLES, 'agent'];

/**
 * MATRICE DES DROITS (miroir de PERMISSIONS dans le front, src/data/service.ts).
 * Le Propriétaire a toujours tous les droits.
 * L'Administrateur a tous les droits, sauf ceux de ADMIN_DENIED ci-dessous.
 * Les réservations restent gérées par reservationAccessGuard.
 */
export const POLICY: Record<string, ModulePolicy> = {
  goods: { read: WITH_AGENT, create: [...MANAGERS, 'agent'], update: [...MANAGERS, 'agent'], delete: ['manager'] },
  trips: { read: WITH_AGENT, create: MANAGERS, update: MANAGERS, delete: MANAGERS },
  boats: { read: WITH_AGENT, create: MANAGERS, update: MANAGERS, delete: [] },
  cashmovements: {
    read: STAFF_ROLES,
    create: STAFF_ROLES,
    update: ['manager', 'gestionnaire', 'comptable', 'caissier'],
    delete: [],
  },
  fuelconsumptions: { read: FUEL_ROLES, create: FUEL_ROLES, update: FUEL_ROLES, delete: [] },
};

/** Opérations interdites à l'Administrateur (le Propriétaire les garde). */
const ADMIN_DENIED: Record<string, Operation[]> = {
  cashmovements: ['create', 'update', 'delete'], // l'Admin consulte la caisse sans y écrire
};

const OPERATION_BY_METHOD: Record<string, Operation> = {
  POST: 'create',
  PUT: 'update',
  PATCH: 'update',
  DELETE: 'delete',
};

export const isAllowed = (user: Pick<SessionUser, 'role'> | undefined, moduleName: string, op: Operation): boolean => {
  const key = policyKey(user?.role);
  if (key === 'proprietaire') return true;
  if (key === 'admin') return !(ADMIN_DENIED[moduleName] ?? []).includes(op);
  return (POLICY[moduleName]?.[op] ?? []).includes(key);
};

/** report (défaut) : on journalise les refus simulés ; enforce : on renvoie 403. */
const isEnforced = () => (process.env.ACCESS_MODE ?? 'report').trim().toLowerCase() === 'enforce';

/** À placer après requireAuth et audit(...), juste avant le routeur du module. */
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