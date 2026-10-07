# tack

Private HTML doc drops for agents. An agent runs `tack upload plan.html`, the page goes up on your own Cloudflare Worker, and it replies with a link. Re-uploads become new versions under the same link.

One Worker, one R2 bucket, one token. No database, no accounts, no content restrictions.

Docs are secret links: anyone with a link can open it, and links carry a random part so they can't be guessed. Uploads and the doc list need the token.

## Deploy

1. **R2**: create a bucket named `tack` (dashboard → R2, or `bunx wrangler r2 bucket create tack`).
2. **Worker**: Workers & Pages → Create → Import a repository → this repo. Deploy command: `bunx wrangler deploy`. Under Settings → Build → Variables, set `BUN_VERSION` = `1.4.0` (the build image defaults to Bun 1.2, which can't read `bun.lock`). `wrangler.jsonc` attaches the `tack.rex.wf` custom domain.
3. **Token + CLI**:

   ```sh
   bun install
   ln -s "$PWD/cli/tack.ts" ~/.bun/bin/tack
   tack setup    # creates a token, sets it on the Worker via wrangler, saves it locally
   tack open     # prints the link that unlocks the doc list in your browser
   ```

   On another machine: `tack setup --token <token>` (the token is in `~/.config/tack/config.json`), or set `TACK_TOKEN`. If the token leaks, `tack setup --rotate` replaces it (and the unlock link).

## CLI

```sh
tack upload plan.html                            # new doc, prints (and copies) the link
tack upload plan.html --note "tightened scope"   # same path again: new version
tack upload ./report/                            # folder with index.html + assets
tack get <slug> --v 2                            # print the exact HTML
tack open <slug>                                 # open in your browser
tack list
tack rm <slug> [--v 2]                           # delete a doc, or one version
tack mv <slug> <new-slug>                        # rename (old links stop working)
```

A single `.html` file also brings along the local images, CSS and pages it references (from its own folder down). Open docs reload themselves when a new version lands.

`TACK_URL`, `TACK_TOKEN` and `--url` override the config (`.env` files are ignored). Uploads are capped at 200 files and 30 MB; symlinks and dotfiles in folders are skipped. A custom `--slug` makes the link guessable.

## Agent skill

```sh
ln -s "$PWD/skill/tack" ~/.agents/skills/tack
```

## URLs

| URL | |
|---|---|
| `/` | all docs (after `tack open`) |
| `/<slug>/` | latest version |
| `/<slug>/v/<n>/` | pinned version |
| `/<slug>/_history` | versions with notes |
| `/<slug>/_diff?a=1&b=2` | what changed between two versions |
| `?raw` | exact uploaded bytes, without the version switcher |

## Local dev

```sh
echo 'TACK_TOKEN=dev' > .dev.vars
bun run dev
TACK_URL=http://localhost:8787 TACK_TOKEN=dev tack upload plan.html
```
