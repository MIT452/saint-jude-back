import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { findRelevantTools } from '../ai/jit.js';
import { defaultKnowledge, retrieveKnowledge, searchKnowledge, storeKnowledge } from '../ai/rag.js';
import { evaluateAnswer } from '../ai/evaluation.js';
import { runMultiAgent } from '../ai/orchestration.js';
import { createMcpServer } from '../ai/mcp.js';
import { transcribeSpeech, synthesizeSpeech } from '../ai/speech.js';
import { tools } from '../ai/tools.js';
import { requireBearerToken } from '../utils/bearerAuth.js';
import { runEvaluationSuite } from '../ai/evaluation-fixtures.js';
import { getObservabilitySnapshot } from '../ai/observability.js';
import { createApprovalRequest, listApprovalRequests, reviewApprovalRequest } from '../ai/approvals.js';
import { aiRequestLimiter } from './ai.js';

const router = Router();
router.use(aiRequestLimiter);
const mcpTools = [
  { name: 'search_knowledge', description: 'Recherche dans la base de connaissances', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, execute: async ({ query }: Record<string, unknown>) => searchKnowledge(String(query ?? ''), knowledge) },
  { name: 'evaluate_answer', description: 'Évalue une réponse', inputSchema: { type: 'object', properties: { answer: { type: 'string' }, expected: { type: 'string' } }, required: ['answer'] }, execute: async ({ answer, expected }: Record<string, unknown>) => evaluateAnswer(String(answer ?? ''), String(expected ?? '')) },
];
const knowledge = defaultKnowledge;

router.post('/rag', async (req: Request, res: Response) => {
  const query = String(req.body?.query ?? '').trim();
  if (!query) return res.status(400).json({ error: 'query requise' });
  res.json({ results: await retrieveKnowledge(query, knowledge) });
});

router.post('/rag/documents', requireBearerToken('RAG_ADMIN_TOKEN'), async (req: Request, res: Response) => {
  const parsed = z.object({
    id: z.string().min(1).max(36).optional(),
    title: z.string().trim().min(1).max(255),
    body: z.string().trim().min(1).max(50_000),
    tags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Document invalide', details: parsed.error.issues });
  try {
    res.status(201).json(await storeKnowledge(parsed.data));
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Ingestion documentaire indisponible' });
  }
});

router.post('/jit', (req: Request, res: Response) => {
  const question = String(req.body?.question ?? '').trim();
  const tools = [
    { name: 'meteo', description: 'Recherche la météo et l’état de la mer.' },
    { name: 'distance', description: 'Calcule la distance entre deux lieux.' },
    { name: 'lister_bateaux', description: 'Liste les bateaux disponibles.' },
  ];
  if (!question) return res.status(400).json({ error: 'question requise' });
  res.json({ selectedTools: findRelevantTools(question, tools) });
});

router.post('/evaluate', (req: Request, res: Response) => {
  const parsed = z.object({ answer: z.string(), expected: z.string().min(1).optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'answer invalide' });
  res.json(evaluateAnswer(parsed.data.answer, parsed.data.expected ?? parsed.data.answer));
});

router.post('/evaluate/suite', (_req: Request, res: Response) => {
  res.json(runEvaluationSuite());
});

router.get('/observability/metrics', requireBearerToken('OBSERVABILITY_TOKEN'), (_req: Request, res: Response) => {
  res.json({ routes: getObservabilitySnapshot() });
});

router.post('/approvals', requireBearerToken('AI_APPROVAL_TOKEN'), async (req: Request, res: Response) => {
  const parsed = z.object({
    requestType: z.string().trim().min(1).max(100),
    payload: z.record(z.string(), z.unknown()),
    requestedBy: z.string().trim().max(255).optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Demande invalide', details: parsed.error.issues });
  try {
    res.status(201).json(await createApprovalRequest(parsed.data));
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'File d’approbation indisponible' });
  }
});

router.get('/approvals', requireBearerToken('AI_APPROVAL_TOKEN'), async (req: Request, res: Response) => {
  const status = String(req.query.status ?? 'pending');
  if (!['pending', 'approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'Statut invalide' });
  try {
    res.json({ requests: await listApprovalRequests(status) });
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'File d’approbation indisponible' });
  }
});

router.patch('/approvals/:id', requireBearerToken('AI_APPROVAL_TOKEN'), async (req: Request, res: Response) => {
  const parsed = z.object({
    decision: z.enum(['approved', 'rejected']),
    reviewedBy: z.string().trim().min(1).max(255),
    reviewNote: z.string().trim().max(2000).optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Décision invalide', details: parsed.error.issues });
  try {
    const result = await reviewApprovalRequest({ id: req.params.id, ...parsed.data });
    if (!result) return res.status(409).json({ error: 'Demande introuvable ou déjà traitée' });
    res.json(result);
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Revue indisponible' });
  }
});

router.post('/multi-agent', async (req: Request, res: Response) => {
  const parsed = z.object({ question: z.string().min(1), planner: z.string().optional(), specialist: z.string().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'question invalide' });
  try {
    res.json(await runMultiAgent(parsed.data.question));
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Orchestration indisponible' });
  }
});

router.post('/mcp', requireBearerToken('MCP_BEARER_TOKEN'), async (req: Request, res: Response) => {
  const message = req.body;
  const businessTools = Object.entries(tools).map(([name, tool]) => ({
    name,
    description: tool.def.function.description,
    inputSchema: tool.def.function.parameters as Record<string, unknown>,
    execute: (arguments_: Record<string, unknown>) => tool.run(arguments_),
  }));
  const handler = createMcpServer([...businessTools, ...mcpTools]);
  const result = await handler(message);
  res.json(result);
});

router.post('/speech/transcribe', async (req: Request, res: Response) => {
  const audio = String(req.body?.audio ?? '');
  const mimeType = String(req.body?.mimeType ?? 'audio/webm');
  if (!audio) return res.status(400).json({ error: 'audio requis' });
  try {
    res.json(await transcribeSpeech(audio, mimeType));
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Transcription indisponible' });
  }
});

router.post('/speech/synthesize', async (req: Request, res: Response) => {
  const text = String(req.body?.text ?? '').trim();
  if (!text) return res.status(400).json({ error: 'text requis' });
  try {
    const audio = await synthesizeSpeech(text);
    res.json({ audio, mimeType: 'audio/mpeg' });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Synthèse indisponible' });
  }
});

export default router;
