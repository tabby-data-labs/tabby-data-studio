/**
 * PLAN Phase 8 — i18n consistency check.
 *
 * Compares the `t('...')` call sites under `src/renderer` against the keys of the
 * English catalogue. The catalogue is read as *text* rather than imported: this
 * is a `.mjs` script and plain Node cannot import a `.ts` module.
 *
 * Usage: node scripts/check-i18n.mjs [--strict]
 *
 * A used key that the catalogue lacks is a failure. The compiler catches most of
 * those through `MessageKey`, but not all — a key assembled by concatenation, or
 * one reached through an `as` cast, typechecks and then renders as its own name.
 *
 * An unused key is a warning. The catalogue is written ahead of the components
 * that consume it, so failing on unused keys would make it impossible to grow,
 * and would fail every migration in progress. `--strict` promotes it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CATALOGUE_PATH = 'src/renderer/src/i18n/en.ts';
const SCAN_ROOT = 'src/renderer';
const SCAN_EXTENSIONS = ['.ts', '.vue'];

// Every pattern here is a literal. Nothing is ever compiled from file contents,
// so a source file holding `(` or `*+` cannot change how it is scanned.
const IDENT_CHAR = /[A-Za-z0-9_$]/;
const KEY_SHAPE = /^[A-Za-z0-9_.]+$/;
const WHITESPACE = /\s/;
const QUOTES = new Set(["'", '"', '`']);

/** Length of the comment starting at `index`, or 0 when there is none. */
function commentLength(source, index) {
  if (source.startsWith('//', index)) {
    const end = source.indexOf('\n', index);
    return (end === -1 ? source.length : end) - index;
  }
  if (source.startsWith('/*', index)) {
    const end = source.indexOf('*/', index + 2);
    return (end === -1 ? source.length : end + 2) - index;
  }
  // Vue templates comment with HTML. `<!--` is also a legacy JS line comment, so
  // skipping it in a `.ts` file costs nothing.
  if (source.startsWith('<!--', index)) {
    const end = source.indexOf('-->', index + 4);
    return (end === -1 ? source.length : end + 3) - index;
  }
  return 0;
}

/**
 * Reads the string literal whose opening quote is at `start`. Returns null when
 * the literal is unterminated, or when it is a template literal containing an
 * expression — neither is a static key.
 */
function readLiteral(source, start) {
  const quote = source[start];
  let value = '';
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === '\\') {
      value += source[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (char === quote) return { value, end: index };
    if (quote === '`' && char === '$' && source[index + 1] === '{') return null;
    value += char;
  }
  return null;
}

function skipWhitespace(source, index) {
  let at = index;
  while (at < source.length && WHITESPACE.test(source[at])) at += 1;
  return at;
}

/**
 * Reads a `t('key')` call whose `t` is at `start`, returning the key and the
 * index to resume scanning from. Resuming just past the first argument — rather
 * than past the whole call — is what lets a `t()` nested in a second argument
 * still be found.
 *
 * Returns null for anything that is not a translation call: a non-string first
 * argument, a dynamic template, an empty or non-key-shaped string, a call that
 * does not close.
 */
function readCall(source, start) {
  const open = skipWhitespace(source, start + 1);
  if (source[open] !== '(') return null;

  const quoteAt = skipWhitespace(source, open + 1);
  if (!QUOTES.has(source[quoteAt])) return null;

  const literal = readLiteral(source, quoteAt);
  if (literal === null) return null;

  const after = skipWhitespace(source, literal.end + 1);
  if (source[after] !== ')' && source[after] !== ',') return null;
  if (!KEY_SHAPE.test(literal.value)) return null;

  return { key: literal.value, end: after + 1 };
}

/**
 * The keys passed to `t()` in `source`, in call order, duplicates kept.
 *
 * Comments are skipped. String literals are not: a `.vue` template holds its
 * calls inside an HTML attribute value (`:title="t('common.close')"`), and
 * skipping strings would hide every template call site. The cost is that a `t()`
 * spelled out inside a plain string is reported too — which is the safe
 * direction, since a false positive here surfaces as a key to add, not as a
 * silently untranslated label.
 *
 * Known limitation: `tPlural('history.cleared', n)` is deliberately ignored,
 * because its first argument is a *base*, not a key. The `.one` and `.other`
 * suffixes it appends are therefore invisible to the unused-key warning.
 */
