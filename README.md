# mocakit

Typed TypeScript SDK for MOCA servers (Blue Yonder / RedPrairie WMS), plus a generator that turns every active
MOCA command on your instance into a typed function.

## Requirements

- Node 20.12+ (the first release with `util.parseEnv`, which the CLI uses to load `.env` files).
- TypeScript ≥ 5.4 to consume the generated client (it uses `NoInfer`, added in 5.4).
- `@types/node` (or another source of DOM lib types) in your project, for the `AbortSignal` type used by
  `CallOptions.signal`.

## Install

```bash
npm install mocakit
```

Or install straight from git (any branch, tag or commit). The package's `prepare` script builds `dist/` during the
install, so no prebuilt files need to be committed:

```bash
npm install "git+https://<git-host>/<owner>/mocakit.git#<branch-or-tag>"
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

### Recommended setup

Don't put the password on the command line, where it can end up in shell history or a process list. Keep the
credentials in a `.env` file next to your `package.json`:

```dotenv
# .env  -- add this file to .gitignore; never commit it
MOCA_URL=https://moca.example.com/service
MOCA_USER=jdoe
MOCA_PASSWORD=change-me
MOCA_IGNORE_SSL=1
```

```bash
echo .env >> .gitignore
```

and add two scripts to your `package.json`:

```json
{
  "scripts": {
    "moca": "mocakit",
    "moca:generate": "mocakit generate"
  }
}
```

Then run either of:

```bash
npm run moca:generate
npm run moca -- generate --dry-run   # any flags after --
```

`npm run moca generate` (without `--`) is **not** valid: npm treats `generate` as its own argument, not the
script's. Use `npm run moca -- generate` or `npm run moca:generate`.

**How `.env` is loaded.** `mocakit generate` loads `./.env` from the current directory automatically if it exists
(and carries on silently if it doesn't), printing `Loaded N variables from <path>`. Values are never printed;
`--verbose` adds the variable names. Other options:

- `--env-file <path>` loads a different file instead (resolved against the cwd); it's an error if the file can't be
  read.
- `--no-env-file` turns the automatic `.env` loading off.
- Variables already set in your real environment win over the file, as with `node --env-file`, so a CI job's
  secrets take precedence over a stray `.env`.
- A `mocakit.config.ts` that reads `process.env.MOCA_URL` (etc.) sees the `.env` values too: the CLI exposes the
  file's variables on `process.env` while it runs (only those not already set), and removes them afterwards.

This writes `src/moca.generated.ts` and, next to it, a `src/moca.commands.json` snapshot. **Commit both files.**
The snapshot lets you regenerate without contacting the server — for example in CI, or after only changing
`include`/`exclude`/`levels`:

```bash
npx mocakit generate --from-snapshot src/moca.commands.json
```

If the server's commands haven't changed since the last run, the existing snapshot is left byte-for-byte untouched
(no `generatedAt` churn). The final `Wrote N commands` line counts the commands actually emitted, and anything the
generator had to skip or adjust is printed to stderr as a `warning: …` line (see [Method names](#method-names)).
At most 50 warnings are printed, followed by `... and N more warnings (use --verbose to see all)`; pass `--verbose`
to print every one.

Other flags: `--config <path>` (default: `mocakit.config.{ts,mts,mjs,js,json}` in the cwd), `--out <path>`,
`--env-file <path>` / `--no-env-file` (see above), `--dry-run` (introspect/report without writing), `--verbose`
(print every warning, and the names of loaded env variables). Run `mocakit generate --help` for the full list.

### Config files

- **Config files are executed code**, not declarative data — a `.ts`/`.mjs`/`.js` config is loaded and its default
  export is used as-is. Don't load a config you didn't write.
- **No top-level `await`.** Config files, and any modules they import, are loaded synchronously; a config with
  top-level `await` fails with a clear error rather than an obscure one from the loader.
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

### Keeping it small

Generating everything is rarely what you want. A full instance can have around 10,000 active commands, which comes
to roughly 6.7 MB of generated TypeScript, and type-checking that file alone takes `tsc` about 3.5 s and 1.1 GB of
memory. Generate only the commands your project calls, using `include`, `exclude` and `levels` in
`mocakit.config.ts`:

```ts
// mocakit.config.ts
import { defineConfig } from 'mocakit';

