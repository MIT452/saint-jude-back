// src/db.ts
import pg from 'pg';
import 'dotenv/config';
import { Pool as NeonPool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

const connectionString = process.env.DATABASE_URL;
const databaseHost = connectionString ? new URL(connectionString).hostname : '';
const isNeon = databaseHost.endsWith('.neon.tech');
const ssl =
  process.env.DB_SSL === 'true' || isNeon
    ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' }
    : undefined;

// DB_OVER_WS=1 (local uniquement, quand le port 5432 est bloqué par le réseau) :
// la connexion à Neon passe par WebSocket sur le port 443.
const overWs = process.env.DB_OVER_WS === '1' && !!connectionString;

if (overWs) {
  neonConfig.webSocketConstructor = ws;
  console.info('[DB] connexion à Neon par WebSocket (port 443)');
}

export const pool: pg.Pool = overWs
  ? (new NeonPool({ connectionString }) as unknown as pg.Pool)
  : new pg.Pool({
      ...(connectionString
        ? { connectionString }
        : {
            host: process.env.DB_HOST ?? 'localhost',
            port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432,
            user: process.env.DB_USER ?? 'postgres',
            password: process.env.DB_PASSWORD ?? '',
            database: process.env.DB_NAME ?? 'saint_jude',
          }),
      ...(ssl ? { ssl } : {}),
    });