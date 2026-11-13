export type CandidateTool = {
  name: string;
  description: string;
};

// Enlève les accents et passe en minuscules (pour comparer la question et les descriptions d'outils)
const strip = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

// Mots trop courants pour désigner un outil (déjà sans accents)
const STOP_WORDS = new Set(
  [
    'la', 'le', 'les', 'et', 'de', 'du', 'des', 'un', 'une', 'je', 'veux', 'souhaite', 'prévoir', 'rechercher',
    'calcule', 'liste', 'oui', 'non', 'pour', 'dans', 'que', 'qui', 'quoi', 'est', 'sont', 'pas', 'mon', 'mes',
    'vos', 'vous', 'nous', 'avec', 'sur', 'vers', 'par', 'ces', 'cet', 'cette', 'aussi', 'bien', 'faire', 'peux',
    'puis', 'voudrais', 'bonjour', 'merci', 'alors', 'tout', 'tous', 'comment',
  ].map(strip),
);

// Chaque outil envoyé au modèle coûte des tokens (quota Groq par minute) : on en garde peu
const MAX_TOOLS = 5;

export function findRelevantTools(question: string, tools: CandidateTool[]): CandidateTool[] {
  const terms = [
    ...new Set(
      strip(question)
        .split(/[^a-z0-9]+/)
        .filter((term) => term.length >= 3 && !STOP_WORDS.has(term)),
    ),
  ];

  return tools
    .map((tool) => {
      const description = strip(tool.description);
      const name = strip(tool.name);
      const score = terms.reduce((total, term) => {
        // « bateaux » doit aussi trouver « bateau »
        const forms = /[sx]$/.test(term) && term.length > 4 ? [term, term.slice(0, -1)] : [term];
        const inDescription = forms.some((f) => description.includes(f));
        const inName = forms.some((f) => name.includes(f));
        return total + (inDescription ? 1 : 0) + (inName ? 1 : 0);
      }, 0);
      return { ...tool, score };
    })
    .filter((tool) => tool.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_TOOLS);
}

export function selectToolsForQuestion(question: string, tools: CandidateTool[]): CandidateTool[] {
  return findRelevantTools(question, tools);
}