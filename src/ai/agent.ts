import { chat, type Msg } from './llm.js';
import { tools, toolDefs } from './tools.js';
import { findRelevantTools } from './jit.js';
import { defaultKnowledge, retrieveKnowledge } from './rag.js';

const SYSTEM = `Tu es l'assistant de Saint-Jude, une application de transport maritime à Madagascar.
Réponds en français, de façon courte.
Pour toute donnée chiffrée, appelle un outil. N'invente jamais de chiffres.
Les montants sont en Ariary.`;

export async function runAgent(question: string): Promise<string> {
  const documents = await retrieveKnowledge(question, defaultKnowledge);
  const relevantToolNames = new Set(findRelevantTools(question, Object.entries(tools).map(([name, tool]) => ({
    name,
    description: tool.def.function.description,
  }))).map((tool) => tool.name));
  const availableToolDefs = toolDefs.filter((definition) => relevantToolNames.has(definition.function.name));
  const context = documents.map((document) => `- ${document.title}: ${document.body}`).join('\n');
  const messages: Msg[] = [
    { role: 'system', content: `${SYSTEM}\nUtilise ce contexte documentaire s'il est pertinent :\n${context || 'Aucun document pertinent.'}` },
    { role: 'user', content: question },
  ];

  for (let tour = 0; tour < 5; tour++) {
    const reply = await chat(messages, availableToolDefs);
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