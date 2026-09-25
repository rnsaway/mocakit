# Changelog

All notable changes to mocakit are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/) (while below 1.0.0, a minor version can contain breaking changes).

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
  `try { ... } finally { try { [rollback] } catch (@?) { noop } }` and sent with `autocommit="false"`.
- **`moca.batch((b) => [...steps], opts?)`**: several commands in one request, committed or rolled back together.
  The builder `b` offers every generated command with the same argument types, plus `b.raw(mocaText)`. Arguments
  are validated as each step is built. Resolves to the last step's rows (or the full result with
  `format: 'full'`).
- Exported types `BatchBuilder`, `BatchStep` and `BatchOptions`.

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

[0.2.0]: https://github.com/rnsaway/mocakit/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/rnsaway/mocakit/releases/tag/v0.1.0
