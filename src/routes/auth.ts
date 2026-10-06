import { Router } from "express";
import { v4 as uuid } from "uuid";
import { pool } from "../db.js";
import { assertAuthSecret, clearSessionCookie, requireAuth, setSessionCookie } from "../utils/authSession.js";
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

const safeUser = ({ password: _password, ...user }: UserRow) => user;
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

router.post("/register", async (request, response) => {
  const { name, lastName, email, tel, password } = normalizeRegistrationInput(request.body);

  if (!name || !lastName || !/^\S+@\S+\.\S+$/.test(email) || password.length < 8 || password.length > 128) {
    response.status(400).json({ error: "Nom, prénom, email valide et mot de passe de 8 à 128 caractères requis." });
    return;
  }

  try {
    assertAuthSecret();
    const passwordHash = await hashPassword(password);
    const { rows } = await pool.query<UserRow>(
      `INSERT INTO "user" (id, name, "lastName", password, email, tel, role, permissions)
       VALUES ($1, $2, $3, $4, $5, $6, 'Agent', '[]'::jsonb)
       RETURNING id, name, "lastName", email, tel, role, permissions, password`,
      [uuid(), name, lastName, passwordHash, email, tel || null],
    );

    const user = rows[0];
    setSessionCookie(response, user.id);
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

  try {
    assertAuthSecret();
    const { rows } = await pool.query<UserRow>(
      'SELECT id, name, "lastName", email, tel, role, permissions, password FROM "user" WHERE LOWER(email) = $1 LIMIT 1',
      [email],
    );
    const user = rows[0];
    if (!user || !(await verifyPassword(password, user.password))) {
      response.status(401).json({ error: "Email ou mot de passe incorrect." });
      return;
    }

    if (!user.password.startsWith("scrypt$")) {
      await pool.query('UPDATE "user" SET password = $1 WHERE id = $2', [await hashPassword(password), user.id]);
    }

    setSessionCookie(response, user.id);
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
