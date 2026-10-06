import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeReservationRequest } from './reservations-ai';

test('valide la requête de planification avant l’appel à l’IA', () => {
  assert.throws(
    () => normalizeReservationRequest({ message: '   ' }),
    /message/
  );

  assert.deepEqual(
    normalizeReservationRequest({ message: 'Réserve trois cartons pour Mahavandy' }),
    { message: 'Réserve trois cartons pour Mahavandy' }
  );
});
