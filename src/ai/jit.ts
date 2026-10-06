export type CandidateTool = {
  name: string;
  description: string;
};

export function findRelevantTools(question: string, tools: CandidateTool[]): CandidateTool[] {
  const terms = question
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => !['a','la','le','les','et','à','de','du','des','un','une','je','veux','souhaite','prévoir','rechercher','calcule','liste'].includes(term));

  return tools
    .map((tool) => ({
      ...tool,
      score: terms.reduce((score, term) => {
        const description = tool.description.toLowerCase();
        return score + (description.includes(term) ? 1 : 0) + (tool.name.includes(term) ? 1 : 0);
      }, 0),
    }))
    .filter((tool) => tool.score > 0)
    .sort((a, b) => b.score - a.score);
}

export function selectToolsForQuestion(question: string, tools: CandidateTool[]): CandidateTool[] {
  return findRelevantTools(question, tools);
}
