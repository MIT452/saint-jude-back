import assert from 'node:assert/strict';
import test from 'node:test';
import { ReservationProposalSchema, normalizeReservationProposal } from './reservationPlanner.js';

test('normalise une proposition de réservation valide', () => {
  const proposal = normalizeReservationProposal({
    clientName: 'Amina Ravo',
    clientTel: '+261 32 00 00 00',
    destName: 'Mahavandy',
    destTel: '+261 32 00 00 01',
    date: '2026-10-12',
    quantity: 3,
    weight: 24,
    totalPrice: 12000,
    tripId: 'trip-42',
  });

  assert.equal(proposal.clientName, 'Amina Ravo');
  assert.equal(proposal.quantity, 3);
  assert.equal(proposal.paymentStatus, false);
});

test('refuse une proposition sans données minimales', () => {
  assert.throws(() =>
    ReservationProposalSchema.parse({
      clientName: 'Amina',
      date: '2026-10-12',
      quantity: 1,
    })
  );
});
