# mocakit

Typed TypeScript SDK for MOCA servers (Blue Yonder / RedPrairie WMS), plus a generator that turns every active
MOCA command on your instance into a typed function.

## Requirements

- Node 20.3+ at runtime.
- TypeScript ≥ 5.4 to consume the generated client (it uses `NoInfer`, added in 5.4).
- `@types/node` (or another source of DOM lib types) in your project, for the `AbortSignal` type used by
  `CallOptions.signal`.

## Install

```bash
npm install mocakit
```

## Generate a typed client

`mocakit generate` introspects a live MOCA instance (`list active commands` and `list active command arguments`)
and writes one TypeScript file with a typed method per active command, plus a JSON snapshot of everything it saw.

```ts
// mocakit.config.ts
import { defineConfig } from 'mocakit';

export default defineConfig({
  out: 'src/moca.generated.ts',
  ignoreSslIssues: true,
  // include: ['list *'], exclude: ['* debug *'], levels: ['USRint', 'wmd'],
});
```

```bash
MOCA_URL=https://moca.example.com:4700/service MOCA_USER=me MOCA_PASSWORD=secret npx mocakit generate
```

This writes `src/moca.generated.ts` and, next to it, a `src/moca.commands.json` snapshot. **Commit both files.**
The snapshot lets you regenerate without contacting the server — for example in CI, or after only changing
`include`/`exclude`/`levels`:

```bash
npx mocakit generate --from-snapshot src/moca.commands.json
```

Other flags: `--config <path>` (default: `mocakit.config.{ts,mts,mjs,js,json}` in the cwd), `--out <path>`,
`--dry-run` (introspect/report without writing).

### Config files

- **Config files are executed code**, not declarative data — a `.ts`/`.mjs`/`.js` config is loaded and its default
  export is used as-is. Don't load a config you didn't write.
- **No top-level `await`.** Config files are loaded synchronously; a config with top-level `await` fails with a
  clear error rather than an obscure one from the loader.
- The config file is **optional** if `MOCA_URL`, `MOCA_USER` and `MOCA_PASSWORD` are all set in the environment
  (or you pass `--from-snapshot`). Prefer taking the password from the environment rather than writing it into the
  config file, so it never ends up committed.
- `MOCA_IGNORE_SSL` accepts `1`, `yes` or `true` (case-insensitive) as a shorthand for `ignoreSslIssues: true`.
- Relative `out`/`snapshot` paths **in the config file** resolve against the config file's own directory (so a
  shared config works regardless of where it's invoked from). The same paths given as **CLI flags** resolve
  against the current working directory instead.
- The snapshot is always unfiltered — `include`/`exclude`/`levels` are applied only when emitting the
  `.generated.ts` file, so you can change filters and regenerate from the same snapshot without hitting the
  server again.

```ts
export default defineConfig({
  include: ['list *', 'update *'],  // command-name globs (`*`, `?`), case-insensitive; default ['*']
  exclude: ['* debug *'],
  levels: ['wmd', 'usrint'],         // component-level allowlist, case-insensitive
});
```

## Use it

```ts
import { createMoca } from './moca.generated';

const moca = createMoca({
  url: process.env.MOCA_URL!,
  username: process.env.MOCA_USER!,
  password: process.env.MOCA_PASSWORD!,
  warehouse: 'WMD1',
});

const orders = await moca.listOrders({ wh_id: 'WMD1', ordnum: 'A1' });
// → [{ ordnum: 'A1', wh_id: 'WMD1', ordqty: 5, ... }]  one object per row

const full = await moca.listOrders({ wh_id: 'WMD1' }, { format: 'full' });
// → { status, message, columns, rows }

const raw = await moca.exec("[select count(*) cnt from ord]");
```

Generated methods live as non-enumerable properties on the client's prototype, typed through `mk.Command` /
`mk.OptionalArgsCommand` rather than emitted as real class methods — this keeps type-checking cheap even with
thousands of commands.

### Argument rendering

Arguments are rendered into a MOCA `where` clause (`list orders where wh_id = 'WMD1' and ordqty = 5`):

- `null` and `undefined` arguments are **removed from the command entirely** — never sent as `''`. A missing
  required argument throws `MocaArgumentError` (and TypeScript catches it at compile time too).
- Numbers are sent unquoted. `NaN`/`Infinity`, integers beyond `Number.MAX_SAFE_INTEGER`, and values whose JS
  string form needs exponent notation (e.g. `1e21`, `1e-7`) throw `MocaArgumentError` — pass those as strings
  instead.
- Booleans are sent as `1` / `0`.
- `Date` values are sent as a quoted 14-digit string, `YYYYMMDDHH24MISS`, in the local time zone:
  `new Date(2026, 8, 22, 14, 5, 9)` → `'20260922140509'`.
- Arguments not declared on the command go through `{ extraArgs: { ... } }`.
- Argument names are matched case-insensitively, since MOCA itself is case-insensitive about them.

## Typing outputs

MOCA doesn't declare what a command returns, so rows default to `MocaRow` (`Record<string, MocaValue>`). Register
the shapes you know once, via module augmentation:

