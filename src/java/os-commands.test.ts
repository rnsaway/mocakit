import { describe, expect, it } from 'vitest';
import {
  DETECT_POSIX,
  DETECT_WINDOWS,
  FILE_SEPARATOR,
  POSIX,
  WINDOWS,
  isSafePath,
  isUsablePath,
  joinRows,
  parseChecksums,
  parseSizeLines,
  parseVarOutput,
  splitFileBatch,
  type OsCommands,
} from './os-commands.js';

const HEX = 'a'.repeat(64);

describe('isSafePath', () => {
  it('accepts ordinary posix and windows paths', () => {
    expect(isSafePath('/opt/acme/cust/lib/a-1.0.jar')).toBe(true);
    expect(isSafePath('/opt/acme/cust lib/a.jar')).toBe(true);
    expect(isSafePath('C:\\acme\\cust\\lib\\a.jar')).toBe(true);
  });
  it.each(["'", '"', '$', '`', ';', '|', '&', '\n', '>', '%'])('rejects %j', (ch) => {
    expect(isSafePath(`/opt/acme/a${ch}b.jar`)).toBe(false);
  });
  it('rejects the empty path', () => {
    expect(isSafePath('')).toBe(false);
  });
});

describe('joinRows', () => {
  it('concatenates result columns in order', () => {
    expect(joinRows([{ result: 'ab' }, { result: 'c\nd' }])).toBe('abc\nd');
  });
  it('keeps a line split across rows whole', () => {
    expect(joinRows([{ result: '12 /a/x.j' }, { result: 'ar\n7 /a/y.jar' }]).split('\n')).toEqual([
      '12 /a/x.jar',
      '7 /a/y.jar',
    ]);
  });
  it('treats a missing or null result as empty', () => {
    expect(joinRows([{ result: null }, {}, { result: 'x' }])).toBe('x');
  });
});

describe('FILE_SEPARATOR', () => {
  it('formats the separator line', () => {
    expect(FILE_SEPARATOR(3)).toBe('==MOCAKIT-FILE 3==');
  });
});

function samples(os: OsCommands): Record<string, string> {
  const w = os.family === 'windows';
  const pa = w ? 'C:\\acme\\cust lib\\a.jar' : '/opt/acme/cust lib/a.jar';
  const pb = w ? 'C:\\acme\\cust\\b.jar' : '/opt/acme/cust/b.jar';
  const dir = w ? 'C:\\acme\\cust lib' : '/opt/acme/cust lib';
  const out: Record<string, string> = {
    readVar: os.readVar('LESDIR'),
    listJars: os.listJars(dir),
    listClasses: os.listClasses(dir),
    statFiles: os.statFiles([pa, pb]),
    checksums: os.checksums([pa, pb]),
    readFilesBase64: os.readFilesBase64([pa, pb]),
    readRangeBase64: os.readRangeBase64(pa, 10, 100),
    hasUnzip: os.hasUnzip(),
  };
  if (!w) out.listZip = os.listZip(pa);
  return out;
}

const STARTS = /^(printenv|stat|find|sha256sum|echo|tail|command|unzip|cmd|certutil|powershell|uname|ver)\b/;
const FORBIDDEN = /(\btee\b|\brm\b|\bdel\b|\bmv\b|\bcp\b|Set-Content|Out-File)/;

