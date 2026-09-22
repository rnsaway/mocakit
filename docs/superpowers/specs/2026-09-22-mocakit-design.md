# mocakit — Typed TypeScript SDK for MOCA

**Date:** 2026-09-22
**Status:** Draft for review

## 1. Purpose

`mocakit` is a Node.js TypeScript SDK for MOCA servers (Blue Yonder / RedPrairie WMS). It speaks the same
`application/moca-xml` protocol as the `n8n-nodes-moca` community node (v0.2.8), and adds:

- a generator CLI (`mocakit generate`) that introspects a MOCA instance with `list active commands` and
  `list active command arguments` and emits one typed function per command;
- typed arguments (required/optional, dtype-mapped), typed errors, and a simplified row-array response format;
- session caching with single-flight login and automatic recovery from expired sessions.

### Non-goals

- Browser, edge, Bun or Deno support (Node 20.3+ only; `AbortSignal.any` is required).
- Converting MOCA names to camelCase (argument names and row keys stay exactly as MOCA reports them).
- Inferring command output shapes by executing commands.
- A `Result`-type / non-throwing API.
- Shipping any generated command code inside the published package.

## 2. Decisions summary

| Topic | Decision |
|---|---|
| Package name | `mocakit` |
| Where generated code lives | In the consuming project, via `mocakit generate`. The package ships runtime + CLI only. |
| Runtime | Node 20.3+ only; `undici` `fetch` + `Agent` for TLS-skip and timeouts |
| Argument rendering | `where` clause: `list orders where wh_id = 'WMD1' and ordqty = 5` |
| Raw MOCA | `moca.exec(mocaText, opts)` escape hatch (pipes, `[SQL]`, redirects, etc.) |
| Output typing | `MocaOutputs` registry via module augmentation, plus a per-call generic override; default `MocaRow` |
| Errors | Throw typed `MocaError` subclasses |
| Function naming | Flat camelCase: `list active commands` → `moca.listActiveCommands()` |
| Arg/column casing | Keep snake_case exactly as MOCA returns it |
| Default response | `T[]` — one plain object per row |
| Session | Process-wide in-memory cache, pluggable `SessionStore`, single-flight login, 523 recovery |

## 3. Wire protocol (ported from n8n-nodes-moca)

**Request:** `POST {url}` with headers `Content-Type: application/moca-xml`, `Accept: application/moca-xml`.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<moca-request autocommit="true">
  <environment>
    <var name="USR_ID" value="..."/>
    <var name="SESSION_KEY" value="..."/>
    <var name="WH_ID" value="..."/>
    <var name="DEVCOD" value="..."/>
    <var name="LOCALE_ID" value="..."/>
  </environment>
  <query>list orders where wh_id = 'WMD1'</query>
</moca-request>
```

Environment vars with `undefined`, `null` or `''` values are omitted. The query text is XML-escaped (`& < >`) and
attribute values are also escaped for `"`.

**Login:** `login user where usr_id = '<user>' and usr_pswd = '<password>'`, sent with `autocommit="false"` and
only `USR_ID` in the environment. On status 0, `session_key` is read from row 0 (case-insensitive column match,
falling back to column position 5), and `locale_id` from row 0 (fallback position 2).

**Response:**

```xml
<moca-response>
  <status>0</status>
  <message>...</message>
  <moca-results>
    <metadata><column name="ordnum" type="S" length="20"/>...</metadata>
    <data><row><field>A1</field><field null="true"/>...</row></data>
  </moca-results>
</moca-response>
```

- No `<status>` element, or a non-integer status → `MocaProtocolError` (the body is not a moca-response).
- Field names come from the metadata column at the same position, then the field's `name` attribute, then `field_N`.
- Duplicate column names get `_2`, `_3`, … suffixes.
- A field is NULL when it has `null`/`nil` = `true|1|yes`, or it has no text and no children.
- A field containing `<moca-results>` is parsed recursively into a nested result set.
- CDATA, comments, processing instructions and numeric/named entities are handled by a small dependency-free
  XML parser (ported from the node).

