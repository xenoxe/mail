# Mail Service

Service d'envoi de mails sécurisé basé sur Node.js, Express et Nodemailer.

## 🔐 Sécurité

Ce service inclut plusieurs couches de sécurité :
- ✅ **Authentification par API Key** - Protection de tous les endpoints (sauf `/health`)
- ✅ **Rate Limiting** - Limite de 100 requêtes/15min et 50 emails/heure par IP
- ✅ **Validation des entrées** - Validation stricte des emails et données
- ✅ **Headers de sécurité** - Helmet pour protéger contre les attaques courantes
- ✅ **CORS restrictif** - Origines autorisées configurables
- ✅ **Limite de taille** - Body limité à 1MB
- ✅ **Sanitization** - Échappement des données utilisateur

## Installation

```bash
npm install
```

## Configuration

Copiez le fichier `env.example` vers `.env` et configurez vos paramètres SMTP :

```bash
cp env.example .env
```

Variables d'environnement requises :
- `SMTP_HOST` : Serveur SMTP (défaut: ssl0.ovh.net)
- `SMTP_PORT` : Port SMTP (défaut: 465)
- `SMTP_USER` : Nom d'utilisateur SMTP
- `SMTP_PASS` : Mot de passe SMTP
- `SMTP_FROM` : Adresse email expéditrice (optionnel, utilise SMTP_USER par défaut)
- `SMTP_TO` : Adresse email destinataire par défaut (optionnel)
- `PORT` : Port du serveur (défaut: 3000)

Variables de sécurité :
- `API_KEYS` : Clés API séparées par des virgules (ex: `key1,key2,key3`). Si vide, l'API est accessible sans authentification (mode développement)
- `ALLOWED_ORIGINS` : Origines CORS autorisées, séparées par des virgules (ex: `http://localhost:3000,https://example.com`)
- `ALLOW_NO_ORIGIN` : Autoriser les requêtes sans origine (défaut: `false`)
- `NODE_ENV` : Environnement (`production` ou `development`)

## Utilisation

### Développement

```bash
npm run dev
```

### Production

```bash
npm start
```

## API Endpoints

### GET /health

Vérifie l'état du service et la configuration SMTP. **Route publique** (pas d'authentification requise).

**Réponse :**
```json
{
  "status": "ok",
  "service": "mail-service",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "smtp": {
    "configured": true,
    "host": "ssl0.ovh.net",
    "port": 465
  },
  "security": {
    "apiKeyRequired": true,
    "rateLimiting": true
  }
}
```

### POST /api/send

Envoie un email simple. **Route protégée** (API key requise).

**Headers requis :**
```
X-API-Key: your-api-key
```
ou
```
Authorization: Bearer your-api-key
```

**Body :**
```json
{
  "to": "destinataire@example.com",
  "subject": "Sujet de l'email",
  "text": "Corps du message en texte brut",
  "html": "<p>Corps du message en HTML</p>",
  "replyTo": "reply@example.com",
  "cc": "cc@example.com",
  "bcc": "bcc@example.com"
}
```

**Réponse :**
```json
{
  "ok": true,
  "messageId": "<message-id>",
  "accepted": ["destinataire@example.com"],
  "rejected": []
}
```

### POST /api/send-template

Envoie un email avec template (variables à remplacer). **Route protégée** (API key requise).

**Headers requis :**
```
X-API-Key: your-api-key
```

**Body :**
```json
{
  "to": "destinataire@example.com",
  "subject": "Bienvenue {{name}}",
  "template": "Bonjour {{name}}, votre email est {{email}}",
  "data": {
    "name": "John Doe",
    "email": "john@example.com"
  },
  "replyTo": "reply@example.com"
}
```

### POST /api/contact

Envoie un email depuis un formulaire de contact. **Route protégée** (API key requise).

**Headers requis :**
```
X-API-Key: your-api-key
```

**Body :**
```json
{
  "name": "John Doe",
  "email": "john@example.com",
  "phone": "+33123456789",
  "message": "Message du formulaire",
  "subject": "Sujet personnalisé (optionnel)"
}
```

## Docker

### Production

```bash
docker-compose up -d
```

### Développement

```bash
docker-compose --profile dev up
```

## Exemples d'utilisation

### cURL

```bash
# Vérifier l'état (route publique)
curl http://localhost:3000/health

# Envoi simple (avec API key)
curl -X POST http://localhost:3000/api/send \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key" \
  -d '{
    "to": "destinataire@example.com",
    "subject": "Test",
    "text": "Message de test"
  }'

# Avec Authorization Bearer
curl -X POST http://localhost:3000/api/send \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "to": "destinataire@example.com",
    "subject": "Test",
    "text": "Message de test"
  }'

# Formulaire de contact
curl -X POST http://localhost:3000/api/contact \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key" \
  -d '{
    "name": "John Doe",
    "email": "john@example.com",
    "message": "Bonjour, je souhaite des informations"
  }'
```

### JavaScript/TypeScript

```typescript
const API_KEY = 'your-api-key';
const API_URL = 'http://localhost:3000';

// Envoi d'email
const response = await fetch(`${API_URL}/api/send`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': API_KEY
  },
  body: JSON.stringify({
    to: 'destinataire@example.com',
    subject: 'Test',
    text: 'Message de test',
    html: '<p>Message de test</p>'
  })
});

const result = await response.json();
console.log(result);
```

## 🔑 Génération d'une clé API

Pour générer une clé API sécurisée, vous pouvez utiliser :

```bash
# Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# OpenSSL
openssl rand -hex 32

# Python
python -c "import secrets; print(secrets.token_hex(32))"
```

Ajoutez ensuite la clé dans votre fichier `.env` :
```
API_KEYS=votre-clé-générée-ici
```

Vous pouvez configurer plusieurs clés en les séparant par des virgules :
```
API_KEYS=key1,key2,key3
```

## Support

Pour toute question ou problème, consultez les logs du service.
