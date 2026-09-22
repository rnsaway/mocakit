import { describe, expect, it } from 'vitest';
import {
  MocaArgumentError,
  MocaAuthError,
  MocaCommandError,
  MocaError,
  MocaProtocolError,
  MocaTransportError,
  isMocaStatus,
  redactArgs,
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

  it('redactCommand is case-insensitive and matches without spaces around =', () => {
    expect(redactCommand(`login user where USR_PSWD = 'A'`)).toBe(`login user where USR_PSWD = '***'`);
    expect(redactCommand(`login user where usr_pswd='x'`)).toBe(`login user where usr_pswd='***'`);
  });

  it('redactCommand handles double-quoted values', () => {
    expect(redactCommand(`login user where usr_pswd = "p""w"`)).toBe(`login user where usr_pswd = '***'`);
  });

  it('redactCommand matches keys containing pswd/password as a substring', () => {
    expect(redactCommand(`update x set old_pswd = 'a'`)).toBe(`update x set old_pswd = '***'`);
    expect(redactCommand(`update x set password = 'a'`)).toBe(`update x set password = '***'`);
  });

  it('redactCommand redacts two occurrences in one command', () => {
    expect(redactCommand(`x usr_pswd = 'a' and old_password = 'b'`)).toBe(
      `x usr_pswd = '***' and old_password = '***'`,
    );
  });

  it('redactCommand is a no-op when there is nothing to redact', () => {
    expect(redactCommand(`list orders where ordnum = 'A'`)).toBe(`list orders where ordnum = 'A'`);
  });

  it('redactArgs replaces password-like keys with ***', () => {
    expect(redactArgs({ usr_pswd: 's', wh_id: 'W' })).toEqual({ usr_pswd: '***', wh_id: 'W' });
  });

  it('centralises redaction on MocaError.command and .args', () => {
    const err = new MocaError('x', { command: "login user where usr_pswd = 'a'" });
    expect(err.command).toBe("login user where usr_pswd = '***'");

    err.args = { usr_pswd: 's', wh_id: 'W' };
    expect(err.args).toEqual({ usr_pswd: '***', wh_id: 'W' });

    expect(JSON.stringify(err)).not.toContain('"s"');
    expect(JSON.stringify(err)).not.toContain("'a'");
  });

  it('supports ??= compound assignment on command and args', () => {
    const err = new MocaError('x');
    err.command ??= "login user where usr_pswd = 'a'";
    err.args ??= { usr_pswd: 's' };
    expect(err.command).toBe("login user where usr_pswd = '***'");
    expect(err.args).toEqual({ usr_pswd: '***' });
  });

  it('each subclass has a fixed name and is instanceof MocaError', () => {
    expect(new MocaError('x').name).toBe('MocaError');
    expect(new MocaCommandError(1, null).name).toBe('MocaCommandError');
    expect(new MocaAuthError('x').name).toBe('MocaAuthError');
    expect(new MocaTransportError('x').name).toBe('MocaTransportError');
    expect(new MocaProtocolError('x', '<a>').name).toBe('MocaProtocolError');
    expect(new MocaArgumentError('x').name).toBe('MocaArgumentError');

    expect(new MocaCommandError(1, null)).toBeInstanceOf(MocaError);
    expect(new MocaAuthError('x')).toBeInstanceOf(MocaError);
    expect(new MocaTransportError('x')).toBeInstanceOf(MocaError);
    expect(new MocaProtocolError('x', '<a>')).toBeInstanceOf(MocaError);
    expect(new MocaArgumentError('x')).toBeInstanceOf(MocaError);
  });
});
