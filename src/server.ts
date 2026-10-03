import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import 'dotenv/config';
import { createServer } from 'http';

import { createCrudRouter } from './utils/crudRouter.js';
import { aiRouter } from './routes/ai.js';
import { positionsRouter } from './routes/positions.js';
import { optimizationRouter } from './routes/optimization.js';
import routesRouter from './routes/routes.js';
import { initRealtime } from './realtime.js';

const app = express();

const PORT = process.env.PORT
  ? Number(process.env.PORT)
  : 3000;

const CORS_ORIGIN =
  process.env.CORS_ORIGIN ?? 'http://localhost:5173';

/* =========================
   MIDDLEWARES
========================= */

app.set('trust proxy', 1);

app.use(
  cors({
    origin: CORS_ORIGIN,
  })
);

app.use(express.json());

app.use(morgan('dev'));

/* =========================
   HEALTH CHECK
========================= */

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'stjude-backend',
  });
});

/* =========================
   CRUD ROUTES
========================= */

app.use(
  '/api/user',
  createCrudRouter({
    table: 'user',
    jsonFields: ['permissions'],
  })
);

app.use(
  '/api/goods',
  createCrudRouter({
    table: 'goods',
    booleanFields: ['status'],
  })
);

app.use(
  '/api/reservations',
  createCrudRouter({
    table: 'reservations',
    booleanFields: ['paymentStatus'],
  })
);

app.use(
  '/api/trips',
  createCrudRouter({
    table: 'trips',
  })
);

app.use(
  '/api/boats',
  createCrudRouter({
    table: 'boats',
    jsonFields: ['crew'],
  })
);

app.use(
  '/api/cashmovements',
  createCrudRouter({
    table: 'cashmovements',
  })
);

app.use(
  '/api/fuelconsumptions',
  createCrudRouter({
    table: 'fuelconsumptions',
  })
);

/* =========================
   INTELLIGENCE / GPS / ROUTING
========================= */

app.use('/api/ai', aiRouter);

app.use('/api/positions', positionsRouter);

app.use('/api/optimization', optimizationRouter);

/*
 * OSRM / Routing
 *
 * POST /api/routes
 */
app.use('/api/routes', routesRouter);

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
  CORS_ORIGIN
);

/* =========================
   START SERVER
========================= */

httpServer.listen(PORT, () => {
  console.log(
    `Backend Saint-Jude démarré sur le port ${PORT}`
  );

  console.log(
    `CORS autorisé pour : ${CORS_ORIGIN}`
  );

  console.log(
    `Routing OSRM disponible sur : http://localhost:${PORT}/api/routes`
  );
});