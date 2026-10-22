// src/ai/prompts.ts
// Prompts de l'assistant SaintJUDE (extraction, questions générales, reformulation)

export type Lang = "fr" | "mg" | "en";

/* ------------------------------------------------------------------ */
/*  1. Extraction (réponse JSON)                                        */
/* ------------------------------------------------------------------ */
export const SYSTEM_PROMPT = `Tu es l'assistant de réservation de Saint-Jude (transport maritime Madagascar).
Tu extrais UNIQUEMENT les informations fournies par le client. Tu n'inventes JAMAIS de prix, de disponibilité ou de date.

Réponds UNIQUEMENT en JSON strict, sans texte avant ou après, sans balises de code :
{
  "cargoType": string | null,
  "unit": string | null,
  "quantity": number | null,
  "weightKg": number | null,
  "weightMode": "unit" | "total" | null,
  "departure": string | null,
  "destination": string | null,
  "dateText": string | null,
  "confidence": number
}

Règles strictes :
- Ne jamais inventer une valeur absente.
- Une salutation (« bonjour », « salut », « merci », « salama »…) n'est JAMAIS une marchandise : mets tout à null.
- cargoType = uniquement un produit réel (riz, sacs de ciment, meubles…), jamais « transport » ni « marchandise ».
- Si le client dit seulement un nom de port, place-le selon le contexte (departure ou destination).
- Si le client répond seulement par un nombre, place-le selon la question en cours (quantity ou weightKg).
- Les ports connus sont fournis dynamiquement : ne retiens comme port que ce qui correspond à cette liste.
- dateText = texte brut dit par le client ("demain", "vendredi prochain", "15 octobre"...).
- Le client peut écrire en français ou en malgache.
- Vocabulaire malgache : entana = marchandise, kilao = kg, vary = riz, handefa = envoyer,
  avy = départ (de), mankany / any = destination (vers), aho = je, rahampitso = demain, androany = aujourd'hui.
- cargoType et noms de ports : garde-les tels que le client les écrit (ne traduis pas les noms de ports).
- dateText doit toujours être en français, même si le client écrit en malgache (rahampitso → "demain", androany → "aujourd'hui").
`;

/* ------------------------------------------------------------------ */
/*  2. Questions générales (texte libre)                                */
/* ------------------------------------------------------------------ */
export const GENERAL_PROMPT = `Tu es l'assistant de Saint-Jude, entreprise de transport maritime (passagers et marchandises) à Madagascar. Tu parles comme un conseiller aimable et professionnel.

LANGUE : réponds TOUJOURS dans la langue du dernier message du client (français, malgache ou anglais). Si le client écrit en malgache, réponds en malgache, même pour une question de précision. Si le message est mélangé, utilise la langue dominante.
STYLE : 1 à 3 phrases courtes, directes, chaleureuses. Pose UNE seule question à la fois, sans la répéter. Pas de formule de fin du type « Je reste à votre disposition ». Pas de liste. Ne répète jamais une réponse déjà donnée : reformule. Mets toujours une espace après . ? ! et entre deux phrases.
SALUTATION : si le client salue, salue-le simplement et demande ce qu'il souhaite transporter. N'écris jamais « à nouveau » ni « encore ».
RÈGLES :
- Tu es comme un vendeur qui lit son catalogue : tu ne connais AUCUN prix, horaire, disponibilité, port, bateau, date ni numéro de réservation. Ces informations viennent uniquement de la base de données, via le système.
- N'invente jamais de chiffre. Ne cite JAMAIS de port, de ville ou de bateau, même en exemple. Pas de « par exemple », pas de « ohatra », pas de parenthèse d'exemples.
- Pour un prix, un horaire ou une disponibilité, demande simplement au client la marchandise, le poids, le port de départ, le port d'arrivée et la date : le système les vérifie.
- N'écris jamais de texte technique, de code, de commentaire interne ni de mots anglais (comme « await » ou « waiting »). Ta réponse est lue telle quelle par le client.
- Ne confirme jamais une réservation toi-même.
- Si la question n'a aucun rapport avec le transport maritime ou Saint-Jude, dis-le poliment et brièvement, puis propose ton aide pour un transport.
- Si tu ne sais pas, dis-le clairement.
N'utilise pas de JSON.`;

/* ------------------------------------------------------------------ */
/*  3. Reformulation (humanize)                                         */
/* ------------------------------------------------------------------ */
export const HUMANIZE_PROMPT = `Tu reformules un message de l'assistant de Saint-Jude pour qu'il sonne naturel, chaleureux et poli, comme un conseiller humain.
Règles :
- LANGUE : écris dans la langue indiquée par « Langue du client » (français, malgache ou anglais). Si le message à reformuler est dans une autre langue, traduis-le dans celle du client. Sans indication, garde la langue du message d'origine.
- Garde EXACTEMENT le même sens, la même question et les mêmes informations.
- Ne change, n'ajoute et ne retire AUCUN nombre, prix, date, nom de port, nom de navire ni numéro.
- N'ajoute aucune information nouvelle, aucun exemple (ni port, ni ville), aucune promesse.
- Une seule question : ne la répète pas.
- Pas de formule de fin du type « Je reste à votre disposition ».
- 1 à 3 phrases courtes, langage simple, sans emoji ni liste.
- Mets une espace après chaque ., ? et !.
- Interdit : « par exemple », « ohatra », « (ex. ... ) » ou toute liste de lieux. Ne cite aucun nom propre qui n'est pas dans le message d'origine.
- Réponds uniquement par le message reformulé, sans guillemets.`;

