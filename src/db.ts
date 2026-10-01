import { Pool } from 'pg';
import 'dotenv/config';

const ssl = process.env.DB_SSL === 'true' ? { rejectUnauthorized: true } : undefined;

export const pool = new Pool({
  ...(process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : {
        host: process.env.DB_HOST ?? 'localhost',
        port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432,
        user: process.env.DB_USER ?? 'postgres',
        password: process.env.DB_PASSWORD ?? '',
        database: process.env.DB_NAME ?? 'saint_jude',
      }),
  ...(ssl ? { ssl } : {}),
});