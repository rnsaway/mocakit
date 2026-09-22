import type { MocaResult, MocaRow } from './types.js';

export interface MocaErrorOptions {
  status?: number;
  command?: string;
  args?: Readonly<Record<string, unknown>>;
  cause?: unknown;
}

const PASSWORD_KEY_PATTERN = /pswd|passw(?:or)?d/i;

export function redactCommand(command: string): string {
  return command.replace(
    /(\b\w*(?:pswd|passw(?:or)?d)\w*\s*=\s*)('(?:[^']|'')*'|"(?:[^"]|"")*")/gi,
    "$1'***'",
  );
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
}

export class MocaProtocolError extends MocaError {
  override readonly name = 'MocaProtocolError' as const;
  readonly rawSnippet: string;

  constructor(message: string, rawSnippet: string, options: MocaErrorOptions = {}) {
    super(message, options);
    this.rawSnippet = rawSnippet;
  }
}

export class MocaArgumentError extends MocaError {
  override readonly name = 'MocaArgumentError' as const;
  readonly argument: string | undefined;

  constructor(message: string, argument?: string, options: MocaErrorOptions = {}) {
    super(message, options);
    this.argument = argument;
  }
}

export function isMocaStatus(error: unknown, status: number): error is MocaError {
  return error instanceof MocaError && error.status === status;
}
