import { Router } from 'express';
import { POLICY, isAllowed, roleKey, policyKey } from '../utils/accessPolicy.js';
import type { Operation } from '../utils/accessPolicy.js';
import type { SessionUser } from '../utils/authSession.js';

const router = Router();
const OPERATIONS: Operation[] = ['read', 'create', 'update', 'delete'];

/** Droits du compte connecté, calculés avec la matrice de accessPolicy.ts. */
router.get('/me', (_request, response) => {
  const user = response.locals.sessionUser as SessionUser;
  const modules = Object.fromEntries(
    Object.keys(POLICY).map((moduleName) => [
      moduleName,
      Object.fromEntries(OPERATIONS.map((op) => [op, isAllowed(user, moduleName, op)])),
    ]),
  );
  const mode = (process.env.ACCESS_MODE ?? 'report').trim().toLowerCase() === 'enforce' ? 'enforce' : 'report';
  response.json({ role: user.role, roleKey: roleKey(user.role), policyRole: policyKey(user.role), mode, modules });
});

export default router;