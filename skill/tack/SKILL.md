---
name: tack
description: Use when the user wants an HTML write-up (plan, spec, report, findings, comparison, UI mock) published as a shareable link, or gives you a tack.rex.wf URL to read.
---

# tack

`tack` publishes HTML to the user's private site (https://tack.rex.wf) and returns a secret link. Every doc is versioned: uploading to the same slug adds a new version under the same link.

## Publish a new doc

0. If the doc might already exist (same subject as earlier work), check first with `tack list --match "<words from the title>" --json`. If one matches, update it instead (see below) rather than creating a duplicate.
1. Write a self-contained HTML file. Inline CSS/JS is fine, as are external https assets. Give it a good `<title>`; it becomes the doc title and the start of the slug.
   Local images, CSS and pages that the file references with relative paths (`img/chart.png`, `details.html`) are uploaded with it automatically, as long as they're in its folder or below. You can also upload a whole folder with an `index.html`.
2. Run `tack upload <file-or-folder> --new --json`. Don't pass your own `--slug` for a new doc; the generated one has a random part that keeps the link private.
   For a single page you don't need a file: pipe it in with `tack upload - --new --json <<'EOF' ... EOF`. Updates work the same way with `tack upload - --slug <slug>`.
3. Reply with the receipt's `url`. It's only published once the receipt has `"ok": true`.

## Update a doc

Run the receipt's `updateCommand` with a note:

```sh
tack upload <path> --slug <slug> --note "what changed" --json
```

The `url` stays the same and always shows the latest version. `versionUrl` pins this exact version. Uploading identical content is a no-op (`"unchanged": true`).

## Read a doc

Links open without a login, so any fetch tool works. `tack get <url-or-slug>` prints the exact HTML (`--v <n>` for a specific version) and `# <slug> v<n> of <latest>` to stderr.

To see what changed between versions, fetch `https://tack.rex.wf/<slug>/_diff?a=<n>&b=<m>`.

## Other commands

`tack list [--match <words>] [--json]`, `tack rm <slug> [--v <n>]`, `tack mv <slug> <new-slug>`, `tack help`. Don't run `tack open`; it's for the user.

Never put the tack token, the config file, or the `tack open` link in a doc or a chat reply. If tack reports a bad or missing token, ask the user to run `tack setup`.
