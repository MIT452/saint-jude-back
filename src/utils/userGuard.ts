import type { RequestHandler } from "express";
import { policyKey } from "./accessPolicy.js";
import type { SessionUser } from "./authSession.js";

// Propriétaire et Administrateur ont la même clé : "admin"
const isTop = (role: unknown) => policyKey(role) === "admin";

export const userGuard: RequestHandler = (request, response, next) => {
  const me = response.locals.sessionUser as SessionUser | undefined;

  if (!me || !isTop(me.role)) {
    response.status(403).json({ error: "Accès réservé au Propriétaire ou à l'Administrateur." });
    return;
  }

  const body = request.body && typeof request.body === "object" ? (request.body as Record<string, unknown>) : {};
  const targetId = request.path.split("/").filter(Boolean)[0];
  const isSelf = !!targetId && targetId === String(me.id);

  if (isSelf && request.method === "DELETE") {
    response.status(403).json({ error: "Vous ne pouvez pas supprimer votre propre compte." });
    return;
  }

  if (isSelf && ["PUT", "PATCH"].includes(request.method) && body.role !== undefined && !isTop(body.role)) {
    response.status(403).json({ error: "Vous ne pouvez pas retirer votre propre rôle." });
    return;
  }

  next();
};