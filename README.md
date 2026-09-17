Géré par: RABETOKOTANY Ny Tsanta FIderana

# Backend Saint-Jude (MySQL)

Ce dossier contient l'API qui permet à votre application frontend de fonctionner avec une vraie
base de données MySQL en local, au lieu des données simulées actuelles.

## Ce qu'il vous faut avant de commencer

- Node.js installé (version 18 ou plus) — vous l'avez sûrement déjà si le frontend tourne.
- MySQL installé et lancé sur votre machine (vous avez confirmé que c'est le cas).
- Un terminal.

## Étape 1 — Créer la base de données

Ouvrez un terminal **dans ce dossier** (`stjude-backend`) et lancez :

```bash
mysql -u root -p < schema.sql
```

- Il vous demandera le mot de passe MySQL de l'utilisateur `root` (laissez vide et appuyez sur
  Entrée si vous n'en avez pas défini).
- Cette commande crée la base `saint_jude` et toutes les tables nécessaires (`user`, `boats`,
  `trips`, `reservations`, `goods`, `cashmovements`, `fuelconsumptions`), ainsi qu'un premier
  utilisateur de connexion.

Si la commande `mysql` n'est pas reconnue, ouvrez votre client MySQL habituel (MySQL Workbench,
phpMyAdmin, TablePlus...) et exécutez le contenu du fichier `schema.sql` manuellement.

## Étape 2 — Configurer la connexion

Copiez le fichier d'exemple :

```bash
cp .env.example .env
```

Ouvrez le fichier `.env` créé et complétez ces deux lignes avec vos identifiants MySQL réels :

```env
DB_USER=root
DB_PASSWORD=
```

(Laissez `DB_PASSWORD=` vide si votre MySQL local n'a pas de mot de passe.)

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
maintenant lire et écrire ses données dans votre base MySQL locale au lieu des données simulées.

## Vérifier que ça fonctionne

Dans votre navigateur, ouvrez `http://localhost:3000/api/health` : vous devez voir
`{"status":"ok","service":"stjude-backend"}`. Si vous voyez ça, le backend tourne bien.

Ensuite `http://localhost:3000/api/user` doit afficher l'utilisateur de départ créé par le script
SQL (Jean Paul).

## En cas de problème

- **Erreur de connexion MySQL au démarrage (`ECONNREFUSED` ou `Access denied`)** : vérifiez que
  MySQL est bien lancé, et que `DB_USER` / `DB_PASSWORD` dans `.env` correspondent à vos vrais
  identifiants.
- **Le frontend ne reçoit aucune donnée / erreurs CORS dans la console du navigateur** : vérifiez
  que `CORS_ORIGIN` dans `.env` correspond bien à l'adresse affichée par `npm run dev` côté
  frontend (normalement `http://localhost:5173`).
- **`Unknown database 'saint_jude'`** : l'étape 1 n'a pas été exécutée correctement — relancez la
  commande `mysql -u root -p < schema.sql`.

## Comment ça correspond à votre code frontend

- Le frontend appelle son API via `src/data/service.ts`, qui pointe vers
  `http://localhost:3000/api/<nom_entité>` (ex : `/api/goods`, `/api/trips`...).
- Ces noms viennent de `TABLE_DATA_BASE` dans `src/data/type.ts`.
- Ce backend expose exactement ces mêmes routes (`GET`, `GET/:id`, `POST`, `PUT/:id`,
  `DELETE/:id`), avec des colonnes MySQL qui reprennent les mêmes noms de champs que vos
  interfaces TypeScript (`Goods`, `Reservation`, `Trip`, `Boat`, `CashMovement`,
  `FuelConsumption`, `User`) — aucune adaptation du code frontend n'est donc nécessaire.
