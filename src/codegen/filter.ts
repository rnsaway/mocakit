import type { SnapshotCommand } from './snapshot.js';

export interface CommandFilter {
  include?: string[];
  exclude?: string[];
  levels?: string[];
}

export function globToRegExp(glob: string): RegExp {
  const pattern = glob
    .split('')
    .map((char) => (char === '*' ? '.*' : char === '?' ? '.' : char.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${pattern}$`, 'i');
}

export function filterCommands(commands: SnapshotCommand[], filter: CommandFilter): SnapshotCommand[] {
  const include = (filter.include ?? ['*']).map(globToRegExp);
  const exclude = (filter.exclude ?? []).map(globToRegExp);
  const levels = filter.levels?.map((level) => level.toLowerCase());
  return commands.filter(
    (command) =>
      include.some((re) => re.test(command.name)) &&
      !exclude.some((re) => re.test(command.name)) &&
      (levels === undefined || (command.level !== undefined && levels.includes(command.level.toLowerCase()))),
  );
}
