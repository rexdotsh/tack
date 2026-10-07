# tack

Private HTML doc drops for agents. An agent runs `tack upload plan.html`, the page goes up on your own Cloudflare Worker, and it replies with a link. Re-uploads become new versions under the same link.

One Worker, one R2 bucket, Cloudflare Access in front. No database, no accounts, no content restrictions.

## Deploy

Do these in order so the domain is never public.

1. **R2**: create a bucket named `tack` (dashboard → R2, or `bunx wrangler r2 bucket create tack`).
2. **Service token**: Zero Trust → Access controls → Service credentials → Service tokens → Create (e.g. `tack-cli`). Save the Client ID and Client Secret.
3. **Access app**: Zero Trust → Access controls → Applications → Add → Self-hosted, domain `tack.rex.wf`, with two policies:
   - `Allow`: include your email
   - `Service Auth`: include the `tack-cli` service token
4. **Worker**: Workers & Pages → Create → Import a repository → this repo. Deploy command: `bunx wrangler deploy`. `wrangler.jsonc` attaches the `tack.rex.wf` custom domain and keeps `workers.dev` and preview URLs off (those would bypass Access).

## CLI

```sh
bun install
ln -s "$PWD/cli/tack.ts" ~/.bun/bin/tack
tack setup        # paste the service token Client ID and Secret
```

```sh
tack upload plan.html                     # new doc, prints the link
tack upload plan.html --note "tightened scope"   # same path again: new version
tack upload ./report/ --slug q3-report    # folder with index.html + assets, custom slug
tack get q3-report --v 2                  # print HTML (through Access)
tack list
tack rm q3-report
```

Config lives in `~/.config/tack/config.json`. `TACK_URL`, `TACK_CLIENT_ID`, `TACK_CLIENT_SECRET` and `--url` override it.

## Agent skill

```sh
ln -s "$PWD/skill/tack" ~/.agents/skills/tack
```

## URLs

| URL | |
|---|---|
| `/` | all docs |
| `/<slug>/` | latest version |
| `/<slug>/v/<n>/` | pinned version |
| `/<slug>/_history` | versions with notes |
| `?raw` | exact uploaded bytes, without the version switcher |

## Local dev

```sh
bun run dev
TACK_URL=http://localhost:8787 tack upload plan.html
```
