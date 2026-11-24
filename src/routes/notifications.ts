import { Router, Request, Response } from 'express';
import { pool } from '../db';
import { toE164MG, invalidateAdminCache } from '../services/admin';
import { requireAuth, requireRole } from '../utils/authSession';

const r = Router();

// Lire la configuration
r.get(
  '/settings',
  requireAuth,
  requireRole('admin'),
  async (_req: Request, res: Response) => {
    try {
      const { rows } = await pool.query(
        `SELECT admin_whatsapp, admin_whatsapp_active, admin_email, admin_email_active
           FROM notification_settings WHERE id = 1`
      );
      res.json(rows[0] ?? {});
    } catch (err) {
      console.error('[notifications] GET /settings', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }
);

// Enregistrer la configuration
r.put(
  '/settings',
  requireAuth,
  requireRole('admin'),
  async (req: Request, res: Response) => {
    try {
      const { adminWhatsapp, adminWhatsappActive, adminEmail, adminEmailActive } = req.body;

      let phone: string | null = null;
      if (adminWhatsapp) {
        phone = toE164MG(String(adminWhatsapp));
        if (!phone) {
          res.status(400).json({ error: 'Numéro WhatsApp invalide' });
          return;
        }
      }

      await pool.query(
        `UPDATE notification_settings
            SET admin_whatsapp = $1, admin_whatsapp_active = $2,
                admin_email = $3,    admin_email_active = $4
          WHERE id = 1`,
        [phone, adminWhatsappActive ?? true, adminEmail || null, adminEmailActive ?? true]
      );

      invalidateAdminCache();
      res.json({ ok: true, adminWhatsapp: phone });
    } catch (err) {
      console.error('[notifications] PUT /settings', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }
);

export default r;