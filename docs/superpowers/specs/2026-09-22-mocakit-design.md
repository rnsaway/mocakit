# mocakit — Typed TypeScript SDK for MOCA

**Date:** 2026-09-22
**Status:** Implemented (pending live-server confirmation)

## 1. Purpose

`mocakit` is a Node.js TypeScript SDK for MOCA servers (Blue Yonder / RedPrairie WMS). It speaks the same
`application/moca-xml` protocol as the `n8n-nodes-moca` community node (v0.2.8), and adds:

- a generator CLI (`mocakit generate`) that introspects a MOCA instance with `list active commands` and
  `list active command arguments` and emits one typed function per command;
- typed arguments (required/optional, dtype-mapped), typed errors, and a simplified row-array response format;
- session caching with single-flight login and automatic recovery from expired sessions.

### Non-goals

- Browser, edge, Bun or Deno support. Node ≥ 20.6 only (the first release with `--env-file`, which the README's
  generate workflow uses).
- Converting MOCA names to camelCase (argument names and row keys stay exactly as MOCA reports them).
- Inferring command output shapes by executing commands.
- A `Result`-type / non-throwing API.
- Shipping any generated command code inside the published package.

## 2. Decisions summary

| Topic | Decision |
|---|---|
| Package name | `mocakit` |
| Where generated code lives | In the consuming project, via `mocakit generate`. The package ships runtime + CLI only. |
| Runtime | Node ≥ 20.6 only; `undici` `fetch` + `Agent` for TLS-skip and timeouts |
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
  protocol/   xml.ts, request.ts, response.ts, convert.ts,   pure; no I/O
              moca-types.ts
  transport/  http.ts                                        fetch + undici Agent; returns raw text
  session/    session-manager.ts, store.ts                   cache, freshness, single-flight login
  client/     client.ts, render.ts, commands.ts              MocaClient (incl. 523 recovery), where-clause
                                                             rendering, Command types + defineCommands
  codegen/    introspect.ts, snapshot.ts, filter.ts,         introspection, snapshot I/O, include/exclude/
              names.ts, emit.ts                              levels filters, naming, TS emission
  dates/      codec.ts                                       formatMocaDate, parseMocaDate, DateCodec (§8a)
  util/       url.ts, text.ts                                redactUrl; BOM stripping, arg-name rule
  cli/        main.ts, generate.ts, load-config.ts           argv parsing, `generate`, config loading
  cli.ts                                                     bin entry (`mocakit`)
  define-config.ts                                           defineConfig + MocakitConfig
  errors.ts, types.ts, version.ts                            shared by every layer
  index.ts                                                   public exports
