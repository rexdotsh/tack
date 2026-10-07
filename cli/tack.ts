#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, realpath, rename, rm as removeFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

const DEFAULT_URL = "https://tack.rex.wf";
const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "tack");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
const MAX_FILES = 200;
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const common = { url: { type: "string" }, json: { type: "boolean" } } as const;

const HELP = `tack - publish HTML docs to your tack instance

Usage:
  tack upload <file.html|dir|-> [--slug <slug>] [--new] [--title <t>] [--note <n>] [--json]
  tack get <slug|url> [--v <n>]     print a doc's HTML to stdout
  tack list [--match <words>] [--json]  find docs by title or slug
  tack open [slug]                  open a doc in your browser; no slug: unlock the doc list
  tack rm <slug> [--v <n>]          delete a doc, or just one version of it
  tack mv <slug> <new-slug>         rename a doc (old links stop working)
  tack update                       update this CLI (and the skill) from your instance
  tack setup [--token <t>|--rotate] save + set the token on the Worker (--token: just save; --rotate: new token)

upload:
  A file is published as the doc's index.html, along with the local images, css
  and pages it references (from its own folder down). A folder must contain
  index.html; everything in it is published. "-" reads one HTML page from stdin.
  --slug <s>   publish to this slug: creates it, or adds a version if it exists
               (pick your own and the link is guessable; new docs get a random one)
  --new        always create a new doc (with --slug: fail if the slug is taken)
               with neither, re-uploading the same path updates the same doc
  --title <t>  doc title (default: the page's <title> or first <h1>)
  --note <n>   what changed in this version, shown in the history
  --json       machine-readable receipt

Every command accepts --url <url>. Precedence: --url, $TACK_URL, config file, ${DEFAULT_URL}.
Config: ${CONFIG_FILE}  (env overrides: TACK_URL, TACK_TOKEN)
`;

