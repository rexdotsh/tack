interface Env {
  BUCKET: R2Bucket;
  TACK_TOKEN?: string;
}

type Version = { n: number; at: string; hash: string; size: number; files: Record<string, string>; note?: string };
type Meta = { slug: string; title: string; createdAt: string; updatedAt: string; versions: Version[] };
type DocSummary = { slug: string; title: string; updatedAt: string; latest: number; versions: number };
type UploadBody = { files?: Record<string, unknown>; title?: string; note?: string; create?: boolean };

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MAX_FILES = 200;
const RESERVED_SLUGS = new Set(["api", "login"]);
const metaKey = (slug: string) => `meta/${slug}.json`;
const blobKey = (slug: string, hash: string) => `blobs/${slug}/${hash}`;

export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url);
    let res: Response;
    try {
      res = await route(req, env, url);
    } catch (err) {
      console.error(err);
      res = text(`tack: internal error: ${err instanceof Error ? err.message : String(err)}`, 500);
    }
    const out = new Response(res.body, res);
    out.headers.set("x-robots-tag", "noindex, nofollow");
    out.headers.set("referrer-policy", "no-referrer");
    return out;
  },
} satisfies ExportedHandler<Env>;

async function route(req: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === "/robots.txt") return text("User-agent: *\nDisallow: /\n");
  if (url.pathname === "/login") return login(env, url);
  if (url.pathname === "/") return (await isViewer(req, env)) ? indexPage(env) : locked();
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    if (!env.TACK_TOKEN) return fail(503, "the TACK_TOKEN secret is not set on the Worker (run `tack setup`)");
    const token = req.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1];
    if (!(await same(token, env.TACK_TOKEN))) return fail(401, "bad or missing token (run `tack setup`)");
    return api(req, env, url);
  }
  return serveDoc(req, env, url);
}

async function viewKey(env: Env): Promise<string | null> {
  return env.TACK_TOKEN ? sha256(new TextEncoder().encode(`${env.TACK_TOKEN}:view`)) : null;
}

async function isViewer(req: Request, env: Env): Promise<boolean> {
  const key = await viewKey(env);
  const cookie = req.headers.get("cookie")?.match(/(?:^|;\s*)tack=([^;]*)/)?.[1];
  return key !== null && (await same(cookie, key));
}

async function login(env: Env, url: URL): Promise<Response> {
  const key = await viewKey(env);
  if (!key || !(await same(url.searchParams.get("key"), key))) return locked();
  return new Response(null, {
    status: 302,
    headers: { location: "/", "set-cookie": `tack=${key}; Max-Age=31536000; Path=/; HttpOnly; Secure; SameSite=Lax` },
  });
}

