import { evaluateAgentRun, type EvaluationResult } from './evaluation.js';

export type EvaluationFixture = { name: string; expected: string; actual: string };

export const evaluationFixtures: EvaluationFixture[] = [
  { name: 'exact-match', expected: 'Réservation confirmée', actual: 'Réservation confirmée' },
  { name: 'accents-and-punctuation', expected: 'La météo est favorable.', actual: 'La météo est favorable' },
  { name: 'contains-expected-answer', expected: 'Mahajanga', actual: 'Le trajet est prévu vers Mahajanga.' },
  { name: 'wrong-answer', expected: 'Toamasina', actual: 'Le trajet est prévu vers Mahajanga.' },
];

export function runEvaluationSuite(fixtures: EvaluationFixture[] = evaluationFixtures): {
  total: number;
  passed: number;
  passRate: number;
  results: Array<EvaluationFixture & { evaluation: EvaluationResult }>;
} {
  const results = fixtures.map((fixture) => ({
    ...fixture,
    evaluation: evaluateAgentRun(fixture.actual, fixture.expected),
  }));
  const passed = results.filter((result) => result.evaluation.valid).length;
  return { total: results.length, passed, passRate: results.length ? passed / results.length : 1, results };
}