**Status codes with built-in meaning:** `0` OK, `510` no rows, `523` session expired.

## 4. Architecture

```
src/
  protocol/   xml.ts, request.ts, response.ts, convert.ts   pure; no I/O
  transport/  http.ts                                        fetch + undici Agent; returns raw text
  session/    session-manager.ts, store.ts                   login, cache, single-flight, 523 recovery
  client/     client.ts, render.ts                            MocaClient, where-clause rendering
  errors.ts, types.ts                                        shared by every layer
  codegen/    introspect.ts, snapshot.ts, names.ts, emit.ts  introspection + TS emission
  dates/      codec.ts                                       formatMocaDate, parseMocaDate, DateCodec (§8a)
  config.ts                                                  defineConfig + config loading
  cli.ts                                                     `mocakit generate`
  index.ts                                                   public exports
```

Each unit has one job and can be tested in isolation:

- **protocol**: `buildRequest(query, env, autocommit = true) → string`, `parseResponse(xml) → RawResult`
  (`{ status, message, columns, rows }` with string/null/nested values), `convertRow(columns, row)`.
- **transport**: `send(body, { url, timeoutMs, ignoreSslIssues }) → Promise<string>`. Throws `MocaTransportError`
  on network/TLS/timeout, non-2xx HTTP status, or empty body. Swappable in tests via the `Transport` interface.
- **session**: `SessionManager.run(fn)` supplies a valid session to `fn`, handling cache, login and 523 retry.
- **client**: `MocaClient` exposes `exec`, `call`, `login`, `logout`, `session`.
- **codegen**: `introspect(client) → Snapshot`, `emit(snapshot, options) → string`.

## 5. Client API

```ts
import { createMoca } from './moca.generated';

const moca = createMoca({
  url: process.env.MOCA_URL!,
  username: process.env.MOCA_USER!,
  password: process.env.MOCA_PASSWORD!,
  warehouse: 'WMD1',            // WH_ID, optional
  device: undefined,            // DEVCOD, optional
  locale: undefined,            // LOCALE_ID, optional; falls back to login locale
  ignoreSslIssues: false,
  timeoutMs: 300_000,
  session: { reuse: true, maxAgeMinutes: 30, store: undefined },
  defaults: { convert: true, noRowsIsError: false, autocommit: true },
});

const orders = await moca.listOrders({ wh_id: 'WMD1', ordnum: 'A1' });
const raw = await moca.exec("[select count(*) cnt from ord]");
```

### `MocaConfig`

| Field | Type | Default | Notes |
|---|---|---|---|
| `url` | `string` | — (required) | Full MOCA service endpoint |
| `username` | `string` | — (required) | `USR_ID` |
| `password` | `string` | — (required) | |
| `warehouse` | `string?` | — | Sent as `WH_ID` |
| `device` | `string?` | — | Sent as `DEVCOD` |
| `locale` | `string?` | login locale | Sent as `LOCALE_ID` |
| `ignoreSslIssues` | `boolean` | `false` | Uses an undici `Agent` with `rejectUnauthorized: false` |
| `timeoutMs` | `number` | `300000` | Per HTTP request |
| `session.reuse` | `boolean` | `true` | Share cached sessions across clients with the same credentials |
| `session.maxAgeMinutes` | `number` | `30` | `0` = reuse until the server rejects it |
| `session.store` | `SessionStore?` | in-memory | See §7 |
| `defaults` | `{ convert?, noRowsIsError?, autocommit? }` | see below | Client-wide call defaults. `format` is per call only, so return types stay statically known. |

### `CallOptions`

