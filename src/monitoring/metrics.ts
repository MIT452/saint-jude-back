import client from "prom-client";
import type { Request, Response, NextFunction } from "express";

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

const httpRequests = new client.Counter({
  name: "saint_jude_http_requests_total",
  help: "Nombre total de requêtes HTTP",
  labelNames: ["method", "route", "status_code"],
  registers: [registry],
});

const httpDuration = new client.Histogram({
  name: "saint_jude_http_request_duration_seconds",
  help: "Durée des requêtes HTTP en secondes",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [registry],
});

// Middleware : à placer AVANT les routes
export function metricsMiddleware(req: Request, res: Response, next: NextFunction) {
  const end = httpDuration.startTimer();
  res.on("finish", () => {
    // Route normalisée (/api/trips/:id) pour éviter l'explosion de séries
    const route = req.route?.path
      ? `${req.baseUrl}${req.route.path}`
      : "non_routee";
    const labels = {
      method: req.method,
      route,
      status_code: String(res.statusCode),
    };
    httpRequests.inc(labels);
    end(labels);
  });
  next();
}

// Handler protégé de /metrics
export async function metricsHandler(req: Request, res: Response) {
  const token = process.env.METRICS_TOKEN;
  if (!token || req.headers.authorization !== `Bearer ${token}`) {
    return res.status(401).send("Unauthorized");
  }
  res.set("Content-Type", registry.contentType);
  res.send(await registry.metrics());
}