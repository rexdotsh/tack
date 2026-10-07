#!/usr/bin/env -S bun --no-env-file
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const DEFAULT_URL = "https://tack.rex.wf";
const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "tack");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
const MAX_FILES = 200;
const common = { url: { type: "string" }, json: { type: "boolean" } } as const;

const HELP = `tack - publish HTML docs to your tack instance

Usage:
  tack upload <file.html|dir> [--slug <slug>] [--new] [--title <t>] [--note <n>] [--json]
  tack get <slug|url> [--v <n>]     print a doc's HTML to stdout
  tack list [--json]
  tack rm <slug>
  tack setup [--client-id <id> --client-secret <secret>]

upload:
  A file is published as the doc's index.html. A folder must contain index.html;
  everything else in it (images, css, js, more pages) is published alongside it.
  --slug <s>   publish to this slug: creates it, or adds a version if it exists
  --new        always create a new doc (with --slug: fail if the slug is taken)
               with neither, re-uploading the same path updates the same doc
  --title <t>  doc title (default: the page's <title> or first <h1>)
  --note <n>   what changed in this version, shown in the history
  --json       machine-readable receipt

Every command accepts --url <url>. Precedence: --url, $TACK_URL, config file, ${DEFAULT_URL}.
Config: ${CONFIG_FILE}  (env overrides: TACK_URL, TACK_CLIENT_ID, TACK_CLIENT_SECRET)
`;

type Config = { url: string; clientId: string; clientSecret: string };
type Receipt = {
  ok: true;
  slug: string;
  title: string;
  version: number;
  versions: number;
  unchanged: boolean;
  url: string;
  versionUrl: string;
  historyUrl: string;
};
type DocSummary = { slug: string; title: string; updatedAt: string; latest: number; versions: number; url: string };

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const commands: Record<string, (argv: string[]) => Promise<void>> = { upload, get, list, rm, setup };
const [cmd, ...rest] = process.argv.slice(2);

