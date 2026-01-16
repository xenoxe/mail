# Backend API - KBL Clean Pro

API backend séparée pour le déploiement sur Hostinger ou autres services Node.js.

## 🚀 Développement Local

```bash
# Installer les dépendances
npm install

# Démarrer en mode développement
npm run dev

# Build TypeScript
npm run build

# Démarrer en production
npm start
```

## 📦 Structure Standalone

Le backend est maintenant **complètement autonome** et peut fonctionner indépendamment du reste du projet :

```
backend/
├── src/                  # Code source TypeScript
│   ├── index.ts          # Point d'entrée principal
│   └── database.ts       # Configuration de la base de données
├── dist/                 # Fichiers compilés (générés)
├── data/                 # Base de données SQLite
├── articles/             # Articles de blog (optionnel)
│   ├── *.json           # Fichiers d'articles
│   └── img/             # Images des articles
├── public/               # Fichiers publics
│   └── uploads/         # Uploads utilisateurs
│       └── variants/    # Images de variantes de services
├── package.json
├── tsconfig.json
└── .env.example
```

**Tous les chemins sont relatifs au répertoire `backend/`** - le backend est standalone.

## 🔧 Variables d'Environnement

Copiez `.env.example` vers `.env` et configurez :

- `SMTP_*` : Configuration email
- `JWT_SECRET` : Secret pour l'authentification
- `PORT` : Port d'écoute (défaut: 3000)
- `DB_PATH` : Chemin vers la base de données
- `STRIPE_*` : Configuration Stripe (optionnel)

## 📤 Déploiement

### Sur Hostinger (Node.js App)

1. Créez une archive ZIP avec :
   - `dist/` (après `npm run build`)
   - `package.json`
   - `data/` (si vous avez une DB existante)
   - `.env` (ou configurez les variables dans le panneau)

2. Uploadez sur Hostinger comme "Node.js Application"

3. Configurez :
   - **Start Command** : `npm start`
   - **Port** : `3000` (ou celui défini dans `.env`)

### Sur Railway

1. Connectez votre repository
2. Railway détectera automatiquement Node.js
3. Configurez les variables d'environnement
4. Déployez

### Sur Render

1. Créez un nouveau "Web Service"
2. Configurez :
   - **Build Command** : `npm install && npm run build`
   - **Start Command** : `npm start`
3. Ajoutez les variables d'environnement
4. Déployez

## 🔗 CORS

L'API est configurée pour accepter les requêtes depuis :
- Votre domaine frontend (à configurer dans `src/index.ts`)
- `http://localhost:8080` (développement local)

## 📝 Notes

- La base de données SQLite est créée automatiquement si elle n'existe pas dans `data/`
- Les uploads sont stockés dans `public/uploads/variants/` (relatif au backend)
- Les articles sont lus depuis `articles/` (dans le répertoire backend)
- Le backend est **standalone** : tous les chemins sont relatifs à `backend/`
- Vous pouvez copier/déployer le dossier `backend/` indépendamment du reste du projet
