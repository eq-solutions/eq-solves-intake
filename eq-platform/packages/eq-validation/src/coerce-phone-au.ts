/**
 * @eq/validation — AU phone coercer
 *
 * Converts AU phone numbers to E.164 (+614xxxxxxxx for mobile, +612xxxxxxxx etc for landlines).
 * International numbers (already +) are kept verbatim if the digit count is plausible.
 * Unparseable numbers are kept raw with a note (we don't reject — the phone field is
 * almost always non-critical for import-time validation).
 *
 * Strips before processing:
 * - Whitespace
 * - Brackets ()
 * - Hyphens, dots, slashes
 * - Leading "ph:", "tel:", "mob:" prefixes
 *
 * Recognised AU patterns:
 * - 04xxxxxxxx (10 digits) → +614xxxxxxxx (mobile)
 * - 614xxxxxxxx (11 digits, no +) → +614xxxxxxxx
 * - 0Nxxxxxxxx where N in [2,3,7,8] (10 digits) → +61Nxxxxxxxx (landline)
 * - 1300xxxxxx, 1800xxxxxx, 13xxxx → kept as-is (no E.164 form for these)
 *
 * Recognised international:
 * - +<country><number> → kept verbatim if 8-15 digits total
 *
 * Anything else: ok with note 'phone_format_unrecognised_kept_raw'.
 */

import { CoerceOptions, CoerceResult, ok, err } from './types';

const STRIP_CHARS = /[\s().\-/]/g;
const PREFIX_STRIP = /^(ph|tel|mob|mobile|phone|cell):\s*/i;

export function coercePhoneAU(
  value: unknown,
  opts: Partial<CoerceOptions> = {}
): CoerceResult<string> {
  // Null / undefined / empty — pass through (phones are almost always optional)
  if (value === null || value === undefined) {
    if (opts.strict) {
      return err('value_null_or_empty', 'Empty phone in strict mode.');
    }
    return ok('', true, 'empty cell');
  }

  if (typeof value !== 'string' && typeof value !== 'number') {
    return err('phone_unrecognised', `Cannot coerce ${typeof value} to phone.`);
  }

  let raw = String(value).trim();
  if (raw === '') {
    if (opts.strict) return err('value_null_or_empty', 'Empty phone.');
    return ok('', true);
  }

  // Strip prefix labels
  raw = raw.replace(PREFIX_STRIP, '');

  // Capture original for fallback
  const original = raw;

  // Strip formatting chars
  let stripped = raw.replace(STRIP_CHARS, '');

  // Already E.164?
  if (stripped.startsWith('+')) {
    const digits = stripped.slice(1);
    if (/^\d{8,15}$/.test(digits)) {
      return ok(stripped, stripped !== original.replace(STRIP_CHARS, ''));
    }
    return ok(original, false, 'phone_format_unrecognised_kept_raw');
  }

  // 614... → +614...
  if (/^614\d{8}$/.test(stripped)) {
    return ok(`+${stripped}`, true);
  }

  // 04xxxxxxxx → +614xxxxxxxx (AU mobile)
  if (/^04\d{8}$/.test(stripped)) {
    return ok(`+61${stripped.slice(1)}`, true);
  }

  // 0[2378]xxxxxxxx → +61[2378]xxxxxxxx (AU landline)
  if (/^0[2378]\d{8}$/.test(stripped)) {
    return ok(`+61${stripped.slice(1)}`, true);
  }

  // 13xxxx, 1300xxxxxx, 1800xxxxxx — AU service numbers, keep as-is
  if (/^(13\d{4}|1[38]00\d{6})$/.test(stripped)) {
    return ok(stripped, stripped !== original);
  }

  // Plausible international without + (8-15 digits)
  if (/^\d{8,15}$/.test(stripped)) {
    return ok(original, false, 'phone_format_unrecognised_kept_raw');
  }

  // Anything else — preserve raw
  return ok(original, false, 'phone_format_unrecognised_kept_raw');
}
