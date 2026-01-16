#!/usr/bin/env node

/**
 * Script pour générer une clé API sécurisée
 * Usage: node scripts/generate-api-key.js
 */

import crypto from "crypto";

// Générer une clé API de 64 caractères (32 bytes en hex)
const apiKey = crypto.randomBytes(32).toString("hex");

console.log("🔑 Clé API générée:");
console.log("");
console.log(apiKey);
console.log("");
console.log("📝 Ajoutez cette clé dans votre fichier .env:");
console.log(`API_KEYS=${apiKey}`);
console.log("");
console.log("💡 Vous pouvez ajouter plusieurs clés en les séparant par des virgules:");
console.log(`API_KEYS=${apiKey},autre-cle-1,autre-cle-2`);
console.log("");
console.log("⚠️  Gardez cette clé secrète et ne la partagez jamais publiquement!");
