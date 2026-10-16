// src/ai/humanize.ts
import { HUMANIZE_PROMPT } from './prompts.js';

type Msg = { role: 'system' | 'user' | 'assistant'; content: string };

export type ChatFn = (
  messages: Msg[],
  options?: { temperature?: number; maxTokens?: number; json?: boolean },
) => Promise<string>;

const strip = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// Tous les nombres du texte (séparateurs de milliers retirés), triés pour comparaison
const nums = (s: string) =>
  (s.replace(/(?<=\d)[\s  ](?=\d{3}(?!\d))/g, '').match(/\d+(?:[.,]\d+)?/g) ?? [])
    .sort()
    .join('|');

/**
 * Reformule un message pour qu'il sonne naturel.
 * Si le LLM change un chiffre, un port ou la nature de la phrase (question/affirmation),
 * ou en cas d'erreur, le message ORIGINAL est renvoyé.
 * Désactivé tant que AI_HUMANIZE n'est pas égal à "1".
 */
export async function humanize(original: string, places: string[], chat: ChatFn): Promise<string> {
  if (process.env.AI_HUMANIZE !== '1') return original;
  if (original.length > 600 || original.includes('\n')) return original; // listes : inchangées

  try {
    const out = (
      await chat(
        [
          { role: 'system', content: HUMANIZE_PROMPT },
          { role: 'user', content: original },
        ],
        { temperature: 0.5, maxTokens: 250, json: false },
      )
    ).trim();

    if (!out || out.length > 800) return original;
    if (nums(out) !== nums(original)) return original; // un chiffre a changé → on rejette

    const o = strip(original);
    const n = strip(out);
    if (places.some((p) => o.includes(strip(p)) && !n.includes(strip(p)))) return original;
    if (original.includes('?') !== out.includes('?')) return original;

    console.info(`[IA] humanize: "${original.slice(0, 80)}" → "${out.slice(0, 80)}"`);
    return out;
  } catch {
    return original;
  }
}