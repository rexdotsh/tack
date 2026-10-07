---
name: tack
description: Use when the user wants an HTML write-up (plan, spec, report, findings, comparison, UI mock) published as a shareable link, or gives you a tack.rex.wf URL to read.
---

# tack

`tack` publishes HTML to the user's private site (https://tack.rex.wf) and returns a secret link. Every doc is versioned: uploading to the same slug adds a new version under the same link.

## Publish a new doc

1. Write a self-contained HTML file. Inline CSS/JS is fine, as are external https assets. Give it a good `<title>`; it becomes the doc title and the start of the slug.
   If the page needs local images or several pages, put everything in a folder with an `index.html`, use relative links (`img/chart.png`, `details.html`), and upload the folder.
2. Run `tack upload <file-or-folder> --new --json`. Don't pass your own `--slug` for a new doc; the generated one has a random part that keeps the link private.
3. Reply with the receipt's `url`. It's only published once the receipt has `"ok": true`.

## Update a doc

Run the receipt's `updateCommand` with a note:

```sh
tack upload <path> --slug <slug> --note "what changed" --json
```

The `url` stays the same and always shows the latest version. `versionUrl` pins this exact version. Uploading identical content is a no-op (`"unchanged": true`).

## Read a doc

Links open without a login, so any fetch tool works. `tack get <url-or-slug>` prints the exact HTML (`--v <n>` for a specific version) and `# <slug> v<n> of <latest>` to stderr.

## Other commands

`tack list`, `tack rm <slug>`, `tack help`.

Never put the tack token, the config file, or the `tack open` link in a doc or a chat reply. If tack reports a bad or missing token, ask the user to run `tack setup`.
