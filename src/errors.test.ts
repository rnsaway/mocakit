import { describe, expect, it } from 'vitest';
import {
  MocaArgumentError,
  MocaAuthError,
  MocaCommandError,
  MocaError,
  MocaProtocolError,
  MocaTransportError,
  isMocaStatus,
  redactCommand,
} from './errors.js';

describe('errors', () => {
  it('MocaCommandError carries status, server message and result', () => {
    const result = { status: 10134, message: 'Invalid location', columns: [], rows: [] };
    const error = new MocaCommandError(10134, 'Invalid location', { command: 'validate location', result });
    expect(error).toBeInstanceOf(MocaError);
    expect(error.name).toBe('MocaCommandError');
    expect(error.message).toBe('MOCA command failed with status 10134: Invalid location');
    expect(error.status).toBe(10134);
    expect(error.serverMessage).toBe('Invalid location');
    expect(error.command).toBe('validate location');
    expect(error.result).toBe(result);
  });

  it('defaults status to -1 for non-server errors', () => {
    expect(new MocaTransportError('down').status).toBe(-1);
    expect(new MocaArgumentError('bad', 'wh_id').argument).toBe('wh_id');
    expect(new MocaProtocolError('bad xml', '<html>').rawSnippet).toBe('<html>');
    expect(new MocaAuthError('nope', { status: 3 }).status).toBe(3);
  });

  it('keeps the cause', () => {
    const cause = new Error('ECONNREFUSED');
    expect(new MocaTransportError('down', { cause }).cause).toBe(cause);
  });

  it('isMocaStatus narrows on status', () => {
    expect(isMocaStatus(new MocaCommandError(510, null), 510)).toBe(true);
    expect(isMocaStatus(new MocaCommandError(510, null), 511)).toBe(false);
    expect(isMocaStatus(new Error('x'), 510)).toBe(false);
  });

  it('redactCommand hides passwords, including embedded quotes', () => {
    expect(redactCommand(`login user where usr_id = 'A' and usr_pswd = 'p''w'`)).toBe(
      `login user where usr_id = 'A' and usr_pswd = '***'`,
    );
  });
});