```

Each unit has one job and can be tested in isolation:

- **protocol**: `buildRequest(query, env, autocommit = true) → string`, `parseResponse(xml) → RawResponse`
  (`{ status, message, columns, rows }` with string/null/nested values), `toRows(set, convert) → MocaRow[]`,
  `classifyMocaType(code)`.
- **transport**: `type Transport = (request: TransportRequest) => Promise<string>`, where `TransportRequest` is
  `{ url, body, timeoutMs, ignoreSslIssues, signal? }`. `httpTransport` throws `MocaTransportError` on an invalid
  URL, credentials in the URL, network/TLS/timeout/abort, a redirect, a non-2xx HTTP status, or an empty body.
  Swappable via `MocaClientDeps.transport`. A custom transport receives request bodies containing the password (at
  login) and the live `SESSION_KEY` (every other request).
- **session**: `SessionManager` exposes `acquire()` (fresh session from memory, the store, or a single-flight
  login), `peek()` (cached fresh session or `null`, never logs in), `adopt(state)` (store an explicitly obtained
  session) and `invalidate(stale)` (compare-then-delete). 523 handling lives in `MocaClient`, not here.
- **client**: `MocaClient` exposes `exec`, `call`, `login`, `logout`, `session`. `defineCommands(proto, specs)`
  installs generated methods.
- **codegen**: `introspect(client, options) → Promise<{ snapshot, warnings }>`,
  `emit(snapshot, options) → { code, warnings, count }`, `filterCommands(commands, filter)`,
  `readSnapshot`/`writeSnapshot`.
- **cli**: `runCli(argv, io?, cwd?) → exit code`, `runGenerate(options)`, `loadConfig`, `resolveConnection`.

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
| `timeoutMs` | `number` | `300000` | Per HTTP request; must be > 0 and ≤ 2147483647 |
| `session.reuse` | `boolean` | `true` | Share cached sessions across clients with the same credentials |
| `session.maxAgeMinutes` | `number` | `30` | `0` or negative = reuse until the server rejects it; must be finite |
| `session.store` | `SessionStore?` | in-memory | See §7. Combining it with `reuse: false` throws `MocaArgumentError` |
| `defaults` | `{ convert?, noRowsIsError?, autocommit? }` | see below | Client-wide call defaults. `format` is per call only, so return types stay statically known. |

### `CallOptions`

| Field | Type | Default | Notes |
|---|---|---|---|
| `format` | `'rows' \| 'full'` | `'rows'` | Return type follows via overloads |
| `convert` | `boolean` | `true` | Type-convert values from column metadata |
| `noRowsIsError` | `boolean` | `false` | Status 510 throws `MocaCommandError` instead of returning `[]` |
| `autocommit` | `boolean` | `true` | `moca-request autocommit` attribute |
| `env` | `Record<string, string>` | — | Extra/override environment vars for this call |
| `extraArgs` | `Record<string, MocaArgValue>` | — | Undeclared arguments appended to the `where` clause (`call` and generated methods only; `exec` rejects it) |
| `signal` | `AbortSignal` | — | Aborts the HTTP request |

### Methods

- `exec<T = MocaRow>(moca: string, opts?)`: sends raw MOCA text. The caller is responsible for quoting. A
  non-empty `opts.extraArgs` throws `MocaArgumentError` (`extraArgs is not supported by exec(); …`) rather than
  being silently dropped from a command that may have side effects.
- `call<T>(spec, args, opts?)`: used by generated functions; validates, renders, executes.
- `login()`: forces its own login now (fail fast, bypassing single-flight) and stores the new session; returns the
  login row converted per `defaults.convert`, with the session key removed: any `session_key` column
  (case-insensitive) and any column whose raw value equals the key (e.g. when it was found by the position-5 fallback).
- `logout()`: sends `logout user`, then evicts the cached session. The session is evicted even if the
  server call fails, and the error is then rethrown. It acts only on an already-cached session (not an in-flight
  login), and with `reuse: true` it ends the session for every client sharing those credentials.
- `session`: read-only `{ active: boolean; locale: string | null; ageMs: number | null }`. The key is never exposed.

The constructor throws `MocaArgumentError` for a blank (or non-string) `url`/`username`/`password`, a non-finite
`maxAgeMinutes`, an out-of-range `timeoutMs`, or `session.store` combined with `session.reuse: false`.
`createMoca(config, deps?)` / `new MocaClient(config, deps?)` take optional `MocaClientDeps` (`{ transport?, now? }`).

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
4. Numbers are rendered unquoted. `NaN`/`Infinity`, integers beyond `Number.MAX_SAFE_INTEGER`, and values whose
   JS string form needs exponent notation (e.g. `1e21`, `1e-7`) throw `MocaArgumentError`; pass those as strings.
5. Booleans are rendered as `1` / `0`.
6. `Date` values are rendered as a quoted 14-digit string in the Oracle-style format `YYYYMMDDHH24MISS` (24-hour
   clock), using the local time zone: `new Date(2026, 8, 22, 14, 5, 9)` → `'20260922140509'`. An invalid `Date`
   throws `MocaArgumentError`. Formatting goes through the dates module (§8a).
7. Order: declared arguments in spec order, then `extraArgs` in insertion order.
8. A command with no args, or whose args were all removed, renders as the bare command name.
9. Duplicate and unknown argument names are detected case-insensitively (MOCA names are case-insensitive).
10. Argument names are validated as `/^[A-Za-z_][A-Za-z0-9_]*$/`. Anything else throws `MocaArgumentError`, which
    blocks injection through `extraArgs` keys.

## 7. Session caching

- **Cache key:** `sha256(JSON.stringify([url, username, password]))`. It is unsalted, so persistent stores must
  protect their keys.
- **Default store:** a module-level store shared by every client in the process. `session.reuse: false` gives a
  client a private, uncached session that lives only as long as the client; it cannot be combined with
  `session.store` (`MocaArgumentError`).
- **`SessionStore` interface** (pluggable, e.g. file- or Redis-backed; only the in-memory store ships). A
  persistent store holds live session keys as its values, so it must protect them like credentials:

  ```ts
  interface SessionState { key: string; locale: string | null; createdAt: number }
  interface SessionStore {
    get(cacheKey: string): Promise<SessionState | undefined>;
    set(cacheKey: string, state: SessionState): Promise<void>;
    delete(cacheKey: string): Promise<void>;
  }
  ```

- **Freshness:** a cached state older than `maxAgeMinutes` is not used; the client logs in again. The stale entry
  is not deleted (the read may already be out of date, and deleting could destroy a newer session another client
  stored); the next successful login overwrites it. The check happens before sending, never after.
  `maxAgeMinutes <= 0` (zero or negative) disables age-based expiry: a session is reused until the server rejects it.
- **Single-flight:** concurrent callers that need a login share one in-flight login promise per store and cache
  key, across every `SessionManager` using that store (so across clients too). Just before logging in, the
  single-flight re-checks the store, in case another process sharing it has already stored a fresh session. A
  failed login is not cached, and the in-flight entry is cleared when it settles. Whichever client starts the
  login runs it with its own settings (transport, timeout).
- **Abort while waiting:** a caller whose `signal` aborts while it waits for a shared login rejects promptly with
  `MocaTransportError`, but the shared login itself is not cancelled. An already-aborted signal never starts a
  login.
- **Lazy login:** the first call logs in. `moca.login()` logs in eagerly (always its own request).
- **523 recovery (in `MocaClient`):** on status 523 the client invalidates that session (compare-then-delete, so a
  newer session stored by another client survives), checks the caller's `signal`, acquires a fresh session
  (single-flight) and retries the command exactly once. A second 523 invalidates again and throws `MocaAuthError`.
- **Environment:** every request sends `USR_ID`, `SESSION_KEY`, and `WH_ID`/`DEVCOD`/`LOCALE_ID` when set
  (`LOCALE_ID` falls back to the login locale). `opts.env` merges on top, except that `USR_ID` and `SESSION_KEY`
  cannot be overridden (case-insensitive; `MocaArgumentError`).

## 8. Response format

### Default: `format: 'rows'` → `Promise<T[]>`

```ts
[{ ordnum: 'A1', wh_id: 'WMD1', ordqty: 5, cancel_flg: false, adddte: '20260922101500', lines: null }]
```

- Keys are column names exactly as returned (snake_case, with duplicates suffixed `_2`, `_3`).
- With `convert: true` (the default), values are converted by the column `type`:

  | MOCA column type | JS value |
  |---|---|
  | `I`, `L`, `F`, `N`, `J`, `INTEGER`, `LONG`, `FLOAT`, `DOUBLE`, `NUMBER`, `NUMERIC` | `number` when the text is a finite decimal (optional sign and exponent); integers beyond `Number.MAX_SAFE_INTEGER` and other text stay strings |
  | `O`, `BOOLEAN`, `BOOL` | `boolean` (`1`/`true` → `true`, `0`/`false` → `false`, case-insensitive, trimmed); other text stays a string |
  | `D`, `DATE`, `DATETIME`, `TIMESTAMP` | `string` (unchanged MOCA date string) |
  | nested `moca-results` | `MocaRow[]` (recursively converted) |
  | anything else | `string` |
  | NULL field | `null` |

  Codes are matched case-insensitively after trimming. The same classification drives the dtype → TS mapping in
  §11. The table is still to be confirmed against a live server (§14); unknown codes fall back to string.
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
  - `formatMocaDate(d: Date): string` returns `YYYYMMDDHH24MISS` (14 digits, 24-hour clock, local time zone); years outside 0–9999 throw `RangeError`.
  - `parseMocaDate(s: string): Date` accepts exactly the 14-digit form (no trimming), interprets it as local time, and
    throws `RangeError` on anything else, including times that fall in a DST gap in the local time zone.
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
- A custom `DateCodec` supplied by the user. (`DateCodec` and the default codec are internal in v1 and not exported;
  only `formatMocaDate` and `parseMocaDate` are public.)

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

Every generated method is generic through `mk.Command`/`mk.OptionalArgsCommand` (`<T = Output<'list orders'>>`,
wrapped in `NoInfer`), so a call site can also override the type explicitly: `moca.listOrders<MyOrder>({ ... })`.
These are type-only assertions and nothing checks them at runtime.

## 10. Error handling

All command failures throw; there is no non-throwing variant.

| Class (extends `MocaError`) | Raised when | Extra fields |
|---|---|---|
| `MocaCommandError` | server status ≠ 0 (and ≠ 510 unless `noRowsIsError`); also a failed `logout user` (other than 523) | `status`, `serverMessage`, `result` (partial `MocaResult` if any) |
| `MocaAuthError` | login returned status ≠ 0, login returned no `session_key`, or a second 523 right after re-login | `status` |
| `MocaTransportError` | invalid service URL, credentials embedded in the URL, network/TLS/timeout/abort, redirect, HTTP non-2xx, empty body | `cause`, `httpStatus?` |
| `MocaProtocolError` | body is not parseable as a moca-response | `rawSnippet` (first 500 chars) |
| `MocaArgumentError` | missing/`null` required arg; unknown arg or wrong casing of a declared one; duplicate `extraArgs` key; invalid arg name; unrenderable number, invalid `Date` or unsupported value type; `USR_ID`/`SESSION_KEY` env override; a character not allowed in XML 1.0 in the query or environment; invalid `MocaConfig` (blank credentials, bad `timeoutMs`/`maxAgeMinutes`, `store` with `reuse: false`); `extraArgs` passed to `exec` | `argument` |

`MocaError` base fields: `message`, `status` (`-1` for non-server errors), `command` (the MOCA text that was, or
would have been, sent), `args`, and `toJSON()` (so `JSON.stringify(error)` includes those fields).

Policies:

- **No automatic retries** of commands other than the single post-523 retry, because commands can have side
  effects.
- **Credentials are never logged or put in error messages.** Redaction is applied by the `command`/`args` setters
  (and therefore `toJSON()`) to every error, not only login errors. In `command`, the value of any `key = value`
  whose key contains `pswd`, `pwd`, `passwd` or `password` (case-insensitive) becomes `'***'`, whether the value is
  single-quoted, double-quoted or an unquoted token; in `args`, any such key's value becomes `'***'`. This is a
  name-based rule, not a secret scanner. Transport errors carry only the redacted URL (no credentials, query or
  hash), and an unparseable URL is never echoed.
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

Config lookup order: `--config`, then `mocakit.config.{ts,mts,mjs,js,json}` in cwd. JS/TS configs are executed
(loaded with `jiti`, a CLI-only dependency, with its disk cache disabled so secrets in a config never land in the OS
temp directory). A config must export a plain object. Credentials can come from `MOCA_URL` / `MOCA_USER` /
`MOCA_PASSWORD` (and `MOCA_IGNORE_SSL=1|yes|true`) env vars when not in the config; if all three are set, or
`--from-snapshot` is used, the config file is optional. Relative `out`/`snapshot` paths in a config file resolve
against the config file's directory; CLI flags resolve against the cwd. JSON config errors never echo file content.

Consumers add `"moca:generate": "node --env-file=.env node_modules/mocakit/dist/cli.js generate"` (or similar) to
their `package.json`. This repo has a `generate` script (`tsx --env-file=.env src/cli.ts generate`) that runs the CLI
from source against a real server into `examples/moca.generated.ts`, per the repo's `mocakit.config.ts`.

The CLI prints warnings (introspection skips, emit de-duplication/drops/skips, name collisions) to stderr as
`warning: …`, and finishes with `Wrote N commands to <out>` (or `Would write …` with `--dry-run`), where `N` is the
number of commands actually emitted, after filtering, de-duplication and skips.

### Introspection

1. `list active commands` runs once, unfiltered. It captures command name, component level, command type and
   description.
   Names are trimmed and internal whitespace collapsed; commands are de-duplicated case- and
   whitespace-insensitively (first row wins). A name that doesn't match `/^[A-Za-z0-9_][A-Za-z0-9_ .\-]*$/` after
   trimming is skipped with a warning (returned in `warnings`), so it is never queried or emitted. No commands at all
   is an error.
2. `list active command arguments` runs once, unfiltered. It captures command, argument name, dtype, required flag
   (`1`/`y`/`yes`/`t`/`true`) and description. If the unfiltered call fails with a `MocaCommandError` **or returns
   zero rows**, the generator first probes with a single `list active command arguments where command = '...'` for
   the first command; if that also fails it throws one error describing both failures. Otherwise it fans out
   per-command calls (concurrency 8 by default, `IntrospectOptions.concurrency`), aborting the rest on the first
   failure. Any other error from the unfiltered call propagates unchanged.
3. Columns are matched case-insensitively against a candidate list per field. If a required field can't be
   matched, the generator fails with an error that lists the columns actually received; two fields resolving to the
   same column is also an error. The candidate lists are still to be confirmed against a live server (§14).
4. The full, unfiltered `Snapshot` (`{ mocakitVersion, generatedAt, server, commands: [...] }`, `server` with
   credentials/query/hash removed, commands sorted by code unit, argument order preserved) is written to
   `snapshot`, so filters can change without re-introspecting. If the file already exists and its `commands` are
   deep-equal to the new ones, it is left untouched (`Snapshot unchanged: …`), so `generatedAt` doesn't churn.
   `--from-snapshot` skips the server entirely, for CI and offline use; `readSnapshot` strips a BOM, validates the
   shape, and rejects (with the offending name) any command name that fails the rule in step 1.
5. Filters (`include`, `exclude`, `levels`) are applied when emitting.

### Emitted file

A single `moca.generated.ts`, deterministic for a given snapshot (input order doesn't matter). Before emitting,
`emit` normalises the command list, pushing a warning for each change:

- A command with a **required** argument whose name isn't a valid MOCA argument name
  (`/^[A-Za-z_][A-Za-z0-9_]*$/`, the rule `renderCommand` enforces) could never be called, so the whole command is
  skipped.
- Commands are de-duplicated case- and whitespace-insensitively; the lowest code-unit name wins.
- An **optional** argument with an invalid name is dropped.
- Repeated argument names within a command are de-duplicated case-insensitively (first wins).

`emit` returns `{ code, warnings, count }`, where `count` is the number of commands emitted.

The file contains:

- A header comment with the mocakit version, server URL (never credentials), command count and
  `/* eslint-disable */`.
- `export type MocaCommandName = 'list orders' | ...`.
- One `export interface <Method>Args` per command that has arguments, named after its method in PascalCase, so it
  inherits the method's collision suffix (`listOrders_2` → `ListOrders_2Args`). Commands with no arguments use
  `mk.NoArgs` (`Record<string, never>`) instead. Each property has JSDoc with its description and dtype, and
  required args are non-optional.
- Server text in JSDoc is sanitised: `*/` becomes `*\/`; an `@` at the start or after a character that is not a
  word character or backslash becomes `\@` (so no JSDoc tags or `{@link}`s); every whitespace run becomes one
  space, and the result is trimmed. In a method's summary, backticks in the command name become `'`.
