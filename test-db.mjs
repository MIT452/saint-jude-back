import "dotenv/config";
import pg from "pg";

const url = process.env.DATABASE_URL;
console.log("DATABASE_URL définie ?", !!url);

const pool = new pg.Pool({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
});

try {
  const r = await pool.query("select now()");
  console.log("Neon OK :", r.rows[0]);

  const t = await pool.query(
    "select table_name from information_schema.tables where table_schema='public'"
  );
  console.log("Tables :", t.rows.map((x) => x.table_name));
} catch (e) {
  console.error("Erreur DB :", e.message);
} finally {
  await pool.end();
}
