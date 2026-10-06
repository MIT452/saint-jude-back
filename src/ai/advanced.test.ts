import assert from 'node:assert/strict';
import test from 'node:test';
import { findRelevantTools } from './jit.js';
import { evaluateAnswer } from './evaluation.js';
import { searchKnowledge } from './rag.js';
import { orchestrate } from './orchestration.js';

test('JIT retrieval selects only tools relevant to the question', () => {
  const tools = [
    { name: 'meteo', description: 'Météo' },
    { name: 'distance', description: 'Distance' },
    { name: 'lister_reservations', description: 'Réservations' },
  ];
  assert.deepEqual(findRelevantTools('Prévisonne la météo à Mahajanga', tools).map((tool) => tool.name), ['meteo']);
});

test('RAG search ranks documentation by relevance', () => {
  const result = searchKnowledge('réservation bateau', [
    { id: '1', title: 'Économie de bateau', body: 'Les réservations sont payées en Ariary', tags: ['réservation'] },
    { id: '2', title: 'Météo', body: 'Le vent est fort', tags: ['météo'] },
  ]);
  assert.equal(result[0].id, '1');
  assert.ok(result[0].score > 0);
});

test('evaluation returns a normalized score and reasons', () => {
  const result = evaluateAnswer('La réservation est confirmée', 'La réservation est confirmée', ['exact']);
  assert.equal(result.score, 1);
  assert.equal(result.valid, true);
});

test('multi-agent orchestration returns a structured answer', () => {
  const result = orchestrate('Combien de colis puis-je reserver ?', { planner: 'Interroge le planificateur', specialist: 'Contrôle la disponibilité' });
  assert.equal(result.status, 'completed');
  assert.equal(result.agents.length, 2);
  assert.match(result.answer, /colis/i);
});
