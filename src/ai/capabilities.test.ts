import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateCapacity,
  classifyIntent,
  extractEntities,
  getCapabilityStatus,
  normalizeDate,
  validateReservation,
} from './capabilities.js';

test('classifie l’intention et extrait les entités', () => {
  assert.equal(classifyIntent('Je veux réserver trois colis'), 'CREATE_RESERVATION');
  const entities = extractEntities('Antananarivo vers Mahajanga le 12 octobre, 3 colis de 10 kg');
  assert.deepEqual(entities, {
    departure: 'Antananarivo',
    destination: 'Mahajanga',
    date: '2026-10-12',
    quantity: 3,
    weight: 10,
  });
});

test('normalise une date relative sans inventer de date', () => {
  assert.equal(normalizeDate('le 12 octobre'), '2026-10-12');
  assert.equal(normalizeDate('demain'), '');
});

test('calcule la capacité et le poids total', () => {
  assert.deepEqual(calculateCapacity(50, 42, 10), {
    capacity: 50,
    reserved: 42,
    available: 8,
    requested: 10,
    allowed: false,
  });
  assert.equal(calculateCapacity(50, 42, 8).allowed, true);
});

test('valide une réservation et signale les données manquantes', () => {
  const result = validateReservation({
    departure: 'Antananarivo',
    destination: 'Mahajanga',
    date: '2026-10-12',
    quantity: 3,
    weight: 0,
  });
  assert.deepEqual(result.missingFields, ['weight']);
  assert.equal(result.valid, false);
});

test('expose le statut des capacités', () => {
  const status = getCapabilityStatus();
  assert.equal(status.llm, 'configured');
  assert.equal(status.toolCalling, 'active');
  assert.equal(status.reAct, 'active');
  assert.ok(['active', 'requires-AI_APPROVAL_TOKEN'].includes(status.humanInTheLoop));
});
