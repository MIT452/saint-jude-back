import { Router, Request, Response, NextFunction } from "express";
import { pool } from "../db.js";
import { hasRole } from "../utils/authSession.js";
import type { SessionUser } from "../utils/authSession.js";

// Monté dans server.ts derrière requireAuth
const router = Router();

const EVENTS = [
  "reservation.manual_review",
  "reservation.auto_approved",
  "reservation.rejected",
  "payment.received",
  "system.error",
];
const PHONE_RE = /^\+[1-9]\d{7,14}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const sessionUser = (res: Response) => res.locals.sessionUser as SessionUser;
const uid = (res: Response) => String(sessionUser(res).id);

// Réservé au propriétaire et à l'administrateur
const requireAdmin = (_req: Request, res: Response, next: NextFunction) => {
  const user = sessionUser(res);
  if (!user || !hasRole(user, "Propriétaire", "Administrateur", "Admin")) {
    return res.status(403).json({ error: "Accès réservé au propriétaire et à l'administrateur." });
  }
  next();
};

const toDto = (r: any) => ({
  whatsappNumber: r?.whatsapp_number ?? "",
  emailAddress: r?.email_address ?? "",
  whatsappEnabled: r?.whatsapp_enabled ?? false,
  emailEnabled: r?.email_enabled ?? false,
  clientWhatsappEnabled: r?.client_whatsapp_enabled ?? true,
  clientEmailEnabled: r?.client_email_enabled ?? true,
  events: r?.events ?? EVENTS,
});

router.use(requireAdmin);

// Lecture : uniquement la ligne de l'utilisateur connecté
router.get("/", async (_req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM notification_settings WHERE user_id = $1", [uid(res)]);
    res.json(toDto(rows[0]));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Mise à jour (upsert)
router.put("/", async (req, res) => {
  try {
    const {
      whatsappNumber = "", emailAddress = "", whatsappEnabled = false, emailEnabled = false,
      clientWhatsappEnabled = true, clientEmailEnabled = true, events = [],
    } = req.body ?? {};
    const phone = String(whatsappNumber).trim();
    const mail = String(emailAddress).trim().toLowerCase();

    if (phone && !PHONE_RE.test(phone)) return res.status(400).json({ error: "Numéro WhatsApp invalide (ex. +261340000000)." });
    if (mail && !EMAIL_RE.test(mail)) return res.status(400).json({ error: "Adresse e-mail invalide." });
    if (whatsappEnabled && !phone) return res.status(400).json({ error: "Renseignez le numéro WhatsApp." });
    if (emailEnabled && !mail) return res.status(400).json({ error: "Renseignez l'adresse e-mail." });

    const cleanEvents = Array.isArray(events) ? events.filter((e: string) => EVENTS.includes(e)) : [];

    const { rows } = await pool.query(
      `INSERT INTO notification_settings
         (user_id, whatsapp_number, email_address, whatsapp_enabled, email_enabled,
          client_whatsapp_enabled, client_email_enabled, events, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb, now())
       ON CONFLICT (user_id) DO UPDATE SET
         whatsapp_number = EXCLUDED.whatsapp_number,
         email_address = EXCLUDED.email_address,
         whatsapp_enabled = EXCLUDED.whatsapp_enabled,
         email_enabled = EXCLUDED.email_enabled,
         client_whatsapp_enabled = EXCLUDED.client_whatsapp_enabled,
         client_email_enabled = EXCLUDED.client_email_enabled,
         events = EXCLUDED.events,
         updated_at = now()
       RETURNING *`,
      [uid(res), phone || null, mail || null, !!whatsappEnabled, !!emailEnabled,
       !!clientWhatsappEnabled, !!clientEmailEnabled, JSON.stringify(cleanEvents)],
    );
    res.json(toDto(rows[0]));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Historique : uniquement les envois de l'administrateur connecté
router.get("/history", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, channel, event, recipient, status, error, created_at
         FROM notification_logs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [uid(res)],
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Test via n8n : le destinataire vient de la base, jamais du front
router.post("/test", async (req, res) => {
  try {
    const channel = req.body?.channel;
    if (!["whatsapp", "email"].includes(channel)) return res.status(400).json({ error: "Canal invalide." });

    const url = process.env.N8N_TEST_WEBHOOK_URL;
    if (!url) return res.status(503).json({ error: "N8N_TEST_WEBHOOK_URL n'est pas configurée sur le serveur." });

    const { rows } = await pool.query("SELECT * FROM notification_settings WHERE user_id = $1", [uid(res)]);
    const s = rows[0];
    const to = channel === "whatsapp" ? s?.whatsapp_number : s?.email_address;
    if (!to) return res.status(400).json({ error: "Enregistrez d'abord la coordonnée." });

    let ok = false;
    let err: string | null = null;
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, to, event: "notification.test" }),
      });
      ok = r.ok;
      if (!r.ok) err = `HTTP ${r.status}`;
    } catch (e: any) {
      err = String(e?.message ?? "Réseau");
    }

    await pool.query(
      "INSERT INTO notification_logs (user_id, channel, event, recipient, status, error) VALUES ($1,$2,$3,$4,$5,$6)",
      [uid(res), channel, "notification.test", to, ok ? "sent" : "failed", err],
    );

    if (!ok) return res.status(502).json({ error: "n8n n'a pas pu envoyer le message." });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

export default router;