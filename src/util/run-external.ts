import { spawn, type ChildProcess } from 'node:child_process';

export interface ExternalResult {
  ok: boolean;
  code: number | null;
  timedOut: boolean;
  stdout: Buffer;
  stderr: string;
  /** True when the process could not be spawned at all. */
  startFailed?: boolean;
}

export interface RunExternalOptions {
  timeoutMs: number;
  cwd?: string;
  /** Merged over `process.env`. */
  env?: NodeJS.ProcessEnv;
}

const MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const MAX_STDERR_BYTES = 4096;
const IS_WINDOWS = process.platform === 'win32';

function killTree(child: ChildProcess): void {
  try {
    if (!IS_WINDOWS && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    else child.kill();
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/** Run a command without a shell. Kills it at the timeout; stdout is capped at 64 MiB and stderr at 4 KB. */
export function runExternal(command: string, args: string[], opts: RunExternalOptions): Promise<ExternalResult> {
  return new Promise((resolve) => {
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    let overflow = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (result: ExternalResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const snapshot = (): Pick<ExternalResult, 'stdout' | 'stderr'> => ({
      stdout: Buffer.concat(stdoutChunks),
      stderr: stderr.toString('utf8'),
    });

    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        shell: false,
        windowsHide: true,
        detached: !IS_WINDOWS,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      finish({ ok: false, code: null, timedOut: false, stdout: Buffer.alloc(0), stderr: String(e), startFailed: true });
      return;
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (overflow) return;
      if (stdoutBytes + chunk.length > MAX_STDOUT_BYTES) {
        overflow = true;
        killTree(child);
        return;
      }
      stdoutBytes += chunk.length;
      stdoutChunks.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_BYTES) {
        stderr = Buffer.concat([stderr, chunk]).subarray(0, MAX_STDERR_BYTES);
      }
    });
    child.on('error', (err) => {
      finish({
        ok: false,
        code: null,
        timedOut: false,
        stdout: Buffer.concat(stdoutChunks),
        stderr: err.message,
        startFailed: true,
      });
    });
    child.on('close', (code) => {
      finish({ ok: code === 0 && !timedOut && !overflow, code, timedOut, ...snapshot() });
    });

    timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      // Do not wait for 'close': a grandchild holding the pipes open could delay it indefinitely.
      finish({ ok: false, code: null, timedOut: true, ...snapshot() });
    }, opts.timeoutMs);
  });
}

/** True unless spawning fails with ENOENT or EACCES. A process that starts is killed immediately. */
export function canStart(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, [], { shell: false, windowsHide: true, stdio: 'ignore', detached: !IS_WINDOWS });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      resolve(!(code === 'ENOENT' || code === 'EACCES'));
      return;
    }
    child.once('error', (err: NodeJS.ErrnoException) => {
      resolve(!(err.code === 'ENOENT' || err.code === 'EACCES'));
    });
    child.once('spawn', () => {
      killTree(child);
      resolve(true);
    });
  });
}

/** Replace `{name}` tokens inside each argument; other text is left alone. */
export function substitute(args: string[], values: Record<string, string>): string[] {
  return args.map((arg) =>
    arg.replace(/\{(\w+)\}/g, (whole, key: string) =>
      Object.prototype.hasOwnProperty.call(values, key) ? (values[key] as string) : whole,
    ),
  );
}
