/**
 * - `any`: MOCA `UNKNOWN`, an argument that takes any scalar.
 * - `stack`: an argument that can only be passed on the MOCA stack (a result set, pointer, object
 *   or binary value), never as a `where`-clause literal.
 */
export type MocaTypeKind = 'number' | 'boolean' | 'date' | 'string' | 'any' | 'stack';

// Two vocabularies share this classifier:
// - Result columns use single-letter codes (confirmed live: S, I, O; F and D are also used).
// - `list active command arguments` reports `argtyp` as one of exactly nine words, confirmed
//   against a live server: STRING, INTEGER, FLOAT, FLAG, UNKNOWN, POINTER, RESULTS, OBJECT,
//   BINARY. There is no date argtyp. The other words below are defensive aliases.
// Unknown codes fall back to 'string'.
const STRING_TYPES = new Set(['S', 'STRING']);
const NUMBER_TYPES = new Set(['I', 'L', 'F', 'N', 'J', 'INTEGER', 'LONG', 'FLOAT', 'DOUBLE', 'NUMBER', 'NUMERIC']);
const BOOLEAN_TYPES = new Set(['O', 'FLAG', 'BOOLEAN', 'BOOL']);
const DATE_TYPES = new Set(['D', 'DATE', 'DATETIME', 'TIMESTAMP']);
const ANY_TYPES = new Set(['UNKNOWN']);
const STACK_TYPES = new Set(['POINTER', 'RESULTS', 'OBJECT', 'BINARY']);

/** Classifies a MOCA column type or argument dtype code. */
export function classifyMocaType(code: string | undefined): MocaTypeKind {
  const normalized = (code ?? '').trim().toUpperCase();
  if (STRING_TYPES.has(normalized)) return 'string';
  if (NUMBER_TYPES.has(normalized)) return 'number';
  if (BOOLEAN_TYPES.has(normalized)) return 'boolean';
  if (DATE_TYPES.has(normalized)) return 'date';
  if (ANY_TYPES.has(normalized)) return 'any';
  if (STACK_TYPES.has(normalized)) return 'stack';
  return 'string';
}
