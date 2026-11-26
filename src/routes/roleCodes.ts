// src/routes/roleCodes.ts
import { Router } from "express";
import type { RequestHandler, Response } from "express";
import crypto from "crypto";
import { pool } from "../db.js";
import { requireAuth } from "../utils/authSession.js";
import { sendMail } from "../utils/mailer.js";

/* ------------------------------------------------------------------ */
/* Rôles                                                               */
/* ------------------------------------------------------------------ */
export type RegisterRole = "agent" | "gestionnaire" | "capitaine" | "admin" | "proprietaire";
export type CodeRole = RegisterRole;

export const CODE_ROLES: CodeRole[] = ["agent", "gestionnaire", "capitaine", "admin", "proprietaire"];

export const ROLE_LABELS: Record<RegisterRole, string> = {
  agent: "Agent",
  gestionnaire: "Gestionnaire",
  capitaine: "Capitaine",
  admin: "Administrateur",
  proprietaire: "Propriétaire",
};

const PREFIX: Record<CodeRole, string> = {
  agent: "AGT",
  gestionnaire: "GEST",
  capitaine: "CAP",
  admin: "ADM",
  proprietaire: "OWN",
};

export const normalizeRole = (value: unknown): RegisterRole | null => {
  const v = String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (v === "agent") return "agent";
  if (v === "gestionnaire") return "gestionnaire";
  if (v === "capitaine") return "capitaine";
  if (v === "admin" || v === "administrateur") return "admin";
  if (v === "proprietaire") return "proprietaire";
  return null;
};

// Codes réservés au Propriétaire : Administrateur et Propriétaire
const isTopRole = (role: CodeRole) => role === "admin" || role === "proprietaire";

