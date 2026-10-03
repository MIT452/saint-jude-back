const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const MODEL = process.env.OLLAMA_MODEL ?? 'qwen2.5:1.5b';

export type ToolCall = { function: { name: string; arguments: Record<string, unknown> } };
export type Msg = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_name?: string;
};

export async function chat(messages: Msg[], tools?: unknown[]): Promise<Msg> {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages, tools, stream: false }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`Ollama a répondu ${res.status}`);
  const data = (await res.json()) as { message: Msg };
  return data.message;
}