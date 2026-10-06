import { randomUUID } from 'node:crypto';
import { pool } from '../src/db.js';

const id = randomUUID();
try {
  await pool.query(
    `INSERT INTO reservations
     (id, "clientName", "destName", status, date, quantity, weight, "totalPrice", "paymentStatus")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, 'Test Client', 'Test Destination', 'PENDING', '2026-10-12', 1, 1, 1000, false]
  );

  const response = await fetch(
    `http://localhost:3000/api/reservations/${id}/status`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'CONFIRMEE' }),
    }
  );

  const result = await response.json();
  console.log(JSON.stringify({ statusCode: response.status, result }, null, 2));

  if (response.status !== 200 || result.status !== 'CONFIRMED') {
    process.exitCode = 1;
  }
} finally {
  await pool.query('DELETE FROM reservations WHERE id = $1', [id]);
  await pool.end();
}
