import { Router } from 'express';
import type { QueryResultRow } from 'pg';
import { v4 as uuid } from 'uuid';
import { pool } from '../db.js';

export interface CrudOptions {
  table: string;
  // Colonnes booléennes à exposer/recevoir comme booléens JS
  booleanFields?: string[];
  // Colonnes JSON à sérialiser automatiquement avant l'écriture
  jsonFields?: string[];
}

function rowOut(row: QueryResultRow, opts: CrudOptions) {
  const out: Record<string, unknown> = { ...row };
  for (const f of opts.booleanFields ?? []) {
    if (f in out) out[f] = !!out[f];
  }
  return out;
}

function rowIn(body: Record<string, unknown>, opts: CrudOptions) {
  const out: Record<string, unknown> = { ...body };
  for (const f of opts.booleanFields ?? []) {
    if (f in out) out[f] = Boolean(out[f]);
  }
  for (const f of opts.jsonFields ?? []) {
    const v = out[f];
    if (v !== undefined && v !== null && typeof v !== 'string') {
      out[f] = JSON.stringify(v);
    }
  }
  return out;
}

function quoteIdentifier(identifier: string) {
  return `"${identifier.replace(/"/g, '""')}"`;
}

export function createCrudRouter(opts: CrudOptions) {
  const router = Router();
  const { table } = opts;
  const quotedTable = quoteIdentifier(table);

  // GET /api/<table> — liste complète
  router.get('/', async (_req, res) => {
    try {
      const { rows } = await pool.query<QueryResultRow>(`SELECT * FROM ${quotedTable}`);
      res.json(rows.map((r) => rowOut(r, opts)));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: `Erreur lors de la lecture de ${table}` });
    }
  });

  // GET /api/<table>/:id
  router.get('/:id', async (req, res) => {
    try {
      const { rows } = await pool.query<QueryResultRow>(
        `SELECT * FROM ${quotedTable} WHERE id = $1`,
        [req.params.id]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Introuvable' });
      res.json(rowOut(rows[0], opts));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: `Erreur lors de la lecture de ${table}` });
    }
  });

  // POST /api/<table> — le frontend envoie déjà un objet complet (id généré côté client via uuid)
  router.post('/', async (req, res) => {
    try {
      const body = rowIn(req.body ?? {}, opts);
      if (!body.id) body.id = uuid();
      const columns = Object.keys(body);
      if (columns.length === 0) {
        return res.status(400).json({ error: 'Corps de requête vide' });
      }
      const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
      const values = columns.map((c) => body[c]);
      const { rows } = await pool.query<QueryResultRow>(
        `INSERT INTO ${quotedTable} (${columns.map(quoteIdentifier).join(', ')}) VALUES (${placeholders}) RETURNING *`,
        values
      );
      res.status(201).json(rowOut(rows[0], opts));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: `Erreur lors de la création dans ${table}` });
    }
  });

  // PUT /api/<table>/:id
  router.put('/:id', async (req, res) => {
    try {
      const body = rowIn(req.body ?? {}, opts);
      delete body.id;
      const columns = Object.keys(body);
      if (columns.length === 0) {
        return res.status(400).json({ error: 'Aucune donnée à mettre à jour' });
      }
      const setClause = columns
        .map((column, index) => `${quoteIdentifier(column)} = $${index + 1}`)
        .join(', ');
      const values = [...columns.map((c) => body[c]), req.params.id];
      const { rows } = await pool.query<QueryResultRow>(
        `UPDATE ${quotedTable} SET ${setClause} WHERE id = $${values.length} RETURNING *`,
        values
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Introuvable' });
      res.json(rowOut(rows[0], opts));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: `Erreur lors de la mise à jour dans ${table}` });
    }
  });

  // DELETE /api/<table>/:id
  router.delete('/:id', async (req, res) => {
    try {
      const { rows } = await pool.query<QueryResultRow>(
        `DELETE FROM ${quotedTable} WHERE id = $1 RETURNING id`,
        [req.params.id]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Introuvable' });
      res.json({ id: req.params.id });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: `Erreur lors de la suppression dans ${table}` });
    }
  });

  return router;
}