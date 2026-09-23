import type { MocaResult, MocaRow } from './types.js';

export interface MocaErrorOptions {
  status?: number;
  command?: string;
  args?: Readonly<Record<string, unknown>>;
  cause?: unknown;
}

/** Argument/column names treated as secrets: anything containing `pswd`, `pwd`, `passwd` or
 * `password`, case-insensitively. */
const PASSWORD_KEY_PATTERN = /pswd|pwd|passw(?:or)?d/i;

/** `<key> = <value>`, where `<key>` matches `PASSWORD_KEY_PATTERN` and `<value>` is a single- or
 * double-quoted MOCA string or an unquoted token (a number, `@var`, a bare word). */
const PASSWORD_ASSIGNMENT = /(\b\w*(?:pswd|pwd|passw(?:or)?d)\w*\s*=\s*)('(?:[^']|'')*'|"(?:[^"]|"")*"|[^\s'"]+)/gi;

/** Replaces the value of every password-like `key = value` in MOCA text with `'***'`. */
export function redactCommand(command: string): string {
  return command.replace(PASSWORD_ASSIGNMENT, "$1'***'");
}

export function redactArgs(args: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const redacted: Record<string, unknown> = { ...args };
  for (const key of Object.keys(redacted)) {
    if (PASSWORD_KEY_PATTERN.test(key)) {
      redacted[key] = '***';
    }
  }
  return redacted;
}

export class MocaError extends Error {
  override readonly name: string = 'MocaError';
  /** MOCA status code, or -1 for errors that did not come from the server. */
  status: number;
  #command: string | undefined;
  #args: Readonly<Record<string, unknown>> | undefined;

  constructor(message: string, options: MocaErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.status = options.status ?? -1;
    this.command = options.command;
    this.args = options.args;
  }

  /** The MOCA text that was (or would have been) sent. Passwords are redacted. */
  get command(): string | undefined {
    return this.#command;
  }

  set command(value: string | undefined) {
    this.#command = value === undefined ? undefined : redactCommand(value);
  }

  get args(): Readonly<Record<string, unknown>> | undefined {
    return this.#args;
  }

  set args(value: Readonly<Record<string, unknown>> | undefined) {
    this.#args = value === undefined ? undefined : redactArgs(value);
  }

  /**
   * `JSON.stringify` (and anything else that calls `toJSON`) otherwise sees none of this
   * error's own state: `message` is a non-enumerable own property on `Error`, and `command`/
   * `args` are accessors defined on the prototype, which are non-enumerable by default. That
   * made past "the password never appears in JSON.stringify" tests pass for the wrong reason
   * (the fields were entirely absent, not safely redacted). This makes them present, through
   * the redacting getters, so serialization is actually exercised.
   */
  toJSON(): { name: string; message: string; status: number; command: string | undefined; args: Readonly<Record<string, unknown>> | undefined } {
    return { name: this.name, message: this.message, status: this.status, command: this.command, args: this.args };
  }
}

export class MocaCommandError extends MocaError {
  override readonly name = 'MocaCommandError' as const;
  readonly serverMessage: string | null;
  readonly result: MocaResult<MocaRow> | undefined;

  constructor(
    status: number,
    serverMessage: string | null,
    options: Omit<MocaErrorOptions, 'status'> & { result?: MocaResult<MocaRow> } = {},
  ) {
    const { result, ...rest } = options;
    super(`MOCA command failed with status ${status}${serverMessage ? `: ${serverMessage}` : ''}`, {
      ...rest,
      status,
    });
    this.serverMessage = serverMessage;
    this.result = result;
  }

  override toJSON(): ReturnType<MocaError['toJSON']> & { serverMessage: string | null } {
    return { ...super.toJSON(), serverMessage: this.serverMessage };
  }
}

export class MocaAuthError extends MocaError {
  override readonly name = 'MocaAuthError' as const;
}

export class MocaTransportError extends MocaError {
  override readonly name = 'MocaTransportError' as const;
  readonly httpStatus: number | undefined;

  constructor(message: string, options: MocaErrorOptions & { httpStatus?: number } = {}) {
    super(message, options);
    this.httpStatus = options.httpStatus;
  }

  override toJSON(): ReturnType<MocaError['toJSON']> & { httpStatus: number | undefined } {
    return { ...super.toJSON(), httpStatus: this.httpStatus };
  }
}

export class MocaProtocolError extends MocaError {
  override readonly name = 'MocaProtocolError' as const;
  readonly rawSnippet: string;

  constructor(message: string, rawSnippet: string, options: MocaErrorOptions = {}) {
    super(message, options);
    this.rawSnippet = rawSnippet;
  }

  override toJSON(): ReturnType<MocaError['toJSON']> & { rawSnippet: string } {
    return { ...super.toJSON(), rawSnippet: this.rawSnippet };
  }
}

export class MocaArgumentError extends MocaError {
  override readonly name = 'MocaArgumentError' as const;
  readonly argument: string | undefined;

  constructor(message: string, argument?: string, options: MocaErrorOptions = {}) {
    super(message, options);
    this.argument = argument;
  }

  override toJSON(): ReturnType<MocaError['toJSON']> & { argument: string | undefined } {
    return { ...super.toJSON(), argument: this.argument };
  }
}

export function isMocaStatus(error: unknown, status: number): error is MocaError {
  return error instanceof MocaError && error.status === status;
}
