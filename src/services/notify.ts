import { randomUUID } from "crypto";

export async function notifyN8n(event: string, data: Record<string, unknown>) {
  const url = process.env.N8N_WEBHOOK_URL;
  if (!url) return; // n8n désactivé : le backend continue de fonctionner

  const payload = {
    eventId: randomUUID(),
    event,
    occurredAt: new Date().toISOString(),
    data,
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-secret": process.env.N8N_WEBHOOK_SECRET ?? "",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) console.error("n8n a répondu", res.status);
  } catch (err) {
    console.error("Notification n8n échouée:", err);
  }
}