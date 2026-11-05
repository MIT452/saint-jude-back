import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { v4 as uuid } from "uuid";
import { pool } from "../db.js";
import { auditSafe } from "../audit/auditService.js";
import { roleKey } from "../utils/accessPolicy.js";
import { assertAuthSecret, clearSessionCookie, normalizePermissions, requireAuth, setSessionCookie } from "../utils/authSession.js";
import { hashPassword, verifyPassword } from "../utils/password.js";

interface UserRow {
  id: string;
  name: string;
  lastName: string;
  email: string;
  tel: string | null;
  role: string;
  permissions: unknown;
  password: string;
}

const safeUser = ({ password: _password, ...user }: UserRow) => ({
  ...user,
  permissions: normalizePermissions(user.permissions),
});
const router = Router();

export function normalizeRegistrationInput(body: unknown) {
  const input = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
  return {
    name: text(input.name ?? input.firstName),
    lastName: text(input.lastName),
    email: text(input.email).toLowerCase(),
    tel: text(input.tel ?? input.phone),
    password: typeof input.password === "string" ? input.password : "",
  };
}

/* ---------- Rôle choisi à l'inscription ---------- */

// Rôle technique -> libellé enregistré dans la colonne "role".
// Chaque rôle de cette liste exige le code de la variable ROLE_CODE_<ROLE> (Render > Environment).
const SELF_SERVICE_ROLES: Record<string, string> = {
  manager: "Manager",
  gestionnaire: "Gestionnaire",
  comptable: "Comptable",
  caissier: "Caissier",
  capitaine: "Capitaine",
  agent: "Agent",
};

// Rôles qui ne peuvent JAMAIS être obtenus depuis le formulaire d'inscription
const FORBIDDEN_ROLE_KEYS = new Set(["admin", "administrateur", "owner", "proprietaire", "directeur", "director"]);

const sameCode = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// Un code trop court, un texte de remplacement ou un code de démonstration n'est pas un vrai secret
const isWeakCode = (value: string) =>
  value.length < 12 ||
  /^code\s+g[ée]n[ée]r[ée]/i.test(value) ||
  /^demo[-_]/i.test(value) ||
  /change.?me|todo|xxx/i.test(value);

// Même règle de mot de passe que le formulaire d'inscription (le navigateur ne suffit jamais)
const isStrongPassword = (p: string) =>
  p.length >= 8 && p.length <= 128 && /[A-Z]/.test(p) && /[a-z]/.test(p) && /\d/.test(p) && /[^A-Za-z0-9]/.test(p);

/* ---------- Limite de tentatives (codes de rôle et connexion) ---------- */

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES_PER_EMAIL = 5;
const MAX_FAILURES_PER_IP = 20;
// Connexion : clé = IP + e-mail, pour qu'un attaquant ne puisse pas bloquer le compte d'un autre utilisateur depuis sa propre IP
const MAX_LOGIN_FAILURES_PER_PAIR = 5;
const MAX_LOGIN_FAILURES_PER_IP = 30;
// Compteurs en mémoire : remis à zéro au redémarrage de Render (suffisant pour une seule instance)
const failures = new Map<string, { count: number; resetAt: number }>();

const purgeExpired = () => {
  const now = Date.now();
  for (const [key, value] of failures) {
    if (value.resetAt <= now) failures.delete(key);
  }
};

const failureCount = (key: string) => {
  const entry = failures.get(key);
  if (!entry || entry.resetAt <= Date.now()) return 0;
  return entry.count;
};

const registerFailure = (key: string) => {
  if (failures.size > 5000) purgeExpired();
  const now = Date.now();
  const entry = failures.get(key);
  if (!entry || entry.resetAt <= now) failures.set(key, { count: 1, resetAt: now + WINDOW_MS });
  else entry.count += 1;
};

const isBlocked = (email: string, ip: string) =>
  failureCount(`email:${email}`) >= MAX_FAILURES_PER_EMAIL || failureCount(`ip:${ip}`) >= MAX_FAILURES_PER_IP;

