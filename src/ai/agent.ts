import { chat, type Msg } from './llm.js';
import { tools, toolDefs } from './tools.js';

const SYSTEM = `Tu es l'assistant de Saint-Jude, une application de transport maritime à Madagascar.
Réponds en français, de façon courte.
Pour toute donnée chiffrée, appelle un outil. N'invente jamais de chiffres.
Les montants sont en Ariary.`;

export async function runAgent(question: string): Promise<string> {
  const messages: Msg[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: question },
  ];

  for (let tour = 0; tour < 5; tour++) {
    const reply = await chat(messages, toolDefs);
    messages.push(reply);
    if (!reply.tool_calls?.length) return reply.content;

    for (const call of reply.tool_calls) {
      const name = call.function.name;
      let result: unknown;
      try {
        const tool = tools[name];
        result = tool ? await tool.run(call.function.arguments ?? {}) : { erreur: 'Outil inconnu' };
      } catch (e) {
        console.error(e);
        result = { erreur: "Échec de l'outil" };
      }
      messages.push({ role: 'tool', tool_name: name, content: JSON.stringify(result).slice(0, 4000) });
    }
  }
  return "Je n'ai pas pu terminer la demande.";
}