export default defineConfig({
  out: 'src/moca.generated.ts',
  include: ['list order*', 'list shipment*', 'list inventory*', 'create order*', 'change order*'],
  exclude: ['* debug *', '* test *'],
  levels: ['usrint', 'wmd'],   // only your own and the WMD component levels
});
```

Because the snapshot is always unfiltered, you can widen or narrow the filters later and rerun
`npx mocakit generate --from-snapshot src/moca.commands.json` without contacting the server. Commands you didn't
generate are still callable via `exec()`.

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

### Method names

Method names come from the MOCA command name, split on whitespace/punctuation and camelCased: `list orders` →
`listOrders`. A name that would collide with a client member (`exec`, `call`, `login`, `logout`, `session`,
`constructor`, `then`, or any `Object.prototype` name such as `toString`) gets a `cmd` prefix instead (e.g. a command
literally named `login` becomes `cmdLogin`). Two commands that camelCase to the same name get `_2`, `_3`, …
suffixes, and `mocakit generate` prints a warning when that happens. Argument interfaces are named after the method
(`listOrders` → `ListOrdersArgs`, `listOrders_2` → `ListOrders_2Args`); commands without arguments use `mk.NoArgs`.

The generator also warns and adjusts, rather than emitting code that can't work:

- Commands that differ only in case/whitespace are emitted once (the lowest-sorting name wins).
- A command name containing anything other than letters, digits, `_`, space, `.` and `-` is skipped (a snapshot
  containing one is rejected).
- An optional argument whose name isn't a valid MOCA argument name (`[A-Za-z_][A-Za-z0-9_]*`, checked after
  removing a leading `@`) is dropped; a command with such a *required* argument is skipped entirely, since it could
  never be called.
- A command with a *required* stack-only argument (see [Argument types](#argument-types)) is skipped with
  `Command "x" requires stack argument "y" (RESULTS); skipped (run it with exec())`.

If you run a generated file against a *newer* mocakit that has added a client member with the same name as one of
your commands, that command isn't installed (the client member wins) and a process warning tells you to regenerate.

### Argument types

Each argument's MOCA type (`argtyp`) decides its TypeScript type:

| MOCA type | TypeScript type |
|---|---|
| `STRING` | `string` |
| `INTEGER`, `FLOAT` | `number` |
| `FLAG` | `boolean` (sent as `1` / `0`) |
| `UNKNOWN` | `string \| number \| boolean \| Date` (each rendered by its runtime type) |
| `POINTER`, `RESULTS`, `OBJECT`, `BINARY` | not settable (stack-only, see below) |

Optional arguments also accept `null`. MOCA has no date argument type. Pass a `Date` to an `UNKNOWN` argument
when you want the 14-digit date format.

Argument names the server writes as `@name` (meaning "`name`, read from the stack") are exposed as plain `name`,
and rendered that way in the `where` clause.

**Stack-only arguments.** `POINTER`, `RESULTS`, `OBJECT` and `BINARY` arguments carry values that only exist on
the MOCA stack (a result set from an earlier command, for example), so they can't be written as `where`-clause
literals. An optional one is left off the argument interface, and the method's doc comment lists it:
`Stack-only arguments not settable here: result_set (RESULTS)`. A command that *requires* one isn't generated
at all. Run it with `exec()` inside a MOCA pipeline instead:

```ts
await moca.exec("list orders where wh_id = 'WMD1' | process order results");
```

**Pass-through commands.** A command whose server definition includes a wildcard argument (`@*`, `*`, or `x.*`)
forwards whatever arguments it's given to the commands it calls. Its doc comment says
`Accepts additional arguments (wildcard: \@*): pass them via opts.extraArgs.`, naming the wildcard the server
listed. Pass those extra arguments through `extraArgs`:

```ts
await moca.processOrders({ wh_id: 'WMD1' }, { extraArgs: { ordnum: 'A1', client_id: 'C1' } });
```

### Client config

Besides `url`/`username`/`password`, `createMoca`/`MocaConfig` also accepts:

| Field | Default | Notes |
|---|---|---|
| `warehouse` | — | Sent as `WH_ID` |
| `device` | — | Sent as `DEVCOD` |
| `locale` | login locale | Sent as `LOCALE_ID` |
| `ignoreSslIssues` | `false` | Skip TLS verification |
| `timeoutMs` | `300000` | Per HTTP request (must be > 0 and at most 2147483647) |
| `session` | see [Sessions](#sessions) | `{ reuse?, maxAgeMinutes?, store? }` |
| `defaults` | — | Client-wide call defaults: `{ convert?, noRowsIsError?, autocommit? }` |

`createMoca(config, deps?)` also takes an optional second argument, `{ transport?, now? }`, mainly for tests. A custom
`transport` receives every request body verbatim — including the **password** (in the `login user` request) and
the live **`SESSION_KEY`** (in every other request) — so only plug in code you trust, and never log its bodies.

### Argument rendering

Arguments are rendered into a MOCA `where` clause (`list orders where wh_id = 'WMD1' and ordqty = 5`):

- `null` and `undefined` arguments are **removed from the command entirely** — never sent as `''`. A missing
  required argument throws `MocaArgumentError` (and TypeScript catches it at compile time too).
- Strings are single-quoted, with an embedded `'` doubled (`it's` → `'it''s'`).
- Numbers are sent unquoted. `NaN`/`Infinity`, integers beyond `Number.MAX_SAFE_INTEGER`, and values whose JS
  string form needs exponent notation (e.g. `1e21`, `1e-7`) throw `MocaArgumentError` — pass those as strings
  instead.
- Booleans are sent as `1` / `0`.
- `Date` values are sent as a quoted 14-digit string, `YYYYMMDDHH24MISS`, in the local time zone:
  `new Date(2026, 8, 22, 14, 5, 9)` → `'20260922140509'`. An invalid `Date` (e.g. `new Date('nope')`) throws
  `MocaArgumentError`.
- Arguments not declared on the command go through `{ extraArgs: { ... } }` (generated methods and `call` only —
  `exec` throws `MocaArgumentError` if given a non-empty `extraArgs`, rather than silently dropping a filter from
  raw MOCA text; put the arguments in the text itself).
- **Argument names must use the declared spelling.** A different casing of a declared name throws
  `MocaArgumentError` naming the correct spelling, and a case-insensitive duplicate within `extraArgs` also
  throws — MOCA's own case-insensitivity is used to catch these mistakes, not to accept them silently.

### Call options

Every call (`exec`, `call`, and every generated method) accepts:

| Field | Default | Notes |
|---|---|---|
| `format` | `'rows'` | `'rows'` → `T[]`; `'full'` → `{ status, message, columns, rows }` |
| `convert` | `true` | Type-convert values from column metadata |
| `noRowsIsError` | `false` | Status 510 throws instead of returning `[]` |
| `autocommit` | `true` | The `moca-request autocommit` attribute |
| `env` | — | Extra/override environment vars for this call only (can't override `USR_ID`/`SESSION_KEY`) |
| `extraArgs` | — | Undeclared arguments, appended to the `where` clause (not supported by `exec`) |
| `signal` | — | Aborts the HTTP request |

## Typing outputs

MOCA doesn't declare what a command returns, so rows default to `MocaRow` (`Record<string, MocaValue>`). Register
the shapes you know once, via module augmentation:

```ts
// e.g. src/moca-outputs.d.ts
import 'mocakit';

