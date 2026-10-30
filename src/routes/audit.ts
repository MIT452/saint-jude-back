import { Router } from "express";
import { pool } from "../db.js";
import type { SessionUser } from "../utils/authSession.js";
import { verifyChain } from "../audit/auditService.js";

const router = Router();
// Monté dans server.ts derrière requireAuth + requireOwner

const toInt = (value: unknown, fallback: number, max: number) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, max) : fallback;
};

router.get("/logs", async (request, response) => {
  const limit = toInt(request.query.limit, 100, 500);
  const offset = toInt(request.query.offset, 0, 1_000_000);
  const status = typeof request.query.status === "string" ? request.query.status : null;
  const resource = typeof request.query.resource === "string" ? request.query.resource : null;

  try {
    const { rows } = await pool.query(
      `SELECT id, created_at, user_id, action, resource, resource_id, details,
              host(ip_address) AS ip_address, result, status
       FROM audit_logs
       WHERE ($1::text IS NULL OR status = $1)
         AND ($2::text IS NULL OR resource = $2)
       ORDER BY id DESC
       LIMIT $3 OFFSET $4`,
      [status, resource, limit, offset],
    );
    response.json(rows);
  } catch (error) {
    console.error("Erreur lecture des logs d'audit", error);
    response.status(500).json({ error: "Impossible de lire le journal d'audit." });
  }
});

router.get("/alerts", async (request, response) => {
  const reviewed =
    request.query.reviewed === "true" ? true : request.query.reviewed === "false" ? false : null;
  try {
    const { rows } = await pool.query(
      `SELECT a.id, a.log_id, a.rule, a.severity, a.reviewed, a.false_positive,
              a.reviewed_by, a.reviewed_at,
              l.created_at, l.user_id, l.action, l.resource, l.resource_id,
              host(l.ip_address) AS ip_address
       FROM audit_alerts a
       JOIN audit_logs l ON l.id = a.log_id
       WHERE ($1::boolean IS NULL OR a.reviewed = $1)
       ORDER BY a.id DESC
       LIMIT 200`,
      [reviewed],
    );
    response.json(rows);
  } catch (error) {
    console.error("Erreur lecture des alertes d'audit", error);
    response.status(500).json({ error: "Impossible de lire les alertes." });
  }
});

router.get("/verify", async (_request, response) => {
  try {
    response.json(await verifyChain());
  } catch (error) {
    console.error("Erreur de vérification de la chaîne d'audit", error);
    response.status(500).json({ ok: false, error: "Vérification impossible." });
  }
});

router.patch("/alerts/:id/review", async (request, response) => {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    response.status(400).json({ error: "Identifiant d'alerte invalide." });
    return;
  }
  const falsePositive = request.body?.falsePositive === true;
  const user = response.locals.sessionUser as SessionUser | undefined;

  try {
    const { rowCount } = await pool.query(
      `UPDATE audit_alerts
       SET reviewed = TRUE, false_positive = $2, reviewed_by = $3, reviewed_at = now()
       WHERE id = $1`,
      [id, falsePositive, user?.id ?? null],
    );
    if (!rowCount) {
      response.status(404).json({ error: "Alerte introuvable." });
      return;
    }
    response.json({ ok: true });
  } catch (error) {
    console.error("Erreur de revue d'alerte", error);
    response.status(500).json({ error: "Impossible de mettre à jour l'alerte." });
  }
});

export default router;