type Config = { url: string; token: string };
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
  status: number;
  body: Record<string, unknown>;
  constructor(message: string, status: number, body: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

const commands: Record<string, (argv: string[]) => Promise<void>> = { upload, get, list, open, rm, mv, update, setup };
const [cmd, ...rest] = process.argv.slice(2);

if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
  process.stdout.write(HELP);
} else if (!commands[cmd]) {
  fail(`unknown command "${cmd}" (try: tack help)`);
} else {
  commands[cmd](rest).catch((err) => fail(err instanceof Error ? err.message : String(err)));
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
    throw new Error("usage: tack upload <file.html|dir|-> [--slug s] [--new] [--title t] [--note n] [--json]");
  }
  const cfg = await loadConfig(o.url);
  const stdin = positionals[0] === "-";
  const abs = stdin ? "" : path.resolve(positionals[0]);
  const files = stdin ? await readStdin() : await collect(abs);
  const title = o.title ?? extractTitle(new TextDecoder().decode(files["index.html"]));

  const mapFile = path.join(CONFIG_DIR, "paths", sha256(`${cfg.url}\n${abs}`).slice(0, 32));
  let slug = o.slug?.toLowerCase();
  let remembered = false;
  if (!slug && !o.new && !stdin) {
    slug = (await readText(mapFile))?.split("\n")[0].trim() || undefined;
    remembered = Boolean(slug);
  }
  const auto = !slug;
  const hashes = Object.fromEntries(Object.entries(files).map(([p, bytes]) => [p, sha256(bytes)]));
  const body = JSON.stringify({
    files: hashes,
    size: Object.values(files).reduce((n, bytes) => n + bytes.byteLength, 0),
    title: title || undefined,
    note: o.note || undefined,
    create: Boolean(o.new) || auto,
  });
  const commit = () =>
    api<Receipt>(cfg, `/api/docs/${encodeURIComponent(slug!)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

  let receipt: Receipt;
  for (let attempt = 0; ; attempt++) {
    if (auto) slug = makeSlug();
    try {
      receipt = await commit().catch(async (err) => {
        if (!(err instanceof HttpError) || err.status !== 428) throw err;
        await sendBlobs(cfg, slug!, files, hashes, err.body.missing as string[]);
        return commit();
      });
      break;
    } catch (err) {
      if (auto && err instanceof HttpError && err.status === 409 && attempt < 3) continue;
      throw err;
    }
  }

  if (!stdin) {
    await mkdir(path.dirname(mapFile), { recursive: true });
    await writeFile(mapFile, `${receipt.slug}\n${cfg.url}\n`);
  }

  const updateCommand = `tack upload ${stdin ? "-" : shellQuote(abs)} --slug ${receipt.slug}`;
  const extras = Object.keys(files).filter((p) => p !== "index.html");
  if (o.json) return printJson({ ...receipt, path: stdin ? null : abs, files: Object.keys(files), updateCommand });
  const status = receipt.unchanged ? "unchanged" : receipt.version === 1 ? "new doc" : "new version";
  const copied = process.stdout.isTTY && (await copy(receipt.url));
  console.log(`${receipt.url}${copied ? "  (copied)" : ""}`);
  console.log(`  v${receipt.version} (${status}) · pinned: ${receipt.versionUrl}`);
  if (extras.length && !stdin && (await stat(abs)).isFile()) {
    const shown = extras.slice(0, 5).join(", ");
    console.log(`  + ${shown}${extras.length > 5 ? `, and ${extras.length - 5} more` : ""}`);
  }
  if (remembered && !receipt.unchanged) {
    console.log("  (updated the doc this path was last uploaded to; pass --new for a separate doc)");
  }
  console.log(`  update with: ${updateCommand}`);
}

async function sendBlobs(
  cfg: Config,
  slug: string,
  files: Record<string, Uint8Array>,
  hashes: Record<string, string>,
  missing: string[],
) {
  const byHash = new Map(Object.entries(hashes).map(([p, h]) => [h, files[p]]));
  const queue = [...new Set(missing)];
  const worker = async () => {
    for (let hash; (hash = queue.shift()); ) {
      const bytes = byHash.get(hash);
      if (!bytes) throw new Error(`server asked for an unknown file ${hash}`);
      for (let attempt = 1; ; attempt++) {
        try {
          await api(cfg, `/api/docs/${encodeURIComponent(slug)}/blobs/${hash}`, { method: "PUT", body: bytes });
          break;
        } catch (err) {
          if (attempt >= 4 || !(err instanceof HttpError) || err.status !== 503) throw err;
          await sleep(1000 * attempt);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
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
  process.stdout.write(Buffer.from(await res.arrayBuffer()));
}

async function list(argv: string[]) {
  const { values: o } = parseArgs({ args: argv, options: { ...common, match: { type: "string" } } });
  const cfg = await loadConfig(o.url);
  const terms = (o.match ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const docs = (await api<{ docs: DocSummary[] }>(cfg, "/api/docs")).docs.filter((d) =>
    terms.every((t) => `${d.title} ${d.slug}`.toLowerCase().includes(t)),
  );
  if (o.json) return printJson(docs);
  if (!docs.length) return console.log(terms.length ? "no matching docs" : "no docs yet");
  const width = Math.max(...docs.map((d) => d.slug.length));
  for (const d of docs) {
    const when = d.updatedAt.slice(0, 16).replace("T", " ");
    console.log(`${d.slug.padEnd(width)}  ${`v${d.latest}`.padEnd(4)}  ${when}  ${d.title}`);
  }
}

async function rm(argv: string[]) {
  const { values: o, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { ...common, v: { type: "string" } },
  });
  if (positionals.length !== 1) throw new Error("usage: tack rm <slug> [--v n]");
  const cfg = await loadConfig(o.url);
  const slug = positionals[0];
  const target = `/api/docs/${encodeURIComponent(slug)}${o.v ? `/v/${Number(o.v)}` : ""}`;
  const res = await api<{ latest?: number }>(cfg, target, { method: "DELETE" });
  if (o.json) return printJson(res);
  console.log(o.v ? `deleted ${slug} v${o.v} (latest is now v${res.latest})` : `deleted ${slug}`);
}

async function mv(argv: string[]) {
  const { values: o, positionals } = parseArgs({ args: argv, allowPositionals: true, options: common });
  if (positionals.length !== 2) throw new Error("usage: tack mv <slug> <new-slug>");
  const cfg = await loadConfig(o.url);
  const [from, to] = positionals;
  const res = await api<{ slug: string; url: string }>(cfg, `/api/docs/${encodeURIComponent(from)}/rename`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to }),
  });
  const dir = path.join(CONFIG_DIR, "paths");
  for (const name of await readdir(dir).catch(() => [])) {
    const file = path.join(dir, name);
    const [mapped, url = cfg.url] = ((await readText(file)) ?? "").split("\n");
    if (mapped.trim() === from && (url.trim() || cfg.url) === cfg.url) await writeFile(file, `${res.slug}\n${cfg.url}\n`);
  }
  if (o.json) return printJson(res);
  console.log(res.url);
}

async function open(argv: string[]) {
  const { values: o, positionals } = parseArgs({ args: argv, allowPositionals: true, options: common });
  const cfg = await loadConfig(o.url);
  const ref = positionals[0];
  let target: string;
  if (ref) target = new URL(/^https?:\/\//i.test(ref) ? ref : `${cfg.url}/${ref.replace(/^\/+|\/+$/g, "")}/`).href;
  else if (cfg.token) target = `${cfg.url}/login?key=${sha256(`${cfg.token}:view`)}`;
  else throw new Error("no token yet (run `tack setup`)");
  if (!/^https?:$/.test(new URL(target).protocol)) throw new Error("can only open http(s) links");
  console.log(target);
  const gui = process.platform === "darwin" || process.env.DISPLAY || process.env.WAYLAND_DISPLAY;
  const launcher = process.platform === "darwin" ? "open" : process.platform === "linux" && gui ? "xdg-open" : null;
  if (launcher) spawn(launcher, [target], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

function run(cmd: string[], opts: { input?: string; cwd?: string; inherit?: boolean } = {}): Promise<number> {
  return new Promise((resolve) => {
    const out = opts.inherit ? "inherit" : "ignore";
    const child = spawn(cmd[0], cmd.slice(1), { cwd: opts.cwd, stdio: [opts.input === undefined ? "ignore" : "pipe", out, out] });
    child.on("error", () => resolve(-1));
    child.on("close", (code) => resolve(code ?? -1));
    child.stdin?.on("error", () => {});
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

async function copy(text: string): Promise<boolean> {
  const candidates =
    process.platform === "darwin"
      ? [["pbcopy"]]
      : process.platform === "win32"
        ? [["clip"]]
        : [
            ...(process.env.WAYLAND_DISPLAY ? [["wl-copy"]] : []),
            ...(process.env.DISPLAY ? [["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]] : []),
          ];
  for (const cmd of candidates) {
    if ((await run(cmd, { input: text })) === 0) return true;
  }
  return false;
}

async function update(argv: string[]) {
  const { values: o } = parseArgs({ args: argv, options: common });
  const cfg = await loadConfig(o.url);
  const self = await realpath(process.argv[1]);
  const repo = await gitRoot(self);
  if (repo) throw new Error(`${self} is in a git checkout (${repo}); use git pull instead`);
  const targets: [string, string][] = [["/cli", self]];
  const skill = path.join(homedir(), ".agents", "skills", "tack", "SKILL.md");
  if ((await lstat(skill).catch(() => null))?.isFile()) {
    const real = await realpath(skill);
    if (!(await gitRoot(real))) targets.push(["/skill.md", real]);
  }
  for (const [route, file] of targets) {
    const res = await request(cfg, route);
    const body = await res.text();
    if (!res.ok || (route === "/cli" && !body.startsWith("#!/usr/bin/env"))) throw new Error(`couldn't download ${cfg.url}${route}`);
    const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.new`;
    await writeFile(temp, body, { flag: "wx", mode: route === "/cli" ? 0o755 : 0o644 });
    await rename(temp, file).catch(async (err) => {
      await removeFile(temp, { force: true });
      throw err;
    });
    console.log(`updated ${file}`);
  }
}

async function gitRoot(file: string): Promise<string | null> {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    if (await stat(path.join(dir, ".git")).catch(() => null)) return dir;
    if (path.dirname(dir) === dir) return null;
  }
}

async function setup(argv: string[]) {
  const { values: o } = parseArgs({
    args: argv,
    options: { ...common, token: { type: "string" }, rotate: { type: "boolean" } },
  });
  const current = ((await readJson(CONFIG_FILE)) ?? {}) as Partial<Config>;
  const url = instanceUrl(o.url || process.env.TACK_URL || current.url || DEFAULT_URL);
  const token =
    o.token || (!o.rotate && current.token) || randomBytes(32).toString("base64url");

  if (o.token) {
    await connect({ url, token }, 1);
  } else {
    console.log("setting TACK_TOKEN on the Worker with wrangler...");
    const repo = path.join(path.dirname(await realpath(process.argv[1])), "..");
    if ((await run(["bunx", "wrangler", "secret", "put", "TACK_TOKEN"], { input: token, cwd: repo, inherit: true })) !== 0) {
      throw new Error(
        "wrangler failed. Is the Worker deployed and are you logged in (`bunx wrangler login`)? With several Cloudflare accounts, set CLOUDFLARE_ACCOUNT_ID.",
      );
    }
  }

  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_FILE, `${JSON.stringify({ ...(url !== DEFAULT_URL && { url }), token }, null, 2)}\n`, { mode: 0o600 });
  await chmod(CONFIG_FILE, 0o600);
  console.log(`saved ${CONFIG_FILE}`);
  if (!o.token) await connect({ url, token }, 6);
}

async function connect(cfg: Config, tries: number) {
  for (let attempt = 1; ; attempt++) {
    try {
      const { docs } = await api<{ docs: DocSummary[] }>(cfg, "/api/docs");
      console.log(`connected to ${cfg.url} (${docs.length} doc${docs.length === 1 ? "" : "s"}). Run \`tack open\` to unlock the doc list.`);
      return;
    } catch (err) {
      if (attempt >= tries || !(err instanceof HttpError) || ![401, 503].includes(err.status)) throw err;
      await sleep(2000);
    }
  }
}