declare module 'mocakit' {
  interface MocaOutputs {
    'list orders': { ordnum: string; wh_id: string; ordqty: number };
  }
}
```

The `import 'mocakit'` is required: without any import, this file has no top-level `import`/`export` and
TypeScript treats it as an ambient script rather than a module, so its `declare module 'mocakit'` **replaces**
the package's own types instead of adding to them. The file must also use the **same module format** (ESM vs.
CJS) as the code that consumes it, or TypeScript won't merge the two declarations of `MocaOutputs`.

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
| `MocaCommandError` | Server status ≠ 0 (and ≠ 510 unless `noRowsIsError`), including a failed `logout user` | `serverMessage`, `result` |
| `MocaAuthError` | Login failed, returned no `session_key`, or a second 523 right after re-login | — |
| `MocaTransportError` | Invalid service URL, credentials embedded in the URL, network, TLS, timeout, abort, redirect, non-2xx HTTP, or empty body | `cause`, `httpStatus?` |
| `MocaProtocolError` | Response body isn't parseable as `moca-response` | `rawSnippet` |
| `MocaArgumentError` | Missing required argument, unknown/mis-cased argument, invalid argument name, unrenderable number/`Date`/value, `USR_ID`/`SESSION_KEY` in `opts.env`, a character XML 1.0 forbids in the query or environment, `extraArgs` on `exec`, or an invalid client config (blank credentials, bad `timeoutMs`/`maxAgeMinutes`, `session.store` with `reuse: false`) | `argument` |

```ts
import { isMocaStatus } from 'mocakit';