- A `const S = { ... } as const satisfies Record<string, mk.CommandSpec>` table:
  `[mocaName, [[argName, dtype, required], ...]]`.
- An interface/class pair. The methods are typed as properties through shared generic callable interfaces exported by
  mocakit, so the type-checker handles thousands of commands cheaply (a class with three overloads per method cost
  ~14 s / 550 MB of `tsc` at 5,000 commands):

  ```ts
  export interface Moca extends mk.MocaClient {
    /** `list orders` · level: wmd · <description> */
    listOrders: mk.Command<ListOrdersArgs, "list orders">;                    // has required args
    listActiveCommands: mk.OptionalArgsCommand<mk.NoArgs, "list active commands">; // no required args
  }
  export class Moca extends mk.MocaClient {}
  mk.defineCommands(Moca.prototype, S); // installs non-enumerable methods that call this.call(spec, args, opts)
  export function createMoca(config: mk.MocaConfig, deps?: mk.MocaClientDeps): Moca;
  ```

  `defineCommands` installs each method as a non-enumerable, writable, configurable property. If a name already
  exists anywhere on the prototype chain (e.g. a `MocaClient` member added in a newer mocakit than the one that
  generated the file), it is **skipped** with `process.emitWarning("mocakit: generated command \"<name>\" clashes
  with a MocaClient member and was not installed; regenerate the client with the installed mocakit version")`
  rather than overwriting the member or throwing at import time.

  `Command`/`OptionalArgsCommand` each have three call signatures: `RowsOptions` → `T[]`, `FullOptions` →
  `MocaResult<T>`, and plain `CallOptions` → the union. `T` defaults to `Output<C>` and is wrapped in `NoInfer`, so it
  can only be set explicitly (`moca.listOrders<MyRow>(...)`), never inferred from an annotation. Consumers need
  TypeScript ≥ 5.4.

