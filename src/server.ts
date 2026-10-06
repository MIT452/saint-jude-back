import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import 'dotenv/config';
import { createServer } from 'http';

import { createCrudRouter } from './utils/crudRouter.js';
import { aiRouter } from './routes/ai.js';
import aiCapabilitiesRouter from './routes/ai-capabilities.js';
import reservationAiRouter from './routes/reservations-ai.js';
import reservationStatusRouter from './routes/reservationStatus.js';
import { positionsRouter } from './routes/positions.js';
import { optimizationRouter } from './routes/optimization.js';
import routesRouter from './routes/routes.js';
import advancedAiRouter from './routes/advanced-ai.js';
import { initRealtime } from './realtime.js';
import { traceRequest } from './ai/observability.js';
import authRouter from './routes/auth.js';
import { requireAuth, requireOwner, requireTrustedOrigin } from './utils/authSession.js';
import { pool } from './db.js';

const app = express();

const PORT = process.env.PORT
  ? Number(process.env.PORT)
  : 3000;

const CORS_ORIGIN =
  process.env.CORS_ORIGIN ?? 'http://localhost:5173';
const CORS_ORIGINS = CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean);

/* =========================
   MIDDLEWARES
========================= */

app.set('trust proxy', 1);

app.use(
  cors({
    origin(origin, callback) {
      callback(null, !origin || CORS_ORIGINS.includes(origin));
    },
    credentials: true,
  })
);

app.use(express.json({ limit: '15mb' }));

app.use(traceRequest);

app.use(morgan('dev'));
app.use('/api', requireTrustedOrigin);

/* =========================
   HEALTH CHECK
========================= */

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'stjude-backend',
  });
});

app.get('/api/health/database', async (_req, res) => {
  try {
    await pool.query('SELECT id FROM "user" LIMIT 0');
    const host = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).hostname : '';
    res.json({ status: 'ok', provider: host.endsWith('.neon.tech') ? 'neon' : 'postgresql' });
  } catch {
    res.status(503).json({ status: 'error', provider: 'postgresql', error: 'Connexion à la base indisponible' });
  }
});

app.use('/api/auth', authRouter);

/* =========================
   CRUD ROUTES
========================= */

app.use(
  '/api/user',
  requireAuth,
  requireOwner,
  createCrudRouter({
    table: 'user',
    jsonFields: ['permissions'],
    omitFields: ['password'],
    hashFields: ['password'],
  })
);

app.use(
  '/api/goods',
  requireAuth,
  createCrudRouter({
    table: 'goods',
    booleanFields: ['status'],
  })
);

app.use(
  '/api/reservations/ai',
  requireAuth,
  reservationAiRouter
);

app.use(
  '/api/reservations',
  requireAuth,
  createCrudRouter({
    table: 'reservations',
    booleanFields: ['paymentStatus'],
  })
);

app.use(
  '/api/reservations',
  requireAuth,
  reservationStatusRouter
);

app.use(
  '/api/trips',
  requireAuth,
  createCrudRouter({
    table: 'trips',
  })
);

app.use(
  '/api/boats',
  requireAuth,
  createCrudRouter({
    table: 'boats',
    jsonFields: ['crew'],
  })
);

app.use(
  '/api/cashmovements',
  requireAuth,
  createCrudRouter({
    table: 'cashmovements',
  })
);

app.use(
  '/api/fuelconsumptions',
  requireAuth,
  createCrudRouter({
    table: 'fuelconsumptions',
  })
);

/* =========================
   INTELLIGENCE / GPS / ROUTING
========================= */

app.use('/api/ai', requireAuth, aiRouter);

app.use('/api/ai-capabilities', requireAuth, aiCapabilitiesRouter);

app.use('/api/ai-advanced', advancedAiRouter);

app.use('/api/positions', requireAuth, positionsRouter);

app.use('/api/optimization', requireAuth, optimizationRouter);

/*
 * OSRM / Routing
 *
 * POST /api/routes
 */
app.use('/api/routes', requireAuth, routesRouter);

/* =========================
   API 404
========================= */

app.use('/api', (_req, res) => {
  res.status(404).json({
    error: 'Route API introuvable',
  });
});

/* =========================
   HTTP + REALTIME
========================= */

const httpServer = createServer(app);

initRealtime(
  httpServer,
  CORS_ORIGINS
);

/* =========================
   START SERVER
========================= */

httpServer.listen(PORT, () => {
  console.log(
    `Backend Saint-Jude démarré sur le port ${PORT}`
  );

  console.log(
    `CORS autorisé pour : ${CORS_ORIGINS.join(', ')}`
  );

  console.log(
    `Routing OSRM disponible sur : http://localhost:${PORT}/api/routes`
  );
});