async function loadConfig(flagUrl?: string): Promise<Config> {
  const file = ((await readJson(CONFIG_FILE)) ?? {}) as Partial<Config>;
  return {
    url: instanceUrl(flagUrl || process.env.TACK_URL || file.url || DEFAULT_URL),
    token: process.env.TACK_TOKEN || file.token || "",
  };
}

function instanceUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:" && !LOCAL_HOSTS.includes(url.hostname)) {
    throw new Error(`${raw}: use https (plain http is only allowed for localhost)`);
  }
  return raw.replace(/\/+$/, "");
}

async function request(cfg: Config, target: string, init: RequestInit = {}): Promise<Response> {
  let url = new URL(target, `${cfg.url}/`);
  const origin = new URL(cfg.url).origin;
  for (let hop = 0; hop < 5; hop++) {
    const headers = new Headers(init.headers);
    if (url.origin === origin && cfg.token) headers.set("authorization", `Bearer ${cfg.token}`);
    let res: Response;
    try {
      res = await fetch(url, { ...init, headers, redirect: "manual" });
    } catch (err) {
      throw new Error(`could not reach ${url.origin}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !location) return res;
    url = new URL(location, url);
    if (url.protocol !== "https:" && !LOCAL_HOSTS.includes(url.hostname)) throw new Error(`refusing to follow a redirect to ${url.origin}`);
  }
  throw new Error("too many redirects");
}

async function api<T>(cfg: Config, pathname: string, init?: RequestInit): Promise<T> {
  const res = await request(cfg, pathname, init);
  const body = (await res.json().catch(() => null)) as ({ ok?: boolean; error?: string } & T) | null;
  if (!body) throw new HttpError(`unexpected HTTP ${res.status} from ${cfg.url}${pathname}`, res.status);
  if (!res.ok || !body.ok) throw new HttpError(body.error || `HTTP ${res.status}`, res.status, body);
  return body;
}

async function collect(abs: string): Promise<Record<string, Uint8Array>> {
  const st = await stat(abs).catch(() => null);
  if (!st) throw new Error(`no such file or folder: ${abs}`);
  const files: Record<string, Uint8Array> = Object.create(null);
  if (st.isFile()) {
    if (!/\.html?$/i.test(abs)) throw new Error("upload an .html file, or a folder containing index.html");
    await collectFile(abs, files);
  } else {
    for (const rel of await walk(abs)) files[rel] = await readFile(path.join(abs, ...rel.split("/")));
    if (!Object.hasOwn(files, "index.html")) throw new Error(`${abs} has no index.html`);
  }
  const count = Object.keys(files).length;
  if (count > MAX_FILES) throw new Error(`${count} files; the limit is ${MAX_FILES} per upload`);
  const total = Object.values(files).reduce((n, bytes) => n + bytes.byteLength, 0);
  if (total > MAX_UPLOAD_BYTES) throw new Error(`upload is ${(total / 1048576).toFixed(1)} MB; the limit is 30 MB`);
  return files;
}

async function walk(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    if (ent.name.startsWith(".") || ent.name === "node_modules") continue;
    if (ent.isDirectory()) out.push(...(await walk(path.join(dir, ent.name), `${prefix}${ent.name}/`)));
    else if (ent.isFile()) out.push(`${prefix}${ent.name}`);
  }
  return out;
}

async function readStdin(): Promise<Record<string, Uint8Array>> {
  if (process.stdin.isTTY) throw new Error("pipe the HTML in, e.g. `cat page.html | tack upload -`");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_UPLOAD_BYTES) throw new Error("stdin is over the 30 MB limit");
    chunks.push(chunk);
  }
  if (!size) throw new Error("nothing on stdin");
  return { "index.html": Buffer.concat(chunks) };
}

async function collectFile(abs: string, files: Record<string, Uint8Array>) {
  const root = await realpath(path.dirname(abs));
  const main = path.basename(abs);
  const html = await readFile(abs);
  files["index.html"] = html;
  const seen = new Set(["index.html", main]);
  const queue: [string, Uint8Array][] = [[main, html]];
  while (queue.length) {
    const [rel, bytes] = queue.shift()!;
    const ext = path.extname(rel).toLowerCase();
    if (![".html", ".htm", ".css"].includes(ext)) continue;
    for (const ref of localRefs(new TextDecoder().decode(bytes), ext === ".css")) {
      if (ref.includes("\\")) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), ref));
      if (target === main && main !== "index.html") files[main] = html;
      if (seen.has(target) || target.split("/").some((seg) => seg.startsWith("."))) continue;
      seen.add(target);
      const real = await realpath(path.join(root, ...target.split("/"))).catch(() => null);
      if (!real?.startsWith(root + path.sep) || !(await stat(real)).isFile()) continue;
      const data = await readFile(real);
      files[target] = data;
      queue.push([target, data]);
    }
  }
}

function localRefs(text: string, css: boolean): string[] {
  const refs: string[] = [];
  const add = (raw = "") => {
    const ref = decodeEntities(raw).trim().replace(/[?#].*$/, "");
    if (!ref || /^([a-z][a-z0-9+.-]*:|\/)/i.test(ref)) return;
    try {
      refs.push(decodeURIComponent(ref));
    } catch {
      refs.push(ref);
    }
  };
  const value = (m: RegExpMatchArray) => m[2] ?? m[3] ?? m[4];
  for (const m of text.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)) add(m[2]);
  for (const m of text.matchAll(/@import\s+(['"])([^'"]+)\1/gi)) add(m[2]);
  if (!css) {
    for (const m of text.matchAll(/\s(src|href|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) add(value(m));
    for (const m of text.matchAll(/\s(srcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
      for (const part of (value(m) ?? "").split(",")) add(part.trim().split(/\s+/)[0]);
    }
  }
  return refs;
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

function makeSlug(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(randomBytes(10), (b) => alphabet[b % alphabet.length]).join("");
}

function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
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

function fail(message: string) {
  if (process.argv.includes("--json")) printJson({ ok: false, error: message });
  else process.stderr.write(`tack: ${message}\n`);
  process.exitCode = 1;
}
