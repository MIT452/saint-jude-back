import { z } from 'zod';

export type Intent =
  | 'CREATE_RESERVATION'
  | 'CHECK_RESERVATION'
  | 'MODIFY_RESERVATION'
  | 'CANCEL_RESERVATION'
  | 'CHECK_AVAILABILITY'
  | 'ASK_PRICE';

export const intentSchema = z.enum([
  'CREATE_RESERVATION',
  'CHECK_RESERVATION',
  'MODIFY_RESERVATION',
  'CANCEL_RESERVATION',
  'CHECK_AVAILABILITY',
  'ASK_PRICE',
]);

export function classifyIntent(message: string): Intent {
  const normalized = message
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  if (/reserver|resever/.test(normalized)) return 'CREATE_RESERVATION';
  if (/annuler|cancel/.test(normalized)) return 'CANCEL_RESERVATION';
  if (/modifier|changer/.test(normalized)) return 'MODIFY_RESERVATION';
  if (/prix|tarif/.test(normalized)) return 'ASK_PRICE';
  if (/disponib|available|capacite/.test(normalized)) return 'CHECK_AVAILABILITY';
  return 'CHECK_RESERVATION';
}

export function extractEntities(message: string) {
  const normalized = message.toLowerCase();
  const cityPattern = /antananarivo|maha[gj]anga|toamasina|fianarantsoa/i;
  const cities = ['Antananarivo', 'Mahajanga', 'Toamasina', 'Fianarantsoa'];
  const departure = cities.find((city) => normalized.includes(city.toLowerCase()));
  const destination = cities.find((city, index) => {
    const text = normalized.slice((departure ? normalized.indexOf(departure.toLowerCase()) + departure.length : 0));
    return index > 0 && text.includes(city.toLowerCase());
  });
  const dateMatch = message.match(/(\d{1,2})\s+(?:octobre|novembre|décembre|janvier|février|mars|avril|mai|juin|juillet|août|septembre)/i);
  const quantityMatch = message.match(/(\d+(?:[.,]\d+)?)\s*(?:colis|colis|packages?|paquets|places?|réservations?)/i);
  const weightMatch = message.match(/(\d+(?:[.,]\d+)?)\s*(?:kg|kilogrammes?)/i);

  return {
    departure: departure ?? '',
    destination: destination ?? '',
    date: dateMatch ? normalizeDate(message.slice(dateMatch.index)) : '',
    quantity: quantityMatch ? Number(quantityMatch[1].replace(',', '.')) : 0,
    weight: weightMatch ? Number(weightMatch[1].replace(',', '.')) : 0,
  };
}

export function normalizeDate(value: string): string {
  const match = value.match(/(\d{1,2})\s+(octobre|novembre|décembre|janvier|février|mars|avril|mai|juin|juillet|août|septembre)/i);
  if (!match) return '';
  const months = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  const month = months.indexOf(match[2].toLowerCase()) + 1;
  return `2026-${String(month).padStart(2, '0')}-${String(match[1]).padStart(2, '0')}`;
}

export function calculateCapacity(capacity: number, reserved: number, requested: number) {
  const available = Math.max(0, capacity - reserved);
  return { capacity, reserved, available, requested, allowed: requested <= available };
}

export function validateReservation(input: Record<string, unknown>) {
  const schema = z.object({
    departure: z.string().min(1),
    destination: z.string().min(1),
    date: z.string().min(4),
    quantity: z.number().positive(),
    weight: z.number().positive(),
  });
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return {
      valid: false,
      missingFields: parsed.error.issues.map((issue) => issue.path[0]),
      errors: parsed.error.issues.map((issue) => issue.message),
    };
  }
  return { valid: true, missingFields: [], errors: [] };
}

export function getCapabilityStatus() {
  return {
    llm: 'configured',
    toolCalling: 'active',
    reAct: 'active',
    rag: 'active',
    contextEngineering: 'active',
    jitToolRetrieval: 'active',
    mcp: process.env.MCP_BEARER_TOKEN ? 'active' : 'requires-MCP_BEARER_TOKEN',
    evaluation: 'active',
    multiAgent: 'active',
    speech: process.env.OPENAI_API_KEY ? 'active' : 'requires-OPENAI_API_KEY',
    weather: 'active',
    routing: 'active',
    observability: process.env.OBSERVABILITY_TOKEN ? 'active' : 'requires-OBSERVABILITY_TOKEN',
    humanInTheLoop: process.env.AI_APPROVAL_TOKEN ? 'active' : 'requires-AI_APPROVAL_TOKEN',
  };
}
