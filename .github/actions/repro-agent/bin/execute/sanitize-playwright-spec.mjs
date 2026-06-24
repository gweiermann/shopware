#!/usr/bin/env node
import fs from 'node:fs';

const VIDEO_HELPERS = [
  'narrate',
  'showStep',
  'showFinalStep',
  'mark',
  'markLocator',
  'stepDelay',
  'clearStep',
  'clearMarkers',
];

function findCallEnd(source, openParenIndex) {
  let depth = 0;
  let quote = '';
  let escaped = false;

  for (let index = openParenIndex; index < source.length; index += 1) {
    const char = source[index];
    const previous = source[index - 1];

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote && (quote !== '`' || previous !== '\\')) {
        quote = '';
      }
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }

    if (char === '(') depth += 1;
    if (char === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function splitArgs(args) {
  const parts = [];
  let depth = 0;
  let quote = '';
  let escaped = false;
  let start = 0;

  for (let index = 0; index < args.length; index += 1) {
    const char = args[index];
    const previous = args[index - 1];

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote && (quote !== '`' || previous !== '\\')) {
        quote = '';
      }
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') depth += 1;
    if (char === ')' || char === ']' || char === '}') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(args.slice(start, index).trim());
      start = index + 1;
    }
  }

  parts.push(args.slice(start).trim());
  return parts.filter(Boolean);
}

function transformMarkedCall(source, name, render) {
  let output = '';
  let cursor = 0;
  const pattern = new RegExp(`(^|\\n)([ \\t]*)await\\s+${name}\\s*\\(`, 'g');
  let match;

  while ((match = pattern.exec(source)) !== null) {
    const statementStart = match.index + match[1].length;
    const openParen = pattern.lastIndex - 1;
    const closeParen = findCallEnd(source, openParen);
    if (closeParen === -1) continue;

    let statementEnd = closeParen + 1;
    while (/\s/.test(source[statementEnd] ?? '')) statementEnd += 1;
    if (source[statementEnd] === ';') statementEnd += 1;

    const args = splitArgs(source.slice(openParen + 1, closeParen));
    const replacement = render(args, match[2]);
    if (!replacement) continue;

    output += source.slice(cursor, statementStart);
    output += replacement;
    cursor = statementEnd;
    pattern.lastIndex = statementEnd;
  }

  output += source.slice(cursor);
  return output;
}

function removeAwaitedHelperCalls(source) {
  let output = source;
  for (const helper of VIDEO_HELPERS) {
    output = transformMarkedCall(output, helper, () => '');
  }
  return output;
}

function removeVideoImports(source) {
  return source
    .replace(/^[ \t]*import\b(?:(?!^[ \t]*import\b)[\s\S])*?from\s+['"]\.\/repro-video\.js['"];?\n?/gm, '')
    .replace(/^[ \t]*const\s+\{[\s\S]*?\}\s*=\s*require\s*\(\s*['"]\.\/repro-video\.js['"]\s*\)\s*;?\n?/gm, '');
}

export function sanitizePlaywrightSpec(source) {
  let sanitized = String(source);

  sanitized = sanitized.replace(
    /^[ \t]*\/\*\s*REPRO_VIDEO_ONLY_START\s*\*\/[\s\S]*?^[ \t]*\/\*\s*REPRO_VIDEO_ONLY_END\s*\*\/[ \t]*\n?/gm,
    '',
  );
  sanitized = transformMarkedCall(sanitized, 'clickMarked', (args, indent) => {
    const locator = args[1];
    if (!locator) return null;
    return `${indent}await ${locator}.click();`;
  });
  sanitized = transformMarkedCall(sanitized, 'fillMarked', (args, indent) => {
    const locator = args[1];
    const value = args[2];
    if (!locator || !value) return null;
    return `${indent}await ${locator}.fill(${value});`;
  });
  sanitized = removeAwaitedHelperCalls(sanitized);
  sanitized = removeVideoImports(sanitized);

  return sanitized
    .replace(/\n{3,}/g, '\n\n')
    .trimStart();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , input, output] = process.argv;
  if (!input || !output) {
    console.error('Usage: node sanitize-playwright-spec.mjs <input> <output>');
    process.exit(2);
  }

  fs.writeFileSync(output, sanitizePlaywrightSpec(fs.readFileSync(input, 'utf8')));
}
