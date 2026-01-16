#!/bin/bash

# Script de test pour le service d'envoi de mails
# Usage: ./scripts/test-email.sh [endpoint] [api-key]
# Exemple: ./scripts/test-email.sh send my-api-key

BASE_URL="${BASE_URL:-http://localhost:3000}"
ENDPOINT="${1:-send}"
API_KEY="${2:-${API_KEY:-}}"

echo "🧪 Test du service mail-service"
echo "📍 URL de base: $BASE_URL"
if [ -n "$API_KEY" ]; then
  echo "🔑 API Key: ${API_KEY:0:8}***"
else
  echo "⚠️  Aucune clé API fournie (utilisez: ./scripts/test-email.sh [endpoint] [api-key])"
fi
echo ""

# Test de santé
echo "1️⃣ Test de santé (GET /health)"
curl -s "$BASE_URL/health" | jq '.' || echo "❌ Erreur"
echo ""
echo "---"
echo ""

# Test selon l'endpoint
case "$ENDPOINT" in
  "send")
    echo "2️⃣ Test d'envoi simple (POST /api/send)"
    if [ -z "$API_KEY" ]; then
      echo "❌ Erreur: Clé API requise pour cet endpoint"
      exit 1
    fi
    curl -X POST "$BASE_URL/api/send" \
      -H "Content-Type: application/json" \
      -H "X-API-Key: $API_KEY" \
      -d '{
        "to": "test@example.com",
        "subject": "Test d'\''envoi",
        "text": "Ceci est un message de test",
        "html": "<p>Ceci est un <strong>message de test</strong></p>"
      }' | jq '.' || echo "❌ Erreur"
    ;;
  
  "template")
    echo "2️⃣ Test d'\''envoi avec template (POST /api/send-template)"
    if [ -z "$API_KEY" ]; then
      echo "❌ Erreur: Clé API requise pour cet endpoint"
      exit 1
    fi
    curl -X POST "$BASE_URL/api/send-template" \
      -H "Content-Type: application/json" \
      -H "X-API-Key: $API_KEY" \
      -d '{
        "to": "test@example.com",
        "subject": "Bienvenue {{name}}",
        "template": "Bonjour {{name}}, votre email est {{email}} et votre numéro est {{phone}}",
        "data": {
          "name": "John Doe",
          "email": "john@example.com",
          "phone": "+33123456789"
        }
      }' | jq '.' || echo "❌ Erreur"
    ;;
  
  "contact")
    echo "2️⃣ Test de formulaire de contact (POST /api/contact)"
    if [ -z "$API_KEY" ]; then
      echo "❌ Erreur: Clé API requise pour cet endpoint"
      exit 1
    fi
    curl -X POST "$BASE_URL/api/contact" \
      -H "Content-Type: application/json" \
      -H "X-API-Key: $API_KEY" \
      -d '{
        "name": "John Doe",
        "email": "john@example.com",
        "phone": "+33123456789",
        "message": "Bonjour, je souhaite des informations sur vos services."
      }' | jq '.' || echo "❌ Erreur"
    ;;
  
  "all")
    if [ -z "$API_KEY" ]; then
      echo "❌ Erreur: Clé API requise pour les tests"
      exit 1
    fi
    echo "2️⃣ Test d'\''envoi simple"
    curl -X POST "$BASE_URL/api/send" \
      -H "Content-Type: application/json" \
      -H "X-API-Key: $API_KEY" \
      -d '{
        "to": "test@example.com",
        "subject": "Test d'\''envoi",
        "text": "Ceci est un message de test"
      }' | jq '.'
    echo ""
    echo "---"
    echo ""
    
    echo "3️⃣ Test de formulaire de contact"
    curl -X POST "$BASE_URL/api/contact" \
      -H "Content-Type: application/json" \
      -H "X-API-Key: $API_KEY" \
      -d '{
        "name": "John Doe",
        "email": "john@example.com",
        "message": "Message de test"
      }' | jq '.'
    ;;
  
  *)
    echo "Usage: $0 [send|template|contact|all] [api-key]"
    echo ""
    echo "Exemples:"
    echo "  $0 send my-api-key      - Test d'envoi simple"
    echo "  $0 template my-api-key - Test avec template"
    echo "  $0 contact my-api-key   - Test formulaire de contact"
    echo "  $0 all my-api-key       - Tous les tests"
    echo ""
    echo "Vous pouvez aussi définir la variable d'environnement API_KEY:"
    echo "  export API_KEY=my-api-key"
    echo "  $0 send"
    exit 1
    ;;
esac

echo ""
echo "✅ Test terminé"