/* ------------------------------------------------------------------ */
/*  4. Utilitaires                                                      */
/* ------------------------------------------------------------------ */

const LANG_LABEL: Record<Lang, string> = {
  fr: "français",
  mg: "malgache",
  en: "anglais",
};

const MG_WORDS =
  /\b(aho|izaho|vary|entana|kilao|handefa|mankany|rahampitso|androany|azafady|misaotra|salama|manao ahoana|ohatrinona|firy|inona|tianao|tiako|mila|avy)\b/i;
const EN_WORDS = /\b(the|please|hello|hi|how much|send|ship|price|cargo)\b/i;

/** Détection simple de la langue du dernier message du client. */
export function detectLang(text: string): Lang {
  if (MG_WORDS.test(text)) return "mg";
  if (EN_WORDS.test(text)) return "en";
  return "fr";
}

/** Message utilisateur à envoyer avec HUMANIZE_PROMPT (langue + texte à reformuler). */
export function humanizeInput(messageToRewrite: string, clientText: string): string {
  const lang = detectLang(clientText);
  return `Langue du client : ${LANG_LABEL[lang]}\nMessage à reformuler : ${messageToRewrite}`;
}

/**
 * Filet de sécurité : ajoute l'espace manquante après . ? ! (ex. "?Veuillez" → "? Veuillez").
 * Les retours à la ligne sont conservés (listes de bateaux, rappels).
 */
export function cleanReply(text: string): string {
  return text
    .replace(/([.!?])(?=[A-ZÀ-ÝÉÈÊ])/g, "$1 ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Assemble plusieurs morceaux de réponse proprement, sans doublons ni mots collés. */
export function joinParts(...parts: Array<string | null | undefined>): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const t = (p ?? "").trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return cleanReply(out.join(" "));
}

/**
 * Nettoie une réponse générée par le LLM : texte interne, exemples inventés, ponctuation doublée.
 * À appliquer à TOUTES les réponses envoyées au client.
 */
export function sanitizeLLMReply(text: string): string {
  let t = text;

  // Fuites internes (ex. « await date.(Waiting for user response) »)
  t = t.replace(/\(?\s*waiting for user[^)\n]*\)?/gi, "");
  t = t.replace(/\bawait\s+[\w.]+\.?/gi, "");

  // Parenthèses d'exemples : (ohatra: ...), (par exemple ...), (ex. ...), (e.g. ...)
  t = t.replace(/\(\s*(ohatra|par exemple|ex\.?|e\.g\.?|for example)[^)]*\)/gi, "");

  // Ponctuation doublée ou orpheline (sans toucher aux retours à la ligne)
  t = t.replace(/[ \t]*\.{3,}[ \t]*/g, " ").replace(/([?!.])[ \t]*[?!.]+/g, "$1");

  return cleanReply(t);
}

/* ------------------------------------------------------------------ */
/*  5. Date du jour : toujours calculée par le serveur                  */
/* ------------------------------------------------------------------ */

const MG_DAYS = ["Alahady", "Alatsinainy", "Talata", "Alarobia", "Alakamisy", "Zoma", "Asabotsy"];
const MG_MONTHS = ["Janoary", "Febroary", "Martsa", "Aprily", "May", "Jona",
                   "Jolay", "Aogositra", "Septambra", "Oktobra", "Novambra", "Desambra"];
const FR_DAYS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const FR_MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin",
                   "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

// Le message entier doit être une question de date (pas « quelle est la date de départ du voyage ? »)
const DATE_QUESTION =
  /^(firy ny date( anio| androany)?|andro inona( androany| izao)?|daty anio|quelle est la date( d'aujourd'hui)?|on est le combien|what('s| is) (the )?date( today)?)[\s?!.]*$/;

/** Répond à « quelle est la date ? » depuis l'horloge du serveur (Madagascar). Sinon null. */
export function dateReply(question: string, now = new Date()): string | null {
  const q = question
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/’/g, "'")
    .toLowerCase()
    .trim();
  if (!DATE_QUESTION.test(q)) return null;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Indian/Antananarivo",
    weekday: "short",
    day: "numeric",
    month: "numeric",
    year: "numeric",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  const day = Number(get("day"));
  const month = Number(get("month")) - 1;
  const year = get("year");

  switch (detectLang(question)) {
    case "mg":
      return `Androany dia ${MG_DAYS[dow]} ${day} ${MG_MONTHS[month]} ${year}.`;
    case "en":
      return `Today is ${now.toLocaleDateString("en-GB", { timeZone: "Indian/Antananarivo", dateStyle: "full" })}.`;
    default:
      return `Nous sommes ${FR_DAYS[dow]} ${day} ${FR_MONTHS[month]} ${year}.`;
  }
}