| Field | Type | Default | Notes |
|---|---|---|---|
| `format` | `'rows' \| 'full'` | `'rows'` | Return type follows via overloads |
| `convert` | `boolean` | `true` | Type-convert values from column metadata |
| `noRowsIsError` | `boolean` | `false` | Status 510 throws `MocaCommandError` instead of returning `[]` |
| `autocommit` | `boolean` | `true` | `moca-request autocommit` attribute |
| `env` | `Record<string, string>` | — | Extra/override environment vars for this call |
| `extraArgs` | `Record<string, MocaArgValue>` | — | Undeclared arguments appended to the `where` clause |
| `signal` | `AbortSignal` | — | Aborts the HTTP request |

### Methods

- `exec<T = MocaRow>(moca: string, opts?)`: sends raw MOCA text. The caller is responsible for quoting.
- `call<T>(spec, args, opts?)`: used by generated functions; validates, renders, executes.
- `login()`: forces a login now (fail fast); returns the login row.
- `logout()`: sends `logout user`, then evicts the cached session. The session is evicted even if the
  server call fails, and the error is then rethrown.
- `session`: read-only `{ active: boolean; locale: string | null; ageMs: number | null }`. The key is never exposed.

## 6. Argument rendering

For `spec = ['list orders', [['ordnum','S',0],['wh_id','S',1],['ordqty','I',0]]]` and
`args = { wh_id: 'WMD1', ordqty: 5, ordnum: undefined }`:

```
list orders where wh_id = 'WMD1' and ordqty = 5
```

Rules:

1. Arguments whose value is `undefined` or `null` are removed from the `where` clause entirely. They are never
   sent as `''`.
2. A required argument that is missing, `undefined` or `null` throws `MocaArgumentError` before any request.
   (TypeScript also catches missing required args at compile time.)
3. Strings are single-quoted, and embedded `'` becomes `''`.
4. Numbers are rendered unquoted. `NaN`/`Infinity` throws `MocaArgumentError`.
5. Booleans are rendered as `1` / `0`.
6. `Date` values are rendered as a quoted 14-digit string in the Oracle-style format `YYYYMMDDHH24MISS` (24-hour
   clock), using the local time zone: `new Date(2026, 8, 22, 14, 5, 9)` → `'20260922140509'`. An invalid `Date`
   throws `MocaArgumentError`. Formatting goes through the dates module (§8a).
7. Order: declared arguments in spec order, then `extraArgs` in insertion order.
8. A command with no args, or whose args were all removed, renders as the bare command name.
9. Argument names are validated as `/^[A-Za-z_][A-Za-z0-9_]*$/`. Anything else throws `MocaArgumentError`, which
    blocks injection through `extraArgs` keys.

## 7. Session caching

- **Cache key:** `sha256(url + '\n' + username + '\n' + password)`.
- **Default store:** a module-level `Map` shared by every client in the process. `session.reuse: false` gives a
  client a private, uncached session that lives only as long as the client.
- **`SessionStore` interface** (pluggable, e.g. file- or Redis-backed; only the in-memory store ships):

  ```ts
  interface SessionState { key: string; locale: string | null; createdAt: number }
  interface SessionStore {
    get(cacheKey: string): Promise<SessionState | undefined>;
    set(cacheKey: string, state: SessionState): Promise<void>;
    delete(cacheKey: string): Promise<void>;
  }
  ```

- **Freshness:** a cached state older than `maxAgeMinutes` is deleted and replaced before use. The check happens
  before sending, never after.
- **Single-flight:** concurrent callers that need a login share one in-flight login promise per cache key. A
  failed login is not cached, and the in-flight entry is cleared when it settles.
- **Lazy login:** the first call logs in. `moca.login()` logs in eagerly.
- **523 recovery:** on status 523 the session manager evicts the key, logs in again (single-flight), and retries
  the command exactly once. A second 523 throws `MocaAuthError`.
- **Environment:** every request sends `USR_ID`, `SESSION_KEY`, and `WH_ID`/`DEVCOD`/`LOCALE_ID` when set
  (`LOCALE_ID` falls back to the login locale). `opts.env` merges on top.

## 8. Response format

### Default: `format: 'rows'` → `Promise<T[]>`

