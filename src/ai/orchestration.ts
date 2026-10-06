export type AgentRole = 'planner' | 'specialist';

export type OrchestrationInput = {
  question: string;
  roles: Record<AgentRole, string>;
};

export type OrchestrationResult = {
  status: 'completed';
  agents: Array<{ name: AgentRole; role: string; result: string }>;
  answer: string;
};

export async function runMultiAgent(question: string): Promise<OrchestrationResult> {
  const { runAgent } = await import('./agent.js');
  const [planning, specialist] = await Promise.all([
    runAgent(`Tu es l'agent planificateur. Décompose cette demande en étapes et précise les informations manquantes : ${question}`),
    runAgent(`Tu es l'agent spécialiste transport maritime Saint-Jude. Identifie les contraintes métier et les vérifications nécessaires : ${question}`),
  ]);
  const answer = await runAgent(`Synthétise ces analyses en une réponse courte sans inventer de données. Demande: ${question}\nPlan: ${planning}\nAnalyse spécialiste: ${specialist}`);
  return {
    status: 'completed',
    agents: [
      { name: 'planner', role: 'Planification', result: planning },
      { name: 'specialist', role: 'Expertise transport maritime', result: specialist },
    ],
    answer,
  };
}

export function orchestrate(question: string, roles: Partial<Record<AgentRole, string>>): OrchestrationResult {
  const agents: OrchestrationResult['agents'] = [
    {
      name: 'planner',
      role: roles.planner ?? 'Planifie la demande',
      result: `Plan de réservation : la demande « ${question} » est analysée en priorité.`,
    },
    {
      name: 'specialist',
      role: roles.specialist ?? 'Vérifie la disponibilité',
      result: `Spécialiste : la disponibilité et les contraintes liées aux colis sont évaluées.`,
    },
  ];

  return {
    status: 'completed',
    agents,
    answer: `Planification coordonnée : ${agents[0].result} ${agents[1].result}`,
  };
}