if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
  process.stdout.write(HELP);
} else if (!commands[cmd]) {
  fail(`unknown command "${cmd}" (try: tack help)`);
} else {
  try {
    await commands[cmd](rest);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function upload(argv: string[]) {
  const { values: o, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      ...common,
      slug: { type: "string" },
      new: { type: "boolean" },
      title: { type: "string" },
      note: { type: "string" },
    },
  });
  if (positionals.length !== 1) {
    throw new Error("usage: tack upload <file.html|dir> [--slug s] [--new] [--title t] [--note n] [--json]");
  }
  const cfg = await loadConfig(o.url);
  const abs = path.resolve(positionals[0]);
  const files = await collect(abs);
  const title = o.title ?? extractTitle(new TextDecoder().decode(files["index.html"]));

  const mapFile = path.join(CONFIG_DIR, "paths", sha256(`${cfg.url}\n${abs}`).slice(0, 32));
  let slug = o.slug?.toLowerCase();
  let remembered = false;
  if (!slug && !o.new) {
    slug = (await readText(mapFile))?.trim() || undefined;
    remembered = Boolean(slug);
  }
  const auto = !slug;
  const body = JSON.stringify({
    files: Object.fromEntries(Object.entries(files).map(([p, bytes]) => [p, Buffer.from(bytes).toString("base64")])),
    title: title || undefined,
    note: o.note || undefined,
    create: Boolean(o.new) || auto,
  });

  let receipt: Receipt;
  for (let attempt = 0; ; attempt++) {
    if (auto) slug = makeSlug(title || path.basename(abs).replace(/\.html?$/i, ""));
    try {
      receipt = await api<Receipt>(cfg, `/api/docs/${encodeURIComponent(slug!)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      break;
    } catch (err) {
      if (auto && err instanceof HttpError && err.status === 409 && attempt < 3) continue;
      throw err;
    }
  }

  await mkdir(path.dirname(mapFile), { recursive: true });
  await Bun.write(mapFile, `${receipt.slug}\n`);

  const updateCommand = `tack upload ${shellQuote(abs)} --slug ${receipt.slug}`;
  if (o.json) return printJson({ ...receipt, path: abs, updateCommand });
  const status = receipt.unchanged ? "unchanged" : receipt.version === 1 ? "new doc" : "new version";
  console.log(receipt.url);
  console.log(`  v${receipt.version} (${status}) · pinned: ${receipt.versionUrl}`);
  if (remembered && !receipt.unchanged) {
    console.log("  (updated the doc this path was last uploaded to; pass --new for a separate doc)");
  }
  console.log(`  update with: ${updateCommand}`);
}

async function get(argv: string[]) {
  const { values: o, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { ...common, v: { type: "string" } },
  });
  if (positionals.length !== 1) throw new Error("usage: tack get <slug|url> [--v n]");
  const cfg = await loadConfig(o.url);
  const ref = positionals[0];
  const isUrl = /^https?:\/\//i.test(ref);
  if (isUrl && o.v) throw new Error("--v only works with a slug; for a URL, use its /v/<n>/ form");
  const url = isUrl
    ? new URL(ref)
    : new URL(`/${ref.replace(/^\/+|\/+$/g, "")}/${o.v ? `v/${o.v}/` : ""}`, cfg.url);
  url.hash = "";
  url.searchParams.set("raw", "1");
  const res = await request(cfg, url.href);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.href}`);
  const version = res.headers.get("x-tack-version");
  if (version) {
    const slug = res.headers.get("x-tack-slug");
    process.stderr.write(`# ${slug} v${version} of ${res.headers.get("x-tack-latest-version")}\n`);
  }
  await Bun.write(Bun.stdout, await res.arrayBuffer());
}

async function list(argv: string[]) {
  const { values: o } = parseArgs({ args: argv, options: common });
  const cfg = await loadConfig(o.url);
  const { docs } = await api<{ docs: DocSummary[] }>(cfg, "/api/docs");
  if (o.json) return printJson(docs);
  if (!docs.length) return console.log("no docs yet");
  const width = Math.max(...docs.map((d) => d.slug.length));
  for (const d of docs) {
    const when = d.updatedAt.slice(0, 16).replace("T", " ");
    console.log(`${d.slug.padEnd(width)}  ${`v${d.latest}`.padEnd(4)}  ${when}  ${d.title}`);
  }
}

async function rm(argv: string[]) {
  const { values: o, positionals } = parseArgs({ args: argv, allowPositionals: true, options: common });
  if (positionals.length !== 1) throw new Error("usage: tack rm <slug>");
  const cfg = await loadConfig(o.url);
  const slug = positionals[0];
  await api(cfg, `/api/docs/${encodeURIComponent(slug)}`, { method: "DELETE" });
  if (o.json) return printJson({ ok: true, slug, deleted: true });
  console.log(`deleted ${slug}`);
}

async function setup(argv: string[]) {
  const { values: o } = parseArgs({
    args: argv,
    options: { ...common, "client-id": { type: "string" }, "client-secret": { type: "string" } },
  });
  const current = ((await readJson(CONFIG_FILE)) ?? {}) as Partial<Config>;
  const interactive = Boolean(process.stdin.isTTY);
  const ask = (question: string, fallback = "", shown = fallback) => {
    if (!interactive) return fallback;
    const answer = prompt(shown ? `${question} [${shown}]:` : `${question}:`)?.trim();
    return answer || fallback;
  };
  const url = (o.url || ask("Instance URL", current.url || DEFAULT_URL)).replace(/\/+$/, "");
  const clientId = o["client-id"] || ask("Access service token Client ID", current.clientId);
  const clientSecret =
    o["client-secret"] ||
    ask("Access service token Client Secret", current.clientSecret, current.clientSecret ? "keep current" : "");
  if (!clientId || !clientSecret) throw new Error("need a Client ID and Client Secret (--client-id / --client-secret)");

  const saved = { ...(url !== DEFAULT_URL && { url }), clientId, clientSecret };
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_FILE, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
  await chmod(CONFIG_FILE, 0o600);
  console.log(`saved ${CONFIG_FILE}`);

  const { docs } = await api<{ docs: DocSummary[] }>({ url, clientId, clientSecret }, "/api/docs");
  console.log(`connected to ${url} (${docs.length} doc${docs.length === 1 ? "" : "s"})`);
}

async function loadConfig(flagUrl?: string): Promise<Config> {
  const file = ((await readJson(CONFIG_FILE)) ?? {}) as Partial<Config>;
  return {
    url: (flagUrl || process.env.TACK_URL || file.url || DEFAULT_URL).replace(/\/+$/, ""),
    clientId: process.env.TACK_CLIENT_ID || file.clientId || "",
    clientSecret: process.env.TACK_CLIENT_SECRET || file.clientSecret || "",
  };
}

async function request(cfg: Config, target: string, init: RequestInit = {}): Promise<Response> {
  let url = new URL(target, `${cfg.url}/`);
  const origin = new URL(cfg.url).origin;
  for (let hop = 0; hop < 5; hop++) {
    const headers = new Headers(init.headers);
    if (url.origin === origin && cfg.clientId) {
      headers.set("cf-access-client-id", cfg.clientId);
      headers.set("cf-access-client-secret", cfg.clientSecret);
    }
    let res: Response;
    try {
      res = await fetch(url, { ...init, headers, redirect: "manual" });
    } catch (err) {
      throw new Error(`could not reach ${url.origin}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      const next = new URL(location, url);
      if (next.hostname.endsWith(".cloudflareaccess.com") || next.pathname.startsWith("/cdn-cgi/access/")) {
        throw accessError(cfg);
      }
      url = next;
      continue;
    }
    if (res.status === 401 || (res.status === 403 && !res.headers.get("content-type")?.includes("json"))) {
      throw accessError(cfg);
    }
    return res;
  }
  throw new Error("too many redirects");
}

async function api<T>(cfg: Config, pathname: string, init?: RequestInit): Promise<T> {
  const res = await request(cfg, pathname, init);
  const body = (await res.json().catch(() => null)) as ({ ok?: boolean; error?: string } & T) | null;
  if (!body) throw new HttpError(`unexpected HTTP ${res.status} from ${cfg.url}${pathname}`, res.status);
  if (!res.ok || !body.ok) throw new HttpError(body.error || `HTTP ${res.status}`, res.status);
  return body;
}

function accessError(cfg: Config) {
  return new Error(
    cfg.clientId
      ? "Cloudflare Access rejected the service token. Check the Access app has a Service Auth policy that includes it."
      : "Cloudflare Access wants a login. Run `tack setup` to add a service token.",
  );
}

async function collect(abs: string): Promise<Record<string, Uint8Array>> {
  const st = await stat(abs).catch(() => null);
  if (!st) throw new Error(`no such file or folder: ${abs}`);
  const files: Record<string, Uint8Array> = Object.create(null);
  if (st.isFile()) {
    if (!/\.html?$/i.test(abs)) throw new Error("upload an .html file, or a folder containing index.html");
    files["index.html"] = await Bun.file(abs).bytes();
  } else {
    for await (const rel of new Bun.Glob("**").scan({ cwd: abs, onlyFiles: true })) {
      const key = rel.split(path.sep).join("/");
      if (key.split("/").includes("node_modules")) continue;
      files[key] = await Bun.file(path.join(abs, rel)).bytes();
    }
    if (!Object.hasOwn(files, "index.html")) throw new Error(`${abs} has no index.html`);
  }
  const count = Object.keys(files).length;
  if (count > MAX_FILES) throw new Error(`${count} files; the limit is ${MAX_FILES} per upload`);
  const total = Object.values(files).reduce((n, bytes) => n + bytes.byteLength, 0);
  if (total > MAX_UPLOAD_BYTES) throw new Error(`upload is ${(total / 1048576).toFixed(1)} MB; the limit is 30 MB`);
  return files;
}

function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!m) return "";
  return decodeEntities(m[1].replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300)
    .toWellFormed();
}

function decodeEntities(s: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return named[e.toLowerCase()] ?? whole;
  });
}

function makeSlug(base: string): string {
  const stem =
    base
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+/, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "doc";
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const suffix = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => alphabet[b % alphabet.length]).join("");
  return `${stem}-${suffix}`;
}

function sha256(s: string): string {
  return new Bun.CryptoHasher("sha256").update(s).digest("hex");
}

async function readText(file: string): Promise<string | null> {
  const f = Bun.file(file);
  return (await f.exists()) ? f.text() : null;
}

async function readJson(file: string): Promise<unknown> {
  const text = await readText(file);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`could not parse ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function printJson(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message: string): never {
  if (process.argv.includes("--json")) printJson({ ok: false, error: message });
  else process.stderr.write(`tack: ${message}\n`);
  process.exit(1);
}
