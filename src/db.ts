import { Pool } from 'pg';
import 'dotenv/config';

const connectionString = process.env.DATABASE_URL;
const databaseHost = connectionString ? new URL(connectionString).hostname : '';
const isNeon = databaseHost.endsWith('.neon.tech');
const ssl = process.env.DB_SSL === 'true' || isNeon
  ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' }
  : undefined;

export const pool = new Pool({
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