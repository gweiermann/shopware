// Strip the optional video-only instrumentation from a Playwright spec before it runs, so what the
// deterministic pipeline executes is exactly the reproduction logic — no narration timing, no video
// helpers. The agent may author `clickMarked`/`fillMarked`/`narrate(...)` for a nicer recording;
// here they become plain actions or disappear.
import fs from 'node:fs';

const VIDEO_HELPERS = ['narrate', 'showStep', 'showFinalStep', 'mark', 'markLocator', 'stepDelay', 'clearStep', 'clearMarkers'];

// Index of the ) that closes the ( at openParen, respecting nested parens and strings.
function findCallEnd(source, openParen) {
  let depth = 0; let quote = ''; let escaped = false;
  for (let i = openParen; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote && (quote !== '`' || source[i - 1] !== '\\')) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth += 1;
    if (ch === ')' && (depth -= 1) === 0) return i;
  }
  return -1;
}

function splitArgs(args) {
  const parts = []; let depth = 0; let quote = ''; let escaped = false; let start = 0;
  for (let i = 0; i < args.length; i += 1) {
    const ch = args[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote && (quote !== '`' || args[i - 1] !== '\\')) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if ('([{'.includes(ch)) depth += 1;
    if (')]}'.includes(ch)) depth -= 1;
    if (ch === ',' && depth === 0) { parts.push(args.slice(start, i).trim()); start = i + 1; }
  }
  parts.push(args.slice(start).trim());
  return parts.filter(Boolean);
}

// Rewrite each `await <name>(...)` statement via render(args, indent). Returning '' deletes it.
function transformCall(source, name, render) {
  let out = ''; let cursor = 0;
  const pattern = new RegExp(`(^|\\n)([ \\t]*)await\\s+${name}\\s*\\(`, 'g');
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const statementStart = match.index + match[1].length;
    const openParen = pattern.lastIndex - 1;
    const closeParen = findCallEnd(source, openParen);
    if (closeParen === -1) continue;
    let end = closeParen + 1;
    while (/\s/.test(source[end] ?? '')) end += 1;
    if (source[end] === ';') end += 1;
    const replacement = render(splitArgs(source.slice(openParen + 1, closeParen)), match[2]);
    if (replacement === null) continue;
    out += source.slice(cursor, statementStart) + replacement;
    cursor = end;
    pattern.lastIndex = end;
  }
  return out + source.slice(cursor);
}

export function sanitizeSpec(source) {
  let spec = String(source)
    .replace(/^[ \t]*\/\*\s*REPRO_VIDEO_ONLY_START\s*\*\/[\s\S]*?^[ \t]*\/\*\s*REPRO_VIDEO_ONLY_END\s*\*\/[ \t]*\n?/gm, '');
  spec = transformCall(spec, 'clickMarked', (args, indent) => (args[1] ? `${indent}await ${args[1]}.click();` : null));
  spec = transformCall(spec, 'fillMarked', (args, indent) => (args[1] && args[2] ? `${indent}await ${args[1]}.fill(${args[2]});` : null));
  for (const helper of VIDEO_HELPERS) spec = transformCall(spec, helper, () => '');
  spec = spec
    .replace(/^[ \t]*import\b(?:(?!^[ \t]*import\b)[\s\S])*?from\s+['"]\.\/repro-video\.js['"];?\n?/gm, '')
    .replace(/^[ \t]*const\s+\{[\s\S]*?\}\s*=\s*require\s*\(\s*['"]\.\/repro-video\.js['"]\s*\)\s*;?\n?/gm, '');
  return spec.replace(/\n{3,}/g, '\n\n').trimStart();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , input, output] = process.argv;
  if (!input || !output) { console.error('usage: sanitize-spec.mjs <input> <output>'); process.exit(2); }
  fs.writeFileSync(output, sanitizeSpec(fs.readFileSync(input, 'utf8')));
}