```ts
[{ ordnum: 'A1', wh_id: 'WMD1', ordqty: 5, cancel_flg: false, adddte: '20260922101500', lines: null }]
```

- Keys are column names exactly as returned (snake_case, with duplicates suffixed `_2`, `_3`).
- With `convert: true` (the default), values are converted by the column `type`:

  | MOCA column type | JS value |
  |---|---|
  | `I`, `L`, `F`, `N`, `INTEGER`, `LONG`, `FLOAT`, `NUMBER` | `number` (non-numeric text left as string) |
  | `O`, `BOOLEAN` | `boolean` (`1`/`true` → `true`, `0`/`false` → `false`) |
  | `D`, `DATE`, `DATETIME` | `string` (unchanged MOCA date string) |
  | nested `moca-results` | `MocaRow[]` (recursively converted) |
  | anything else | `string` |
  | NULL field | `null` |

  The exact type code table is verified against a live server during implementation. Unknown codes fall back to
  string.
- `convert: false` leaves every value as `string | null` or nested rows.
- Status 510 returns `[]` unless `noRowsIsError` is set.
- `parseMocaDate(s: string): Date` is exported as a helper (§8a).

### `format: 'full'` → `Promise<MocaResult<T>>`

```ts
interface MocaColumn { name: string; type?: string; length?: number }
interface MocaResult<T> { status: number; message: string | null; columns: MocaColumn[]; rows: T[] }
```

### Value types

```ts
type MocaValue = string | number | boolean | null | MocaRow[];
type MocaRow = Record<string, MocaValue>;
type MocaArgValue = string | number | boolean | Date | null | undefined; // null/undefined → omitted
```

## 8a. Dates (v1 scope and room to grow)

v1 keeps date handling minimal, but puts it all in one place so later versions can extend it without breaking
changes.

**v1 behavior**

- All date logic lives in `src/dates/` behind two functions. Nothing else in the codebase formats or parses
  dates.
  - `formatMocaDate(d: Date): string` returns `YYYYMMDDHH24MISS` (14 digits, 24-hour clock, local time zone).
  - `parseMocaDate(s: string): Date` accepts the 14-digit form, interprets it as local time, and throws
    `RangeError` on anything else.
- Argument rendering (§6) calls `formatMocaDate`.
- Date columns in responses stay as the unchanged MOCA string.
- Neither `MocaConfig` nor `CallOptions` has date options in v1.

**Built for extension**

- Date behavior will later be configured through an optional `dates` object on both `MocaConfig` and
  `CallOptions`, with per-call settings overriding the client. v1 reserves the name `dates` and doesn't define
  it. Future fields are additive and optional, so adding them isn't a breaking change.
- Internally, rendering receives a `DateCodec` (`{ format(d: Date): string; parse(s: string): Date }`)
  instead of calling the functions directly. v1 always passes the default codec, so a future version can swap
  codecs without touching the render code. Row conversion will also receive the codec once date-column conversion
  is added; v1 conversion doesn't touch dates.
- The default response value for date columns (a string) will not change in a minor version. Returning `Date`
  objects will be opt-in (e.g. `dates: { columns: 'date' }`) until a major version.

**Candidate future enhancements** (not in v1)

- Time zone control: UTC or a named IANA zone instead of the process-local zone, which matters when the MOCA
  server's zone differs from the client's.
- Converting date columns to `Date` (or `Temporal.PlainDateTime` once Node ships Temporal), with typed output.
- Date-only values (`YYYYMMDD`) and other formats, such as partial timestamps from custom commands.
- Accepting ISO strings or `Temporal` values as date arguments.
- A custom `DateCodec` supplied by the user.

## 9. Output typing

MOCA does not declare command outputs, so outputs default to `MocaRow`. Users can register known shapes once:

```ts
// src/moca-outputs.d.ts in the consuming project
import 'mocakit';
declare module 'mocakit' {
  interface MocaOutputs {
    'list orders': { ordnum: string; wh_id: string; ordqty: number };
  }
}
```

```ts
type Output<C extends string> = C extends keyof MocaOutputs ? MocaOutputs[C] : MocaRow;
```

Every generated function is generic, `<T = Output<'list orders'>>`, so a call site can also override the type:
`moca.listOrders<MyOrder>({ ... })`. These are type-only assertions and nothing checks them at runtime.

## 10. Error handling

All command failures throw; there is no non-throwing variant.

| Class (extends `MocaError`) | Raised when | Extra fields |
|---|---|---|
| `MocaCommandError` | server status ≠ 0 (and ≠ 510 unless `noRowsIsError`) | `status`, `serverMessage`, `result` (partial `MocaResult` if any) |
| `MocaAuthError` | login returned status ≠ 0, login returned no `session_key`, or a second 523 after re-login | `status` |
| `MocaTransportError` | network/TLS/timeout/abort, HTTP non-2xx, empty body | `cause`, `httpStatus?` |
| `MocaProtocolError` | body is not parseable as a moca-response | `rawSnippet` (first 500 chars) |
| `MocaArgumentError` | missing required arg, invalid number, invalid arg name | `argument` |

`MocaError` base fields: `message`, `status` (`-1` for non-server errors), `command` (rendered MOCA text, with
the password redacted for login), `args`.

Policies:

- **No automatic retries** of commands other than the single post-523 retry, because commands can have side
  effects.
- **Credentials are never logged or put in error messages.** The login query in `command` is redacted to
  `usr_pswd = '***'`.
- Helper: `isMocaStatus(err: unknown, status: number): err is MocaError`.

## 11. Code generation

### CLI

```bash
npx mocakit generate [--config mocakit.config.ts] [--out path] [--from-snapshot path] [--dry-run]
```

```ts
// mocakit.config.ts
import { defineConfig } from 'mocakit';
export default defineConfig({
  url: process.env.MOCA_URL!,
  username: process.env.MOCA_USER!,
  password: process.env.MOCA_PASSWORD!,
  ignoreSslIssues: true,
  out: 'src/moca.generated.ts',
  snapshot: 'src/moca.commands.json',   // default: next to `out`
  include: ['*'],                        // command-name globs
  exclude: [],
  levels: undefined,                     // optional component-level allowlist
});
```

Config lookup order: `--config`, then `mocakit.config.{ts,mjs,js,json}` in cwd. The `.ts` config is loaded with
`jiti` (a dev-time dependency of the CLI only). Credentials can come from `MOCA_URL` / `MOCA_USER` /
`MOCA_PASSWORD` env vars when not in the config.

Consumers add `"moca:generate": "mocakit generate"` to their `package.json`. This repo has a `generate` script that
runs the CLI from source against a real server into `examples/moca.generated.ts`.

### Introspection

1. `list active commands` runs once, unfiltered. It captures command name, component level, command type and
   description.
2. `list active command arguments` runs once, unfiltered. It captures command, argument name, dtype, required flag
   and description. If the server rejects an unfiltered call, the generator falls back to per-command
   `list active command arguments where command = '...'` calls with concurrency 8.
3. Columns are matched case-insensitively against a candidate list per field. If a required field can't be
   matched, the generator fails with an error that lists the columns actually received. Exact column names are
   confirmed against a live server during implementation.
4. Filters (`include`, `exclude`, `levels`) are applied.
5. A `Snapshot` (`{ generatedAt, mocakitVersion, server: url, commands: [...] }`, sorted by command name, argument
   order preserved) is written to `snapshot`. `--from-snapshot` skips the server entirely, for CI and offline
   use.

### Emitted file

A single `moca.generated.ts`, deterministic for a given snapshot:

- A header comment with the mocakit version, server URL (never credentials), command count and
  `/* eslint-disable camelcase */`.
- One `export interface <Pascal>Args` per command that has arguments. Each property has JSDoc with its description
  and dtype, and required args are non-optional.
