import { createHash } from 'node:crypto';
import { MocaCommandError } from '../../src/errors.js';
import { DETECT_POSIX, DETECT_WINDOWS, FILE_SEPARATOR, POSIX, WINDOWS, type OsCommands, type OsFamily } from '../../src/java/os-commands.js';
import type { OsExec } from '../../src/java/server-reader.js';
import { listZip } from '../../src/util/zip.js';

export interface FakeOsOptions {
  family: OsFamily;
  env: Record<string, string>;
  /** Files on the server, keyed by full path (posix `/a/b`, windows `C:\a\b`). */
  files: Record<string, Uint8Array>;
  /** Empty folders that exist on the server (folders holding files exist implicitly). */
  dirs?: string[];
  /** Symlinks: link path to target path; stat, hash and reads follow them. */
  links?: Record<string, string>;
  /** Extra `<size> <path>` lines appended to every listing and stat output. */
  injectLines?: string[];
  /** Whether `unzip` is installed (default true). */
  unzip?: boolean;
  /** Files whose downloaded bytes get the first byte flipped. */
  corrupt?: string[];
  /** Files that read as empty in batch and range reads, like a failed read on a real server. */
  unreadable?: string[];
  /** Every command fails with this MOCA status (the server has no `execute os command`). */
  unavailable?: number;
}

interface Handler {
  /** Loose parse of the command into arguments, or null when it is not this kind of command. */
  parse(command: string): unknown[] | null;
  /** Rebuild the command from the arguments using the real template. */
  build(args: unknown[]): string;
  run(args: unknown[]): string;
}

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');

function fail(status: number): never {
  throw new MocaCommandError(status, null);
}

function quotedAll(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
}

/**
 * A fake server that answers exactly the commands the templates in
 * `src/java/os-commands.ts` produce. A command is accepted only when it was
 * parsed loosely and rebuilding it from the parsed arguments with the real
 * template gives the identical string; anything else throws.
 */