### dtype → TS type

| dtype | TS type |
|---|---|
| string (`S`, …) | `string` |
| integer / float (`I`, `F`, …) | `number` |
| boolean (`O`, …) | `boolean` |
| date (`D`, …) | `string \| Date` |
| unknown | `string` |

The dtype codes are classified exactly like the column types in §8. All optional argument types also accept `null`,
which removes the argument just like `undefined`. The codes are still to be confirmed against a live server.

### Naming

- Command name → Unicode NFKD with combining marks removed → lowercase → split on runs of non-`[a-z0-9]` →
  camelCase (`list active commands` → `listActiveCommands`). A name with no such characters becomes `command`. A
  leading digit gets an `_` prefix.
- Reserved names get a `cmd` prefix (`exec` → `cmdExec`): the client members `exec`, `call`, `login`, `logout`,
  `session`, plus `constructor`, `then` (so a client is never mistaken for a thenable) and every
  `Object.prototype` name. A test keeps this list in sync with `MocaClient`'s actual members.
- Collisions after conversion get `_2`, `_3` (in code-unit order of the MOCA name), and the CLI prints a warning.
- Arg interface names are the method name in PascalCase + `Args`, so they carry the same collision suffixes.
- Argument names are kept verbatim (only valid MOCA argument names reach this point); `__proto__` is quoted.

