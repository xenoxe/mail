#!/bin/bash

# Script pour migrer les articles depuis la racine du projet vers backend/articles/
# Utile lors de la transition vers une structure standalone

echo "🔄 Migration des articles vers backend/articles/..."

# Vérifier si on est dans le bon répertoire
if [ ! -f "package.json" ]; then
    echo "❌ Erreur: Exécutez ce script depuis le répertoire backend/"
    exit 1
fi

# Chemin vers les articles dans la racine du projet
ROOT_ARTICLES="../articles"
BACKEND_ARTICLES="./articles"

# Vérifier si les articles existent dans la racine
if [ ! -d "$ROOT_ARTICLES" ]; then
    echo "ℹ️  Le répertoire $ROOT_ARTICLES n'existe pas"
    echo "✅ Les articles sont déjà dans backend/articles/ ou n'existent pas encore"
    exit 0
fi

# Vérifier si backend/articles existe déjà
if [ -d "$BACKEND_ARTICLES" ]; then
    echo "⚠️  Le répertoire $BACKEND_ARTICLES existe déjà"
    read -p "Voulez-vous le remplacer ? (o/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Oo]$ ]]; then
        echo "❌ Migration annulée"
        exit 0
    fi
    rm -rf "$BACKEND_ARTICLES"
fi

# Copier les articles
echo "📦 Copie des articles depuis $ROOT_ARTICLES vers $BACKEND_ARTICLES..."
cp -r "$ROOT_ARTICLES" "$BACKEND_ARTICLES"

if [ $? -eq 0 ]; then
    echo "✅ Articles migrés avec succès vers backend/articles/"
    echo "📁 Vous pouvez maintenant supprimer $ROOT_ARTICLES si vous le souhaitez"
else
    echo "❌ Erreur lors de la migration"
    exit 1
fi
