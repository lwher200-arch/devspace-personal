# DevSpace Eterna

Public home: https://github.com/lwher200-arch/devspace-eterna

This is an Eterna-oriented development fork of
[Waishnav/devspace](https://github.com/Waishnav/devspace), not an official upstream
release or an OpenAI product. The upstream MIT license and copyright notice are
retained unchanged.

## Branches and Provenance

- `codex/eterna-local`: maintained local-extension snapshot and default branch.
- `main`: upstream snapshot preserved when this fork was created; never replaced
  with an unrelated local history.
- Local extension base: `69a00ee4b90fb6966100b0247d39569f4d4ca08d`.
- Upstream main observed at repository creation:
  `8c5a50150d3f2f12e074c208f31087144c164a27`. It has not been merged into the local
  extension branch as part of publication.

The package name/version remain upstream-compatible for command discovery. Use
the Git commit SHA to identify this fork build. No fork-specific npm release is
published; `npm install -g @waishnav/devspace` installs upstream, not this branch.

## Included Extensions

- Paginated project inventory, literal text search and exact UTF-8 reads with
  completion/exclusion reporting and SHA-256 values.
- Patch previews, expected-content hashes and UTF-8 BOM preservation.
- Logical and physical path validation, persisted workspace anchors and
  profile-level read-only authority ceilings.
- Windows PATH/PATHEXT normalization and deferred optional-provider loading.
- Bounded Codex MCP task submission, durable request receipts, continuation and
  optional explicit-model/minimum-version/runtime-evidence policy.

OAuth, workspace tools, provider adapters, agent CLI and persistence are largely
upstream capabilities that this fork extends. See [docs/closed-loop.md](docs/closed-loop.md).

## Build and Use

Use the Node and pnpm versions specified in `package.json`, plus the
upstream-supported Git/shell dependencies.

```sh
git clone https://github.com/lwher200-arch/devspace-eterna.git
cd devspace-eterna
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
node bin/devspace.js init
node bin/devspace.js serve
```

Configure your own owner credential, approved roots and public HTTPS endpoint.
Explicitly opt into bridge writes only for authorized editing. Do not change
machine-wide model preferences as a workaround for a failed protected task.

## Intentionally Local Only

The original machine-specific Windows deployment scripts, tunnel identifiers,
ChatGPT conversation binding, credentials, SQLite state, backups, logs and
acceptance artifacts are not published. Existing local files are not deleted.
The `scripts/windows/` bundle is excluded until a portable, reviewed installer
with configuration-preservation and rollback coverage replaces it.

## Known Limits

- Discovery is scoped and paginated, not automatic full-repository ingestion.
  Text reads have an 8 MiB limit, and literal search is not semantic/regex search.
- Hash guards and root checks are not an OS sandbox or an atomic multi-file
  transaction. Shell commands retain the service account's authority.
- Directory submission serialization currently applies within a bridge process;
  it is not a cross-process lease.
- Guarded model evidence relies on provider rollout records and bounded reads.
  A failure after execution starts can leave changed files; inspect before retry.
- Host metadata must be refreshed after tool-schema changes. This repository
  does not implement an unattended bidirectional ChatGPT/Codex relay.
- The private Pi image-helper dependency and portable deployment workflow remain
  review items. Publication is a versioned development snapshot, not a claim
  that every issue or platform has been validated.

## Updating This Fork

Keep upstream as a separate remote and review changes before integrating them.
Never force-push over someone else's work or replace existing service settings
with another machine's examples. Keep production credentials outside the checkout.
