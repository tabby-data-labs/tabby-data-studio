/**
 * The i18n mechanism (PLAN Phase 8): a catalogue lookup plus `{name}`
 * interpolation, with no runtime framework behind it. The active locale is a
 * module-level value with an accessor because nothing in the renderer needs to
 * react to a locale change yet — when something does, this is the seam to
 * replace with a store, and callers of `t()` will not change.
 */
import { en } from './en';
import type { MessageKey } from './en';

export type { MessageKey };

export type Locale = 'en';

export const SUPPORTED_LOCALES: readonly Locale[] = ['en'];

export const DEFAULT_LOCALE: Locale = 'en';

/** Message parameters. Values are data, never a source of further placeholders. */
type Params = Readonly<Record<string, string | number>>;

// Static pattern, never built from message text. A name is letters, digits, `_`
// and `.`; anything else — `{}`, `{a-b}`, `{ a }`, a lone `{` — is literal text.
const PLACEHOLDER = /\{([A-Za-z0-9_.]+)\}/g;

// tPlural's key only exists once its suffix is appended, so it cannot be typed
// as a MessageKey and has to be looked up by string. Built from the same
// `as const` object as t()'s direct indexing, so the two cannot drift.
const CATALOGUE_BY_KEY: ReadonlyMap<string, string> = new Map(Object.entries(en));

let activeLocale: Locale = DEFAULT_LOCALE;

/** The active locale. */
export function currentLocale(): Locale {
  return activeLocale;
}

/** Refuses an unsupported locale rather than accepting it and rendering nothing. */
export function setLocale(locale: Locale): void {
  if (!SUPPORTED_LOCALES.includes(locale)) return;
  activeLocale = locale;
}

/**
 * Substitutes `{name}` from `params` into `value`, in a single pass.
 *
 * Single pass matters because param values come from user data: a filename or a
 * query can contain braces, and re-scanning the output would let one param
 * inject another. The replacer is a *function*, so a value holding `$&`, `$'` or
 * `$1` is inserted literally instead of being read as a replacement pattern.
 */
export function interpolate(value: string, params?: Params): string {
  if (params === undefined) return value;
  return value.replace(PLACEHOLDER, (match, name: string) => {
    const replacement = params[name];
    // A param that is absent stays visible: `{file}` reads as a missing
    // translation argument, where an empty string reads as a broken sentence.
    // Present-but-empty is a caller decision and is honoured below.
    if (replacement === undefined) return match;
    // Numbered in the active locale so grouping is deterministic across machines
    // rather than inherited from whatever LANG the process happened to start with.
    return typeof replacement === 'number' ? replacement.toLocaleString(activeLocale) : replacement;
  });
}

/**
 * Looks up `key` and interpolates its placeholders.
 *
 * There is deliberately no unknown-key branch: `MessageKey` is a union of string
 * literals derived from `as const`, so the compiler has already rejected any key
 * the catalogue does not contain, and a runtime fallback would be unreachable.
 */
export function t(key: MessageKey, params?: Params): string {
  return interpolate(en[key], params);
}

/**
 * Picks between the `.one` and `.other` forms of a pluralised key, where `base`
 * is the key without its suffix — `'history.cleared'`, not
 * `'history.cleared.one'`. English selects `.one` for exactly 1 and `.other` for
 * everything else, including 0.
 *
 * A base with no plural forms cannot be caught at compile time, so it is
 * reported visibly rather than rendered as an empty string.
 */
export function tPlural(base: string, count: number, params?: Params): string {
  const key = `${base}.${count === 1 ? 'one' : 'other'}`;
  const value = CATALOGUE_BY_KEY.get(key);
  if (value === undefined) return key;
  return interpolate(value, params);
}
