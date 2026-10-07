# AGENTS.md

tack: a private postplan.dev. A Cloudflare Worker + R2 bucket serves versioned HTML docs at secret links; a Bun CLI uploads them.

## Layout

- `src/worker.ts`: the whole Worker (API, serving, index/history/diff pages, version chip) plus the `Live` Durable Object.
- `cli/tack.ts`: the whole CLI. Runs directly with Bun, zero dependencies.
- `skill/tack/SKILL.md`: skill that tells agents how to use the CLI.
- `wrangler.jsonc`: Worker config. Deployed from the Cloudflare dashboard via GitHub, so this file is the source of truth on every push. Its build step copies the CLI and skill into `dist/`, which is served as static assets at `/cli` and `/skill.md` (free, no Worker invocation), so installs always match the deployed Worker. `tack update` re-downloads both, and refuses to run from a git checkout.

## Commands

```sh
bun install
bun run check     # wrangler types + tsc for worker and cli
echo 'TACK_TOKEN=dev' > .dev.vars
bun run dev       # local worker with local R2 on :8787
TACK_URL=http://localhost:8787 TACK_TOKEN=dev XDG_CONFIG_HOME=/tmp/tack-cfg ./cli/tack.ts upload x.html
```

There are no automated tests. Verify changes against `bun run dev` with the CLI and curl. Never run `tack setup` without `--token` while testing: it sets the secret on the real Worker.

## Slugs

New docs get up to three meaningful words from the title (filler words dropped) plus 10 random base36 characters. The random part is what keeps links private; don't shorten it.

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
- R2 layout: `meta/<slug>.json` holds the title and the version list (`files` maps path → sha256), plus `customMetadata` so `/` needs one `list()`. File bytes live at `blobs/<slug>/<sha256>`. Versions are append-only and immutable; meta writes go through `saveMeta()` (conditional put + throttle retry).
- Uploads are content-addressed: the CLI POSTs `{ files: { path: sha256 }, size, ... }`; the Worker answers `428 { missing }` for hashes it doesn't have, the CLI PUTs those raw to `/api/docs/<slug>/blobs/<sha256>` (streamed into R2, which verifies the sha256), then POSTs again to commit. The Worker never decodes or hashes file bytes.
- Blobs are only deleted with their doc (`tack rm <slug>`) or by a rename. Deleting a single version leaves its blobs in place, because a concurrent upload may be reusing them.
- Doc delete and rename first set `meta.lock` (`{ reason, at }`); uploads, version deletes, deletes and renames refuse while it's younger than 5 minutes, so a crashed operation can't wedge a doc. Rename copies blobs 4 at a time and unlocks on any failure before the target is published. Delete removes blobs before the meta, so a new doc at that slug never sees half-deleted files.
- URL space: `/api/*`, `/login`, `/robots.txt`, `/<slug>/` latest, `/<slug>/v/<n>/` pinned, `/<slug>/_history`, `/<slug>/_diff`, `/<slug>/_live` (WebSocket). Slugs `api`, `login` and `cli`, and file paths starting with `v`, `_history`, `_diff` or `_live`, are reserved.
- Version numbers are never reused: `meta.lastN` remembers the highest ever issued, so deleting a version can't make an old pinned URL show new content. Numbers can have gaps; use neighbours from `meta.versions`, never `n ± 1`.
- `BAR_JS` is injected into HTML only for `Sec-Fetch-Dest: document` without `?raw`, so API clients and `tack get` always get the exact bytes. The visible chip only renders once a doc has more than one version. At rest it reads `v3 / 3` (amber number on older versions); hover reveals ‹ ›, the version's age and a `changes` link to `_diff`. On the latest view it remembers the last version seen in `localStorage` (`tack:seen:<slug>`) and, only when there's a newer one, shows `· updated 2h ago` for that visit. The ETag hashes `BAR_JS` and its data so script changes aren't hidden behind cached 304s. All its URLs are built from `location.origin`, never relative (a doc's `<base>` must not see the slug).
- Live updates are pushed, never polled: one `Live` Durable Object per slug holds hibernatable WebSockets from open tabs (read-only; any client message closes the socket). `meta.rev` is an integer bumped on every committed change. `notify()` stores and broadcasts state: `update` ignores anything not newer than what's stored, `reset` overwrites (new doc, rename target), `end` broadcasts and clears storage (deleted doc, rename source). New sockets get the stored state on connect. Tabs act only on `rev` newer than the page's, so stale or reordered notifications can't cause reload loops. Tabs stop reconnecting after ~1 minute of failures and retry when they become visible.
- Workers Free allows 1,000 R2 calls per request, so uploads are capped at 200 files (worker and CLI). Use `Object.hasOwn` for lookups keyed by paths or extensions.
- The CLI runs with `bun --no-env-file` so a project's `.env` can't redirect the token. It only sends the token to its configured origin, which must be https (http only for localhost). Folder uploads never follow symlinks.
- Every response is `cache-control: ... no-transform`; without it Cloudflare's bot detection injects a script into HTML and docs stop being byte-for-byte.
- Workers Builds needs the `BUN_VERSION` build variable (≥ 1.4) to read `bun.lock`.

## Cost model (Workers Free)

Keep every hot path O(1) in requests and R2 operations, and never poll.

- Page view: 1 Worker request, 1 R2 read (meta). File bytes come from the edge cache (`caches.default`, keyed by content hash) after the first view per colo.
- Open tab: 2 requests to connect the WebSocket (Worker + Durable Object), then nothing while idle; outgoing messages are free.
- Identical re-upload: 1 request, 1 R2 read. Changed upload: 2 commits + 1 PUT per new file; existing files are never resent.
- Diff page: only for text types; computed once per pair of file hashes and cached (never cached on read errors); input is capped (first 150 KB via a ranged read, 2,000 lines, Myers bails past 200 edits, word diffs share a 4,000-token budget).
