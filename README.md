# tack

Private HTML docs for agents, on your own Cloudflare.

An agent runs `tack upload plan.html` and replies with a link. Uploading again adds a version under the same link, and open tabs update live.

- **Secret links.** Anyone with a link can read it; nobody can guess one.
- **Versions.** `/id` is the latest, `/id/v/2` is pinned, plus `/_history` and `/_diff`.
- **Anything goes.** Served byte-for-byte: scripts, assets, multi-page folders.
- **Free plan friendly.** One Worker, one R2 bucket, one Durable Object.

## Setup

1. Create an R2 bucket named `tack`.
2. Workers & Pages → Import this repo. Deploy command `bunx wrangler deploy`, build variable `BUN_VERSION=1.4.0`. Set your domain in `wrangler.jsonc` and `DEFAULT_URL` in `cli/tack.ts`.
3. Install the CLI and skill (running from the repo needs Node 22.18+):

```sh
bun install
ln -s "$PWD/cli/tack.ts" ~/.local/bin/tack
ln -s "$PWD/skill/tack" ~/.agents/skills/tack
tack setup   # creates a token and sets it on the Worker
tack open    # unlocks the doc list in your browser
```

Any other machine with Node 20+ installs the CLI and skill from your instance:

```sh
curl -fsSL https://tack.rex.wf/install | sh
tack setup --token <token>   # token is in ~/.config/tack/config.json on the first machine
```

## CLI

```
tack upload <file|dir|-> [--new] [--slug s] [--note n] [--json]
tack get <slug|url> [--v n]
tack list [--match words] [--json]
tack open [slug]
tack rm <slug> [--v n]
tack mv <slug> <new-slug>
tack setup [--token t | --rotate]
tack update
```

## Dev

```sh
echo 'TACK_TOKEN=dev' > .dev.vars
bun run dev
TACK_URL=http://localhost:8787 TACK_TOKEN=dev tack upload plan.html
```

Internals and invariants are in [AGENTS.md](AGENTS.md).
