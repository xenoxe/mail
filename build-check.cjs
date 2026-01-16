// Script de vérification pour le build
// Vérifie que dist/ existe et contient des fichiers
const fs = require('fs');
const path = require('path');

const distDir = path.join(__dirname, 'dist');

if (fs.existsSync(distDir)) {
  const files = fs.readdirSync(distDir);
  if (files.length > 0) {
    console.log('✅ Files already compiled in dist/');
    process.exit(0);
  }
}

console.error('❌ dist/ directory not found or empty');
process.exit(1);
