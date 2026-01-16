# Guide de Sécurité

Ce document décrit les mesures de sécurité implémentées dans le service mail.

## 🔐 Authentification

### API Key

Tous les endpoints (sauf `/health`) nécessitent une clé API valide.

**Méthodes d'authentification acceptées :**
1. Header `X-API-Key` : `X-API-Key: your-api-key`
2. Header `Authorization` : `Authorization: Bearer your-api-key`

**Configuration :**
- Définissez `API_KEYS` dans votre fichier `.env` avec une ou plusieurs clés séparées par des virgules
- Si `API_KEYS` est vide, l'API est accessible sans authentification (mode développement uniquement)

**Génération d'une clé :**
```bash
npm run generate-key
```

## 🛡️ Rate Limiting

### Limites par défaut

- **Requêtes générales** : 100 requêtes par IP toutes les 15 minutes
- **Envoi d'emails** : 50 emails par IP par heure

Ces limites peuvent être ajustées dans le code si nécessaire.

### Headers de réponse

Le rate limiting ajoute automatiquement les headers suivants :
- `X-RateLimit-Limit` : Limite maximale
- `X-RateLimit-Remaining` : Nombre de requêtes restantes
- `X-RateLimit-Reset` : Timestamp de réinitialisation

## ✅ Validation des entrées

### Emails

- Validation stricte du format email (RFC 5322)
- Support des emails multiples (tableau ou chaîne séparée par virgules)
- Validation séparée pour `to`, `cc`, `bcc`, `replyTo`

### Contenu

- **Sujet** : Maximum 200 caractères
- **Message texte** : Maximum 10 000 caractères
- **Message HTML** : Maximum 50 000 caractères
- **Template** : Maximum 50 000 caractères
- **Nom** : 2-100 caractères
- **Message de contact** : 10-5000 caractères

### Sanitization

- Échappement HTML automatique pour prévenir les attaques XSS
- Normalisation des emails
- Trim des chaînes de caractères

## 🌐 CORS (Cross-Origin Resource Sharing)

### Configuration

- Origines autorisées configurées via `ALLOWED_ORIGINS` (séparées par des virgules)
- Par défaut : `http://localhost:3000` et `http://localhost:5173`
- Support des credentials (cookies, headers d'authentification)

### Mode développement

Si `ALLOW_NO_ORIGIN=true`, les requêtes sans origine sont autorisées (utile pour Postman, mobile apps, etc.)

⚠️ **Ne pas activer en production !**

## 🔒 Headers de sécurité (Helmet)

Le service utilise Helmet pour ajouter automatiquement des headers de sécurité :

- `X-Content-Type-Options: nosniff` - Empêche le MIME-sniffing
- `X-Frame-Options: DENY` - Empêche le clickjacking
- `X-XSS-Protection: 1; mode=block` - Protection XSS
- `Strict-Transport-Security` - Force HTTPS (si configuré)
- `Content-Security-Policy` - Politique de sécurité du contenu

## 📏 Limites de taille

- **Body JSON** : Maximum 1MB
- **URL** : Limite par défaut d'Express

## 🚫 Protection contre les attaques

### Injection

- Validation stricte de tous les champs
- Échappement des données utilisateur
- Pas d'évaluation de code dynamique

### DDoS

- Rate limiting par IP
- Timeout de connexion SMTP (15 secondes)
- Limite de taille du body

### Spam

- Validation des emails
- Limite d'envoi par IP
- Logging de toutes les tentatives

## 📝 Logging et monitoring

### Logs de sécurité

Le service enregistre :
- Tentatives d'accès avec clés API invalides
- Erreurs de validation
- Erreurs d'envoi d'email
- Adresses IP des requêtes

### Informations sensibles

⚠️ **Les mots de passe et clés API ne sont jamais loggés en clair.**

## 🔄 Bonnes pratiques

### Production

1. ✅ Définissez `NODE_ENV=production`
2. ✅ Configurez des clés API fortes et uniques
3. ✅ Limitez les origines CORS aux domaines autorisés
4. ✅ Désactivez `ALLOW_NO_ORIGIN`
5. ✅ Utilisez HTTPS (via reverse proxy comme nginx)
6. ✅ Surveillez les logs pour détecter les abus
7. ✅ Changez régulièrement les clés API
8. ✅ Utilisez un firewall pour limiter l'accès au port

### Développement

- Vous pouvez laisser `API_KEYS` vide pour tester sans authentification
- Activez `ALLOW_NO_ORIGIN=true` si nécessaire pour Postman
- Les limites de rate limiting sont plus permissives

## 🚨 En cas de compromission

1. **Révoquez immédiatement** toutes les clés API compromises
2. **Générez de nouvelles clés** : `npm run generate-key`
3. **Mettez à jour** le fichier `.env` avec les nouvelles clés
4. **Redémarrez** le service
5. **Vérifiez les logs** pour identifier les accès non autorisés
6. **Changez** les mots de passe SMTP si nécessaire

## 📚 Ressources

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Express Security Best Practices](https://expressjs.com/en/advanced/best-practice-security.html)
- [Nodemailer Security](https://nodemailer.com/about/#security)