describe.each([
  ['POSIX', POSIX],
  ['WINDOWS', WINDOWS],
])('%s read-only allow-list', (_name, os) => {
  it.each(Object.entries(samples(os)))('%s is read-only', (_m, cmd) => {
    expect(cmd).toMatch(STARTS);
    const stripped = cmd.replace(/2>\/dev\/null/g, '').replace(/2>nul/g, '');
    expect(stripped).not.toContain('>');
    expect(cmd).not.toContain('>>');
    expect(cmd).not.toMatch(FORBIDDEN);
  });
  it('wraps paths with a space in quotes', () => {
    const w = os.family === 'windows';
    const sp = w ? 'C:\\acme\\cust lib\\a.jar' : '/opt/acme/cust lib/a.jar';
    const dir = w ? 'C:\\acme\\cust lib' : '/opt/acme/cust lib';
    expect(os.listJars(dir)).toContain(`"${dir}`);
    expect(os.listClasses(dir)).toContain(`"${dir}"`);
    expect(os.statFiles([sp])).toContain(`"${sp}"`);
    expect(os.checksums([sp])).toContain(`"${sp}"`);
    if (!w) expect(os.listZip(sp)).toContain(`"${sp}"`);
    // powershell scripts use single quotes inside the double-quoted -Command
    expect(os.readFilesBase64([sp])).toContain(w ? `'${sp}'` : `"${sp}"`);
    expect(os.readRangeBase64(sp, 0, 5)).toContain(w ? `'${sp}'` : `"${sp}"`);
  });
  it('throws on an unsafe path', () => {
    const bad = "/a/b'; rm -rf /";
    expect(() => os.listJars(bad)).toThrow();
    expect(() => os.listClasses(bad)).toThrow();
    expect(() => os.statFiles([bad])).toThrow();
    expect(() => os.checksums([bad])).toThrow();
    expect(() => os.readFilesBase64([bad])).toThrow();
    expect(() => os.readRangeBase64(bad, 0, 1)).toThrow();
    expect(() => os.statFiles(['/a/ok.jar', bad])).toThrow();
  });
  it('throws on an invalid variable name', () => {
    expect(() => os.readVar('A B')).toThrow();
    expect(() => os.readVar('A%')).toThrow();
  });
  it('throws on a bad range', () => {
    expect(() => os.readRangeBase64('/a/b.jar', -1, 5)).toThrow();
    expect(() => os.readRangeBase64('/a/b.jar', 0, 0)).toThrow();
    expect(() => os.readRangeBase64('/a/b.jar', 1.5, 5)).toThrow();
  });
  it('throws on an empty path list', () => {
    expect(() => os.statFiles([])).toThrow();
    expect(() => os.checksums([])).toThrow();
    expect(() => os.readFilesBase64([])).toThrow();
  });
});

describe('POSIX templates', () => {
  it('has the exact templates', () => {
    expect(POSIX.family).toBe('posix');
    expect(POSIX.classpathSeparator).toBe(':');
    expect(POSIX.readVar('LESDIR')).toBe('printenv LESDIR');
    expect(POSIX.listJars('/a/lib')).toBe('stat -L -c "%s %n" "/a/lib"/*.jar 2>/dev/null; true');
    expect(POSIX.listClasses('/a/c')).toBe(
      'find -L "/a/c" -type f -name "*.class" -printf "%s %p\\n" 2>/dev/null; true',
    );
    expect(POSIX.statFiles(['/a/x.jar', '/a/y z.jar'])).toBe(
      'stat -L -c "%s %n" "/a/x.jar" "/a/y z.jar" 2>/dev/null; true',
    );
    expect(POSIX.checksums(['/a/x.jar', '/a/y.jar'])).toBe('sha256sum "/a/x.jar" "/a/y.jar"');
    expect(POSIX.readFilesBase64(['/a/x.jar', '/a/y.jar'])).toBe(
      'echo "==MOCAKIT-FILE 0=="; base64 -w 0 "/a/x.jar"; echo; echo "==MOCAKIT-FILE 1=="; base64 -w 0 "/a/y.jar"; echo',
    );
    expect(POSIX.readRangeBase64('/a/b.jar', 0, 1048576)).toBe(
      'tail -c +1 "/a/b.jar" | head -c 1048576 | base64 -w 0',
    );
    expect(POSIX.readRangeBase64('/a/b.jar', 9, 5)).toBe('tail -c +10 "/a/b.jar" | head -c 5 | base64 -w 0');
    expect(POSIX.hasUnzip()).toBe('command -v unzip; true');
    expect(POSIX.listZip('/a/b.jar')).toBe('unzip -Z1 "/a/b.jar"');
  });
});

