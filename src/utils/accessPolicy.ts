import type { RequestHandler } from 'express';
import type { SessionUser } from './authSession.js';

export type Operation = 'read' | 'create' | 'update' | 'delete';
export type RoleKey = 'admin' | 'agent' | 'capitaine' | 'comptable' | 'quai' | 'client' | 'inconnu';

const norm = (value: unknown) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

/** Rôle texte de la base -> clé technique (sans accents ni majuscules). */
export const roleKey = (role: unknown): RoleKey => {
  const r = norm(role);
  if (['proprietaire', 'owner', 'admin', 'administrateur'].includes(r)) return 'admin';
  if (['agent', 'agent commercial'].includes(r)) return 'agent';
  if (['capitaine', 'captain'].includes(r)) return 'capitaine';
  if (['comptable', 'accountant'].includes(r)) return 'comptable';
  if (['agent de quai', 'quai', 'logistique', 'logistics', 'responsable logistique'].includes(r)) return 'quai';
  if (['client', 'customer'].includes(r)) return 'client';
  return 'inconnu';
};

type ModulePolicy = Partial<Record<Operation, RoleKey[]>>;

const EVERYONE: RoleKey[] = ['agent', 'capitaine', 'comptable', 'quai', 'client'];

/**
 * MATRICE DES DROITS (un seul endroit à lire et à modifier).
 * Le Propriétaire et l'Admin ont toujours tous les droits.
 * Un rôle absent de la liste d'une opération n'y a pas accès.
 * Les réservations ne sont pas ici : elles restent gérées par reservationAccessGuard.
 */
export const POLICY: Record<string, ModulePolicy> = {
  goods: { read: EVERYONE, create: ['agent', 'quai', 'client'], update: ['agent', 'quai'], delete: [] },
  trips: { read: EVERYONE, create: [], update: ['capitaine'], delete: [] },
  boats: { read: EVERYONE, create: [], update: [], delete: [] },
  // Encaissement par l'agent ; modification réservée au comptable ; suppression : admin seulement
  cashmovements: { read: ['comptable'], create: ['agent', 'comptable'], update: ['comptable'], delete: [] },
  fuelconsumptions: {
    read: ['capitaine', 'comptable'],
    create: ['capitaine', 'comptable'],
    update: ['comptable'],
    delete: [],
  },
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