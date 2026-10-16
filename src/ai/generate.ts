const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const MODEL = process.env.OLLAMA_MODEL ?? "llama3.1";

export type ChatMsg = { role: "user" | "assistant"; content: string };

export async function generateAIResponse(opts: {
  message: string;
  systemPrompt: string;
  history?: ChatMsg[]; // vide pour l'instant, utilisé à l'étape 2
}): Promise<string> {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      options: {
        temperature: 0.4,      // plus bas = plus stable
        repeat_penalty: 1.15,  // réduit les répétitions
        num_ctx: 4096,
      },
      messages: [
        { role: "system", content: opts.systemPrompt },
        ...(opts.history ?? []),
        { role: "user", content: opts.message },
      ],
    }),
  });
  if (!res.ok) throw new Error(`LLM error ${res.status}`);
const data = (await res.json()) as { message?: { content?: string } };
  return String(data.message?.content ?? "").trim();
}