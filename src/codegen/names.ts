/** Public members of MocaClient plus Object.prototype names. Generated methods must not shadow them. */
export const RESERVED_MEMBERS = new Set<string>([
  'exec',
  'call',
  'login',
  'logout',
  'session',
  'constructor',
  ...Object.getOwnPropertyNames(Object.prototype),
]);

const capitalize = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

export function toMethodBase(command: string): string {
  const words = command.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.length === 0) return 'command';
  let name = (words[0] as string) + words.slice(1).map(capitalize).join('');
  if (/^[0-9]/.test(name)) name = `_${name}`;
  if (RESERVED_MEMBERS.has(name)) name = `cmd${capitalize(name)}`;
  return name;
}

/** Assigns unique method names. Later commands that collide get `_2`, `_3`, … in input order. */
export function assignMethodNames(commands: readonly string[]): { names: Map<string, string>; collisions: string[][] } {
  const names = new Map<string, string>();
  const groups = new Map<string, string[]>();
  for (const command of commands) {
    const base = toMethodBase(command);
    const group = groups.get(base) ?? [];
    group.push(command);
    groups.set(base, group);
    names.set(command, group.length === 1 ? base : `${base}_${group.length}`);
  }
  const collisions = [...groups.values()].filter((group) => group.length > 1);
  return { names, collisions };
}

export function toPascal(name: string): string {
  return capitalize(name);
}

export function isIdentifier(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}
