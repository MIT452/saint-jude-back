// src/ai/llm.ts
// Les variables d'environnement sont lues À CHAQUE APPEL (et non à l'import) :
// avec les modules ESM, les imports sont exécutés avant dotenv.config(), ce qui
// faisait retomber le modèle sur une valeur par défaut non installée.

const ollamaUrl = () => (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').trim();
const ollamaModel = () => (process.env.OLLAMA_MODEL || 'llama3.2').trim();

// llama-3.1-8b-instant est arrêté chez Groq : remplaçant officiel openai/gpt-oss-20b
const groqModel = () => (process.env.GROQ_MODEL || 'openai/gpt-oss-20b').trim();
const openaiModel = () => (process.env.OPENAI_MODEL || 'gpt-4o-mini').trim();

export type ToolCall = { function: { name: string; arguments: Record<string, unknown> } };
export type Msg = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_name?: string;
};

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  /** true = sortie JSON stricte (extraction). false/absent = texte libre. */
  json?: boolean;
}

type Provider = 'ollama' | 'groq' | 'openai';

/** Masque les clés API dans les messages d'erreur. */
export const safeError = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).replace(/(gsk_|sk-)[A-Za-z0-9_-]+/g, '***').slice(0, 300);

function pickProvider(): Provider {
  const p = (process.env.AI_PROVIDER || '').trim().toLowerCase();
  const groqKey = (process.env.GROQ_API_KEY || '').trim();
  const openaiKey = (process.env.OPENAI_API_KEY || '').trim();

  if (p === 'groq' && groqKey) return 'groq';
  if (p === 'openai' && openaiKey) return 'openai';
  if (p === 'ollama') return 'ollama';
  if (process.env.NODE_ENV === 'production') {
    if (groqKey) return 'groq';
    if (openaiKey) return 'openai';
  }
  return 'ollama';
}

export function currentProviderInfo(): { provider: Provider; model: string } {
  const provider = pickProvider();
  const model = provider === 'groq' ? groqModel() : provider === 'openai' ? openaiModel() : ollamaModel();
  return { provider, model };
}

export async function chat(messages: Msg[], tools?: unknown[], options: ChatOptions = {}): Promise<Msg> {
  const provider = pickProvider();

  if (provider === 'groq') {
    return chatOpenAICompat(
      'https://api.groq.com/openai/v1',
      (process.env.GROQ_API_KEY || '').trim(),
      groqModel(),
      'Groq',
      messages,
      tools,
      options,
    );
  }

  if (provider === 'openai') {
    return chatOpenAICompat(
      (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').trim(),
      (process.env.OPENAI_API_KEY || '').trim(),
      openaiModel(),
      'OpenAI',
      messages,
      tools,
      options,
    );
  }

  return chatOllama(messages, tools, options);
}

/** Réponse texte simple (sans outils). Lève une erreur si le modèle répond vide. */
export async function chatText(messages: Msg[], options: ChatOptions = {}): Promise<string> {
  const out = await chat(messages, undefined, options);
  const text = (out.content || '').trim();
  if (!text) throw new Error('Réponse vide du modèle');
  return text;
}

async function chatOllama(messages: Msg[], tools?: unknown[], options: ChatOptions = {}): Promise<Msg> {
  const model = ollamaModel();
  const res = await fetch(`${ollamaUrl()}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      tools,
      stream: false,
      ...(options.json ? { format: 'json' } : {}),
      options: {
        temperature: options.temperature ?? 0.2,
        num_predict: options.maxTokens ?? 700,
      },
    }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Ollama a répondu ${res.status} (modèle ${model}) : ${detail.slice(0, 300)}`);
  }

  const data = (await res.json()) as { message: Msg };
  return data.message;
}

// Convertit les messages au format Ollama vers le format OpenAI/Groq
// (arguments en chaîne JSON + tool_call_id obligatoire)
function toOpenAIMessages(messages: Msg[]) {
  let pending: { id: string; name: string }[] = [];
  let counter = 0;

  return messages.map((m) => {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      pending = m.tool_calls.map((tc) => ({
        id: `call_${counter++}`,
        name: tc.function.name,
      }));
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.tool_calls.map((tc, i) => ({
          id: pending[i].id,
          type: 'function',
          function: {
            name: tc.function.name,
            arguments: JSON.stringify(tc.function.arguments ?? {}),
          },
        })),
      };
    }

    if (m.role === 'tool') {
      const idx = pending.findIndex((p) => p.name === m.tool_name);
      const found = idx >= 0 ? pending.splice(idx, 1)[0] : undefined;
      return {
        role: 'tool',
        tool_call_id: found?.id ?? `call_${counter++}`,
        content: m.content,
      };
    }

    return { role: m.role, content: m.content };
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function chatOpenAICompat(
  baseUrl: string,
  apiKey: string,
  model: string,
  label: string,
  messages: Msg[],
  tools?: unknown[],
  options: ChatOptions = {},
): Promise<Msg> {
  const isReasoning = model.includes('gpt-oss');

  const body: Record<string, unknown> = {
    model,
    messages: toOpenAIMessages(messages),
    temperature: options.temperature ?? 0.2,
    // les modèles gpt-oss « réfléchissent » : leur raisonnement consomme aussi des tokens
    max_tokens: (options.maxTokens ?? 700) + (isReasoning ? 400 : 0),
    ...(isReasoning ? { reasoning_effort: 'low' } : {}),
  };
  if (options.json) body.response_format = { type: 'json_object' };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  let res: Response | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    // Une seule nouvelle tentative en cas de limite de débit ou d'erreur serveur passagère
    if (res.status === 429 || res.status >= 500) {
      if (attempt === 0) {
        await sleep(1500);
        continue;
      }
    }
    break;
  }

  if (!res || !res.ok) {
    const detail = res ? await res.text().catch(() => '') : '';
    throw new Error(`${label} a répondu ${res?.status ?? '???'} (modèle ${model}) : ${detail.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{ function: { name: string; arguments: string } }>;
      };
    }>;
  };

  const msg = data.choices?.[0]?.message;

  const toolCalls: ToolCall[] | undefined = msg?.tool_calls?.map((tc) => {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(tc.function.arguments || '{}');
    } catch {
      /* arguments invalides : on garde {} */
    }
    return { function: { name: tc.function.name, arguments: args } };
  });

  return {
    role: 'assistant',
    content: msg?.content ?? '',
    ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
  };
}