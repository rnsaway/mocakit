# Changelog

All notable changes to mocakit are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/) (while below 1.0.0, a minor version can contain breaking changes).

## [0.5.0] - 2026-10-01

### Added

- **REST API client** (`api` in the config, or `--api`): `mocakit generate` reads the server's Swagger specs and adds a
  typed `moca.api.<tag>.<method>(...)` to the generated client, with `path`, `query`, `body` and `form` parameters typed
  from the spec. Responses resolve to the rows (`{ format: 'full' }` gives `{ status, body }`), and the server's
  404 "no rows affected" for an empty list resolves to `[]`. The session is a lazy
  cookie login with one re-login after a 401; only `GET` requests are retried, and writes are never retried.
- **`moca.api.json`, `moca.api.ts` and `moca-api/`**: the spec snapshot, the typed operation table and definitions, and
  agent docs (`README.md`, `INDEX.md` and one page per operation). Options: `groups`, `include`, `exclude`,
  `methods` (`['get']` for a read-only client), `snapshot`, `out`, `docs`.
- `--api` and `--no-api` flags. `--from-snapshot` rebuilds the API output from `moca.api.json`.
- `MocaApiError` (`method`, `path`, `httpStatus`, `userMessage`, `errorCode`, `responseId`) and the `RestTransport` type
  for injecting a fake REST transport in tests.

### Changed

- `api` is now a reserved method name: a MOCA command called `api` is generated as `cmdApi`.

## [0.4.0] - 2026-10-01

### Added

- **Command docs** (`commandDocs` in the config, or `--command-docs`): `moca-commands/` with `README.md`, `INDEX.md` and one
  page per command (`commands/<name>.md`) with arguments, implementation, triggers in firing order, and overrides.
  Implementation source is written only for custom component levels by default (`commandDocs.source`, `customLevels`,
  `customTriggers`); `source: 'all'` also writes product source, `source: false` none.
- **Call graph and table cross-reference**: approximate Calls / Called by and Reads / Writes links from scanned command
  source. The table docs gain a "Used by" section, kept in `moca.schema.json` so offline rebuilds keep it.
- **Code values** (`schema.codes`): `moca-schema/codes/<column>.md` from `codmst`/`dscmst`, linked from coded columns in
  the table docs.
- `--command-docs` and `--no-command-docs` flags. `--from-snapshot` skips command docs.

### Changed

- The generated `README.md` and `INDEX.md` in `moca-schema/` and `moca-commands/` start with a private-repository notice.
- `writeSchemaDocs` also removes stale generated files in `codes/`.

## [0.3.0] - 2026-09-30

### Added

- **Opt-in schema introspection** in `mocakit generate` (`schema` in the config, or `--schema`): reads the MOCA login
  schema's tables, views, columns, comments and primary keys from SQL Server or Oracle into `moca.schema.json`.
- **`moca.schema.ts`**: a `MocaTables` interface with every table's columns, typed and documented for hover.
- **Agent docs** (`moca-schema/`): `README.md`, `INDEX.md` and `tables/<table>.md` for coding agents; stale generated
  files are removed. Hand-written files are never overwritten or deleted: if one is in the way, `generate` refuses to
  run before writing anything.
- **`moca.from(table)`**: a typed single-table query helper (`select`, equality `where`, `orderBy`, `rows`) with values
  bound as MOCA variables. `null` in `where` means `is null`; a `Date` value is sent through `to_date`. `rows()`
  always converts values and has no `convert` option.
- `--no-schema` to skip schema introspection when the config enables it.

### Changed

- `from` is now a reserved method name: a MOCA command named `from` is generated as `cmdFrom`.

## [0.2.0] - 2026-09-25

### Breaking

- **The `autocommit` option is removed** from `CallOptions` and `ClientDefaults`. `autocommit: false` never gave
  you a controllable transaction: MOCA runs every request on a different pooled database connection and left the
  transaction open there, for an unrelated later request to inherit. Every request is now sent with
  `autocommit="true"`, so it commits when it succeeds and rolls back entirely when it fails. Passing `autocommit`
  (per call or in `config.defaults`) throws `MocaArgumentError`; use `{ dryRun: true }` or `moca.batch()` instead.
  See "Upgrading from 0.1.0" in the README.
- `batch` and `raw` are now reserved method names: a MOCA command with either name is generated as `cmdBatch` /
  `cmdRaw`. Regenerate your client.

### Added

- **`dryRun`** call option (`exec`, `call`, generated methods, `batch`): runs the command, returns its rows, then
  rolls back what it wrote. The text is wrapped in
  `try { ... } finally { try { [rollback] } catch (@?) { noop } }` and sent with `autocommit="true"` like every
  request (mocakit never sends `autocommit="false"`), so a failing wrapper is rolled back by MOCA. Per call only:
  `defaults.dryRun` and non-boolean values throw `MocaArgumentError`, and so does dryRun `exec`/`batch` text with the
  word `commit` inside a `[...]` block (a best-effort check). `buildRequest` has no `autocommit` parameter any more:
  it always emits `autocommit="true"`.
- **`moca.batch((b) => [...steps], opts?)`**: several commands in one request, committed or rolled back together.
  The builder `b` offers every generated command with the same argument types, plus `b.raw(mocaText)`. Arguments
  are validated as each step is built. Resolves to the last step's rows (or the full result with
  `format: 'full'`). A step that finds no rows (510) makes MOCA roll back the whole request, so `batch` always throws
  `MocaCommandError` for it, and `noRowsIsError` is not a batch option. Step factories reject a second (options)
  argument, an `async` build callback is rejected, and overridden commands resolve to their original spec (the
  override's JavaScript never runs in a batch).
- Exported types `BatchBuilder`, `BatchStep` and `BatchOptions`.
- `null` options are treated like omitted ones in `exec`, `call` and `batch`.
- `CHANGELOG.md` ships in the npm package.
- README: MOCA rolls back a request whose final statement finds no rows (510), even though `exec` returns `[]`.

### Fixed

- `login user` is sent with `autocommit="true"`. 0.1.0 sent it with `autocommit="false"` (copied from
  n8n-nodes-moca), which left a transaction open on a pooled database connection after every login.
- Required arguments of Local Syntax commands: MOCA only enforces flagged (`argreq`) arguments for compiled
  commands (C Function, Simple C Function, Java Method). The generator now makes a flagged argument of a Local
  Syntax command optional, instead of required, and no longer skips such commands when the flagged argument is
  stack-typed.

## [0.1.0] - 2026-09-23

### Added

- First release: a typed MOCA client (`MocaClient`: `exec`, `call`, `login`, `logout`, `session`) speaking the
  `application/moca-xml` protocol, with session caching, single-flight login and one automatic retry after a 523
  (session expired).
- `mocakit generate`: introspects a live instance and writes one typed method per active command, plus a JSON
  snapshot; `include`/`exclude`/`levels` filters, `--from-snapshot`, `--dry-run` and `.env` loading.
- Typed errors (`MocaCommandError`, `MocaAuthError`, `MocaTransportError`, `MocaProtocolError`,
  `MocaArgumentError`) with password redaction, a `MocaOutputs` registry for row types, and date helpers
  (`formatMocaDate`, `parseMocaDate`).

[0.5.0]: https://github.com/rnsaway/mocakit/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/rnsaway/mocakit/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/rnsaway/mocakit/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/rnsaway/mocakit/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/rnsaway/mocakit/releases/tag/v0.1.0
