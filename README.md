Créé et géré par: RABETOKOTANY Ny Tsanta FIderana

# Backend Saint-Jude (PostgreSQL)

Ce dossier contient l'API qui permet à votre application frontend de fonctionner avec une vraie
base de données PostgreSQL, en local ou hébergée, au lieu des données simulées actuelles.

## Ce qu'il vous faut avant de commencer

- Node.js installé (version 18 ou plus) — vous l'avez sûrement déjà si le frontend tourne.
- PostgreSQL installé et lancé sur votre machine, ou une base PostgreSQL hébergée.
- Un terminal.

## Étape 1 — Créer la base de données

Pour une base locale, créez la base puis appliquez le schéma depuis un terminal dans ce dossier :

```bash
createdb -U postgres saint_jude
psql -U postgres -d saint_jude -f schema-postgresql.sql
```

Pour une base hébergée, créez d'abord la base chez votre fournisseur et exécutez
`schema-postgresql.sql` sur cette base avec `psql` ou son client SQL. Le schéma ne crée pas de
compte utilisateur de démonstration.

## Étape 2 — Configurer la connexion

Copiez le fichier d'exemple :

```bash
cp .env.example .env
```

Ouvrez le fichier `.env` créé et complétez les paramètres PostgreSQL locaux, ou renseignez
`DATABASE_URL` avec l'URL fournie par votre hébergeur :

```env
DB_USER=postgres
DB_PASSWORD=
DB_NAME=saint_jude
# DATABASE_URL=postgresql://... (base hébergée)
```

Ne publiez jamais l'URL de connexion ni son mot de passe dans GitHub. Activez `DB_SSL=true` si votre
fournisseur exige SSL.

Ne touchez pas à `PORT=3000` : votre frontend appelle `http://localhost:3000/api`, ce numéro de
port est donc obligatoire.

## Étape 3 — Installer et démarrer le backend

```bash
npm install
npm run dev
```

Vous devriez voir :
```
🚢 Backend Saint-Jude démarré sur http://localhost:3000
```

Laissez ce terminal ouvert — c'est votre serveur backend qui tourne.

## Étape 4 — Démarrer le frontend

Dans un **autre** terminal, dans le dossier de votre projet frontend (`Saint-jude-main`) :

```bash
npm install
npm run dev
```

Ouvrez ensuite l'adresse indiquée (normalement `http://localhost:5173`). L'application devrait
maintenant lire et écrire ses données dans votre base PostgreSQL au lieu des données simulées.

## Vérifier que ça fonctionne

Dans votre navigateur, ouvrez `http://localhost:3000/api/health` : vous devez voir
`{"status":"ok","service":"stjude-backend"}`. Si vous voyez ça, le backend tourne bien.

Ensuite `http://localhost:3000/api/user` doit renvoyer une liste vide tant qu'aucun utilisateur
n'a été créé par l'application.

## En cas de problème

- **Erreur de connexion PostgreSQL au démarrage (`ECONNREFUSED` ou authentification refusée)** :
  vérifiez que PostgreSQL est lancé, et que `DATABASE_URL` ou `DB_USER` / `DB_PASSWORD` correspondent
  à vos identifiants.
- **Le frontend ne reçoit aucune donnée / erreurs CORS dans la console du navigateur** : vérifiez
  que `CORS_ORIGIN` dans `.env` correspond bien à l'adresse affichée par `npm run dev` côté
  frontend (normalement `http://localhost:5173`).
- **La base ou les tables n'existent pas** : créez `saint_jude` puis appliquez de nouveau
  `schema-postgresql.sql`.

## Comment ça correspond à votre code frontend

- Le frontend appelle son API via `src/data/service.ts`, qui pointe vers
  `http://localhost:3000/api/<nom_entité>` (ex : `/api/goods`, `/api/trips`...).
