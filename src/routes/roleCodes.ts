// src/routes/roleCodes.ts
import { Router } from "express";
import crypto from "crypto";
import { pool } from "../db.js";
import { requireAuth, requireOwner } from "../utils/authSession.js";

/* ------------------------------------------------------------------ */
/* Rôles : Client (public) + 4 rôles du personnel (code d'accès)        */
/* ------------------------------------------------------------------ */
export type RegisterRole = "client" | "agent" | "gestionnaire" | "capitaine" | "proprietaire";
export type CodeRole = Exclude<RegisterRole, "client">;

export const CODE_ROLES: CodeRole[] = ["agent", "gestionnaire", "capitaine", "proprietaire"];

/* Libellé enregistré dans la colonne "role" de la table "user".
   ⚠️ Vérifie avec les valeurs déjà présentes en base :
   SELECT role, COUNT(*) FROM "user" GROUP BY role;  */
export const ROLE_LABELS: Record<RegisterRole, string> = {
  client: "Client",
  agent: "Agent",
  gestionnaire: "Gestionnaire",
  capitaine: "Capitaine",
  proprietaire: "Propriétaire",
};

const PREFIX: Record<CodeRole, string> = {
  agent: "AGT",
  gestionnaire: "GEST",
  capitaine: "CAP",
  proprietaire: "OWN",
};

export const normalizeRole = (value: unknown): RegisterRole | null => {
  const v = String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (v === "client" || v === "voyageur") return "client";
  if (v === "agent") return "agent";
  if (v === "gestionnaire") return "gestionnaire";
  if (v === "capitaine") return "capitaine";
  if (v === "proprietaire" || v === "admin" || v === "administrateur") return "proprietaire";
  return null;
};

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
          created_by  INTEGER,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
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
/* Vérification (à appeler depuis /auth/register)                      */
/*  - Client : aucun code                                              */
/*  - Agent / Gestionnaire / Capitaine / Propriétaire : code obligatoire */
/* ------------------------------------------------------------------ */
export interface VerifyResult {
  ok: boolean;
  error?: string;
}

export const verifyRoleCode = async (role: RegisterRole, code: string, clientKey: string): Promise<VerifyResult> => {
  if (role === "client") return { ok: true };

  const key = `rolecode:${clientKey}`;
  if (isLimited(key)) {
    return { ok: false, error: "Trop de tentatives. Réessayez dans 15 minutes." };
  }
  if (!code || !code.trim()) {
    return { ok: false, error: `Le code d'accès du rôle ${ROLE_LABELS[role]} est obligatoire.` };
  }

  await ensureTable();
  const { rows } = await pool.query(
    `SELECT code_hash, expires_at
       FROM role_access_codes
      WHERE role = $1 AND is_active = TRUE
      LIMIT 1`,
    [role],
  );

  const row = rows[0];
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

/* ------------------------------------------------------------------ */
/* Routes réservées au Propriétaire (protégées ici même)               */
/* ------------------------------------------------------------------ */
const router = Router();
router.use(requireAuth, requireOwner);

// État des codes (jamais le code lui-même)
router.get("/", async (_req, res) => {
  try {
    await ensureTable();
    const { rows } = await pool.query(
      `SELECT role, is_active, expires_at, created_at
         FROM role_access_codes
        WHERE is_active = TRUE AND role = ANY($1::text[])`,
      [CODE_ROLES],
    );
    res.json(
      rows.map((r) => ({
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

// Générer / renouveler un code (le code en clair n'est renvoyé qu'ici, une seule fois)
router.post("/", async (req, res) => {
  const role = normalizeRole(req.body?.role);
  const days = Number(req.body?.days);
  if (!role || role === "client") return res.status(400).json({ error: "Rôle invalide." });
  if (![7, 30, 90].includes(days)) return res.status(400).json({ error: "Durée invalide (7, 30 ou 90 jours)." });

  const client = await pool.connect();
  try {
    await ensureTable();
    const code = generateCode(role);
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    const createdBy = Number((req as any).user?.id) || null;

    await client.query("BEGIN");
    await client.query(`UPDATE role_access_codes SET is_active = FALSE WHERE role = $1 AND is_active = TRUE`, [role]);
    await client.query(
      `INSERT INTO role_access_codes (role, code_hash, expires_at, created_by)
       VALUES ($1, $2, $3, $4)`,
      [role, hashCode(code), expiresAt, createdBy],
    );
    await client.query("COMMIT");

    res.status(201).json({ role, code, expiresAt: expiresAt.toISOString() });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error("[role-codes] POST", err);
    res.status(500).json({ error: "Erreur serveur." });
  } finally {
    client.release();
  }
});

// Désactiver le code actif d'un rôle (plus personne ne peut s'inscrire avec ce rôle)
router.delete("/:role", async (req, res) => {
  const role = normalizeRole(req.params.role);
  if (!role || role === "client") return res.status(400).json({ error: "Rôle invalide." });
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