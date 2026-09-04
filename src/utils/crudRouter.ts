import { Router } from 'express';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { v4 as uuid } from 'uuid';
import { pool } from '../db.js';

export interface CrudOptions {
  table: string;
  // colonnes TINYINT(1) à exposer/recevoir comme booléens JS
  booleanFields?: string[];
  // colonnes JSON à parser/sérialiser automatiquement
  jsonFields?: string[];
}

function rowOut(row: RowDataPacket, opts: CrudOptions) {
  const out: Record<string, unknown> = { ...row };
  for (const f of opts.booleanFields ?? []) {
    if (f in out) out[f] = !!out[f];
  }
  for (const f of opts.jsonFields ?? []) {
    if (typeof out[f] === 'string') {
      try {
        out[f] = JSON.parse(out[f] as string);
      } catch {
        // laisser tel quel si ce n'est pas du JSON valide
      }
    }
  }
  return out;
}

function rowIn(body: Record<string, unknown>, opts: CrudOptions) {
  const out: Record<string, unknown> = { ...body };
  for (const f of opts.booleanFields ?? []) {
    if (f in out) out[f] = out[f] ? 1 : 0;
  }
  for (const f of opts.jsonFields ?? []) {
    if (f in out && out[f] != null && typeof out[f] !== 'string') {
      out[f] = JSON.stringify(out[f]);
    }
  }
  return out;
}

export function createCrudRouter(opts: CrudOptions) {
  const router = Router();
  const { table } = opts;

  // GET /api/<table> — liste complète
  router.get('/', async (_req, res) => {
    try {
      const [rows] = await pool.query<RowDataPacket[]>(`SELECT * FROM \`${table}\``);
      res.json(rows.map((r) => rowOut(r, opts)));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: `Erreur lors de la lecture de ${table}` });
    }
  });

  // GET /api/<table>/:id
  router.get('/:id', async (req, res) => {
    try {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT * FROM \`${table}\` WHERE id = ?`,
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
      const placeholders = columns.map(() => '?').join(', ');
      const values = columns.map((c) => body[c]);
      await pool.query<ResultSetHeader>(
        `INSERT INTO \`${table}\` (${columns.map((c) => `\`${c}\``).join(', ')}) VALUES (${placeholders})`,
        values
      );
      res.status(201).json(rowOut(body as RowDataPacket, opts));
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
      const setClause = columns.map((c) => `\`${c}\` = ?`).join(', ');
      const values = [...columns.map((c) => body[c]), req.params.id];
      const [result] = await pool.query<ResultSetHeader>(
        `UPDATE \`${table}\` SET ${setClause} WHERE id = ?`,
        values
      );
      if (result.affectedRows === 0) return res.status(404).json({ error: 'Introuvable' });
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT * FROM \`${table}\` WHERE id = ?`,
        [req.params.id]
      );
      res.json(rowOut(rows[0], opts));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: `Erreur lors de la mise à jour dans ${table}` });
    }
  });

  // DELETE /api/<table>/:id
  router.delete('/:id', async (req, res) => {
    try {
      const [result] = await pool.query<ResultSetHeader>(
        `DELETE FROM \`${table}\` WHERE id = ?`,
        [req.params.id]
      );
      if (result.affectedRows === 0) return res.status(404).json({ error: 'Introuvable' });
      res.json({ id: req.params.id });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: `Erreur lors de la suppression dans ${table}` });
    }
  });

  return router;
}
