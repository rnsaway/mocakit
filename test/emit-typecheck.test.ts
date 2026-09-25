import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';
import { emit } from '../src/codegen/emit.js';
import type { Snapshot } from '../src/codegen/snapshot.js';

const root = new URL('../', import.meta.url);
const path = (relative: string) => fileURLToPath(new URL(relative, root));

function typecheck(file: string, strict: boolean): string[] {
  const program = ts.createProgram([path(file)], {
    strict,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    types: ['node'],
  });
  return ts.getPreEmitDiagnostics(program).map((d) => {
    const where = d.file ? `${d.file.fileName}:${d.file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1}` : '';
    return `${where} ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`;
  });
}

describe('generated code', () => {
  beforeAll(() => {
    const snapshot = JSON.parse(readFileSync(path('test/fixtures/snapshot.json'), 'utf8')) as Snapshot;
    const { code } = emit(snapshot, { version: '0.1.0', importFrom: '../../src/index.js' });
    mkdirSync(path('test/.tmp'), { recursive: true });
    writeFileSync(path('test/.tmp/moca.generated.ts'), code);
  });

  it('type-checks against the runtime, including negative cases', () => {
    expect(typecheck('test/fixtures/usage.ts', true)).toEqual([]);
  }, 60_000);

  it("keeps the batch builder's required/optional distinction in a non-strict project", () => {
    expect(typecheck('test/fixtures/batch-nonstrict.ts', false)).toEqual([]);
  }, 60_000);
});
