// src/services/notifications.ts
// Envoi direct des notifications : e-mail (Brevo) et WhatsApp (API Cloud de Meta).
// Utilisé par flushOutbox (ai.ts) quand N8N_WEBHOOK_URL n'est pas défini.

type Payload = Record<string, any>;
type Msg = { subject: string; text: string };

const env = (k: string) => (process.env[k] ?? '').trim();

export const emailEnabled = () => Boolean(env('BREVO_API_KEY') && env('MAIL_FROM'));
export const whatsappEnabled = () =>
  Boolean(env('WHATSAPP_TOKEN') && env('WHATSAPP_PHONE_NUMBER_ID'));
export const directNotificationsEnabled = () => emailEnabled() || whatsappEnabled();
export const notificationsEnabled = () => Boolean(env('N8N_WEBHOOK_URL')) || directNotificationsEnabled();

const money = (n: unknown) => `${Number(n || 0).toLocaleString('fr-FR')} Ar`;

function details(p: Payload): string {
  const goods = [p.quantite, p.unite, p.marchandise].filter(Boolean).join(' ');
  return [
    p.client_nom && `Client : ${p.client_nom}`,
    goods && `Marchandise : ${goods}${p.poids_kg ? ` (${p.poids_kg} kg)` : ''}`,
    (p.depart || p.arrivee) && `Trajet : ${p.depart ?? '?'} → ${p.arrivee ?? '?'}`,
    p.date && `Date : ${p.date}`,
    p.navire && `Navire : ${p.navire}`,
    p.total ? `Montant : ${money(p.total)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Contenu des messages selon l'événement : admin et/ou client. */
function buildMessages(event: string, p: Payload): { admin?: Msg; client?: Msg } {
  const ref = `#${p.numero ?? ''}`;
  const hello = `Bonjour${p.client_nom ? ` ${p.client_nom}` : ''},`;
  const d = details(p);

  switch (event) {
    case 'reservation.pending':
      return {
        admin: {
          subject: `Nouvelle demande de réservation ${ref}`,
          text: `Bonjour,\n\nUne nouvelle demande est à traiter.\n\n${d}\n\nAction : vérifier la disponibilité et le tarif, puis accepter ou refuser.`,
        },
        client: {
          subject: `Votre demande ${ref} est enregistrée`,
          text: `${hello}\n\nVotre demande de réservation ${ref} a bien été enregistrée.\n\n${d}\n\nElle est en attente de validation par notre équipe. Nous vous informerons dès qu'une décision sera prise.`,
        },
      };
    case 'reservation.confirmed':
      return {
        admin: {
          subject: `Réservation ${ref} confirmée`,
          text: `La réservation ${ref} est confirmée.\n\n${d}`,
        },
        client: {
          subject: `Réservation ${ref} confirmée`,
          text: `${hello}\n\nVotre réservation ${ref} est confirmée.\n\n${d}\n\nRetrouvez-la dans votre espace client.`,
        },
      };
    case 'reservation.refused':
      return {
        client: {
          subject: `Réservation ${ref} refusée`,
          text: `${hello}\n\nNous sommes désolés, votre demande ${ref} n'a pas pu être acceptée.${p.motif ? `\nMotif : ${p.motif}` : ''}\n\nVous pouvez contacter notre équipe ou effectuer une nouvelle demande.`,
        },
      };
    case 'reservation.cancelled':
      return {
        admin: { subject: `Réservation ${ref} annulée`, text: `La réservation ${ref} a été annulée.\n\n${d}` },
        client: {
          subject: `Réservation ${ref} annulée`,
          text: `${hello}\n\nVotre réservation ${ref} a été annulée.\n\n${d}`,
        },
      };
    default:
      return {}; // no_show, completed, etc. : pas de message
  }
}

/** Numéro malgache → format international sans « + » (ex. 0341234567 → 261341234567). */
export function normalizePhone(raw: unknown): string | null {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('261')) return d;
  if (d.startsWith('0')) return `261${d.slice(1)}`;
  if (d.length === 9) return `261${d}`;
  return d;
}

async function sendEmail(to: string, m: Msg) {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': env('BREVO_API_KEY'),
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { name: env('MAIL_FROM_NAME') || 'SAINT-JUDE', email: env('MAIL_FROM') },
      to: [{ email: to }],
      subject: m.subject,
      textContent: m.text,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Brevo ${res.status}: ${(await res.text()).slice(0, 150)}`);
}

async function sendWhatsApp(to: string, p: Payload) {
  // WhatsApp impose un template approuvé pour écrire en premier : hello_world pour les tests.
  const template: Record<string, unknown> = {
    name: env('WHATSAPP_TEMPLATE') || 'hello_world',
    language: { code: env('WHATSAPP_TEMPLATE_LANG') || 'en_US' },
  };
  if (env('WHATSAPP_TEMPLATE_PARAMS') === '1') {
    template.components = [
      {
        type: 'body',
        parameters: [p.numero, `${p.depart ?? '-'} → ${p.arrivee ?? '-'}`, p.date].map((v) => ({
          type: 'text',
          text: String(v ?? '-'),
        })),
      },
    ];
  }
  const version = env('WHATSAPP_API_VERSION') || 'v23.0';
  const res = await fetch(`https://graph.facebook.com/${version}/${env('WHATSAPP_PHONE_NUMBER_ID')}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('WHATSAPP_TOKEN')}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template', template }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${(await res.text()).slice(0, 150)}`);
}

/**
 * Envoie les messages d'un événement. `already` = cibles déjà livrées (évite les doublons
 * quand une nouvelle tentative a lieu). Un destinataire sans adresse est simplement ignoré.
 */
export async function deliverNotification(event: string, p: Payload, already: string[] = []) {
  const msgs = buildMessages(event, p);
  const jobs: Array<{ key: string; run: () => Promise<void> }> = [];

  const adminMail = env('ADMIN_EMAIL');
  const adminWa = normalizePhone(env('ADMIN_WHATSAPP'));
  const clientMail = typeof p.email === 'string' ? p.email.trim() : '';
  const clientWa = normalizePhone(p.telephone);

  if (msgs.admin) {
    const m = msgs.admin;
    if (emailEnabled() && adminMail) jobs.push({ key: 'admin:email', run: () => sendEmail(adminMail, m) });
    if (whatsappEnabled() && adminWa) jobs.push({ key: 'admin:whatsapp', run: () => sendWhatsApp(adminWa, p) });
  }
  if (msgs.client) {
    const m = msgs.client;
    if (emailEnabled() && clientMail) jobs.push({ key: 'client:email', run: () => sendEmail(clientMail, m) });
    if (whatsappEnabled() && clientWa) jobs.push({ key: 'client:whatsapp', run: () => sendWhatsApp(clientWa, p) });
  }

  const sent: string[] = [];
  const failed: string[] = [];
  for (const job of jobs) {
    if (already.includes(job.key)) continue;
    try {
      await job.run();
      sent.push(job.key);
    } catch (err) {
      console.warn(`[notif] ${job.key} échoué : ${err instanceof Error ? err.message : String(err)}`);
      failed.push(job.key);
    }
  }
  return { sent, failed };
}