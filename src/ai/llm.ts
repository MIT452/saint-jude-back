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

export async function chat(messages: Msg[], tools?: unknown[]): Promise<Msg> {
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