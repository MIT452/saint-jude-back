# Intégration IA de réservation

## Modèle choisi

Le backend utilise OpenAI avec un modèle configurable via `OPENAI_MODEL`. La valeur par défaut est `gpt-4.1-mini` car le nom `GPT-5.6 Luna` n'est pas une identification de modèle garantie par le code existant et peut ne pas être disponible sur tous les comptes ou endpoints.

L'option `OPENAI_MODEL=GPT-5.6 Luna` ne doit être utilisée qu'après vérification que le modèle est réellement disponible dans votre compte et dans l'API OpenAI. Le backend ne dépend pas de ce nom dans le code.

## Responsabilité du backend

- Le backend reçoit le texte du client.
- Le modèle ouvre une proposition structurée, sans écrire en base.
- Le backend valide la proposition avec Zod.
- Le backend effectue la création PostgreSQL avec une transaction.
- Le frontend ne reçoit que la proposition ou un identifiant de réservation.

## Responsabilité du frontend

1. Demander à l'utilisateur le texte de réservation.
2. Envoyer `POST /api/reservations/ai/plan` avec `{ "message": "..." }`.
3. Afficher la proposition et demander une confirmation.
4. Envoyerla proposition validée à `POST /api/reservations`.
5. Afficher le statut, les erreurs et l'identifiant returned par le serveur.

La route de planification ne crée aucune réservation. L’écriture reste dans le contrôleur backend.

## Configuration

Créez un fichier `.env` à partir de `.env.example` et renseignez :

- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `OPENAI_BASE_URL`, si votre fournisseur OpenAI-compatible est utilisé

Pour une exécution locale hors OpenAI, l'option `OLLAMA_MODEL` du code d'IA général reste disponible, mais la planification de réservation utilise actuellement OpenAI.
