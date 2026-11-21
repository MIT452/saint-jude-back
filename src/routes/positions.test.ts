import assert from 'node:assert/strict';
import test from 'node:test';

import { buildLatestPositionResponse } from './positions.js';

test('retourne null quand aucun bateau n’a de position enregistrée', () => {
  assert.equal(buildLatestPositionResponse([]), null);
});

test('renvoie la dernière position disponible quand elle existe', () => {
  const row = {
    boatId: 'boat-42',
    latitude: 12.34,
    longitude: 56.78,
    speed: 9.5,
  };

  assert.deepEqual(buildLatestPositionResponse([row]), row);
});
