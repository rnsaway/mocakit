export type MocaTypeKind = 'number' | 'boolean' | 'date' | 'string';

// To be confirmed against a live server; unknown codes fall back to 'string'.
const NUMBER_TYPES = new Set(['I', 'L', 'F', 'N', 'J', 'INTEGER', 'LONG', 'FLOAT', 'DOUBLE', 'NUMBER', 'NUMERIC']);
const BOOLEAN_TYPES = new Set(['O', 'BOOLEAN', 'BOOL']);
const DATE_TYPES = new Set(['D', 'DATE', 'DATETIME', 'TIMESTAMP']);

/** Classifies a MOCA column type or argument dtype code. */
export function classifyMocaType(code: string | undefined): MocaTypeKind {
  const normalized = (code ?? '').trim().toUpperCase();
  if (NUMBER_TYPES.has(normalized)) return 'number';
  if (BOOLEAN_TYPES.has(normalized)) return 'boolean';
  if (DATE_TYPES.has(normalized)) return 'date';
  return 'string';
}