export function findUsedKeys(source) {
  const keys = [];
  let index = 0;
  while (index < source.length) {
    const comment = commentLength(source, index);
    if (comment > 0) {
      index += comment;
      continue;
    }

    if (source[index] === 't') {
      const previous = index === 0 ? '' : source[index - 1];
      // `t` must start its own identifier. This is what excludes `split(`,
      // `format(`, `$t(`, `_t(` and a `t` reached through a property (`i18n.t(`).
      const startsIdentifier = previous === '' || (!IDENT_CHAR.test(previous) && previous !== '.');
      if (startsIdentifier) {
        const call = readCall(source, index);
        if (call !== null) {
          keys.push(call.key);
          index = call.end;
          continue;
        }
      }
    }

    index += 1;
  }
  return keys;
}

/** Index of the `{` opening the `en` object literal, or null. */
function findCatalogueObjectStart(source) {
  const declaration = /(?:^|[^A-Za-z0-9_$])const\s+en\s*(?::[^=]*)?=\s*/.exec(source);
  if (declaration === null) return null;
  const brace = declaration.index + declaration[0].length;
  return source[brace] === '{' ? brace : null;
}

/**
 * The quoted keys of the `en` object literal, in file order.
 *
 * Scanned rather than regexed, because the values contain the characters a
 * regex would trip on: `{rows}` looks like a nested object and
 * `'Export failed: {reason}'` puts a colon inside a string. Tracking string and
 * comment state, plus brace depth, is what makes both harmless. Only depth-1
 * keys are reported, and the scan stops at the object's closing brace so the
 * `MessageKey` alias below it is not read as more keys.
 */
export function findCatalogueKeys(source) {
  const open = findCatalogueObjectStart(source);
  if (open === null) return [];

  const keys = [];
  let depth = 0;
  let index = open;
  while (index < source.length) {
    const comment = commentLength(source, index);
    if (comment > 0) {
      index += comment;
      continue;
    }

    const char = source[index];

    if (QUOTES.has(char)) {
      const literal = readLiteral(source, index);
      if (literal === null) break;
      if (depth === 1 && source[skipWhitespace(source, literal.end + 1)] === ':') {
        keys.push(literal.value);
      }
      index = literal.end + 1;
      continue;
    }

    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
    index += 1;
  }
  return keys;
}

/** Keys used but not catalogued, and catalogued but not used. Both sorted and deduped. */
export function diffKeys(used, catalogue) {
  const usedSet = new Set(used);
  const catalogueSet = new Set(catalogue);
  return {
    missing: [...usedSet].filter((key) => !catalogueSet.has(key)).sort(),
    unused: [...catalogueSet].filter((key) => !usedSet.has(key)).sort(),
  };
}

/** Every file under `root` whose extension is listed, with the keys it uses. */
export function scanDirectory(root, extensions) {
  const wanted = new Set(extensions);
  const found = [];
  const pending = [root];

  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
        continue;
      }
      // Symlinks are not followed: a link out of the tree would drag in files
      // this checker has no business reading.
      if (!entry.isFile() || !wanted.has(extname(entry.name))) continue;
      found.push({ file: full, keys: findUsedKeys(readFileSync(full, 'utf8')) });
    }
  }

  found.sort((a, b) => a.file.localeCompare(b.file));
  return found;
}

/** Runs the check and returns the process exit code. */
export function main(argv = process.argv.slice(2)) {
  const strict = argv.includes('--strict');
  const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

  const catalogueKeys = findCatalogueKeys(readFileSync(join(projectRoot, CATALOGUE_PATH), 'utf8'));
  const scanned = scanDirectory(join(projectRoot, SCAN_ROOT), SCAN_EXTENSIONS);
  const usedKeys = scanned.flatMap((entry) => entry.keys);
  const { missing, unused } = diffKeys(usedKeys, catalogueKeys);

  const usedIn = new Map();
  for (const entry of scanned) {
    for (const key of entry.keys) {
      const files = usedIn.get(key);
      if (files === undefined) usedIn.set(key, [entry.file]);
      else files.push(entry.file);
    }
  }
  const show = (file) => relative(projectRoot, file);

  console.log(`${CATALOGUE_PATH}: ${catalogueKeys.length} keys`);
  console.log(`${SCAN_ROOT}: ${scanned.length} files scanned, ${usedKeys.length} t() call sites`);

  if (missing.length === 0) {
    console.log('no missing keys');
  } else {
    console.error(`\nmissing from the catalogue (${missing.length}):`);
    for (const key of missing) {
      const files = (usedIn.get(key) ?? []).map(show).join(', ');
      console.error(`  ${key}  <- ${files}`);
    }
  }

  if (unused.length === 0) {
    console.log('no unused keys');
  } else {
    const suffix = strict ? '' : ' — warning only';
    console.warn(`\nunused catalogue keys (${unused.length})${suffix}:`);
    for (const key of unused) console.warn(`  ${key}`);
  }

  if (missing.length > 0) return 1;
  if (strict && unused.length > 0) return 1;
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = main();
  if (code !== 0) process.exit(code);
}
