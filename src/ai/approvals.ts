import { randomUUID } from 'node:crypto';
import { pool } from '../db.js';

export type ApprovalDecision = 'approved' | 'rejected';

export async function createApprovalRequest(input: {
  requestType: string;
  payload: Record<string, unknown>;
  requestedBy?: string;
}) {
  const id = randomUUID();
  const { rows } = await pool.query(
    `INSERT INTO ai_approval_requests (id, "requestType", payload, "requestedBy")
     VALUES ($1, $2, $3, $4)
     RETURNING id, "requestType", payload, status, "requestedBy", "createdAt"`,
    [id, input.requestType, input.payload, input.requestedBy ?? null]
  );
  return rows[0];
}

export async function listApprovalRequests(status = 'pending') {
  const { rows } = await pool.query(
    `SELECT id, "requestType", payload, status, "requestedBy", "reviewedBy", "reviewNote", "createdAt", "reviewedAt"
     FROM ai_approval_requests WHERE status = $1 ORDER BY "createdAt" ASC LIMIT 100`,
    [status]
  );
  return rows;
}

export async function reviewApprovalRequest(input: {
  id: string;
  decision: ApprovalDecision;
  reviewedBy: string;
  reviewNote?: string;
}) {
  const { rows } = await pool.query(
    `UPDATE ai_approval_requests
     SET status = $2, "reviewedBy" = $3, "reviewNote" = $4, "reviewedAt" = CURRENT_TIMESTAMP
     WHERE id = $1 AND status = 'pending'
     RETURNING id, "requestType", payload, status, "requestedBy", "reviewedBy", "reviewNote", "createdAt", "reviewedAt"`,
    [input.id, input.decision, input.reviewedBy, input.reviewNote ?? null]
  );
  return rows[0] ?? null;
}