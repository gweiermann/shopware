#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(process.argv[2] || 'test-results');
const shots = [];

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    if (entry.isFile() && /\.(png|jpe?g|webp)$/i.test(entry.name)) shots.push(full);
  }
}

walk(root);

if (shots.length === 0) {
  console.error(`No screenshots found under ${root}`);
  process.exit(1);
}

console.log('Screenshots to inspect:');
for (const shot of shots) {
  const stat = fs.statSync(shot);
  console.log(`- ${path.relative(process.cwd(), shot)} (${stat.size} bytes)`);
}

console.log('\nManual/vision gate: reject the run unless the screenshot shows the rendered target state claimed by builder-result.json.');
