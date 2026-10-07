# AGENTS.md

tack: a private postplan.dev. A Cloudflare Worker + R2 bucket serves versioned HTML docs at secret links; a Bun CLI uploads them.

## Layout

- `src/worker.ts`: the whole Worker (API, serving, index/history/diff pages, version chip) plus the `Live` Durable Object.
- `cli/tack.ts`: the whole CLI, zero dependencies. Node built-ins only and erasable TypeScript only, so it runs as-is on Node 22.18+ (type stripping) and Bun, and `bun run build:cli` bundles it to `dist/cli` for Node 20+.
- `skill/tack/SKILL.md`: skill that tells agents how to use the CLI.
- `wrangler.jsonc`: Worker config. Deployed from the Cloudflare dashboard via GitHub, so this file is the source of truth on every push. Its build step bundles the CLI and copies the skill and `cli/install.sh` into `dist/`, served as static assets at `/cli`, `/skill.md` and `/install` (free, no Worker invocation), so installs always match the deployed Worker. The installer saves the CLI as `~/.local/share/tack/tack.mjs` (the `.mjs` makes it ESM on every Node 20+, regardless of package.json scope) and links `~/.local/bin/tack` to it. `tack update` re-downloads the CLI and a downloaded skill through unique temp files, and refuses to touch anything inside a git checkout.

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

New docs get a slug of 10 random base36 characters (~51 bits), which is what keeps links private; don't shorten it. Links are printed without a trailing slash: single-page docs (and single-page pinned versions) are served at `/id` directly, multi-file ones redirect to `/id/` so relative links resolve.

## Rules

- Bun for repo tooling: `bun`, `bunx`, `bun.lock`. No npm/npx.
- The CLI must not depend on Bun: no `Bun.*` APIs, no top-level await, no TypeScript-only runtime syntax (`cli/tsconfig.json` enforces `erasableSyntaxOnly`). Check changes with `node cli/tack.ts` and `bun run build:cli && node dist/cli`.
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
- Uploaded file paths must already be canonical (no `./`, `//`, `..` or backslashes); the Worker rejects anything it would have to rewrite.
- Uploads are content-addressed: the CLI POSTs `{ files: { path: sha256 }, size, ... }`; the Worker answers `428 { missing }` for hashes it doesn't have, the CLI PUTs those raw to `/api/docs/<slug>/blobs/<sha256>` (streamed into R2, which verifies the sha256), then POSTs again to commit. The Worker never decodes or hashes file bytes.
- Blobs are only deleted with their doc (`tack rm <slug>`) or by a rename. Deleting a single version leaves its blobs in place, because a concurrent upload may be reusing them.
- Doc delete and rename set `meta.lock` (`{ reason, at, to?, from?, phase? }`). While it's younger than 5 minutes everything else refuses. Once older it's a recovery marker (`blocked()`), and the message names the slug to `tack rm`: a stale delete, a stale rename in its `cleanup` phase, a half-made rename copy (`from`), or a rename source whose published target exists. A stale rename source whose target is gone is ignored (its blobs were never touched). `tack rm` refuses to delete an intact source while its half-made copy still exists.
- Rename: lock the source, reserve the target with a locked copy of the meta (create-only, `from`), stream blobs 4 at a time, publish the target by replacing the reservation, mark the source `phase: "cleanup"`, then delete the source's blobs and finally its meta. Any failure before publishing removes the reservation and unlocks the source. Delete: lock, blobs, meta.
- URL space: `/api/*`, `/login`, `/robots.txt`, `/<slug>/` latest, `/<slug>/v/<n>/` pinned, `/<slug>/_history`, `/<slug>/_diff`, `/<slug>/_live` (WebSocket). Slugs `api`, `login`, `cli` and `install`, and file paths starting with `v`, `_history`, `_diff` or `_live`, are reserved.
- Version numbers are never reused: `meta.lastN` remembers the highest ever issued, so deleting a version can't make an old pinned URL show new content. Numbers can have gaps; use neighbours from `meta.versions`, never `n ± 1`.
- `BAR_JS` is injected into HTML only for `Sec-Fetch-Dest: document` without `?raw`, so API clients and `tack get` always get the exact bytes. The visible chip only renders once a doc has more than one version. At rest it reads `v3 / 3` (amber number on older versions); hover reveals ‹ ›, the version's age and a `changes` link to `_diff`. On the latest view it remembers the last version seen in `localStorage` under `tack:seen:<hash of slug>` (never the raw slug: docs share the origin, so their JS can read it) and, only when there's a newer one, shows `· updated 2h ago` for that visit. The ETag hashes `BAR_JS` and its data so script changes aren't hidden behind cached 304s. All its URLs are built from `location.origin`, never relative (a doc's `<base>` must not see the slug).
- Live updates are pushed, never polled: one `Live` Durable Object per slug holds hibernatable WebSockets from open tabs (read-only; any client message closes the socket). Every state carries `(gen, rev)`: `meta.gen` is issued by the slug's Durable Object (`begin()`, strictly increasing even across clock skew) when a slug starts a new life (created, or renamed into), and `meta.rev` is bumped on every committed change. States also keep the legacy `latest`/`count` fields for tabs opened before a deploy. The DO stores and broadcasts a state only if its `(gen, rev)` is newer than what it has, and tabs act only on states newer than their page, so delayed or reordered notifications (even from a deleted, recreated doc) can't regress state or loop reloads. States carry the version list (`ns`) so pinned tabs can recompute their neighbours. Tabs reset their reconnect budget only after a connection stays up 30 s, stop after ~1 minute of failures, and retry when they become visible.
- Workers Free allows 1,000 R2 calls per request, so uploads are capped at 200 files (worker and CLI). Use `Object.hasOwn` for lookups keyed by paths or extensions.
- The CLI never loads `.env` files (Node doesn't by default; don't add dotenv), so a project's `.env` can't redirect the token. It only sends the token to its configured origin, which must be https (http only for localhost), and never follows a redirect to plain http. Running the CLI with plain `bun` would bring back `.env` autoloading; use `node` or `bun --no-env-file`. Folder uploads never follow symlinks.
- Every response is `cache-control: ... no-transform`; without it Cloudflare's bot detection injects a script into HTML and docs stop being byte-for-byte.
- Workers Builds needs the `BUN_VERSION` build variable (≥ 1.4) to read `bun.lock`.

## Cost model (Workers Free)

Keep every hot path O(1) in requests and R2 operations, and never poll.

- Page view: 1 Worker request, 1 R2 read (meta). File bytes come from the edge cache (`caches.default`, keyed by content hash) after the first view per colo.
- Open tab: 2 requests to connect the WebSocket (Worker + Durable Object), then nothing while idle; outgoing messages are free.
- Identical re-upload: 1 request, 1 R2 read. Changed upload: 2 commits + 1 PUT per new file; existing files are never resent.
- Diff page: only for text types (HTML is compared as extracted text, other text line by line with whitespace kept); a cut-off comparison says so; computed once per pair of file hashes and cached under `DIFF_REV` (bump it whenever the diff output changes, or old results stick forever; never cached on read errors); input is capped (first 150 KB via a ranged read, 2,000 lines, Myers bails past 200 edits, word diffs share a 4,000-token budget).
