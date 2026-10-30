import type { RequestHandler } from "express";
import type { SessionUser } from "../utils/authSession.js";
import { auditSafe, type AuditAction } from "./auditService.js";

const ACTIONS: Record<string, AuditAction> = {
  POST: "CREATE",
  PUT: "UPDATE",
  PATCH: "UPDATE",
  DELETE: "DELETE",
};

const SENSITIVE_KEY = /pass(word)?|token|secret/i;
const MAX_DETAILS_LENGTH = 8000;

// Ne jamais journaliser un mot de passe ou un jeton
function redact(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== "object" || depth > 6) return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, val]) => [
      key,
      SENSITIVE_KEY.test(key) ? "***" : redact(val, depth + 1),
    ]),
  );
}

function summarizeBody(body: unknown): unknown {
  if (body === undefined || body === null) return null;
  const cleaned = redact(body);
  const size = JSON.stringify(cleaned)?.length ?? 0;
  return size > MAX_DETAILS_LENGTH ? { _truncated: true, size } : cleaned;
}

/**
 * À placer APRÈS requireAuth, juste avant le routeur de la ressource.
 * Journalise chaque POST / PUT / PATCH / DELETE une fois la réponse envoyée.
 */
export const audit = (resource: string): RequestHandler => {
  return (request, response, next) => {
    const action = ACTIONS[request.method];
    if (!action) {
      next();
      return;
    }

    // req.path est relatif au point de montage : "/123" ou "/123/status"
    const resourceId = request.path.split("/").filter(Boolean)[0] ?? null;
    const ip = request.ip ?? null;
    const body = summarizeBody(request.body);

    response.on("finish", () => {
      const user = response.locals.sessionUser as SessionUser | undefined;
      void auditSafe({
        userId: user?.id ?? null,
        action,
        resource,
        resourceId,
        details: { body, httpStatus: response.statusCode },
        ip,
        result: response.statusCode < 400 ? "SUCCESS" : "FAILURE",
      });
    });

    next();
  };
};