const isLoginBlocked = (email: string, ip: string) =>
  failureCount(`login:${ip}:${email}`) >= MAX_LOGIN_FAILURES_PER_PAIR || failureCount(`loginip:${ip}`) >= MAX_LOGIN_FAILURES_PER_IP;

const registerLoginFailure = (email: string, ip: string) => {
  registerFailure(`login:${ip}:${email}`);
  registerFailure(`loginip:${ip}`);
};

/**
 * Le navigateur ne décide jamais seul de son rôle :
 *  - Admin / Propriétaire / Directeur : jamais depuis le formulaire ;
 *  - rôle d'employé : code d'accès propre au rôle (variable ROLE_CODE_<ROLE> sur Render) ;
 *  - rôle absent ou inconnu : compte « Client » sans droits sur les modules.
 */
function resolveRegistrationRole(requested: unknown, roleCode: unknown): { role: string } | { error: string; codeFailure: boolean } {
  const key = roleKey(requested);
  if (FORBIDDEN_ROLE_KEYS.has(key)) {
    return { error: "Ce rôle ne peut pas être choisi à l'inscription.", codeFailure: false };
  }
  const label = SELF_SERVICE_ROLES[key];
  if (!label) return { role: "Client" };

  const variable = `ROLE_CODE_${key.toUpperCase()}`;
  const expected = process.env[variable]?.trim();
  const given = typeof roleCode === "string" ? roleCode.trim() : "";

  if (!expected || isWeakCode(expected)) {
    // Visible uniquement dans les logs Render : le code du rôle n'est pas configuré correctement
    console.warn(`[register] ${variable} est absent ou trop faible : inscription refusée pour ce rôle.`);
    return { error: "Code d'accès invalide pour ce rôle.", codeFailure: true };
  }
  // Même message si le code est faux ou absent : on ne révèle rien
  if (!given || !sameCode(given, expected)) {
    return { error: "Code d'accès invalide pour ce rôle.", codeFailure: true };
  }
  return { role: label };
}

router.post("/register", async (request, response) => {
  const { name, lastName, email, tel, password } = normalizeRegistrationInput(request.body);

  if (!name || !lastName || !/^\S+@\S+\.\S+$/.test(email) || password.length < 8 || password.length > 128) {
    response.status(400).json({ error: "Nom, prénom, email valide et mot de passe de 8 à 128 caractères requis." });
    return;
  }
  if (!isStrongPassword(password)) {
    response.status(400).json({
      error: "Le mot de passe doit contenir une majuscule, une minuscule, un chiffre et un caractère spécial.",
    });
    return;
  }

  const rawBody = request.body && typeof request.body === "object" ? request.body as Record<string, unknown> : {};
  const ip = request.ip ?? "unknown";

  // Trop d'essais ratés de code de rôle : on bloque temporairement (les inscriptions « Client » restent possibles)
  if (SELF_SERVICE_ROLES[roleKey(rawBody.role)] && isBlocked(email, ip)) {
    response.status(429).json({ error: "Trop de tentatives. Réessayez dans quelques minutes." });
    return;
  }

  const resolved = resolveRegistrationRole(rawBody.role, rawBody.roleCode);
  if ("error" in resolved) {
    if (resolved.codeFailure) {
      registerFailure(`email:${email}`);
      registerFailure(`ip:${ip}`);
    }
    // Compté par la règle de détection (5 essais ratés = alerte critique)
    await auditSafe({
      action: "LOGIN_FAILED",
      resource: "auth",
      userId: null,
      ip: request.ip,
      result: "FAILURE",
      details: { email, event: "role-code" },
    });
    response.status(403).json({ error: resolved.error });
    return;
  }

  try {
    assertAuthSecret();
    const passwordHash = await hashPassword(password);
    const { rows } = await pool.query<UserRow>(
      `INSERT INTO "user" (id, name, "lastName", password, email, tel, role, permissions)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '[]'::jsonb)
       RETURNING id, name, "lastName", email, tel, role, permissions, password`,
      [uuid(), name, lastName, passwordHash, email, tel || null, resolved.role],
    );

    const user = rows[0];
    setSessionCookie(response, user.id);
    await auditSafe({
      action: "CREATE",
      resource: "user",
      resourceId: user.id,
      userId: user.id,
      ip: request.ip,
      details: { event: "register", email, role: resolved.role },
    });
    response.status(201).json({ user: safeUser(user) });
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
    if (code === "23505") {
      response.status(409).json({ error: "Cette adresse email est déjà utilisée." });
      return;
    }
    console.error("Erreur lors de l’inscription", error);
    response.status(503).json({ error: "Inscription indisponible. Vérifiez la connexion à la base de données et AUTH_SECRET." });
  }
});

