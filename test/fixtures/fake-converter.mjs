// Test double for a document converter. Usage: node fake-converter.mjs <mode> <input> [output]
// Modes: ok-text | ok-md | fail | noisy | empty | hang. With an output path, the text is written there instead of stdout.
import { writeFileSync } from 'node:fs';

const [, , mode = 'ok-text', input, output] = process.argv;

const emit = (text) => {
  if (output) writeFileSync(output, text);
  else process.stdout.write(text);
};

const page = (n, body) => `${body}\nACME CONFIDENTIAL   ${n}\n`;

if (mode === 'ok-text') {
  emit(
    [
      page(1, ['Gadget Guide', '', 'Contents', 'Overview ........ 3', '   Naming ........ 4', ''].join('\n')),
      page(2, ['Overview', '', 'The widget guide begins here.', ''].join('\n')),
      page(3, ['   Naming', '', 'Use short names.', ''].join('\n')),
    ].join('\f'),
  );
} else if (mode === 'ok-md') {
  emit(`# Gadget Guide\n\n## Parts\n\nInput was ${input ? 'given' : 'missing'}.\n`);
} else if (mode === 'fail') {
  process.stderr.write('boom: cannot convert\n');
  process.exit(2);
} else if (mode === 'noisy') {
  process.stderr.write(`<b>bad</b> [x](y)\t${'z'.repeat(400)}\nsecond line\n`);
  process.exit(3);
} else if (mode === 'hang') {
  setTimeout(() => {}, 60_000);
}
// 'empty' (and anything else): exit 0, write nothing.