```ts
// e.g. src/moca-outputs.d.ts
declare module 'mocakit' {
  interface MocaOutputs {
    'list orders': { ordnum: string; wh_id: string; ordqty: number };
  }
}
```

The augmentation file must use the **same module format** (ESM vs. CJS) as the code that consumes it, or
TypeScript won't merge the two declarations of `MocaOutputs`.

You can also override the type at a single call site: `moca.listOrders<MyOrder>({ wh_id: 'WMD1' })`. Note that the
generic is wrapped in `NoInfer`, so it can **only be set explicitly this way** — it is never inferred from a type
annotation on the result (`const rows: MyOrder[] = await moca.listOrders(...)` still returns the registered/default
type). These are type-only assertions; nothing checks them at runtime.

## Response format

With the default `format: 'rows'`, a call resolves to `T[]`, one plain object per row, with keys exactly as MOCA
named the columns (duplicates suffixed `_2`, `_3`, ...). With `convert: true` (the default):

- Numeric column types convert to `number`, except integers beyond `Number.MAX_SAFE_INTEGER`, which stay strings
  to avoid silent precision loss.
- Boolean column types convert to `boolean`.
- Date/datetime columns are **left as the original MOCA string** — there is no automatic `Date` conversion. Use
  the exported `parseMocaDate(s: string): Date` helper when you need one.
- `convert: false` leaves every value as `string | null` (or nested rows for nested result sets).

Pass `{ format: 'full' }` to get `{ status, message, columns, rows }` instead of just the row array.

Status `510` (no rows) returns `[]` by default; pass `{ noRowsIsError: true }` to have it throw
`MocaCommandError` instead.

## Errors

Everything throws a subclass of `MocaError` (`message`, `status`, `command`, `args`):

| Error | When | Extra fields |
|---|---|---|
| `MocaCommandError` | Server status ≠ 0 (and ≠ 510 unless `noRowsIsError`) | `serverMessage`, `result` |
| `MocaAuthError` | Login failed, returned no `session_key`, or a second 523 right after re-login | — |
| `MocaTransportError` | Network, TLS, timeout, abort, non-2xx HTTP, or empty body | `cause`, `httpStatus?` |
| `MocaProtocolError` | Response body isn't parseable as `moca-response` | `rawSnippet` |
| `MocaArgumentError` | Missing/invalid required argument, bad number, invalid argument name | `argument` |

```ts
import { isMocaStatus } from 'mocakit';

try {
  await moca.validateLocation({ stoloc: 'X' });
} catch (error) {
  if (isMocaStatus(error, 10134)) { /* invalid location */ }
  else throw error;
}
```

- **Passwords are redacted** wherever an error could otherwise leak one: in `error.command` (the rendered MOCA
  text), in `error.args`, and via the error's own `toJSON()` (so `JSON.stringify(error)` is safe too).
- **No automatic retries** of commands, since they can have side effects — the one exception is a single retry
  after a 523 (session expired), which re-logs in and resends exactly once. A second 523 throws `MocaAuthError`.
- `USR_ID` and `SESSION_KEY` cannot be overridden via `opts.env` on a per-call basis — that would let a caller
  silently run as a different user or session, so it throws `MocaArgumentError` instead.

## Sessions

Sessions are logged in lazily on first use, cached in memory keyed by URL + username + password, and shared
across every `MocaClient` built with those same credentials in the process (concurrent callers needing a login
share a single in-flight request). By default a session is reused for 30 minutes
(`session: { maxAgeMinutes: 30 }`; `0` means reuse until the server itself rejects it).

```ts
createMoca({ ...connection, session: { reuse: false } });     // this client's own private session
createMoca({ ...connection, session: { maxAgeMinutes: 5 } }); // shorter reuse window
createMoca({ ...connection, session: { store: myStore } });   // e.g. Redis-backed
```

Plug in a custom `SessionStore` (`get`/`set`/`delete`) to persist sessions outside the process. Cache keys are an
**unsalted** `sha256` hash of `[url, username, password]`, so a persistent store must restrict read access to its
keys (or re-hash them with a secret) — anyone who can read a key and knows the URL/username could otherwise
brute-force a short password offline.

Call `await moca.login()` to fail fast at startup instead of on the first real request, and `await moca.logout()`
to end the session. With the default `session.reuse: true`, `logout()` ends the session for **every** client
sharing those credentials, not just the one you called it on.

Every call accepts `{ signal }` to abort the underlying HTTP request (and, if you're still waiting on a shared
login, to stop waiting on it without cancelling that login for other callers).

## Caveats

- Generated commands are installed as **properties** on the prototype, not real methods. If you subclass the
  generated `Moca` class, override one by assigning a property (`this.listOrders = ...` or a class field), not by
  declaring a same-named method — a `class` method declaration doesn't override a property the same way.
- Don't detach a command from its client (`const f = moca.listOrders; f(...)`) — it relies on `this`, which is
  lost once it's called unbound. Call it as `moca.listOrders(...)`, or bind it explicitly if you need a reference.

## License

MIT
