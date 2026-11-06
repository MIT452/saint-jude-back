import { Router, Request, Response, NextFunction } from "express";
import { pool } from "../db.js";
import { hasRole } from "../utils/authSession.js";
import type { SessionUser } from "../utils/authSession.js";
import { sendTestMessage } from "../services/notifications.js";

// Monté dans server.ts derrière requireAuth.
// Table notification_settings = configuration UNIQUE de l'application (une seule ligne).
const router = Router();

const EVENTS = [
  "reservation.manual_review",
  "reservation.auto_approved",
  "reservation.rejected",
  "payment.received",
  "system.error",
];
const DEFAULT_EVENTS = ["reservation.manual_review", "reservation.auto_approved", "reservation.rejected"];
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

const parseEvents = (v: unknown): string[] => {
  let list: unknown = v;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      list = null;
    }
  }
  return Array.isArray(list) ? list.filter((e): e is string => typeof e === "string" && EVENTS.includes(e)) : DEFAULT_EVENTS;
};

const toDto = (r: any) => ({
  whatsappNumber: r?.admin_whatsapp ?? "",
  emailAddress: r?.admin_email ?? "",
  whatsappEnabled: r?.whatsapp_enabled ?? false,
  emailEnabled: r?.email_enabled ?? false,
  clientWhatsappEnabled: r?.client_whatsapp_enabled ?? true,
  clientEmailEnabled: r?.client_email_enabled ?? true,
  events: parseEvents(r?.events),
});

router.use(requireAdmin);

async function readSettings() {
  const { rows } = await pool.query("SELECT * FROM notification_settings ORDER BY id LIMIT 1");
  return rows[0];
}

// Lecture de la configuration
router.get("/", async (_req, res) => {
  try {
    res.json(toDto(await readSettings()));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Mise à jour : modifie la ligne unique, ou la crée si la table est vide
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
    const values = [
      phone || null, mail || null, !!whatsappEnabled, !!emailEnabled,
      !!clientWhatsappEnabled, !!clientEmailEnabled, JSON.stringify(cleanEvents),
    ];

    const updated = await pool.query(
      `UPDATE notification_settings SET
         admin_whatsapp = $1, admin_email = $2, whatsapp_enabled = $3, email_enabled = $4,
         client_whatsapp_enabled = $5, client_email_enabled = $6, events = $7::jsonb, updated_at = now()
       WHERE id = (SELECT MIN(id) FROM notification_settings)
       RETURNING *`,
      values,
    );
    if (updated.rows[0]) return res.json(toDto(updated.rows[0]));

    const inserted = await pool.query(
      `INSERT INTO notification_settings
         (admin_whatsapp, admin_email, whatsapp_enabled, email_enabled,
          client_whatsapp_enabled, client_email_enabled, events, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb, now())
       RETURNING *`,
      values,
    );
    res.json(toDto(inserted.rows[0]));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Historique des envois (50 derniers) : réservé à l'administrateur
router.get("/history", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, channel, event, recipient, status, error, created_at
         FROM notification_logs ORDER BY id DESC LIMIT 50`,
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Test : le destinataire vient de la base, jamais du front
router.post("/test", async (req, res) => {
  try {
    const channel = req.body?.channel;
    if (!["whatsapp", "email"].includes(channel)) return res.status(400).json({ error: "Canal invalide." });

    const s = await readSettings();
    const to = channel === "whatsapp" ? s?.admin_whatsapp : s?.admin_email;
    if (!to) return res.status(400).json({ error: "Enregistrez d'abord la coordonnée." });

    let ok = false;
    let err: string | null = null;
    const n8nTest = (process.env.N8N_TEST_WEBHOOK_URL ?? "").trim();
    try {
      if (n8nTest) {
        const r = await fetch(n8nTest, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channel, to, event: "notification.test" }),
          signal: AbortSignal.timeout(10_000),
        });
        ok = r.ok;
        if (!r.ok) err = `HTTP ${r.status}`;
      } else {
        await sendTestMessage(channel, String(to), s?.mail_from_name);
        ok = true;
      }
    } catch (e: any) {
      err = String(e?.message ?? "Réseau").slice(0, 200);
    }

    await pool
      .query(
        "INSERT INTO notification_logs (user_id, channel, event, recipient, status, error) VALUES ($1,$2,$3,$4,$5,$6)",
        [uid(res), channel, "notification.test", to, ok ? "sent" : "failed", err],
      )
      .catch(() => undefined);

    if (!ok) return res.status(502).json({ error: err ? `Envoi impossible : ${err}` : "Envoi impossible." });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

export default router;