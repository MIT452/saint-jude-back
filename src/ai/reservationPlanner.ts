import OpenAI from 'openai';
import { z } from 'zod';

export const ReservationProposalSchema = z.object({
  clientName: z.string().trim().min(2).max(255),
  clientTel: z.string().trim().min(2).max(50).optional().default(''),
  destName: z.string().trim().min(2).max(255),
  destTel: z.string().trim().min(2).max(50).optional().default(''),
  date: z.string().trim().min(4).max(50),
  quantity: z.number().int().positive().max(100000),
  weight: z.number().nonnegative().max(1000000),
  totalPrice: z.number().nonnegative().max(100000000000),
  tripId: z.string().trim().min(1).max(100),
  paymentStatus: z.boolean().default(false),
  itemName: z.string().trim().min(1).max(255).optional().default(''),
  departure: z.string().trim().max(255).optional().default(''),
  destination: z.string().trim().max(255).optional().default(''),
  notes: z.string().trim().max(1000).optional().default(''),
});

export type ReservationProposal = z.infer<typeof ReservationProposalSchema>;

export function normalizeReservationProposal(input: unknown): ReservationProposal {
  return ReservationProposalSchema.parse(input);
}

const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';
const baseURL = process.env.OPENAI_BASE_URL;

function createClient(): OpenAI | null {
  if (!apiKey) return null;
  return new OpenAI({ apiKey, baseURL });
}

const systemPrompt = `
Tu es un planificateur de réservation pour Saint-Jude, une application de transport maritime.
Travail en français. Ne fais jamais d'invention monétaire ou de données.
Retourne uniquement un objet JSON valide avec les champs clientName, clientTel, destName,
destTel, date, quantity, weight, totalPrice, tripId, itemName, departure, destination, notes.
Les champs obligatoires sont clientName, destName, date, quantity, weight, totalPrice, tripId.
Si une information est absente, utilise une valeur vide ou une valeur raisonnable uniquement si elle
est explicitement déduite de la demande. Ne crée jamais de réservation : retourne seulement une proposition.
`;

export async function planReservation(message: string): Promise<ReservationProposal> {
  const client = createClient();
  if (!client) {
    throw new Error('OPENAI_API_KEY n’est pas configuré');
  }

  const completion = await client.chat.completions.create({
    model,
    temperature: 0.1,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: message },
    ],
  });

  const content = completion.choices[0]?.message.content;
  if (!content) throw new Error('Le modèle n’a pas renvoyé de proposition');

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('La réponse du modèle n’est pas un objet JSON valide');
  }

  return normalizeReservationProposal(parsed);
}

export function getReservationModel(): { provider: string; model: string } {
  return { provider: 'openai', model };
}