async function same(given: string | null | undefined, expected: string): Promise<boolean> {
  if (!given) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

async function api(req: Request, env: Env, url: URL): Promise<Response> {
  const m = url.pathname.match(/^\/api\/docs(?:\/([^/]+))?\/?$/);
  if (!m) return fail(404, "not found");
  const slug = m[1];

  if (!slug) {
    if (req.method !== "GET") return fail(405, "method not allowed");
    const docs = await listDocs(env);
    return json({ ok: true, docs: docs.map((d) => ({ ...d, url: `${url.origin}/${d.slug}/` })) });
  }
  if (req.method === "GET") {
    const meta = await getMeta(env, slug);
    if (!meta) return fail(404, `no doc called "${slug}"`);
    return json({ ok: true, url: `${url.origin}/${slug}/`, ...meta });
  }
  if (req.method === "POST") return upload(req, env, url.origin, slug);
  if (req.method === "DELETE") return remove(env, slug);
  return fail(405, "method not allowed");
}

async function upload(req: Request, env: Env, origin: string, slug: string): Promise<Response> {
  if (!SLUG_RE.test(slug) || RESERVED_SLUGS.has(slug)) {
    return fail(400, "slug must be 1-64 chars of a-z, 0-9 and '-' (not starting/ending with '-'), and not 'api' or 'login'");
  }
  const body = await req.json<UploadBody>().catch(() => null);
  if (!body?.files || typeof body.files !== "object") return fail(400, "expected JSON { files: { path: base64 } }");
  const entries = Object.entries(body.files);
  if (entries.length > MAX_FILES) return fail(413, `an upload can have at most ${MAX_FILES} files`);

  const files: Record<string, string> = Object.create(null);
  const blobs = new Map<string, Uint8Array>();
  let size = 0;
  for (const [raw, b64] of entries) {
    const path = cleanPath(raw);
    if (!path) return fail(400, `bad file path "${raw}" (no '..', and the first segment can't be 'v' or '_history')`);
    if (typeof b64 !== "string") return fail(400, `file "${raw}" must be a base64 string`);
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.fromBase64(b64);
    } catch {
      return fail(400, `file "${raw}" is not valid base64`);
    }
    const hash = await sha256(bytes);
    files[path] = hash;
    blobs.set(hash, bytes);
    size += bytes.byteLength;
  }
  if (!Object.hasOwn(files, "index.html")) return fail(400, "an upload needs an index.html");

  await Promise.all(
    [...blobs].map(async ([hash, bytes]) => {
      const key = blobKey(slug, hash);
      if (!(await env.BUCKET.head(key))) await env.BUCKET.put(key, bytes);
    }),
  );

  const versionHash = await sha256(
    new TextEncoder().encode(Object.keys(files).sort().map((p) => `${p}\0${files[p]}`).join("\n")),
  );
  const title = body.title?.trim().slice(0, 300).toWellFormed();
  const note = body.note?.trim().slice(0, 1000).toWellFormed();

  for (let attempt = 0; attempt < 5; attempt++) {
    const now = new Date().toISOString();
    const existing = await env.BUCKET.get(metaKey(slug));
    if (existing && body.create) return fail(409, `slug "${slug}" is already taken`);
    const meta: Meta = existing
      ? await existing.json<Meta>()
      : { slug, title: slug, createdAt: now, updatedAt: now, versions: [] };

    const latest = meta.versions.at(-1);
    if (latest && latest.hash === versionHash) return json(receipt(origin, meta, latest, true));

    const version: Version = { n: (latest?.n ?? 0) + 1, at: now, hash: versionHash, size, files };
    if (note) version.note = note;
    meta.versions.push(version);
    meta.title = title || meta.title;
    meta.updatedAt = now;

    let saved: R2Object | null;
    try {
      saved = await env.BUCKET.put(metaKey(slug), JSON.stringify(meta), {
        onlyIf: existing ? { etagMatches: existing.etag } : new Headers({ "if-none-match": "*" }),
        httpMetadata: { contentType: "application/json" },
        customMetadata: {
          title: encodeURIComponent(meta.title.slice(0, 120).toWellFormed()),
          updatedAt: now,
          latest: String(version.n),
          versions: String(meta.versions.length),
        },
      });
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    if (saved) return json(receipt(origin, meta, version, false), existing ? 200 : 201);
    if (body.create) return fail(409, `slug "${slug}" is already taken`);
  }
  return fail(503, "too many concurrent uploads to this slug; retry");
}

function receipt(origin: string, meta: Meta, v: Version, unchanged: boolean) {
  const base = `${origin}/${meta.slug}/`;
  return {
    ok: true,
    slug: meta.slug,
    title: meta.title,
    version: v.n,
    versions: meta.versions.length,
    unchanged,
    url: base,
    versionUrl: `${base}v/${v.n}/`,
    historyUrl: `${base}_history`,
  };
}

async function remove(env: Env, slug: string): Promise<Response> {
  if (!SLUG_RE.test(slug) || !(await env.BUCKET.head(metaKey(slug)))) return fail(404, `no doc called "${slug}"`);
  await env.BUCKET.delete(metaKey(slug));
  let cursor: string | undefined;
  do {
    const page = await env.BUCKET.list({ prefix: `blobs/${slug}/`, cursor });
    if (page.objects.length) await env.BUCKET.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return json({ ok: true, slug, deleted: true });
}

async function getMeta(env: Env, slug: string): Promise<Meta | null> {
  if (!SLUG_RE.test(slug)) return null;
  const obj = await env.BUCKET.get(metaKey(slug));
  return obj ? obj.json<Meta>() : null;
}

async function listDocs(env: Env): Promise<DocSummary[]> {
  const docs: DocSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.BUCKET.list({ prefix: "meta/", include: ["customMetadata"], cursor });
    for (const o of page.objects) {
      const m = o.customMetadata ?? {};
      const slug = o.key.slice("meta/".length, -".json".length);
      let title = slug;
      try {
        title = decodeURIComponent(m.title ?? "") || slug;
      } catch {}
      docs.push({
        slug,
        title,
        updatedAt: m.updatedAt ?? o.uploaded.toISOString(),
        latest: Number(m.latest ?? 0),
        versions: Number(m.versions ?? 0),
      });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return docs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function serveDoc(req: Request, env: Env, url: URL): Promise<Response> {
  const [, slug, rest] = url.pathname.match(/^\/([^/]+)(\/.*)?$/) ?? [];
  if (!slug || !SLUG_RE.test(slug)) return notFound();
  if (rest === undefined) return redirect(`/${slug}/${url.search}`);
  const meta = await getMeta(env, slug);
  if (!meta) return notFound(`No doc called “${slug}”.`);

  let sub = rest.slice(1);
  if (sub === "_history") return html(historyPage(meta));

  const latestN = meta.versions.at(-1)!.n;
  let version = meta.versions.at(-1)!;
  const vm = sub.match(/^v\/(\d+)(\/.*)?$/);
  if (vm) {
    const found = meta.versions.find((v) => v.n === Number(vm[1]));
    if (!found) return notFound(`${slug} has no version ${vm[1]}.`, slug);
    if (vm[2] === undefined) return redirect(`/${slug}/v/${found.n}/${url.search}`);
    version = found;
    sub = vm[2].slice(1);
  }

  let path: string;
  try {
    path = decodeURIComponent(sub);
  } catch {
    return notFound();
  }
  const has = (p: string) => Object.hasOwn(version.files, p);
  if (path === "" || path.endsWith("/")) path += "index.html";
  else if (!has(path)) {
    if (has(`${path}.html`)) path += ".html";
    else if (has(`${path}/index.html`)) return redirect(`${url.pathname}/${url.search}`);
  }
  if (!has(path)) return notFound(`${slug} v${version.n} has no file “${path}”.`, slug);
  const hash = version.files[path];

  const type = contentType(path);
  const inject =
    meta.versions.length > 1 &&
    type.startsWith("text/html") && !url.searchParams.has("raw") && req.headers.get("sec-fetch-dest") === "document";
  const etag = `"${hash.slice(0, 32)}${inject ? `-${BAR_REV}-${version.n}of${latestN}` : ""}"`;
  const headers = new Headers({
    "content-type": type,
    "cache-control": "private, no-cache, no-transform",
    etag,
    vary: "sec-fetch-dest",
    "x-tack-slug": slug,
    "x-tack-version": String(version.n),
    "x-tack-latest-version": String(latestN),
  });
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });

  const obj = await env.BUCKET.get(blobKey(slug, hash));
  if (!obj) return notFound(`Missing blob for ${slug} v${version.n} “${path}”.`, slug);
  const res = new Response(obj.body, { headers });
  return inject ? withVersionBar(res, { slug, n: version.n, latest: latestN, sub, at: version.at, note: version.note ?? "" }) : res;
}

const BAR_JS = `(function (d) {
  var e = function (s) { return String(s).replace(/[&"'<>]/g, function (c) { return "&#" + c.charCodeAt(0) + ";"; }); };
  var base = "/" + d.slug + "/";
  var href = function (n) { return n === d.latest ? base + d.sub : base + "v/" + n + "/" + d.sub; };
  var icon = function (p) { return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + p + '"/></svg>'; };
  var step = function (n, label, path) {
    var ok = n >= 1 && n <= d.latest;
    return '<a class="ic" aria-label="' + label + '" title="' + label + '"' +
      (ok ? ' href="' + e(href(n)) + '"' : ' aria-disabled="true"') + ">" + icon(path) + "</a>";
  };
  var old = d.n < d.latest;
  var when = new Date(d.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  var host = document.createElement("tack-bar");
  var root = host.attachShadow({ mode: "closed" });
  root.innerHTML =
    "<style>" +
    ":host{all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;animation:in .3s cubic-bezier(.2,.8,.2,1) .1s both}" +
    "@keyframes in{from{opacity:0;transform:translateY(8px) scale(.97)}}" +
    "@media (prefers-reduced-motion:reduce){:host{animation:none}}@media print{:host{display:none}}" +
    ".bar{display:flex;align-items:center;gap:2px;height:36px;padding:0 5px;box-sizing:border-box;border-radius:999px;" +
    "font:500 12.5px/1 ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;font-variant-numeric:tabular-nums;color:#fafafa;" +
    "background:rgba(18,18,20,.8);-webkit-backdrop-filter:blur(16px) saturate(1.6);backdrop-filter:blur(16px) saturate(1.6);" +
    "border:1px solid rgba(255,255,255,.13);box-shadow:inset 0 1px 0 rgba(255,255,255,.07),0 12px 32px -10px rgba(0,0,0,.5),0 2px 8px rgba(0,0,0,.16)}" +
    "a,button{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:26px;" +
    "border-radius:999px;cursor:pointer;color:inherit;transition:background .15s,color .15s}" +
    "a:focus-visible,button:focus-visible{outline:2px solid #60a5fa;outline-offset:1px}" +
    "svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}" +
    ".ic{width:26px;color:#a1a1aa}.ic:hover{background:rgba(255,255,255,.1);color:#fff}" +
    ".ic[aria-disabled]{opacity:.25;cursor:default;background:none;color:#a1a1aa}" +
    ".label{padding:0 9px}.label:hover{background:rgba(255,255,255,.1)}.label span{color:#a1a1aa;font-weight:400}" +
    ".dot{width:7px;height:7px;border-radius:50%;background:#34d399;box-shadow:0 0 0 3px rgba(52,211,153,.18)}" +
    ".old .dot{background:#fbbf24;box-shadow:0 0 0 3px rgba(251,191,36,.2)}" +
    ".latest{padding:0 9px 0 11px;margin:0 2px;font-weight:600;color:#fcd34d;background:rgba(251,191,36,.15)}" +
    ".latest:hover{background:rgba(251,191,36,.25)}.latest svg{width:13px;height:13px}" +
    ".sep{width:1px;height:16px;margin:0 2px;background:rgba(255,255,255,.13)}" +
    ".x{color:#71717a}" +
    "</style>" +
    '<nav class="bar' + (old ? " old" : "") + '" aria-label="Versions">' +
    step(d.n - 1, "Previous version", "m15 18-6-6 6-6") +
    '<a class="label" href="' + e(base + "_history") + '" title="' + e("v" + d.n + " · " + when + (d.note ? " · " + d.note : "")) + '">' +
    '<i class="dot"></i><b>v' + d.n + "</b><span>of " + d.latest + "</span></a>" +
    step(d.n + 1, "Next version", "m9 18 6-6-6-6") +
    (old ? '<a class="latest" href="' + e(base + d.sub) + '">Latest' + icon("M5 12h14M13 6l6 6-6 6") + "</a>" : "") +
    '<i class="sep"></i><button class="ic x" aria-label="Hide" title="Hide">' + icon("M18 6 6 18M6 6l12 12") + "</button></nav>";
  root.querySelector("button").onclick = function () { host.remove(); };
  document.documentElement.appendChild(host);
})(__DATA__);`;
const BAR_REV = [...BAR_JS].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0).toString(36);

type BarData = { slug: string; n: number; latest: number; sub: string; at: string; note: string };

function withVersionBar(res: Response, data: BarData): Response {
  const payload = JSON.stringify(data).replace(/</g, "\\u003c");
  const tag = `<script data-tack>${BAR_JS.replace("__DATA__", () => payload)}</script>`;
  let done = false;
  return new HTMLRewriter()
    .on("body", {
      element(el) {
        el.onEndTag((end) => {
          if (!done) end.before(tag, { html: true });
          done = true;
        });
      },
    })
    .onDocument({
      end(end) {
        if (!done) end.append(tag, { html: true });
      },
    })
    .transform(res);
}

const CSS = `:root{color-scheme:light dark;--fg:#18181b;--mute:#71717a;--line:#e4e4e7;--bg:#fff;--acc:#2563eb}
@media (prefers-color-scheme:dark){:root{--fg:#e4e4e7;--mute:#a1a1aa;--line:#27272a;--bg:#09090b;--acc:#60a5fa}}
body{margin:0 auto;max-width:880px;padding:40px 20px;font:15px/1.5 ui-sans-serif,system-ui,sans-serif;color:var(--fg);background:var(--bg)}
h1{font-size:20px;margin:0}a{color:var(--acc);text-decoration:none}a:hover{text-decoration:underline}
.m{color:var(--mute);font-size:13px}.crumb{margin:0 0 8px}
input{width:100%;box-sizing:border-box;margin:16px 0 4px;padding:8px 10px;font:inherit;color:inherit;background:transparent;border:1px solid var(--line);border-radius:8px}
table{width:100%;border-collapse:collapse;margin-top:12px}td{padding:10px 8px;border-top:1px solid var(--line);vertical-align:top}
td+td{white-space:nowrap;text-align:right;color:var(--mute);font-size:13px}.note{margin-top:2px}.empty{padding:32px 0;color:var(--mute)}`;

const PAGE_JS = `for (const t of document.querySelectorAll("time")) {
  const d = new Date(t.dateTime), s = (Date.now() - d) / 1000;
  t.title = d.toLocaleString();
  t.textContent = s < 60 ? "just now" : s < 3600 ? Math.floor(s / 60) + "m ago" : s < 86400 ? Math.floor(s / 3600) + "h ago"
    : s < 604800 ? Math.floor(s / 86400) + "d ago" : d.toLocaleDateString();
}
const q = document.getElementById("q");
if (q) q.addEventListener("input", () => {
  const v = q.value.toLowerCase();
  for (const r of document.querySelectorAll("tbody tr")) r.hidden = !r.textContent.toLowerCase().includes(v);
});`;

const FAVICON = `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📌</text></svg>`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><link rel="icon" href="${FAVICON}"><style>${CSS}</style></head><body>${body}<script>${PAGE_JS}</script></body></html>`;
}

const time = (iso: string) => `<time datetime="${esc(iso)}">${esc(iso.slice(0, 16).replace("T", " "))}</time>`;

async function indexPage(env: Env): Promise<Response> {
  const docs = await listDocs(env);
  const rows = docs
    .map(
      (d) =>
        `<tr><td><a href="/${d.slug}/">${esc(d.title)}</a><div class="m">${d.slug}</div></td>` +
        `<td><a href="/${d.slug}/_history">v${d.latest}</a></td><td>${time(d.updatedAt)}</td></tr>`,
    )
    .join("");
  return html(
    page(
      "tack",
      `<h1>📌 tack</h1><div class="m">${docs.length} doc${docs.length === 1 ? "" : "s"}</div>` +
        (docs.length
          ? `<input id="q" placeholder="Filter…" autofocus><table><tbody>${rows}</tbody></table>`
          : `<div class="empty">Nothing here yet. Run <code>tack upload ./plan.html</code>.</div>`),
    ),
  );
}

function historyPage(meta: Meta): string {
  const latest = meta.versions.at(-1)!.n;
  const rows = meta.versions
    .slice()
    .reverse()
    .map(
      (v) =>
        `<tr><td><a href="/${meta.slug}/v/${v.n}/">v${v.n}</a>${v.n === latest ? ` <span class="m">· latest</span>` : ""}` +
        `${v.note ? `<div class="note">${esc(v.note)}</div>` : ""}</td>` +
        `<td>${Object.keys(v.files).length} file${Object.keys(v.files).length === 1 ? "" : "s"} · ${fmtSize(v.size)}</td>` +
        `<td>${time(v.at)}</td></tr>`,
    )
    .join("");
  return page(
    `${meta.title} · history`,
    `<p class="crumb m"><a href="/">tack</a> / ${meta.slug}</p><h1>${esc(meta.title)}</h1>` +
      `<div class="m"><a href="/${meta.slug}/">open latest</a> · ${meta.versions.length} version${meta.versions.length === 1 ? "" : "s"}</div>` +
      `<table><tbody>${rows}</tbody></table>`,
  );
}

function locked(): Response {
  return html(page("tack", `<h1>📌 tack</h1><p class="m">Locked. Run <code>tack open</code> for your unlock link.</p>`), 401);
}

function notFound(message = "Not found.", slug?: string): Response {
  const links = `<a href="/">all docs</a>${slug ? ` · <a href="/${slug}/_history">${slug} history</a>` : ""}`;
  return html(page("Not found · tack", `<h1>404</h1><p>${esc(message)}</p><p class="m">${links}</p>`), 404);
}

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  pdf: "application/pdf",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  wasm: "application/wasm",
};

function contentType(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  return Object.hasOwn(TYPES, ext) ? TYPES[ext] : "application/octet-stream";
}

function cleanPath(raw: string): string | null {
  const segs = raw.replace(/\\/g, "/").split("/").filter((s) => s && s !== ".");
  if (!segs.length || segs.includes("..") || segs[0] === "v" || segs[0] === "_history") return null;
  return segs.join("/");
}

async function sha256(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fmtSize(n: number): string {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const json = (data: unknown, status = 200) => Response.json(data, { status });
const fail = (status: number, error: string) => json({ ok: false, error }, status);
const text = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-cache, no-transform" } });
const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });
