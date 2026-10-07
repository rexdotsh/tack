# AGENTS.md

tack: a private postplan.dev. A Cloudflare Worker + R2 bucket behind Cloudflare Access serves versioned HTML docs; a Bun CLI uploads them.

## Layout

- `src/worker.ts`: the whole Worker (API, serving, index/history pages, version switcher).
- `cli/tack.ts`: the whole CLI. Runs directly with Bun, zero dependencies.
- `skill/tack/SKILL.md`: skill that tells agents how to use the CLI.
- `wrangler.jsonc`: Worker config. Deployed from the Cloudflare dashboard via GitHub, so this file is the source of truth on every push.

## Commands

```sh
bun install
bun run check     # wrangler types + tsc for worker and cli
bun run dev       # local worker with local R2 on :8787
TACK_URL=http://localhost:8787 XDG_CONFIG_HOME=/tmp/tack-cfg bun cli/tack.ts upload x.html
```

There are no automated tests. Verify changes against `bun run dev` with the CLI and curl.

## Rules

- Bun for everything: `bun`, `bunx`, `bun.lock`. No npm/npx/node.
- Keep it minimal. No frameworks, no runtime dependencies, no new Cloudflare resources unless unavoidable.
- No comments unless the code would be misleading without one.
- Conventional commits with short messages (`feat: ...`, `fix: ...`).

## Invariants

- `workers_dev` and `preview_urls` stay `false`. They bypass Access.
- No auth code in the Worker. Access does auth. The one check: writes (`POST`/`DELETE` on `/api`) are refused when `cf-access-authenticated-user-email` is present, so only the service token (CLI) can write, never a browser session or a doc's own JS.
- Uploaded files are served byte-for-byte. No sanitizing or CSP sandboxing; that's the point.
- R2 layout: `meta/<slug>.json` holds the title and the version list (`files` maps path → sha256), plus `customMetadata` so `/` needs one `list()`. File bytes live at `blobs/<slug>/<sha256>`. Versions are append-only and immutable; meta writes use conditional puts.
- URL space: `/api/*` is the API, `/<slug>/` latest, `/<slug>/v/<n>/` pinned, `/<slug>/_history`. Slug `api` and file paths starting with `v/` or `_history` are reserved.
- The version switcher is only injected for `Sec-Fetch-Dest: document` without `?raw`. API clients and `tack get` always get the exact bytes.
