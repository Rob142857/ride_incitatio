#!/usr/bin/env node
/**
 * Regenerate short codes and short URLs for all trips in D1.
 * Uses wrangler CLI to fetch and update rows.
 */
const { execSync } = require('child_process');
const crypto = require('crypto');

const BASE_URL = 'https://ride.incitat.io';
const DB_NAME = 'ride-db';

function run(command) {
  const out = execSync(command, { stdio: ['pipe', 'pipe', 'inherit'] }).toString();
  return out;
}

function getTrips() {
  const raw = run(`wrangler d1 execute ${DB_NAME} --json --command "SELECT id FROM trips;"`);
  const parsed = JSON.parse(raw);
  return parsed?.results || [];
}

function generateShortCode() {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const buf = crypto.randomBytes(6);
  let code = '';
  for (let i = 0; i < buf.length; i++) {
    code += chars[buf[i] % chars.length];
  }
  return code;
}

function main() {
  const trips = getTrips();
  if (!trips.length) {
    console.log('No trips found.');
    return;
  }

  const used = new Set();
  const updates = [];

  for (const row of trips) {
    let code;
    do {
      code = generateShortCode();
    } while (used.has(code));
    used.add(code);
    updates.push({ id: row.id, code });
  }

  for (const u of updates) {
    const shortUrl = `${BASE_URL}/${u.code}`;
    const sql = `UPDATE trips SET short_code='${u.code}', short_url='${shortUrl}' WHERE id='${u.id}';`;
    run(`wrangler d1 execute ${DB_NAME} --command "${sql}"`);
    console.log(`Updated ${u.id} -> ${u.code}`);
  }

  console.log(`Done. Updated ${updates.length} trips.`);
}

main();
