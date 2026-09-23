/** A MOCA argument name: what `renderCommand` accepts and what the generator emits. */
export const MOCA_ARG_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isMocaArgName(name: string): boolean {
  return MOCA_ARG_NAME.test(name);
}

/** Removes a leading UTF-8 byte-order mark, which some Windows editors write into JSON files. */
export function stripBom(text: string): string {
  return text.startsWith('\uFEFF') ? text.slice(1) : text;
}
