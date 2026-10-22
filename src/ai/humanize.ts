// src/ai/humanize.ts
import { HUMANIZE_PROMPT, humanizeInput, cleanReply } from './prompts.js';

type Msg = { role: 'system' | 'user' | 'assistant'; content: string };

export type ChatFn = (
  messages: Msg[],
  options?: { temperature?: number; maxTokens?: number; json?: boolean },
) => Promise<string>;

// Retire les accents et met en minuscules (\u0300-\u036f = accents combinants)
const strip = (s: string) =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

// Tous les nombres du texte (séparateurs de milliers retirés), triés pour comparaison
const nums = (s: string) =>
  (s.replace(/(?<=\d)[\s\u00a0\u202f](?=\d{3}(?!\d))/g, '').match(/\d+(?:[.,]\d+)?/g) ?? [])
    .sort()
    .join('|');

// Villes souvent inventées par le modèle comme « exemples »
const COMMON_CITIES = ['Antananarivo', 'Mahajanga', 'Toamasina', 'Fianarantsoa'];

/**
 * Reformule un message pour qu'il sonne naturel, dans la langue du client.
 * Si le LLM change un chiffre, un port, ajoute un lieu, ou change la nature de la phrase
 * (question/affirmation), ou en cas d'erreur, le message ORIGINAL est renvoyé.
 * Désactivé tant que AI_HUMANIZE n'est pas égal à "1".
 *
 * @param clientText dernier message du client (sert à choisir la langue). Facultatif.
 */
export async function humanize(
  original: string,
  places: string[],
  chat: ChatFn,
  clientText?: string,
): Promise<string> {
  if (process.env.AI_HUMANIZE !== '1') return original;
  if (original.length > 600 || original.includes('\n')) return original; // listes : inchangées

  try {
    const userContent = clientText ? humanizeInput(original, clientText) : original;

    const raw = (
      await chat(
        [
          { role: 'system', content: HUMANIZE_PROMPT },
          { role: 'user', content: userContent },
        ],
        { temperature: 0.5, maxTokens: 250, json: false },
      )
    ).trim();

    // Retire d'éventuels guillemets autour du message, puis répare les espaces
    const out = cleanReply(raw.replace(/^["«»\s]+|["«»\s]+$/g, ''));

    if (!out || out.length > 800) return original;
    if (nums(out) !== nums(original)) return original; // un chiffre a changé → on rejette

    const o = strip(original);
    const n = strip(out);

    // Un port de l'original a disparu → on rejette
    if (places.some((p) => o.includes(strip(p)) && !n.includes(strip(p)))) return original;

    // Un port/une ville a été AJOUTÉ (exemple inventé) → on rejette
    const watched = [...places, ...COMMON_CITIES];
    if (watched.some((p) => n.includes(strip(p)) && !o.includes(strip(p)))) return original;

    // Mots typiques d'une liste d'exemples
    if (/\b(ohatra|par exemple|ex\.|e\.g\.|for example)\b/i.test(out) &&
        !/\b(ohatra|par exemple|ex\.|e\.g\.|for example)\b/i.test(original)) return original;

    if (original.includes('?') !== out.includes('?')) return original;

    console.info(`[IA] humanize: "${original.slice(0, 80)}" → "${out.slice(0, 80)}"`);
    return out;
  } catch {
    return original;
  }
}