export function fakeOs(options: FakeOsOptions): { exec: OsExec; commands: string[] } {
  const windows = options.family === 'windows';
  const sep = windows ? '\\' : '/';
  const cmds: OsCommands = windows ? WINDOWS : POSIX;
  const eol = windows ? '\r\n' : '\n';
  const all: Record<string, Uint8Array> = { ...options.files };
  for (const [link, target] of Object.entries(options.links ?? {})) all[link] = options.files[target]!;
  const paths = Object.keys(all).sort();
  const inject = (options.injectLines ?? []).map((l) => `${l}${eol}`).join('');
  const norm = (p: string): string => (windows ? p.toLowerCase() : p);
  const find = (p: string): string | undefined => paths.find((k) => norm(k) === norm(p));
  const dirExists = (d: string): boolean =>
    (options.dirs ?? []).some((x) => norm(x) === norm(d)) || paths.some((k) => norm(k).startsWith(`${norm(d)}${sep}`));
  const exists = (p: string): boolean => find(p) !== undefined || dirExists(p);
  const sizeOf = (p: string): number => (find(p) !== undefined ? all[find(p)!]!.length : 0);
  const dirname = (p: string): string => p.slice(0, p.lastIndexOf(sep));

  const readBytes = (p: string): Uint8Array | undefined => {
    const key = find(p);
    if (key === undefined || (options.unreadable ?? []).includes(key)) return undefined;
    const bytes = Uint8Array.from(all[key]!);
    if ((options.corrupt ?? []).includes(key) && bytes.length > 0) bytes[0] = bytes[0]! ^ 0xff;
    return bytes;
  };
  const need = (p: string): Uint8Array => {
    const key = find(p);
    if (key === undefined) fail(1);
    return all[key]!;
  };
  const sizeLine = (p: string): string => `${sizeOf(p)} ${p}${eol}`;

  const handlers: Handler[] = [];
  const add = (parse: Handler['parse'], build: Handler['build'], run: Handler['run']): void => {
    handlers.push({ parse, build, run });
  };

  if (windows) {
    add((c) => (c === DETECT_POSIX ? [] : null), () => DETECT_POSIX, () => fail(1));
    add((c) => (c === DETECT_WINDOWS ? [] : null), () => DETECT_WINDOWS, () => `${eol}Microsoft Windows [Version 10.0.19045.0]${eol}`);
    add(
      (c) => /^cmd \/c echo %(\w+)%$/.exec(c)?.slice(1) ?? null,
      (a) => cmds.readVar(a[0] as string),
      (a) => `${options.env[a[0] as string] ?? `%${a[0] as string}%`}${eol}`,
    );
    add(
      (c) => /^cmd \/c for %f in \("(.*)\\\*\.jar"\) do @echo %~zf %f$/.exec(c)?.slice(1) ?? null,
      (a) => cmds.listJars(a[0] as string),
      (a) =>
        paths
          .filter((k) => norm(dirname(k)) === norm(a[0] as string) && k.toLowerCase().endsWith('.jar'))
          .map(sizeLine)
          .join('') + inject,
    );
    add(
      (c) => /^cmd \/c for \/r "(.*)" %f in \(\*\.class\) do @echo %~zf %f$/.exec(c)?.slice(1) ?? null,
      (a) => cmds.listClasses(a[0] as string),
      (a) =>
        paths
          .filter((k) => norm(k).startsWith(`${norm(a[0] as string)}${sep}`) && k.endsWith('.class'))
          .map(sizeLine)
          .join('') + inject,
    );
    add(
      (c) => {
        const m = /^cmd \/c for %f in \((.*)\) do @if exist %f @echo %~zf %f$/.exec(c);
        return m ? [quotedAll(m[1]!)] : null;
      },
      (a) => cmds.statFiles(a[0] as string[]),
      (a) =>
        (a[0] as string[])
          .filter(exists)
          .map(sizeLine)
          .join('') + inject,
    );
    add(
      (c) => (c.startsWith('certutil ') ? [[...c.matchAll(/certutil -hashfile "([^"]*)" SHA256/g)].map((m) => m[1]!)] : null),
      (a) => cmds.checksums(a[0] as string[]),
      (a) =>
        (a[0] as string[])
          .map((p) => {
            const hex = sha(need(p)).replace(/(..)/g, '$1 ').trim();
            return `SHA256 hash of ${p}:${eol}${hex}${eol}CertUtil: -hashfile command completed successfully.${eol}`;
          })
          .join(''),
    );
    add(
      (c) => {
        const m = /^powershell -NoProfile -Command ".*foreach\(\$p in @\((.*?)\)\)\{/.exec(c);
        return m && c.includes('$i=0;') ? [[...m[1]!.matchAll(/'([^']*)'/g)].map((x) => x[1]!)] : null;
      },
      (a) => cmds.readFilesBase64(a[0] as string[]),
      (a) =>
        (a[0] as string[])
          .map((p, i) => {
            const bytes = readBytes(p);
            return `${FILE_SEPARATOR(i)}${eol}${bytes === undefined || bytes.length === 0 ? '' : `${b64(bytes)}${eol}`}`;
          })
          .join(''),
    );
    add(
      (c) => {
        const m = /^powershell -NoProfile -Command "\$p='([^']*)'; .*Seek\((\d+),'Begin'\); \$b=New-Object byte\[\] (\d+);/.exec(c);
        return m ? [m[1]!, Number(m[2]), Number(m[3])] : null;
      },
      (a) => cmds.readRangeBase64(a[0] as string, a[1] as number, a[2] as number),
      (a) => {
        const bytes = readBytes(a[0] as string);
        const slice = bytes === undefined ? new Uint8Array() : bytes.subarray(a[1] as number, (a[1] as number) + (a[2] as number));
        return `${b64(slice)}${eol}`;
      },
    );
    add(
      (c) => (c === 'cmd /c where unzip 2>nul' ? [] : null),
      () => cmds.hasUnzip(),
      () => (options.unzip === false ? fail(1) : `C:\\tools\\unzip.exe${eol}`),
    );
  } else {
    add((c) => (c === DETECT_POSIX ? [] : null), () => DETECT_POSIX, () => `Linux${eol}`);
    add((c) => (c === DETECT_WINDOWS ? [] : null), () => DETECT_WINDOWS, () => fail(127));
    add(
      (c) => /^printenv (\w+)$/.exec(c)?.slice(1) ?? null,
      (a) => cmds.readVar(a[0] as string),
      (a) => (options.env[a[0] as string] === undefined ? fail(1) : `${options.env[a[0] as string]!}${eol}`),
    );
    add(
      (c) => /^stat -L -c "%s %n" "(.*)"\/\*\.jar 2>\/dev\/null; true$/.exec(c)?.slice(1) ?? null,
      (a) => cmds.listJars(a[0] as string),
      (a) =>
        paths
          .filter((k) => dirname(k) === (a[0] as string) && k.endsWith('.jar'))
          .map(sizeLine)
          .join('') + inject,
    );
    add(
      (c) => /^find -L "(.*)" -type f -name "\*\.class" -printf "%s %p\\n" 2>\/dev\/null; true$/.exec(c)?.slice(1) ?? null,
      (a) => cmds.listClasses(a[0] as string),
      (a) =>
        paths
          .filter((k) => k.startsWith(`${a[0] as string}/`) && k.endsWith('.class'))
          .map(sizeLine)
          .join('') + inject,
    );
    add(
      (c) => {
        const m = /^stat -L -c "%s %n" (.*) 2>\/dev\/null; true$/.exec(c);
        return m ? [quotedAll(m[1]!)] : null;
      },
      (a) => cmds.statFiles(a[0] as string[]),
      (a) =>
        (a[0] as string[])
          .filter(exists)
          .map((p) => `${find(p) === undefined ? 4096 : sizeOf(p)} ${p}${eol}`)
          .join('') + inject,
    );
    add(
      (c) => (c.startsWith('sha256sum ') ? [quotedAll(c.slice('sha256sum '.length))] : null),
      (a) => cmds.checksums(a[0] as string[]),
      (a) =>
        (a[0] as string[])
          .map((p) => `${sha(need(p))}  ${p}${eol}`)
          .join(''),
    );
    add(
      (c) => [[...c.matchAll(/echo "==MOCAKIT-FILE (\d+)=="; base64 -w 0 "([^"]*)"; echo/g)].map((m) => m[2]!)],
      (a) => cmds.readFilesBase64(a[0] as string[]),
      (a) =>
        (a[0] as string[])
          .map((p, i) => {
            const bytes = readBytes(p);
            return `${FILE_SEPARATOR(i)}${eol}${bytes === undefined ? '' : b64(bytes)}${eol}`;
          })
          .join(''),
    );
    add(
      (c) => {
        const m = /^tail -c \+(\d+) "([^"]*)" \| head -c (\d+) \| base64 -w 0$/.exec(c);
        return m ? [m[2]!, Number(m[1]) - 1, Number(m[3])] : null;
      },
      (a) => cmds.readRangeBase64(a[0] as string, a[1] as number, a[2] as number),
      (a) => {
        const bytes = readBytes(a[0] as string);
        return bytes === undefined ? '' : b64(bytes.subarray(a[1] as number, (a[1] as number) + (a[2] as number)));
      },
    );
    add(
      (c) => (c === 'command -v unzip; true' ? [] : null),
      () => cmds.hasUnzip(),
      () => (options.unzip === false ? '' : `/usr/bin/unzip${eol}`),
    );
    add(
      (c) => /^unzip -Z1 "(.*)"$/.exec(c)?.slice(1) ?? null,
      (a) => cmds.listZip(a[0] as string),
      (a) => {
        if (options.unzip === false) fail(127);
        const bytes = all[find(a[0] as string) ?? ''];
        if (bytes === undefined) fail(9);
        return listZip(bytes).map((e) => `${e.name}${eol}`).join('');
      },
    );
  }

  const commands: string[] = [];
  const exec: OsExec = async (command) => {
    commands.push(command);
    if (options.unavailable !== undefined) fail(options.unavailable);
    for (const h of handlers) {
      const args = h.parse(command);
      if (args === null) continue;
      let rebuilt: string | undefined;
      try {
        rebuilt = h.build(args);
      } catch {
        rebuilt = undefined;
      }
      if (rebuilt === command) return h.run(args);
    }
    throw new Error(`fakeOs: not a template command: ${command}`);
  };
  return { exec, commands };
}