/* ------------------------------------------------------------------ */
/* Table Neon (créée automatiquement si absente)                       */
/* ------------------------------------------------------------------ */
let tableReady: Promise<void> | null = null;
const ensureTable = (): Promise<void> => {
  if (!tableReady) {
    tableReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS role_access_codes (
          id          SERIAL PRIMARY KEY,
          role        VARCHAR(30) NOT NULL,
          code_hash   TEXT NOT NULL,
          expires_at  TIMESTAMPTZ,
          is_active   BOOLEAN NOT NULL DEFAULT TRUE,
          created_by  TEXT,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      // Les identifiants utilisateur sont des UUID : created_by doit être du texte
      await pool.query(`ALTER TABLE role_access_codes ALTER COLUMN created_by TYPE TEXT USING created_by::text`);
      await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS role_access_codes_one_active
          ON role_access_codes (role) WHERE is_active
      `);
    })().catch((err) => {
      tableReady = null;
      throw err;
    });
  }
  return tableReady;
};

/* ------------------------------------------------------------------ */
/* Hash + génération                                                   */
/* ------------------------------------------------------------------ */
const secret = () => process.env.ROLE_CODE_SECRET || process.env.AUTH_SECRET || "saint-jude-role-code";

const normalizeCode = (code: string) => code.trim().toUpperCase().replace(/\s+/g, "");

const hashCode = (code: string) =>
  crypto.createHmac("sha256", secret()).update(normalizeCode(code)).digest("hex");

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sans 0/O/1/I
const randomBlock = (len: number) => {
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
};
const generateCode = (role: CodeRole) => `${PREFIX[role]}-${randomBlock(4)}-${randomBlock(4)}-${randomBlock(4)}`;

/* ------------------------------------------------------------------ */
/* Limitation des tentatives (en mémoire : 8 essais / 15 min / clé)    */
/* ------------------------------------------------------------------ */
const attempts = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;

const isLimited = (key: string) => {
  const entry = attempts.get(key);
  if (!entry || entry.resetAt < Date.now()) return false;
  return entry.count >= MAX_ATTEMPTS;
};
const registerCodeFailure = (key: string) => {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.resetAt < now) attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
  else entry.count += 1;
};

/* ------------------------------------------------------------------ */
/* Vérification (appelée depuis /auth/register)                        */
/* ------------------------------------------------------------------ */
export interface VerifyResult {
  ok: boolean;
  error?: string;
}

export const verifyRoleCode = async (role: RegisterRole, code: string, clientKey: string): Promise<VerifyResult> => {
  await ensureTable();
  const { rows } = await pool.query(
    `SELECT code_hash, expires_at
       FROM role_access_codes
      WHERE role = $1 AND is_active = TRUE
      LIMIT 1`,
    [role],
  );
  const row = rows[0];

  // Agent sans code actif : inscription libre
  if (role === "agent" && !row) return { ok: true };

  const key = `rolecode:${clientKey}`;
  if (isLimited(key)) {
    return { ok: false, error: "Trop de tentatives. Réessayez dans 15 minutes." };
  }
  if (!code || !code.trim()) {
    return { ok: false, error: `Le code d'accès du rôle ${ROLE_LABELS[role]} est obligatoire.` };
  }

  const expired = row?.expires_at && new Date(row.expires_at).getTime() < Date.now();

  let match = false;
  if (row && !expired) {
    const a = Buffer.from(hashCode(code), "hex");
    const b = Buffer.from(String(row.code_hash), "hex");
    match = a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  if (!match) {
    registerCodeFailure(key);
    return { ok: false, error: "Code d'accès invalide ou expiré pour ce rôle." };
  }
  return { ok: true };
};

// Rôles qui exigent un code à l'inscription (l'Agent seulement si un code Agent est actif)
export const getRequiredRoles = async (): Promise<CodeRole[]> => {
  await ensureTable();
  const { rows } = await pool.query(
    `SELECT role, expires_at FROM role_access_codes WHERE is_active = TRUE`,
  );
  const active = new Set(rows.map((r) => String(r.role)));
  return CODE_ROLES.filter((r) => r !== "agent" || active.has("agent"));
};

/* ------------------------------------------------------------------ */
/* E-mail du code généré                                               */
/* ------------------------------------------------------------------ */
const sendCodeEmail = async (to: string, role: CodeRole, code: string, expiresAt: Date) => {
  const label = ROLE_LABELS[role];
  const dateFr = expiresAt.toLocaleDateString("fr-FR");
  await sendMail(
    to,
    `Nouveau code d'accès — Rôle ${label}`,
    `Un nouveau code d'accès pour le rôle ${label} vient d'être généré.\n\nCode : ${code}\nExpire le : ${dateFr}\n\nL'ancien code a été désactivé.\n\nÉquipe SAINT-JUDE`,
    `<p>Bonjour,</p>
     <p>Un nouveau code d'accès pour le rôle <b>${label}</b> vient d'être généré.</p>
     <p style="font-size:22px;font-weight:bold;letter-spacing:2px">${code}</p>
     <p>Date d'expiration : <b>${dateFr}</b></p>
     <p>L'ancien code a été désactivé.</p>
     <p>Cordialement,<br/>Équipe SAINT-JUDE</p>`,
  );
};

/* ------------------------------------------------------------------ */
/* Routes : Propriétaire et Administrateur                             */
/*  - codes Agent / Gestionnaire / Capitaine : les deux                 */
/*  - codes Administrateur / Propriétaire : Propriétaire seulement      */
/* ------------------------------------------------------------------ */
const callerRole = (res: Response): RegisterRole | null =>
  normalizeRole((res.locals.sessionUser as { role?: string } | undefined)?.role);

const canManageCodes: RequestHandler = (_req, res, next) => {
  const r = callerRole(res);
  if (r === "proprietaire" || r === "admin") {
    next();
    return;
  }
  res.status(403).json({ error: "Accès réservé au Propriétaire ou à l'Administrateur." });
};

const router = Router();
router.use(requireAuth, canManageCodes);

// État des codes (jamais le code lui-même)
router.get("/", async (_req, res) => {
  try {
    await ensureTable();
    const { rows } = await pool.query(
      `SELECT role, is_active, expires_at, created_at
         FROM role_access_codes
        WHERE is_active = TRUE`,
    );
    const isOwnerCaller = callerRole(res) === "proprietaire";
    res.json(
      rows
        .filter((r) => isOwnerCaller || !isTopRole(r.role as CodeRole))
        .map((r) => ({
          role: r.role,
          isActive: r.is_active,
          expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
          createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        })),
    );
  } catch (err) {
    console.error("[role-codes] GET", err);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

// Générer / renouveler un code (renvoyé en clair une seule fois + envoyé par e-mail)
router.post("/", async (req, res) => {
  const role = normalizeRole(req.body?.role);
  const days = Number(req.body?.days);
  if (!role) return res.status(400).json({ error: "Rôle invalide." });
  if (![7, 30, 90].includes(days)) return res.status(400).json({ error: "Durée invalide (7, 30 ou 90 jours)." });
  if (isTopRole(role) && callerRole(res) !== "proprietaire") {
    return res.status(403).json({ error: "Seul le Propriétaire peut gérer ce code." });
  }

  const sessionUser = res.locals.sessionUser as { id?: string | number } | undefined;
  const createdBy = sessionUser?.id != null ? String(sessionUser.id) : null;

  const client = await pool.connect();
  try {
    await ensureTable();
    const code = generateCode(role);
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    await client.query("BEGIN");
    await client.query(`UPDATE role_access_codes SET is_active = FALSE WHERE role = $1 AND is_active = TRUE`, [role]);
    await client.query(
      `INSERT INTO role_access_codes (role, code_hash, expires_at, created_by)
       VALUES ($1, $2, $3, $4)`,
      [role, hashCode(code), expiresAt, createdBy],
    );
    await client.query("COMMIT");

    // Envoi par e-mail à la personne connectée (n'annule jamais la génération)
    let emailSent = false;
    if (createdBy) {
      try {
        const { rows } = await pool.query(`SELECT email FROM "user" WHERE id = $1`, [createdBy]);
        const to = rows[0]?.email;
        if (to) {
          await sendCodeEmail(String(to), role, code, expiresAt);
          emailSent = true;
        }
      } catch (mailErr) {
        console.error("[role-codes] e-mail non envoyé", mailErr);
      }
    }

    res.status(201).json({ role, code, expiresAt: expiresAt.toISOString(), emailSent });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error("[role-codes] POST", err);
    res.status(500).json({ error: "Erreur serveur." });
  } finally {
    client.release();
  }
});

// Désactiver le code actif d'un rôle (pour l'Agent : l'inscription redevient libre)
router.delete("/:role", async (req, res) => {
  const role = normalizeRole(req.params.role);
  if (!role) return res.status(400).json({ error: "Rôle invalide." });
  if (isTopRole(role) && callerRole(res) !== "proprietaire") {
    return res.status(403).json({ error: "Seul le Propriétaire peut gérer ce code." });
  }
  try {
    await ensureTable();
    await pool.query(`UPDATE role_access_codes SET is_active = FALSE WHERE role = $1 AND is_active = TRUE`, [role]);
    res.status(204).end();
  } catch (err) {
    console.error("[role-codes] DELETE", err);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

export default router;