try {
  await moca.validateLocation({ stoloc: 'X' });
} catch (error) {
  if (isMocaStatus(error, 10134)) { /* invalid location */ }
  else throw error;
}
```

- **Values are redacted** in `error.command` (the rendered MOCA text), `error.args`, and the error's own
  `toJSON()` (so `JSON.stringify(error)` is safe too), on every error — but only for arguments whose *name*
  contains `pswd`, `pwd`, `passwd` or `password` (case-insensitive), whether the value is quoted or a bare token.
  That covers the login command and any command with a similarly named argument. This is not a general secret
  scanner: a secret passed under a differently named argument is not redacted.
- **No automatic retries** of commands, since they can have side effects — the one exception is a single retry
  after a 523 (session expired), which re-logs in and resends exactly once. A second 523 throws `MocaAuthError`.
- `USR_ID` and `SESSION_KEY` cannot be overridden via `opts.env` on a per-call basis — that would let a caller
  silently run as a different user or session, so it throws `MocaArgumentError` instead.

## Sessions

Sessions are logged in lazily on first use, cached in memory keyed by URL + username + password, and shared
across every `MocaClient` built with those same credentials in the process (concurrent callers needing a login
share a single in-flight request). By default a session is reused for 30 minutes
(`session: { maxAgeMinutes: 30 }`; `0` or any negative value means reuse until the server itself rejects it).

```ts
createMoca({ ...connection, session: { reuse: false } });     // this client's own private session
createMoca({ ...connection, session: { maxAgeMinutes: 5 } }); // shorter reuse window
createMoca({ ...connection, session: { store: myStore } });   // e.g. Redis-backed
```

Plug in a custom `SessionStore` (`get`/`set`/`delete`) to persist sessions outside the process. Its **values are
live session keys** — anyone who can read one can act as that user until the session expires — so protect the store
like a credential. A `store` can't be combined with `reuse: false` (that throws `MocaArgumentError`). Cache keys are an
**unsalted** `sha256` hash of `[url, username, password]`, so a persistent store must restrict read access to its
keys (or re-hash them with a secret) — anyone who can read a key and knows the URL/username could otherwise
brute-force a short password offline.

Call `await moca.login()` to fail fast at startup instead of on the first real request (it resolves to the login
row, with the session key removed), and `await moca.logout()` to end the session. `logout()` evicts the cached session even if the server-side logout call itself fails (the
error is still rethrown after the eviction). With the default `session.reuse: true`, `logout()` ends the session
for **every** client sharing those credentials, not just the one you called it on.

Every call accepts `{ signal }` to abort the underlying HTTP request (and, if you're still waiting on a shared
login, to stop waiting on it without cancelling that login for other callers).

## Caveats

- Generated commands are typed through shared callable interfaces (`mk.Command<Args, CommandName>` /
  `mk.OptionalArgsCommand<Args, CommandName>`) and installed as **properties** on the prototype, not as real
  class methods — this keeps type-checking cheap even with thousands of commands. One consequence: if you
  subclass the generated `Moca` class, you can't override a command with a `class` method declaration.
  TypeScript rejects it with error TS2425 ("Class 'Moca' defines instance member property 'listOrders', but
  extended class '…' defines it as instance member function."), because a property can't be overridden by a
  method. Override it as a property instead:

  ```ts
  class MyMoca extends Moca {
    // The cast is needed because `listOrders`'s overloaded call signature can't be written directly
    // as an arrow function's type; `Moca['listOrders']` is where the real, checked signature lives.
    override listOrders = ((args, opts) => super.listOrders(args, opts as any)) as Moca['listOrders'];
  }
  ```

- Don't detach a command from its client (`const f = moca.listOrders; f(...)`) — it relies on `this`, which is
  lost once it's called unbound. Call it as `moca.listOrders(...)`, or bind it explicitly if you need a reference.

## License

MIT
