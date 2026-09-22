/**
 * The send dialogs default to remembering the template. Only an explicit
 * false value opts out, which also keeps older clients compatible when they
 * omit the flag entirely.
 */
export function shouldSaveEmailTemplate(value) {
  return value !== false && String(value ?? '').trim().toLowerCase() !== 'false';
}