- Ces noms viennent de `TABLE_DATA_BASE` dans `src/data/type.ts`.
- Ce backend expose exactement ces mêmes routes (`GET`, `GET/:id`, `POST`, `PUT/:id`,
  `DELETE/:id`), avec des colonnes PostgreSQL qui reprennent les mêmes noms de champs que vos
  interfaces TypeScript (`Goods`, `Reservation`, `Trip`, `Boat`, `CashMovement`,
  `FuelConsumption`, `User`) — aucune adaptation du code frontend n'est donc nécessaire.

## Inscription, connexion et Neon

Le frontend utilise `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me` et
`POST /api/auth/logout`. Les mots de passe sont hachés avec scrypt dans la table `user`; la session
est conservée dans un cookie `HttpOnly`, jamais dans `localStorage`. Une inscription publique crée
uniquement un compte `Agent`.

Pour utiliser Neon, configurez les variables dans le `.env` du backend (ou dans les variables
secrètes de l’hébergeur) :

```env
DATABASE_URL=postgresql://...   # URL Neon, ne pas committer
DB_SSL=true                  # Neon utilise TLS (détection automatique aussi)
AUTH_SECRET=                    # secret aléatoire d'au moins 32 caractères
CORS_ORIGIN=http://localhost:5173
```

Important : si `DATABASE_URL` est vide, le backend utilise les variables `DB_HOST`, `DB_PORT`,
`DB_USER`, `DB_PASSWORD` et `DB_NAME` et écrit donc dans cette base locale, pas dans Neon. Vérifiez
`http://localhost:3000/api/health/database` : `provider` doit valoir `neon` et `status` `ok`.
Cette vérification confirme également que la table `user` existe.

Configurez `VITE_API_URL=http://localhost:3000/api` dans le frontend en développement. En
production, remplacez-la par l’URL publique du backend et ajoutez l’origine exacte du frontend à
`CORS_ORIGIN`. Les cookies nécessitent `credentials` côté API et navigateur. Après avoir créé votre
compte, un administrateur de la base peut attribuer le rôle propriétaire au premier compte de
confiance dans Neon :

```sql
UPDATE "user" SET role = 'Propriétaire' WHERE email = 'votre-email@example.com';
```

Appliquez `schema-postgresql.sql` à la base Neon avant l’inscription. Ne mettez jamais `DATABASE_URL`
ou `AUTH_SECRET` dans le frontend ni dans Git.

## Capacités IA avancées

Les routes complémentaires sont sous `/api/ai-advanced` :

- `POST /rag` recherche les documents; `POST /rag/documents` les ajoute ou les met à jour.
- `POST /mcp` expose `initialize`, `ping`, `tools/list` et `tools/call` en JSON-RPC.
- `POST /evaluate/suite` lance les fixtures de référence.
- `GET /observability/metrics` renvoie les compteurs par route et leur latence moyenne.
- `POST /approvals`, `GET /approvals` et `PATCH /approvals/:id` gèrent les validations humaines.
- `POST /speech/transcribe` et `POST /speech/synthesize` utilisent les API audio OpenAI.

Appliquez `schema-postgresql.sql` après chaque mise à jour du schéma. Pour activer les embeddings,
renseignez `OPENAI_API_KEY`; sans clé, l’ingestion et la recherche utilisent le texte intégral
PostgreSQL. Les embeddings sont comparés en mémoire, ce qui convient à un corpus limité (2 000
documents) ; une base plus volumineuse doit migrer vers pgvector.

Définissez des secrets aléatoires non vides dans `MCP_BEARER_TOKEN`, `RAG_ADMIN_TOKEN`,
`OBSERVABILITY_TOKEN` et `AI_APPROVAL_TOKEN`. Passez-les comme en-tête `Authorization: Bearer <secret>`
sur les routes protégées. Ne réutilisez pas ces secrets entre environnements.

La suite actuelle est un smoke test déterministe, pas une évaluation sémantique d’un LLM. Le
frontend n’est pas dans ce dépôt; il faut relier ses écrans au projet frontend séparé.
