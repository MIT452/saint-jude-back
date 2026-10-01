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
