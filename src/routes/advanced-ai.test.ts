import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateAnswer } from '../ai/evaluation.js';
import { searchKnowledge } from '../ai/rag.js';
import { orchestrate } from '../ai/orchestration.js';

test('evaluation normalizes accents and punctuation', () => {
  assert.equal(evaluateAnswer('La réservation est confirmée.', 'La réservation est confirmée').score, 1);
});

test('RAG returns ranked documents', () => {
  const results = searchKnowledge('réservation', [{ id: 'a', title: 'Réservations', body: 'Les réservations sont enregistrées', tags: [] }]);
  assert.equal(results[0].id, 'a');
});

test('orchestration includes every agent', () => {
  const result = orchestrate('Réserve un colis', { planner: 'Planifie', specialist: 'Vérifie' });
  assert.equal(result.agents.length, 2);
});