describe('WINDOWS templates', () => {
  it('has the exact templates', () => {
    expect(WINDOWS.family).toBe('windows');
    expect(WINDOWS.classpathSeparator).toBe(';');
    expect(WINDOWS.readVar('LESDIR')).toBe('cmd /c echo %LESDIR%');
    expect(WINDOWS.listJars('C:\\a\\lib')).toBe('cmd /c for %f in ("C:\\a\\lib\\*.jar") do @echo %~zf %f');
    expect(WINDOWS.listClasses('C:\\a\\c')).toBe('cmd /c for /r "C:\\a\\c" %f in (*.class) do @echo %~zf %f');
    expect(WINDOWS.statFiles(['C:\\a\\x.jar', 'C:\\a\\y.jar'])).toBe(
      'cmd /c for %f in ("C:\\a\\x.jar" "C:\\a\\y.jar") do @if exist %f @echo %~zf %f',
    );
    expect(WINDOWS.checksums(['C:\\a\\x.jar', 'C:\\a\\y.jar'])).toBe(
      'certutil -hashfile "C:\\a\\x.jar" SHA256 & certutil -hashfile "C:\\a\\y.jar" SHA256',
    );
  });
  it('reads through a read-only shared handle', () => {
    const c = WINDOWS.readFilesBase64(['C:\\a\\x.jar']);
    expect(c).toMatch(/^powershell -NoProfile -Command "/);
    expect(c).toContain("[IO.File]::Open($p,'Open','Read','ReadWrite')");
    expect(c).toContain('[Convert]::ToBase64String');
    expect(c).toContain('==MOCAKIT-FILE');
    const r = WINDOWS.readRangeBase64('C:\\a\\x.jar', 4, 8);
    expect(r).toContain("'Open','Read','ReadWrite'");
    expect(r).toContain('Seek(4');
  });
  it('listZip throws', () => {
    expect(() => WINDOWS.listZip('C:\\a\\x.jar')).toThrow();
  });
  it('hasUnzip is a cmd lookup', () => {
    expect(WINDOWS.hasUnzip()).toMatch(/^cmd /);
  });
});

describe('detection commands', () => {
  it('are fixed', () => {
    expect(DETECT_POSIX).toBe('uname -s');
    expect(DETECT_WINDOWS).toBe('ver');
  });
});

describe('parseVarOutput', () => {
  it('trims posix output', () => {
    expect(parseVarOutput('posix', 'LESDIR', '/opt/acme/cust\n')).toBe('/opt/acme/cust');
    expect(parseVarOutput('posix', 'LESDIR', '')).toBe('');
  });
  it('treats the literal %NAME% as an unset windows variable', () => {
    expect(parseVarOutput('windows', 'LESDIR', '%LESDIR%\r\n')).toBe('');
    expect(parseVarOutput('windows', 'LESDIR', '')).toBe('');
    expect(parseVarOutput('windows', 'LESDIR', 'C:\\acme\\cust\r\n')).toBe('C:\\acme\\cust');
  });
});

describe('parseSizeLines', () => {
  it('parses size and path, keeping spaces in the path', () => {
    expect(parseSizeLines('12 /a/x.jar\n7 /a/y z.jar\n')).toEqual([
      { size: 12, path: '/a/x.jar' },
      { size: 7, path: '/a/y z.jar' },
    ]);
  });
  it('skips blank and malformed lines, handles CRLF and quoted paths', () => {
    expect(parseSizeLines('\r\nnoise\r\n5 "C:\\a\\x.jar"\r\n9 C:\\a\\y.jar\r\n')).toEqual([
      { size: 5, path: 'C:\\a\\x.jar' },
      { size: 9, path: 'C:\\a\\y.jar' },
    ]);
  });
});

describe('parseChecksums', () => {
  it('parses sha256sum output', () => {
    const m = parseChecksums('posix', `${HEX.toUpperCase()}  /a/x.jar\n${'b'.repeat(64)}  /a/y z.jar\n`);
    expect(m.get('/a/x.jar')).toBe(HEX);
    expect(m.get('/a/y z.jar')).toBe('b'.repeat(64));
  });
  it('parses certutil output', () => {
    const spaced = HEX.match(/.{2}/g)!.join(' ').toUpperCase();
    const text = [
      'SHA256 hash of C:\\a\\x.jar:',
      spaced,
      'CertUtil: -hashfile command completed successfully.',
      'SHA256 hash of file C:\\a\\y z.jar:',
      'b'.repeat(64),
      'CertUtil: -hashfile command completed successfully.',
    ].join('\r\n');
    const m = parseChecksums('windows', text);
    expect(m.get('C:\\a\\x.jar')).toBe(HEX);
    expect(m.get('C:\\a\\y z.jar')).toBe('b'.repeat(64));
    expect(m.size).toBe(2);
  });
});

describe('splitFileBatch', () => {
  it('splits by separator', () => {
    const m = splitFileBatch('==MOCAKIT-FILE 0==\nQUJD\n==MOCAKIT-FILE 1==\n\n');
    expect(m.get(0)).toBe('QUJD');
    expect(m.get(1)).toBe('');
    expect(m.size).toBe(2);
  });
  it('handles CRLF and a missing trailing line', () => {
    const m = splitFileBatch('==MOCAKIT-FILE 0==\r\nQUJD\r\n==MOCAKIT-FILE 1==');
    expect(m.get(0)).toBe('QUJD');
    expect(m.get(1)).toBe('');
  });
});

describe('POSIX path hardening', () => {
  const calls: Array<[string, (p: string) => string]> = [
    ['listJars', (p) => POSIX.listJars(p)],
    ['listClasses', (p) => POSIX.listClasses(p)],
    ['statFiles', (p) => POSIX.statFiles([p])],
    ['checksums', (p) => POSIX.checksums([p])],
    ['readFilesBase64', (p) => POSIX.readFilesBase64([p])],
    ['readRangeBase64', (p) => POSIX.readRangeBase64(p, 0, 1)],
    ['listZip', (p) => POSIX.listZip(p)],
  ];
  describe.each(calls)('%s', (_n, call) => {
    it.each(['/a/lib\\', '/a/b\\c.jar'])('rejects backslash path %j', (p) => {
      expect(() => call(p)).toThrow();
    });
    it.each(['-f', '-Z1.jar', 'relative/a.jar'])('rejects non-absolute path %j', (p) => {
      expect(() => call(p)).toThrow();
    });
    it('accepts an absolute path', () => {
      expect(() => call('/a/b.jar')).not.toThrow();
    });
  });
  it('WINDOWS still accepts backslash paths', () => {
    expect(() => WINDOWS.statFiles(['C:\\acme\\cust\\lib\\a.jar'])).not.toThrow();
    expect(() => WINDOWS.listJars('C:\\acme\\cust\\lib\\')).not.toThrow();
  });
});

describe('isUsablePath', () => {
  it('requires an absolute path without a backslash on posix', () => {
    expect(isUsablePath('posix', '/opt/acme/a.jar')).toBe(true);
    expect(isUsablePath('posix', 'opt/acme/a.jar')).toBe(false);
    expect(isUsablePath('posix', '/opt/acme\\a.jar')).toBe(false);
    expect(isUsablePath('posix', '/opt/acme/a$b.jar')).toBe(false);
  });
  it('accepts any safe path on windows', () => {
    expect(isUsablePath('windows', 'C:\\acme\\a.jar')).toBe(true);
    expect(isUsablePath('windows', 'C:\\acme\\a%b.jar')).toBe(false);
  });
});
