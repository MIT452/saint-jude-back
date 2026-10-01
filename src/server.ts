import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import 'dotenv/config';

import { createCrudRouter } from './utils/crudRouter.js';

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? 'http://localhost:5173';

app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());
app.use(morgan('dev'));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'stjude-backend' });
});

// Les noms de routes suivent exactement TABLE_DATA_BASE dans src/data/type.ts du frontend
app.use('/api/user', createCrudRouter({ table: 'user', jsonFields: ['permissions'] }));
app.use('/api/goods', createCrudRouter({ table: 'goods', booleanFields: ['status'] }));
app.use('/api/reservations', createCrudRouter({ table: 'reservations', booleanFields: ['paymentStatus'] }));
app.use('/api/trips', createCrudRouter({ table: 'trips' }));
app.use('/api/boats', createCrudRouter({ table: 'boats', jsonFields: ['crew'] }));
app.use('/api/cashmovements', createCrudRouter({ table: 'cashmovements' }));
app.use('/api/fuelconsumptions', createCrudRouter({ table: 'fuelconsumptions' }));

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Route API introuvable' });
});

app.listen(PORT, () => {
  console.log(`🚢 Backend Saint-Jude démarré sur http://localhost:${PORT}`);
  console.log(`   CORS autorisé pour : ${CORS_ORIGIN}`);
});
