import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';
import { emit } from '../src/codegen/emit.js';
import { emitApi } from '../src/codegen/emit-api.js';
import type { ApiSnapshot } from '../src/codegen/api-snapshot.js';
import { emitSchema } from '../src/codegen/emit-schema.js';
import type { SchemaSnapshot } from '../src/codegen/schema-snapshot.js';
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
    const schema = JSON.parse(readFileSync(path('test/fixtures/schema.json'), 'utf8')) as SchemaSnapshot;
    writeFileSync(path('test/.tmp/moca.schema.ts'), emitSchema(schema, { version: '0.3.0', importFrom: '../../src/index.js' }).code);
    const client = emit(snapshot, { version: '0.3.0', importFrom: '../../src/index.js', schemaImport: './moca.schema.js' }).code;
    writeFileSync(path('test/.tmp/moca.schema-client.ts'), client);
    const apiSnapshot = JSON.parse(readFileSync(path('test/fixtures/api.json'), 'utf8')) as ApiSnapshot;
    writeFileSync(path('test/.tmp/moca.api.ts'), emitApi(apiSnapshot, { version: '0.5.0', importFrom: '../../src/index.js' }).code);
    writeFileSync(path('test/.tmp/moca.api-client.ts'), emit(snapshot, { version: '0.5.0', importFrom: '../../src/index.js', apiImport: './moca.api.js' }).code);
  });

  it('type-checks against the runtime, including negative cases', () => {
    expect(typecheck('test/fixtures/usage.ts', true)).toEqual([]);
  }, 60_000);

  it("keeps the batch builder's required/optional distinction in a non-strict project", () => {
    expect(typecheck('test/fixtures/batch-nonstrict.ts', false)).toEqual([]);
  }, 60_000);

  it('types moca.from() from the schema output, strict and non-strict', () => {
    expect(typecheck('test/fixtures/schema-usage.ts', true)).toEqual([]);
    expect(typecheck('test/fixtures/schema-usage.ts', false)).toEqual([]);
  }, 60_000);

  it('types moca.api from the API output, strict and non-strict', () => {
    expect(typecheck('test/fixtures/api-usage.ts', true)).toEqual([]);
    expect(typecheck('test/fixtures/api-usage.ts', false)).toEqual([]);
  }, 60_000);
});
