import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

type Metric = { requests: number; errors: number; totalDurationMs: number };
const metrics = new Map<string, Metric>();

export function traceRequest(req: Request, res: Response, next: NextFunction) {
  const traceId = randomUUID();
  const startedAt = Date.now();
  res.setHeader('x-request-id', traceId);
  res.on('finish', () => {
    const durationMs = Date.now() - startedAt;
    const route = `${req.method} ${req.baseUrl}${req.route?.path ?? req.path.replace(/[0-9a-f-]{20,}/gi, ':id')}`;
    const metric = metrics.get(route) ?? { requests: 0, errors: 0, totalDurationMs: 0 };
    metric.requests++;
    metric.errors += res.statusCode >= 400 ? 1 : 0;
    metric.totalDurationMs += durationMs;
    metrics.set(route, metric);
    console.info(JSON.stringify({ level: 'info', event: 'http_request', traceId, method: req.method, route, status: res.statusCode, durationMs }));
  });
  next();
}

export function getObservabilitySnapshot() {
  return [...metrics.entries()].map(([route, metric]) => ({
    route,
    ...metric,
    averageDurationMs: metric.requests ? Math.round(metric.totalDurationMs / metric.requests) : 0,
  }));
}

export function resetObservabilityForTests() {
  metrics.clear();
}