- A `const specs = { ... } as const` table: `[mocaName, [[argName, dtype, required], ...]]`.
- `export function createMoca(config: MocaConfig)`, which returns a `MocaClient` augmented with one method per
  command:

  ```ts
  /** `list orders` · level: wmd · <description> */
  listOrders<T = Output<'list orders'>>(args: ListOrdersArgs, opts?: CallOptions & { format?: 'rows' }): Promise<T[]>;
  listOrders<T = Output<'list orders'>>(args: ListOrdersArgs, opts: CallOptions & { format: 'full' }): Promise<MocaResult<T>>;
  ```

  If a command has no required args, `args` is optional.
- `export type MocaCommandName = 'list orders' | ...`.

### dtype → TS type

| dtype | TS type |
|---|---|
| string (`S`, …) | `string` |
| integer / float (`I`, `F`, …) | `number` |
| boolean (`O`, …) | `boolean` |
| date (`D`, …) | `string \| Date` |
| unknown | `string` |

All optional argument types also accept `null`, which removes the argument just like `undefined`. The exact dtype codes are confirmed against the live
server.

### Naming

- Command name → split on whitespace and non-alphanumerics → lowercase → camelCase (`list active commands` →
  `listActiveCommands`). A leading digit gets an `_` prefix.
- Reserved client member names (`exec`, `call`, `login`, `logout`, `session`, plus `Object.prototype` names) get a
  `cmd` prefix (`cmdExec`).
- Collisions after conversion get `_2`, `_3` (sorted by MOCA name), and the CLI prints a warning.
- Arg interface names are PascalCase + `Args`, with the same collision suffixes.
- Argument names are kept verbatim, and quoted in the interface if they aren't valid identifiers.

## 12. Packaging

- `package.json`: `"type": "module"`, `exports` for ESM + CJS + types, `bin: { "mocakit": "dist/cli.js" }`,
  `engines: { node: ">=20.3" }`.
- Build with `tsup`. TypeScript `strict`.
- Runtime dependencies: `undici` (for the `Agent`; same major as Node's bundled version). CLI-only dependency:
  `jiti`.
- Scripts: `build`, `test`, `typecheck`, `generate`. (No linter in v1.)

## 13. Testing

- **Vitest**, colocated `*.test.ts`.
- **Protocol:** XML fixtures for normal, empty, NULL, duplicate columns, nested results, 510, 523, error with
  message, entities/CDATA, malformed body.
- **Render:** quoting, escaping, numbers, booleans, dates, `null` and `undefined` removal (never `''`),
  `null` for a required arg, missing required arg, invalid extraArgs key.
- **Dates:** `formatMocaDate` uses the 24-hour clock (e.g. 14:05:09 → `140509`), zero-pads, rejects invalid
  `Date`s. `parseMocaDate` round-trips and rejects malformed input.
- **Session** (fake transport + fake clock): lazy login, cache sharing across clients, `reuse: false`, max-age
  expiry, single-flight under 20 concurrent calls (exactly one login), failed login not cached, 523 → one re-login
  and one retry, second 523 → `MocaAuthError`.
- **Client:** status → error mapping, `noRowsIsError`, `format: 'full'`, `convert` on/off, credential redaction.
- **Codegen:** snapshot tests from a fixture `moca.commands.json`, covering naming collisions, reserved names,
  dtype mapping and no-arg commands. The generated output is also type-checked with `tsc --noEmit` against a
  small usage file.
- **Live** (skipped unless `MOCA_URL` is set): login, `listActiveCommands()`, `generate --dry-run`, 510 behavior.

## 14. Items to confirm against a live server

These don't block the design. They are verified during implementation, and the code is written defensively
around them:

1. Column names returned by `list active commands` and `list active command arguments`.
2. Whether `list active command arguments` works unfiltered.
3. The dtype and column-type code sets (for the mapping tables in §8 and §11).

(`logout user` is confirmed to exist.)