router.post("/login", async (request, response) => {
  const email = typeof request.body?.email === "string" ? request.body.email.trim().toLowerCase() : "";
  const password = typeof request.body?.password === "string" ? request.body.password : "";
  if (!email || !password) {
    response.status(400).json({ error: "Email et mot de passe requis." });
    return;
  }

  const ip = request.ip ?? "unknown";
  // Après 5 échecs (même IP + même e-mail) ou 30 échecs (même IP) en 15 min : pause
  if (isLoginBlocked(email, ip)) {
    response.status(429).json({ error: "Trop de tentatives. Réessayez dans quelques minutes." });
    return;
  }

  try {
    assertAuthSecret();
    const { rows } = await pool.query<UserRow>(
      'SELECT id, name, "lastName", email, tel, role, permissions, password FROM "user" WHERE LOWER(email) = $1 LIMIT 1',
      [email],
    );
    const user = rows[0];
    if (!user || !(await verifyPassword(password, user.password))) {
      registerLoginFailure(email, ip);
      await auditSafe({
        action: "LOGIN_FAILED",
        resource: "auth",
        userId: user?.id ?? null,
        ip: request.ip,
        result: "FAILURE",
        details: { email },
      });
      response.status(401).json({ error: "Email ou mot de passe incorrect." });
      return;
    }

    // Connexion réussie : on remet à zéro le compteur de cette IP + e-mail
    failures.delete(`login:${ip}:${email}`);

    if (!user.password.startsWith("scrypt$")) {
      await pool.query('UPDATE "user" SET password = $1 WHERE id = $2', [await hashPassword(password), user.id]);
    }

    setSessionCookie(response, user.id);
    await auditSafe({
      action: "LOGIN",
      resource: "auth",
      userId: user.id,
      ip: request.ip,
      details: { email },
    });
    response.json({ user: safeUser(user) });
  } catch (error) {
    console.error("Erreur lors de la connexion", error);
    response.status(503).json({ error: "Connexion indisponible. Vérifiez la base de données et AUTH_SECRET." });
  }
});

router.post("/change-password", requireAuth, async (request, response) => {
  const oldPassword = typeof request.body?.oldPassword === "string" ? request.body.oldPassword : "";
  const newPassword = typeof request.body?.newPassword === "string" ? request.body.newPassword : "";
  if (newPassword.length < 8 || newPassword.length > 128) {
    response.status(400).json({ error: "Le nouveau mot de passe doit contenir de 8 à 128 caractères." });
    return;
  }

  const user = response.locals.sessionUser as Pick<UserRow, "id">;
  try {
    const { rows } = await pool.query<{ password: string }>(
      'SELECT password FROM "user" WHERE id = $1',
      [user.id],
    );
    if (!rows[0] || !(await verifyPassword(oldPassword, rows[0].password))) {
      response.status(400).json({ error: "Ancien mot de passe incorrect." });
      return;
    }

    await pool.query('UPDATE "user" SET password = $1 WHERE id = $2', [await hashPassword(newPassword), user.id]);
    await auditSafe({
      action: "UPDATE",
      resource: "user",
      resourceId: user.id,
      userId: user.id,
      ip: request.ip,
      details: { event: "change-password" },
    });
    response.json({ message: "Mot de passe modifié." });
  } catch (error) {
    console.error("Erreur lors du changement de mot de passe", error);
    response.status(500).json({ error: "Impossible de modifier le mot de passe." });
  }
});

router.get("/me", requireAuth, (_request, response) => {
  const user = response.locals.sessionUser as Omit<UserRow, "password">;
  response.json({ user });
});

router.post("/logout", (_request, response) => {
  clearSessionCookie(response);
  response.status(204).end();
});

export default router;