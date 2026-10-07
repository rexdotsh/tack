# AGENTS.md

tack: a private postplan.dev. A Cloudflare Worker + R2 bucket serves versioned HTML docs at secret links; a Bun CLI uploads them.

## Layout

- `src/worker.ts`: the whole Worker (API, serving, index/history pages, version switcher).
- `cli/tack.ts`: the whole CLI. Runs directly with Bun, zero dependencies.
- `skill/tack/SKILL.md`: skill that tells agents how to use the CLI.
- `wrangler.jsonc`: Worker config. Deployed from the Cloudflare dashboard via GitHub, so this file is the source of truth on every push.

## Commands

```sh
bun install
bun run check     # wrangler types + tsc for worker and cli
echo 'TACK_TOKEN=dev' > .dev.vars
bun run dev       # local worker with local R2 on :8787
TACK_URL=http://localhost:8787 TACK_TOKEN=dev XDG_CONFIG_HOME=/tmp/tack-cfg ./cli/tack.ts upload x.html
```

There are no automated tests. Verify changes against `bun run dev` with the CLI and curl. Never run `tack setup` without `--token` while testing: it sets the secret on the real Worker.

## Rules

- Bun for everything: `bun`, `bunx`, `bun.lock`. No npm/npx/node.
- Keep it minimal. No frameworks, no runtime dependencies, no new Cloudflare resources unless unavoidable.
- No comments unless the code would be misleading without one.
- Conventional commits with short messages (`feat: ...`, `fix: ...`).

## Access model

- Docs (`/<slug>/...`, `/<slug>/_history`) are public to anyone with the link. Privacy comes from the 10-char random slug suffix the CLI generates, plus `x-robots-tag: noindex`, `referrer-policy: no-referrer` and a disallow-all `robots.txt`.
- `/api/*` requires `Authorization: Bearer <TACK_TOKEN>` (a Worker secret). It fails closed when the secret is unset.
- `/` (the doc list) requires the `tack` cookie, set by `/login?key=<view key>`. The view key is `sha256(TACK_TOKEN + ":view")`, so it can list docs but never write. `tack open` prints that link.
- Compare secrets with `same()` (constant time). Never accept the cookie or view key for writes.

## Invariants

- Uploaded files are served byte-for-byte. No sanitizing or CSP sandboxing; that's the point.
- R2 layout: `meta/<slug>.json` holds the title and the version list (`files` maps path → sha256), plus `customMetadata` so `/` needs one `list()`. File bytes live at `blobs/<slug>/<sha256>`. Versions are append-only and immutable; meta writes use conditional puts.
- URL space: `/api/*`, `/login`, `/robots.txt`, `/<slug>/` latest, `/<slug>/v/<n>/` pinned, `/<slug>/_history`. Slugs `api` and `login`, and file paths starting with `v/` or `_history`, are reserved.
- The version switcher is only injected into docs with more than one version, for `Sec-Fetch-Dest: document`, without `?raw`. API clients and `tack get` always get the exact bytes. Its ETag includes `BAR_REV` (a hash of `BAR_JS`) so redesigns aren't hidden behind cached 304s.
- Workers Free allows 1,000 R2 calls per request, so uploads are capped at 200 files (worker and CLI). Use `Object.hasOwn` for lookups keyed by paths or extensions.
- The CLI runs with `bun --no-env-file` so a project's `.env` can't redirect the token. It only sends the token to its configured origin, which must be https (http only for localhost). Folder uploads never follow symlinks.
- Every response is `cache-control: ... no-transform`; without it Cloudflare's bot detection injects a script into HTML and docs stop being byte-for-byte.
- Workers Builds needs the `BUN_VERSION` build variable (≥ 1.4) to read `bun.lock`.
