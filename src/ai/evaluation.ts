export type EvaluationResult = {
  score: number;
  valid: boolean;
  reasons: string[];
};

export function evaluateAnswer(
  answer: string,
  expected: string,
  criteria: string[] = ['exact']
): EvaluationResult {
  const normalize = (value: string) => value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
  const normalizedAnswer = normalize(answer);
  const normalizedExpected = normalize(expected);
  const reasons: string[] = [];

  if (criteria.includes('exact') && normalizedAnswer === normalizedExpected) {
    reasons.push('Réponse identique au résultat attendu.');
  } else if (criteria.includes('semantic') && normalizedAnswer.includes(normalizedExpected)) {
    reasons.push('La réponse contient le résultat attendu.');
  } else {
    reasons.push('La réponse ne correspond pas au résultat attendu.');
  }

  const score = normalizedAnswer === normalizedExpected ? 1 : normalizedAnswer.includes(normalizedExpected) ? 0.8 : 0;
  return { score, valid: score >= 0.8, reasons };
}

export function evaluateAgentRun(answer: string, expected: string): EvaluationResult {
  return evaluateAnswer(answer, expected, ['exact', 'semantic']);
}
