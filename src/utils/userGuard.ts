import type { RequestHandler } from "express";
import { pool } from "../db.js";
import { policyKey } from "./accessPolicy.js";
import type { SessionUser } from "./authSession.js";

const isTop = (role: unknown) => {
  const k = policyKey(role);
  return k === "proprietaire" || k === "admin";
};

export const userGuard: RequestHandler = async (request, response, next) => {
  const me = response.locals.sessionUser as SessionUser | undefined;
  const myKey = policyKey(me?.role);

  if (myKey === "proprietaire") {
    next();
    return;
  }
  if (myKey !== "admin" || !me) {
    response.status(403).json({ error: "Accès réservé au Propriétaire ou à l'Administrateur." });
    return;
  }

  const body = request.body && typeof request.body === "object" ? (request.body as Record<string, unknown>) : {};
  const targetId = request.path.split("/").filter(Boolean)[0];
  const isSelf = !!targetId && targetId === String(me.id);
  const writes = ["POST", "PUT", "PATCH"].includes(request.method);

  // Un Administrateur ne peut attribuer ni le rôle Propriétaire ni un autre rôle Administrateur
  if (writes && body.role !== undefined && isTop(body.role)) {
    const keepsOwnAdminRole = isSelf && policyKey(body.role) === "admin";
    if (!keepsOwnAdminRole) {
      response.status(403).json({ error: "Seul le Propriétaire peut attribuer ce rôle." });
      return;
    }
  }

  // Il ne peut pas modifier ni supprimer un compte Propriétaire ou Administrateur (sauf le sien, hors suppression)
  if (targetId && ["PUT", "PATCH", "DELETE"].includes(request.method)) {
    if (request.method === "DELETE" && isSelf) {
      response.status(403).json({ error: "Vous ne pouvez pas supprimer votre propre compte." });
      return;
    }
    if (!isSelf) {
      try {
        const { rows } = await pool.query(`SELECT role FROM "user" WHERE id = $1`, [targetId]);
        if (rows[0] && isTop(rows[0].role)) {
          response.status(403).json({ error: "Seul le Propriétaire peut modifier ce compte." });
          return;
        }
      } catch {
        response.status(400).json({ error: "Identifiant invalide." });
        return;
      }
    }
  }

  next();
};