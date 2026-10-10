// src/ai/llm.ts
// Les variables d'environnement sont lues À CHAQUE APPEL (et non à l'import) :
// avec les modules ESM, les imports sont exécutés avant dotenv.config(), ce qui
// faisait retomber le modèle sur une valeur par défaut non installée.

const ollamaUrl = () => process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const ollamaModel = () => process.env.OLLAMA_MODEL || 'llama3.2';

export type ToolCall = { function: { name: string; arguments: Record<string, unknown> } };
export type Msg = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_name?: string;
};

type Provider = 'ollama' | 'groq' | 'openai';

function pickProvider(): Provider {
  const p = (process.env.AI_PROVIDER || '').toLowerCase();
  if (p === 'groq' && process.env.GROQ_API_KEY) return 'groq';
  if (p === 'openai' && process.env.OPENAI_API_KEY) return 'openai';
  if (p === 'ollama') return 'ollama';
  if (process.env.NODE_ENV === 'production') {
    if (process.env.GROQ_API_KEY) return 'groq';
    if (process.env.OPENAI_API_KEY) return 'openai';
  }
  return 'ollama';
}

export async function chat(messages: Msg[], tools?: unknown[]): Promise<Msg> {
  const provider = pickProvider();

  if (provider === 'groq') {
    return chatOpenAICompat(
      'https://api.groq.com/openai/v1',
      process.env.GROQ_API_KEY!,
      process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
      'Groq',
      messages,
      tools,
    );
  }

  if (provider === 'openai') {
    return chatOpenAICompat(
      process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      process.env.OPENAI_API_KEY!,
      process.env.OPENAI_MODEL || 'gpt-4o-mini',
      'OpenAI',
      messages,
      tools,
    );
  }

  return chatOllama(messages, tools);
}

async function chatOllama(messages: Msg[], tools?: unknown[]): Promise<Msg> {
  const model = ollamaModel();
  const res = await fetch(`${ollamaUrl()}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, tools, stream: false }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!res.ok) {
    // Le corps d'erreur d'Ollama dit par exemple « model 'xxx' not found »
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

async function chatOpenAICompat(
  baseUrl: string,
  apiKey: string,
  model: string,
  label: string,
  messages: Msg[],
  tools?: unknown[],
): Promise<Msg> {
  const body: Record<string, unknown> = {
    model,
    messages: toOpenAIMessages(messages),
    temperature: 0.2,
  };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${label} a répondu ${res.status} (modèle ${model}) : ${detail.slice(0, 300)}`);
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