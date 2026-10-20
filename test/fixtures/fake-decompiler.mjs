// Test double for a Java decompiler. Usage: node fake-decompiler.mjs <input> <output>
// Mode comes from FAKE_DECOMPILER_MODE: ok | empty | fail | hang | stdout | bigout
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const mode = process.env.FAKE_DECOMPILER_MODE ?? 'ok';
const [, , input, output] = process.argv;

if (mode === 'ok') {
  const dir = join(output, 'com', 'acme', 'cust');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'Widgets.java'),
    `package com.acme.cust;\n// input: ${input ? 'given' : 'missing'}\npublic class Widgets {}\n`,
  );
} else if (mode === 'fail') {
  process.stderr.write('boom: cannot decompile\n');
  process.exit(1);
} else if (mode === 'hang') {
  setTimeout(() => {}, 60_000);
} else if (mode === 'stdout') {
  process.stdout.write(Buffer.from([1, 2, 3, 250]));
  process.stderr.write('x'.repeat(10_000));
  process.exit(3);
} else if (mode === 'bigout') {
  const chunk = Buffer.alloc(1024 * 1024, 65);
  for (let i = 0; i < 80; i++) process.stdout.write(chunk);
}
// 'empty' (and anything else): exit 0, write nothing.
