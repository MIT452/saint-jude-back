import { randomUUID } from 'node:crypto';
import { pool } from '../db.js';

export type KnowledgeDocument = {
  id: string;
  title: string;
  body: string;
  tags?: string[];
};

export type RankedKnowledge = KnowledgeDocument & { score: number };

async function createEmbedding(text: string): Promise<number[] | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const baseUrl = (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const response = await fetch(`${baseUrl}/embeddings`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small', input: text.slice(0, 8000) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Embedding provider returned ${response.status}`);
  const payload = await response.json() as { data?: Array<{ embedding?: number[] }> };
  return payload.data?.[0]?.embedding ?? null;
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (!left.length || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

export const defaultKnowledge: KnowledgeDocument[] = [
  { id: 'reservation-policy', title: 'Politique de réservation', body: 'Les réservations de marchandises sont enregistrées avec quantité, poids, date et statut de paiement.', tags: ['réservation', 'marchandises'] },
  { id: 'capacity-policy', title: 'Capacité des bateaux', body: 'La capacité disponible est la capacité totale moins les places déjà réservées.', tags: ['capacité', 'bateau'] },
];

function tokenize(value: string): string[] {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function stem(token: string): string {
  return token.endsWith('s') && token.length > 3 ? token.slice(0, -1) : token;
}

function containsToken(searchable: string[], term: string): boolean {
  const stemmedTerm = stem(term);
  return searchable.some((candidate) => candidate === stemmedTerm || candidate.startsWith(`${stemmedTerm}`) || stem(candidate) === stemmedTerm);
}

export function searchKnowledge(query: string, documents: KnowledgeDocument[]): RankedKnowledge[] {
  const queryTerms = tokenize(query);
  return documents
    .map((document) => {
      const searchable = tokenize(`${document.title} ${document.body} ${(document.tags ?? []).join(' ')}`);
      const score = queryTerms.reduce((total, term) => total + (containsToken(searchable, term) ? 1 : 0), 0);
      return { ...document, score };
    })
    .filter((document) => document.score > 0)
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
}

export async function retrieveKnowledge(query: string, documents: KnowledgeDocument[]): Promise<RankedKnowledge[]> {
  try {
    const queryEmbedding = await createEmbedding(query);
    if (queryEmbedding) {
      const { rows } = await pool.query(
        `SELECT id, title, content AS body, tags, embedding
         FROM knowledge_documents WHERE embedding IS NOT NULL LIMIT 2000`
      );
      const semanticResults = rows
        .map((row) => ({
          id: row.id as string,
          title: row.title as string,
          body: row.body as string,
          tags: row.tags as string[],
          score: cosineSimilarity(queryEmbedding, row.embedding as number[]),
        }))
        .filter((document) => document.score > 0.15)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
      if (semanticResults.length) return semanticResults;
    }
    const { rows } = await pool.query(
      `SELECT id, title, content AS body, tags,
              ts_rank(search_vector, plainto_tsquery('simple', $1)) AS score
       FROM knowledge_documents
       WHERE search_vector @@ plainto_tsquery('simple', $1)
       ORDER BY score DESC LIMIT 5`,
      [query]
    );
    return rows.length ? rows : searchKnowledge(query, documents);
  } catch {
    return searchKnowledge(query, documents);
  }
}

export async function storeKnowledge(input: Omit<KnowledgeDocument, 'id'> & { id?: string }): Promise<KnowledgeDocument> {
  const document = { ...input, id: input.id ?? randomUUID() };
  let embedding: number[] | null = null;
  try {
    embedding = await createEmbedding(`${document.title}\n${document.body}\n${(document.tags ?? []).join(' ')}`);
  } catch {
    embedding = null;
  }
  const { rows } = await pool.query(
    `INSERT INTO knowledge_documents (id, title, content, tags, embedding)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, content = EXCLUDED.content, tags = EXCLUDED.tags,
                                   embedding = EXCLUDED.embedding
     RETURNING id, title, content AS body, tags`,
    [document.id, document.title, document.body, document.tags ?? [], embedding ? JSON.stringify(embedding) : null]
  );
  return rows[0] as KnowledgeDocument;
}
