# Backend Saint-Jude (MySQL)

Ce dossier contient l'API qui permet à votre application frontend de fonctionner avec une vraie
base de données MySQL en local, au lieu des données simulées actuelles.



## Étape 1 — Créer la base de données



ouvrez votre client MySQL et exécutez le contenu du fichier `schema.sql` manuellement.

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


