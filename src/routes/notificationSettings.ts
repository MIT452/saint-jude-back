import { Router, Request, Response } from "express";
import { pool } from "../db"; // adapte ce chemin à ton export Pool

const router = Router();

const EVENTS = [
  "reservation.confirmed",
  "reservation.pending",
  "reservation.rejected",
  "reservation.cancelled",
  "payment.received",
] as const;
const ALLOWED_VARS = new Set(["client", "trajet", "date", "passagers", "total", "reference", "motif"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const isOwner = (req: Request) => /propri|admin/i.test(String((req as any).user?.role ?? ""));

// WhatsApp attend des chiffres uniquement, au format international (ex. 261340000000)
const cleanPhone = (v: string): string | null => {
  const d = v.replace(/[\s().-]/g, "").replace(/^\+/, "").replace(/^00/, "");
  return /^[1-9]\d{7,14}$/.test(d) ? d : null;
};

const hasUnknownVars = (text: string) =>
  [...text.matchAll(/\{(\w+)\}/g)].some((m) => !ALLOWED_VARS.has(m[1]));

const defaults = () => ({
  adminEmail: "",
  adminWhatsapp: "",
  emailEnabled: true,
  whatsappEnabled: false,
  events: Object.fromEntries(EVENTS.map((e) => [e, true])),
  templates: {},
  aiTone: "professionnel et chaleureux",
  updatedAt: null,
});

const toApi = (r: any) => ({
  adminEmail: r.admin_email ?? "",
  adminWhatsapp: r.admin_whatsapp ? `+${r.admin_whatsapp}` : "",
  emailEnabled: r.email_enabled,
  whatsappEnabled: r.whatsapp_enabled,
  events: { ...defaults().events, ...(r.events ?? {}) },
  templates: r.templates ?? {},
  aiTone: r.ai_tone,
  updatedAt: r.updated_at,
});

router.get("/", async (req: Request, res: Response) => {
  if (!isOwner(req)) return res.status(403).json({ error: "Accès réservé à l'administrateur." });
  try {
    const r = await pool.query("SELECT * FROM notification_settings WHERE id = 1");
    return res.json(r.rowCount ? toApi(r.rows[0]) : defaults());
  } catch (err) {
    console.error("[notification-settings][GET]", err);
    return res.status(500).json({ error: "Erreur serveur." });
  }
});

router.put("/", async (req: Request, res: Response) => {
  if (!isOwner(req)) return res.status(403).json({ error: "Accès réservé à l'administrateur." });
  try {
    const b = req.body ?? {};
    const email = String(b.adminEmail ?? "").trim();
    const phoneRaw = String(b.adminWhatsapp ?? "").trim();
    const emailEnabled = !!b.emailEnabled;
    const whatsappEnabled = !!b.whatsappEnabled;

    if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: "Adresse e-mail invalide." });
    if (emailEnabled && !email) return res.status(400).json({ error: "Renseignez une adresse e-mail pour activer ce canal." });

    const phone = phoneRaw ? cleanPhone(phoneRaw) : null;
    if (phoneRaw && !phone) return res.status(400).json({ error: "Numéro WhatsApp invalide (format international, ex. +261 34 00 000 00)." });
    if (whatsappEnabled && !phone) return res.status(400).json({ error: "Renseignez un numéro WhatsApp pour activer ce canal." });

    const events: Record<string, boolean> = {};
    for (const e of EVENTS) events[e] = !!b.events?.[e];

    const templates: Record<string, { subject: string; body: string }> = {};
    for (const e of EVENTS) {
      const t = b.templates?.[e];
      if (!t) continue;
      const subject = String(t.subject ?? "").trim().slice(0, 150);
      const body = String(t.body ?? "").trim().slice(0, 1500);
      if (!subject && !body) continue;
      if (hasUnknownVars(subject) || hasUnknownVars(body))
        return res.status(400).json({ error: `Variable inconnue dans le message « ${e} ».` });
      templates[e] = { subject, body };
    }

    const tone = String(b.aiTone ?? "professionnel et chaleureux").trim().slice(0, 80) || "professionnel et chaleureux";
    const userId = String((req as any).user?.id ?? "");

    const r = await pool.query(
      `INSERT INTO notification_settings
         (id, admin_email, admin_whatsapp, email_enabled, whatsapp_enabled, events, templates, ai_tone, updated_by, updated_at)
       VALUES (1,$1,$2,$3,$4,$5,$6,$7,$8,NOW())
       ON CONFLICT (id) DO UPDATE SET
         admin_email = EXCLUDED.admin_email,
         admin_whatsapp = EXCLUDED.admin_whatsapp,
         email_enabled = EXCLUDED.email_enabled,
         whatsapp_enabled = EXCLUDED.whatsapp_enabled,
         events = EXCLUDED.events,
         templates = EXCLUDED.templates,
         ai_tone = EXCLUDED.ai_tone,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()
       RETURNING *`,
      [email || null, phone, emailEnabled, whatsappEnabled, JSON.stringify(events), JSON.stringify(templates), tone, userId],
    );
    return res.json(toApi(r.rows[0]));
  } catch (err) {
    console.error("[notification-settings][PUT]", err);
    return res.status(500).json({ error: "Erreur serveur." });
  }
});

export default router;