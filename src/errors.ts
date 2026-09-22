import type { MocaResult, MocaRow } from './types.js';

export interface MocaErrorOptions {
  status?: number;
  command?: string;
  args?: Readonly<Record<string, unknown>>;
  cause?: unknown;
}

export class MocaError extends Error {
  /** MOCA status code, or -1 for errors that did not come from the server. */
  status: number;
  /** The MOCA text that was (or would have been) sent. Passwords are redacted. */
  command: string | undefined;
  args: Readonly<Record<string, unknown>> | undefined;

  constructor(message: string, options: MocaErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.status = options.status ?? -1;
    this.command = options.command;
    this.args = options.args;
  }
}

export class MocaCommandError extends MocaError {
  readonly serverMessage: string | null;
  readonly result: MocaResult<MocaRow> | undefined;

  constructor(
    status: number,
    serverMessage: string | null,
    options: Omit<MocaErrorOptions, 'status'> & { result?: MocaResult<MocaRow> } = {},
  ) {
    super(`MOCA command failed with status ${status}${serverMessage ? `: ${serverMessage}` : ''}`, {
      ...options,
      status,
    });
    this.serverMessage = serverMessage;
    this.result = options.result;
  }
}

export class MocaAuthError extends MocaError {}

export class MocaTransportError extends MocaError {
  readonly httpStatus: number | undefined;

  constructor(message: string, options: MocaErrorOptions & { httpStatus?: number } = {}) {
    super(message, options);
    this.httpStatus = options.httpStatus;
  }
}

export class MocaProtocolError extends MocaError {
  readonly rawSnippet: string;

  constructor(message: string, rawSnippet: string, options: MocaErrorOptions = {}) {
    super(message, options);
    this.rawSnippet = rawSnippet;
  }
}

export class MocaArgumentError extends MocaError {
  readonly argument: string | undefined;

  constructor(message: string, argument?: string, options: MocaErrorOptions = {}) {
    super(message, options);
    this.argument = argument;
  }
}

export function isMocaStatus(error: unknown, status: number): error is MocaError {
  return error instanceof MocaError && error.status === status;
}

export function redactCommand(command: string): string {
  return command.replace(/(usr_pswd\s*=\s*)'(?:[^']|'')*'/gi, "$1'***'");
}
