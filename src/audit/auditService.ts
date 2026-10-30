import { createHash } from "node:crypto";
import { pool } from "../db.js";

export type AuditAction = "LOGIN" | "LOGIN_FAILED" | "CREATE" | "UPDATE" | "DELETE";

export interface AuditEvent {
  userId?: string | null;
  action: AuditAction;
  resource: string;
  resourceId?: string | null;
  details?: unknown;
  ip?: string | null;
  result?: "SUCCESS" | "FAILURE";
}

const ADVISORY_LOCK_KEY = 727001;

// JSON à clés triées : l'empreinte reste identique après un aller-retour JSONB
function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(obj[key])}`)
    .join(",")}}`;
}

interface HashFields {
  createdAt: string;
  userId: string | null;
  action: string;
  resource: string;
  resourceId: string | null;
  details: unknown;
  result: string;
  status: string;
}

export function computeHash(prev: string, f: HashFields): string {
  return createHash("sha256")
    .update(
      stable([prev, f.createdAt, f.userId, f.action, f.resource, f.resourceId, f.details, f.result, f.status]),
    )
    .digest("hex");
}

// Madagascar = UTC+3, sans changement d'heure
const madagascarHour = () => (new Date().getUTCHours() + 3) % 24;

const emailFromDetails = (details: unknown): string | null => {
  if (details && typeof details === "object" && "email" in details) {
    const email = (details as { email: unknown }).email;
    return typeof email === "string" && email ? email.toLowerCase() : null;
  }
  return null;
};

// Règles déterministes : ce sont elles qui décident du statut, pas le LLM
async function classify(e: AuditEvent): Promise<{ status: "NORMAL" | "SUSPECT" | "CRITIQUE"; rule?: string }> {
  if (e.action === "LOGIN_FAILED") {
    // On compte les échecs de la même IP OU visant le même compte (e-mail) :
    // changer d'IP ne contourne donc pas la détection.
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_logs
       WHERE action = 'LOGIN_FAILED'
         AND created_at > now() - interval '10 minutes'
         AND (ip_address = $1::inet OR lower(details->>'email') = $2::text)`,
      [e.ip ?? null, emailFromDetails(e.details)],
    );
    const attempts = (rows[0]?.n ?? 0) + 1;
    if (attempts >= 5) return { status: "CRITIQUE", rule: "BRUTE_FORCE" };
    if (attempts >= 3) return { status: "SUSPECT", rule: "LOGIN_FAILED_REPEAT" };
    return { status: "NORMAL" };
  }

  if (e.resource === "cashmovements" && (e.action === "UPDATE" || e.action === "DELETE")) {
    return { status: "SUSPECT", rule: "CASH_MODIFIED" };
  }

  const hour = madagascarHour();
  if (hour >= 22 || hour < 5) return { status: "SUSPECT", rule: "OFF_HOURS" };

  return { status: "NORMAL" };
}

export async function writeAudit(e: AuditEvent): Promise<void> {
  const { status, rule } = await classify(e);

  // Normalise les détails comme le fera JSONB (retire les clés undefined)
  const details = e.details == null ? null : JSON.parse(JSON.stringify(e.details));

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [ADVISORY_LOCK_KEY]); // sérialise la chaîne

    const last = await client.query<{ hash: string }>("SELECT hash FROM audit_logs ORDER BY id DESC LIMIT 1");
    const prev = last.rows[0]?.hash ?? "GENESIS";

    const fields: HashFields = {
      createdAt: new Date().toISOString(), // horodatage fixé par le serveur
      userId: e.userId ?? null,
      action: e.action,
      resource: e.resource,
      resourceId: e.resourceId ?? null,
      details,
      result: e.result ?? "SUCCESS",
      status,
    };
    const hash = computeHash(prev, fields);

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO audit_logs
         (created_at, user_id, action, resource, resource_id, details, ip_address, result, status, prev_hash, hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [
        fields.createdAt,
        fields.userId,
        fields.action,
        fields.resource,
        fields.resourceId,
        details === null ? null : JSON.stringify(details),
        e.ip ?? null,
        fields.result,
        status,
        prev,
        hash,
      ],
    );

    if (rule) {
      await client.query("INSERT INTO audit_alerts (log_id, rule, severity) VALUES ($1,$2,$3)", [
        inserted.rows[0].id,
        rule,
        status,
      ]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// L'audit ne doit jamais casser une requête métier
export async function auditSafe(e: AuditEvent): Promise<void> {
  try {
    await writeAudit(e);
  } catch (error) {
    console.error("[audit] échec d'écriture", error);
  }
}

export async function verifyChain(): Promise<{ ok: boolean; count?: number; brokenAtId?: string }> {
  const { rows } = await pool.query(
    `SELECT id, created_at, user_id, action, resource, resource_id, details, result, status, prev_hash, hash
     FROM audit_logs ORDER BY id`,
  );
  let prev = "GENESIS";
  for (const r of rows) {
    const expected = computeHash(prev, {
      createdAt: new Date(r.created_at).toISOString(),
      userId: r.user_id,
      action: r.action,
      resource: r.resource,
      resourceId: r.resource_id,
      details: r.details,
      result: r.result,
      status: r.status,
    });
    if (r.prev_hash !== prev || r.hash !== expected) {
      return { ok: false, brokenAtId: String(r.id) };
    }
    prev = r.hash;
  }
  return { ok: true, count: rows.length };
}