import { createHmac, timingSafeEqual } from "node:crypto";
import type { RequestHandler, Response } from "express";
import { pool } from "../db.js";

const COOKIE_NAME = "sj_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

interface SessionClaims {
  userId: string;
  expiresAt: number;
}

interface SessionUser {
  id: string;
  name: string;
  lastName: string;
  email: string;
  tel: string | null;
  role: string;
  permissions: unknown;
}

const getAuthSecret = () => {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("AUTH_SECRET doit contenir au moins 32 caractères.");
  }
  return secret;
};

export const assertAuthSecret = () => {
  getAuthSecret();
};

const signatureFor = (payload: string) =>
  createHmac("sha256", getAuthSecret()).update(payload).digest("base64url");

export const createSessionToken = (userId: string) => {
  const claims: SessionClaims = {
    userId,
    expiresAt: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${signatureFor(payload)}`;
};

const verifySessionToken = (token: string): SessionClaims | null => {
  try {
    const [payload, signature] = token.split(".");
    if (!payload || !signature) return null;
    const expected = Buffer.from(signatureFor(payload));
    const received = Buffer.from(signature);
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;

    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SessionClaims;
    if (!claims.userId || claims.expiresAt <= Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
};

const readSessionCookie = (cookieHeader = "") => {
  const value = cookieHeader.split(";").map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(`${COOKIE_NAME}=`))
    ?.slice(COOKIE_NAME.length + 1);
  return value ? decodeURIComponent(value) : "";
};

const cookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: (process.env.NODE_ENV === "production" ? "none" : "lax") as "none" | "lax",
  path: "/",
  maxAge: SESSION_TTL_SECONDS * 1000,
});

export const setSessionCookie = (response: Response, userId: string) => {
  response.cookie(COOKIE_NAME, createSessionToken(userId), cookieOptions());
};

export const clearSessionCookie = (response: Response) => {
  const { maxAge: _maxAge, ...options } = cookieOptions();
  response.clearCookie(COOKIE_NAME, options);
};

export const requireAuth: RequestHandler = async (request, response, next) => {
  let claims: SessionClaims | null;
  try {
    claims = verifySessionToken(readSessionCookie(request.headers.cookie));
  } catch {
    response.status(503).json({ error: "Authentification indisponible : configurez AUTH_SECRET." });
    return;
  }

  if (!claims) {
    response.status(401).json({ error: "Authentification requise." });
    return;
  }

  try {
    const { rows } = await pool.query<SessionUser>(
      'SELECT id, name, "lastName", email, tel, role, permissions FROM "user" WHERE id = $1',
      [claims.userId],
    );
    if (!rows[0]) {
      clearSessionCookie(response);
      response.status(401).json({ error: "Session invalide." });
      return;
    }
    response.locals.sessionUser = rows[0];
    next();
  } catch (error) {
    console.error("Erreur de vérification de session", error);
    response.status(500).json({ error: "Impossible de vérifier la session." });
  }
};

export const requireOwner: RequestHandler = (_request, response, next) => {
  const user = response.locals.sessionUser as SessionUser | undefined;
  if (user?.role !== "Propriétaire") {
    response.status(403).json({ error: "Accès réservé au propriétaire." });
    return;
  }
  next();
};

export const requireTrustedOrigin: RequestHandler = (request, response, next) => {
  const origin = request.get("origin");
  const allowedOrigins = (process.env.CORS_ORIGIN ?? "http://localhost:5173")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (!origin || allowedOrigins.includes(origin)) {
    next();
    return;
  }
  response.status(403).json({ error: "Origine de requête non autorisée." });
};
