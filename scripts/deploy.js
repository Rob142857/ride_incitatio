#!/usr/bin/env node
/**
 * deploy.js — Auto-bump BUILD_ID, then run wrangler deploy.
 *
 * Usage:  node scripts/deploy.js
 *    or:  npm run deploy
 *
 * Generates a BUILD_ID like "2026-02-15T02" (date + two-digit counter).
 * If today already has a deploy, the counter increments.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const WORKER_PATH = path.resolve(__dirname, '..', 'api', 'worker.js');

// Read current worker source
let src = fs.readFileSync(WORKER_PATH, 'utf8');

// Extract current BUILD_ID
const match = src.match(/const BUILD_ID\s*=\s*'([^']+)'/);
const oldId = match ? match[1] : '';

// Generate new BUILD_ID
const today = new Date().toISOString().slice(0, 10); // "2026-02-15"
let counter = 1;

if (oldId.startsWith(today + 'T')) {
  const prev = parseInt(oldId.split('T')[1], 10);
  if (!isNaN(prev)) counter = prev + 1;
}

const newId = `${today}T${String(counter).padStart(2, '0')}`;

// Write updated file
src = src.replace(
  /const BUILD_ID\s*=\s*'[^']*'/,
  `const BUILD_ID = '${newId}'`
);
fs.writeFileSync(WORKER_PATH, src, 'utf8');

console.log(`\n  BUILD_ID: ${oldId || '(none)'} → ${newId}\n`);

// Run wrangler deploy
try {
  execSync('npx wrangler deploy', { stdio: 'inherit', cwd: path.resolve(__dirname, '..') });
} catch (err) {
  process.exit(err.status || 1);
}