## 12. Packaging

- `package.json`: `"type": "module"`, `exports` for ESM + CJS + types, `bin: { "mocakit": "dist/cli.js" }`,
  `engines: { node: ">=20.6" }`.
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
- **Live** (`test/live.test.ts`, skipped unless `MOCA_URL` is set; prints nothing secret): login (logs the login
  columns), `list active commands` and unfiltered `list active command arguments` (logs columns and distinct
  values, for §14 items 1–3), full introspection, 510 behavior (`[select 1 x from dual where 1 = 0]` returns `[]`,
  and throws 510 with `noRowsIsError`; a non-Oracle dialect is logged and skipped), a raw request with a bogus
  `SESSION_KEY` (logs the status/message and asserts it is non-zero, for §14 item 5), and `runGenerate` with
  `dryRun: true` from env vars (asserts `Would write …` and that no files are written).

## 14. Items to confirm against a live server

These don't block the design. The code is written defensively around them, and the live suite (§13) logs what it
needs to confirm them; none has been confirmed against a live server yet:

1. Column names returned by `list active commands` and `list active command arguments`.
2. Whether `list active command arguments` works unfiltered.
3. The dtype and column-type code sets (for the mapping tables in §8 and §11).
4. Whether MOCA ever sends an empty `<field></field>` for an empty string (mocakit currently reads it as NULL).
5. That a 523 always means the command did not execute, including when a command makes nested `remote(...)` calls
   (the single post-523 retry relies on this). The live suite's bogus-`SESSION_KEY` check records which status an
   invalid session actually produces.

(`logout user` is confirmed to exist.)
