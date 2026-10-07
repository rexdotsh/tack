import { DurableObject } from "cloudflare:workers";

interface Env {
  BUCKET: R2Bucket;
  LIVE: DurableObjectNamespace<Live>;
  TACK_TOKEN?: string;
}

type Version = { n: number; at: string; hash: string; size: number; files: Record<string, string>; note?: string };
type Meta = {
  slug: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastN?: number;
  rev?: number;
  gen?: number;
  lock?: { reason: string; at: number; to?: string; from?: string; phase?: "cleanup" };
  versions: Version[];
};
type DocSummary = { slug: string; title: string; updatedAt: string; latest: number; versions: number };
type UploadBody = { files?: Record<string, unknown>; size?: number; title?: string; note?: string; create?: boolean };
type LiveState = {
  gen: number;
  rev: number;
  ns?: number[];
  latest?: number;
  count?: number;
  moved?: string;
  deleted?: boolean;
};

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MAX_FILES = 200;
const RESERVED_SLUGS = new Set(["api", "login", "cli", "install"]);
const RESERVED_PATHS = new Set(["v", "_history", "_diff", "_live"]);
const HASH_RE = /^[0-9a-f]{64}$/;
const LOCK_MS = 5 * 60_000;
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const newer = (a: LiveState, b: LiveState) => (a.gen ?? 0) - (b.gen ?? 0) || a.rev - b.rev;
const liveState = (meta: Meta): LiveState => {
  const ns = meta.versions.map((v) => v.n);
  return { gen: meta.gen ?? 0, rev: meta.rev ?? 0, ns, latest: ns.at(-1), count: ns.length };
};
const metaKey = (slug: string) => `meta/${slug}.json`;
const blobKey = (slug: string, hash: string) => `blobs/${slug}/${hash}`;

export class Live extends DurableObject<Env> {
  async fetch(): Promise<Response> {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    const state = await this.ctx.storage.get<string>("state");
    if (state) server.send(state);
    return new Response(null, { status: 101, webSocket: client });
  }

  async begin(): Promise<number> {
    const last = (await this.ctx.storage.get<number>("gen")) ?? 0;
    const stored = await this.ctx.storage.get<string>("state");
    const gen = Math.max(Date.now(), last + 1, (stored ? (JSON.parse(stored).gen ?? 0) : 0) + 1);
    await this.ctx.storage.put("gen", gen);
    return gen;
  }

  async notify(state: LiveState) {
    const stored = await this.ctx.storage.get<string>("state");
    if (stored && newer(JSON.parse(stored), state) >= 0) return;
    const msg = JSON.stringify(state);
    await this.ctx.storage.put("state", msg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
      } catch {}
    }
  }

  webSocketMessage(ws: WebSocket) {
    ws.close(1008, "read-only");
  }

  webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code);
    } catch {}
  }
}

const live = (env: Env, slug: string) => env.LIVE.get(env.LIVE.idFromName(slug));

async function nextGen(env: Env, slug: string): Promise<number> {
  try {
    return await live(env, slug).begin();
  } catch (err) {
    console.error("live begin failed", err);
    return Date.now();
  }
}

async function notify(env: Env, slug: string, state: LiveState) {
  try {
    await live(env, slug).notify(state);
  } catch (err) {
    console.error("live notify failed", err);
  }
}

export default {
  async fetch(req, env, ctx): Promise<Response> {
    const url = new URL(req.url);
    let res: Response;
    try {
      res = await route(req, env, ctx, url);
      if (res.webSocket) return res;
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

async function route(req: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  if (url.pathname === "/robots.txt") return text("User-agent: *\nDisallow: /\n");
  if (url.pathname === "/login") return login(env, url);
  if (url.pathname === "/") return (await isViewer(req, env)) ? indexPage(env) : locked();
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    if (!env.TACK_TOKEN) return fail(503, "the TACK_TOKEN secret is not set on the Worker (run `tack setup`)");
    const token = req.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1];
    if (!(await same(token, env.TACK_TOKEN))) return fail(401, "bad or missing token (run `tack setup`)");
    return api(req, env, url);
  }
  return serveDoc(req, env, ctx, url);
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
  const m = url.pathname.match(/^\/api\/docs(?:\/([^/]+)(?:\/(rename|v\/\d+|blobs\/[0-9a-f]{64}))?)?\/?$/);
  if (!m) return fail(404, "not found");
  const [, slug, sub] = m;
  const allow = (method: string, run: () => Promise<Response>) => (req.method === method ? run() : fail(405, "method not allowed"));
  if (sub === "rename") return allow("POST", () => rename(req, env, url.origin, slug));
  if (sub?.startsWith("v/")) return allow("DELETE", () => removeVersion(env, slug, Number(sub.slice(2))));
  if (sub) return allow("PUT", () => putBlob(req, env, slug, sub.slice(6)));

  if (!slug) {
    if (req.method !== "GET") return fail(405, "method not allowed");
    const docs = await listDocs(env);
    return json({ ok: true, docs: docs.map((d) => ({ ...d, url: `${url.origin}/${d.slug}` })) });
  }
  if (req.method === "GET") {
    const meta = await getMeta(env, slug);
    if (!meta) return fail(404, `no doc called "${slug}"`);
    return json({ ok: true, url: `${url.origin}/${slug}`, ...meta });
  }
  if (req.method === "POST") return upload(req, env, url.origin, slug);
  if (req.method === "DELETE") return remove(env, slug);
  return fail(405, "method not allowed");
}

async function blocked(env: Env, meta: Meta): Promise<string | null> {
  const lock = meta.lock;
  if (!lock) return null;
  if (Date.now() - lock.at < LOCK_MS) return `${meta.slug} is ${lock.reason}; retry in a moment`;
  const finish = (slug: string, what: string) => `an earlier ${what} didn't finish; run \`tack rm ${slug}\` to clean it up`;
  if (lock.from) return finish(meta.slug, `rename from ${lock.from}`);
  if (!lock.to) return finish(meta.slug, "delete");
  if (lock.phase === "cleanup") return finish(meta.slug, `rename to ${lock.to}`);
  const target = await getMeta(env, lock.to);
  if (!target) return null;
  return finish(target.lock?.from === meta.slug ? lock.to : meta.slug, `rename to ${lock.to}`);
}

async function putBlob(req: Request, env: Env, slug: string, hash: string): Promise<Response> {
  if (!SLUG_RE.test(slug)) return fail(400, "bad slug");
  const length = Number(req.headers.get("content-length"));
  const body = length > 0 && req.body ? req.body : await req.arrayBuffer();
  try {
    await env.BUCKET.put(blobKey(slug, hash), body, { sha256: hash });
  } catch (err) {
    return /checksum|10037/i.test(String(err)) ? fail(400, "file contents don't match their hash") : fail(503, "storage busy; retry");
  }
  return json({ ok: true });
}

async function upload(req: Request, env: Env, origin: string, slug: string): Promise<Response> {
  if (!SLUG_RE.test(slug) || RESERVED_SLUGS.has(slug)) {
    return fail(400, "slug must be 1-64 chars of a-z, 0-9 and '-' (not starting/ending with '-'), and not 'api' or 'login'");
  }
  const body = await req.json<UploadBody>().catch(() => null);
  if (!body?.files || typeof body.files !== "object") return fail(400, "expected JSON { files: { path: sha256 } }");
  const entries = Object.entries(body.files);
  if (entries.length > MAX_FILES) return fail(413, `an upload can have at most ${MAX_FILES} files`);

  const files: Record<string, string> = Object.create(null);
  for (const [raw, hash] of entries) {
    const path = cleanPath(raw);
    if (!path || path !== raw) {
      return fail(400, `bad file path "${raw}" (plain relative paths only: no '..', '//', backslashes, or a first segment of v, _history, _diff or _live)`);
    }
    if (typeof hash !== "string" || !HASH_RE.test(hash)) return fail(400, `file "${raw}" needs a lowercase hex sha256`);
    files[path] = hash;
  }
  if (!Object.hasOwn(files, "index.html")) return fail(400, "an upload needs an index.html");
  const size = Math.max(0, Math.floor(Number(body.size) || 0));

  const versionHash = await sha256(
    new TextEncoder().encode(Object.keys(files).sort().map((p) => `${p}\0${files[p]}`).join("\n")),
  );
  const title = body.title?.trim().slice(0, 300).toWellFormed();
  const note = body.note?.trim().slice(0, 1000).toWellFormed();

  const present = new Set<string>();
  let lifecycle = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const now = new Date().toISOString();
    const existing = await env.BUCKET.get(metaKey(slug));
    if (existing && body.create) return fail(409, `slug "${slug}" is already taken`);
    const meta: Meta = existing
      ? await existing.json<Meta>()
      : { slug, title: slug, createdAt: now, updatedAt: now, gen: await nextGen(env, slug), versions: [] };
    const current = existing ? `${meta.gen ?? 0}:${meta.createdAt}` : "new";
    if (current !== lifecycle) present.clear();
    lifecycle = current;
    const lock = await blocked(env, meta);
    if (lock) return fail(409, lock);

    const latest = meta.versions.at(-1);
    if (latest && latest.hash === versionHash) return json(receipt(origin, meta, latest, true));

    const known = new Set(meta.versions.flatMap((v) => Object.values(v.files)));
    const fresh = [...new Set(Object.values(files))].filter((h) => !known.has(h) && !present.has(h));
    const heads = await Promise.all(fresh.map((h) => env.BUCKET.head(blobKey(slug, h))));
    fresh.forEach((h, i) => heads[i] && present.add(h));
    const missing = fresh.filter((h) => !present.has(h));
    if (missing.length) return json({ ok: false, error: "upload these files first", missing }, 428);

    const version: Version = { n: Math.max(meta.lastN ?? 0, latest?.n ?? 0) + 1, at: now, hash: versionHash, size, files };
    if (note) version.note = note;
    meta.versions.push(version);
    meta.lastN = version.n;
    meta.rev = (meta.rev ?? 0) + 1;
    delete meta.lock;
    meta.title = title || meta.title;
    meta.updatedAt = now;

    const saved = await saveMeta(env, meta, existing ? { etagMatches: existing.etag } : new Headers({ "if-none-match": "*" }));
    if (saved) {
      await notify(env, slug, liveState(meta));
      return json(receipt(origin, meta, version, false), existing ? 200 : 201);
    }
    if (body.create) return fail(409, `slug "${slug}" is already taken`);
  }
  return fail(503, "too many concurrent uploads to this slug; retry");
}

function receipt(origin: string, meta: Meta, v: Version, unchanged: boolean) {
  const base = `${origin}/${meta.slug}`;
  return {
    ok: true,
    slug: meta.slug,
    title: meta.title,
    version: v.n,
    versions: meta.versions.length,
    unchanged,
    url: base,
    versionUrl: `${base}/v/${v.n}`,
    historyUrl: `${base}/_history`,
  };
}

async function saveMeta(env: Env, meta: Meta, onlyIf: R2Conditional | Headers): Promise<R2Object | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await env.BUCKET.put(metaKey(meta.slug), JSON.stringify(meta), {
        onlyIf,
        httpMetadata: { contentType: "application/json" },
        customMetadata: {
          title: encodeURIComponent(meta.title.slice(0, 120).toWellFormed()),
          updatedAt: meta.updatedAt,
          latest: String(meta.versions.at(-1)!.n),
          versions: String(meta.versions.length),
        },
      });
    } catch (err) {
      if (attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function remove(env: Env, slug: string): Promise<Response> {
  const obj = SLUG_RE.test(slug) ? await env.BUCKET.get(metaKey(slug)) : null;
  if (!obj) return fail(404, `no doc called "${slug}"`);
  const meta = await obj.json<Meta>();
  if (meta.lock && Date.now() - meta.lock.at < LOCK_MS) return fail(409, `${slug} is ${meta.lock.reason}; retry in a moment`);
  if (meta.lock?.to && meta.lock.phase !== "cleanup" && (await getMeta(env, meta.lock.to))?.lock?.from === slug) {
    return fail(409, `an unfinished rename left a half-made copy at ${meta.lock.to}; run \`tack rm ${meta.lock.to}\` first, which keeps ${slug}`);
  }
  if (!(await saveMeta(env, { ...meta, lock: { reason: "being deleted", at: Date.now() } }, { etagMatches: obj.etag }))) {
    return fail(409, `${slug} changed while deleting; retry`);
  }
  await deleteBlobs(env, slug);
  await env.BUCKET.delete(metaKey(slug));
  await notify(env, slug, { gen: meta.gen ?? 0, rev: (meta.rev ?? 0) + 1, deleted: true });
  return json({ ok: true, slug, deleted: true });
}

async function deleteBlobs(env: Env, slug: string) {
  let cursor: string | undefined;
  do {
    const page = await env.BUCKET.list({ prefix: `blobs/${slug}/`, cursor });
    if (page.objects.length) await env.BUCKET.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

async function removeVersion(env: Env, slug: string, n: number): Promise<Response> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const obj = SLUG_RE.test(slug) ? await env.BUCKET.get(metaKey(slug)) : null;
    if (!obj) return fail(404, `no doc called "${slug}"`);
    const meta = await obj.json<Meta>();
    const lock = await blocked(env, meta);
    if (lock) return fail(409, lock);
    const i = meta.versions.findIndex((v) => v.n === n);
    if (i < 0) return fail(404, `${slug} has no version ${n}`);
    if (meta.versions.length === 1) return fail(400, `v${n} is the only version; use \`tack rm ${slug}\` to delete the doc`);
    const [gone] = meta.versions.splice(i, 1);
    meta.lastN = Math.max(meta.lastN ?? 0, gone.n);
    meta.rev = (meta.rev ?? 0) + 1;
    meta.updatedAt = new Date().toISOString();
    if (await saveMeta(env, meta, { etagMatches: obj.etag })) {
      await notify(env, slug, liveState(meta));
      return json({ ok: true, slug, deleted: n, latest: meta.versions.at(-1)!.n });
    }
  }
  return fail(503, "too many concurrent changes to this doc; retry");
}

async function rename(req: Request, env: Env, origin: string, slug: string): Promise<Response> {
  const to = ((await req.json<{ to?: string }>().catch(() => null))?.to ?? "").toLowerCase();
  if (!SLUG_RE.test(to) || RESERVED_SLUGS.has(to)) return fail(400, `"${to}" isn't a valid slug`);
  const obj = SLUG_RE.test(slug) ? await env.BUCKET.get(metaKey(slug)) : null;
  if (!obj) return fail(404, `no doc called "${slug}"`);
  if (await env.BUCKET.head(metaKey(to))) return fail(409, `slug "${to}" is already taken`);
  const meta = await obj.json<Meta>();
  const lock = await blocked(env, meta);
  if (lock) return fail(409, lock);
  const hashes = [...new Set(meta.versions.flatMap((v) => Object.values(v.files)))];
  if (hashes.length > MAX_FILES * 2) return fail(413, `${slug} has too many files to rename`);

  const sourceLock = { reason: `being renamed to ${to}`, at: Date.now(), to };
  const locked = await saveMeta(env, { ...meta, lock: sourceLock }, { etagMatches: obj.etag });
  if (!locked) return fail(409, `${slug} changed while renaming; retry`);
  const unlock = () => saveMeta(env, meta, { etagMatches: locked.etag }).catch(() => null);

  const moved: Meta = { ...meta, slug: to, gen: await nextGen(env, to), rev: (meta.rev ?? 0) + 1 };
  delete moved.lock;
  const reserved = await saveMeta(
    env,
    { ...moved, lock: { reason: `being renamed from ${slug}`, at: Date.now(), from: slug } },
    new Headers({ "if-none-match": "*" }),
  );
  if (!reserved) {
    await unlock();
    return fail(409, `slug "${to}" is already taken`);
  }
  const abandon = async () => {
    await deleteBlobs(env, to);
    await env.BUCKET.delete(metaKey(to));
    await unlock();
  };
  try {
    for (let i = 0; i < hashes.length; i += 4) {
      const batch = await Promise.all(
        hashes.slice(i, i + 4).map(async (h) => {
          const blob = await env.BUCKET.get(blobKey(slug, h));
          if (!blob) return false;
          const { readable, writable } = new FixedLengthStream(blob.size);
          await Promise.all([blob.body.pipeTo(writable), env.BUCKET.put(blobKey(to, h), readable)]);
          return true;
        }),
      );
      if (batch.includes(false)) {
        await abandon();
        return fail(500, `${slug} is missing stored files; not renamed`);
      }
    }
    if (!(await saveMeta(env, moved, { etagMatches: reserved.etag }))) {
      await abandon();
      return fail(409, `${to} changed while renaming; retry`);
    }
  } catch (err) {
    await abandon().catch(() => null);
    throw err;
  }
  await notify(env, to, liveState(moved));

  const cleanup = await saveMeta(env, { ...meta, lock: { ...sourceLock, at: Date.now(), phase: "cleanup" } }, { etagMatches: locked.etag });
  if (!cleanup) return fail(500, `renamed to ${to}, but couldn't clean up ${slug}; run \`tack rm ${slug}\``);
  await deleteBlobs(env, slug);
  await env.BUCKET.delete(metaKey(slug));
  await notify(env, slug, { gen: meta.gen ?? 0, rev: (meta.rev ?? 0) + 1, moved: to });
  return json({ ok: true, from: slug, slug: to, url: `${origin}/${to}` });
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

async function serveDoc(req: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const [, slug, rest] = url.pathname.match(/^\/([^/]+)(\/.*)?$/) ?? [];
  if (!slug || !SLUG_RE.test(slug)) return notFound();
  if (rest === "/_live") {
    if (req.headers.get("upgrade") !== "websocket") return fail(426, "expected a websocket");
    if (!(await env.BUCKET.head(metaKey(slug)))) return fail(404, "not found");
    return live(env, slug).fetch(req);
  }
  const meta = await getMeta(env, slug);
  if (!meta) return notFound(`No doc called “${slug}”.`);

  const single = (v: Version) => Object.keys(v.files).length === 1;
  let sub = rest?.slice(1) ?? "";
  if (sub === "_history") return html(historyPage(meta));
  if (sub === "_diff") return diffPage(env, ctx, meta, url);

  const latestN = meta.versions.at(-1)!.n;
  let version = meta.versions.at(-1)!;
  let pinned = false;
  const vm = sub.match(/^v\/(\d+)(\/.*)?$/);
  if (vm) {
    const found = meta.versions.find((v) => v.n === Number(vm[1]));
    if (!found) return notFound(`${slug} has no version ${vm[1]}.`, slug);
    if (vm[2] === undefined && !single(found)) return redirect(`/${slug}/v/${found.n}/${url.search}`);
    version = found;
    pinned = true;
    sub = vm[2]?.slice(1) ?? "";
  } else if (rest === undefined && !single(version)) {
    return redirect(`/${slug}/${url.search}`);
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
    type.startsWith("text/html") && !url.searchParams.has("raw") && req.headers.get("sec-fetch-dest") === "document";
  const i = meta.versions.indexOf(version);
  const bar: BarData = {
    slug,
    n: version.n,
    latest: latestN,
    count: meta.versions.length,
    prev: meta.versions[i - 1]?.n ?? 0,
    next: meta.versions[i + 1]?.n ?? 0,
    pinned,
    sub,
    at: version.at,
    note: version.note ?? "",
    rev: meta.rev ?? 0,
    gen: meta.gen ?? 0,
    seenKey: hash36(`seen:${slug}`),
  };
  const etag = `"${hash.slice(0, 32)}${inject ? `-${hash36(BAR_JS + JSON.stringify(bar))}` : ""}"`;
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

  const body = await readBlob(env, ctx, slug, hash);
  if (!body) return notFound(`Missing blob for ${slug} v${version.n} “${path}”.`, slug);
  const res = new Response(body, { headers });
  return inject ? withVersionBar(res, bar) : res;
}

async function readBlob(env: Env, ctx: ExecutionContext, slug: string, hash: string): Promise<ReadableStream | null> {
  const key = new Request(`https://blob.tack/${slug}/${hash}`);
  const hit = await caches.default.match(key);
  if (hit?.body) return hit.body;
  const obj = await env.BUCKET.get(blobKey(slug, hash));
  if (!obj) return null;
  const [mine, cached] = obj.body.tee();
  ctx.waitUntil(caches.default.put(key, new Response(cached, { headers: { "cache-control": "public, max-age=31536000, immutable" } })));
  return mine;
}

const BAR_JS = `(function (d) {
  var e = function (s) { return String(s).replace(/[&"'<>]/g, function (c) { return "&#" + c.charCodeAt(0) + ";"; }); };
  var base = location.origin + "/" + d.slug + "/";
  var href = function (n) { return n === d.latest ? base + d.sub : base + "v/" + n + "/" + d.sub; };
  var ago = function (iso) {
    var s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    if (s < 604800) return Math.floor(s / 86400) + "d ago";
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };
  var ageText = function () { return "\u2009·\u2009" + (news ? "updated " : "") + ago(d.at); };
  var arrow = function (n, label, path) {
    if (!n) return "";
    return '<a class="ar" href="' + e(href(n)) + '" aria-label="' + label + '" title="' + label + '">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + path + '"/></svg></a>';
  };
  var when = new Date(d.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  var dead = false, fresh = false, news = false, tries = 0, ws = null, host, root;
  if (!d.pinned) {
    try {
      var seen = Number(localStorage.getItem("tack:seen:" + d.seenKey)) || 0;
      news = seen > 0 && seen < d.latest;
      localStorage.setItem("tack:seen:" + d.seenKey, String(d.latest));
    } catch (_) {}
  }
  var render = function () {
    if (d.count < 2) {
      if (host) { host.remove(); host = root = null; }
      return;
    }
    if (!host) {
      host = document.createElement("tack-bar");
      root = host.attachShadow({ mode: "closed" });
      document.documentElement.appendChild(host);
    }
    root.innerHTML =
      "<style>" +
      ":host{all:initial;position:fixed;right:12px;bottom:12px;z-index:2147483647}" +
      "nav{display:flex;align-items:center;height:26px;padding:0 3px;box-sizing:border-box;border-radius:8px;" +
      "font:500 12px/1 ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;font-variant-numeric:tabular-nums;color:#e5e5e5;" +
      "background:rgba(17,17,17,.88);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);" +
      "box-shadow:0 0 0 1px rgba(255,255,255,.08),0 2px 8px rgba(0,0,0,.16)}" +
      "a{all:unset;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;height:20px;border-radius:5px;color:inherit;white-space:nowrap}" +
      "a:hover{background:rgba(255,255,255,.1)}a:focus-visible{outline:2px solid #60a5fa}" +
      ".v{padding:0 6px}.v span{color:#8a8a8a}.old .v b{color:#fbbf24}b{font-weight:500}" +
      ".nw{padding:0 6px;color:#4ade80;font-weight:600}" +
      ".ar,.ch,.age{opacity:0;overflow:hidden;color:#a3a3a3;transition:max-width .2s,width .2s,opacity .2s,padding .2s}" +
      ".ar{width:0}.ch,.age{max-width:0}.age{display:inline-block;vertical-align:top;white-space:nowrap}.ar:hover,.ch:hover{color:#fff}" +
      "nav:hover .ar,nav:focus-within .ar{width:20px;opacity:1}nav:hover .ch,nav:focus-within .ch{max-width:72px;padding:0 6px;opacity:1}" +
      "nav:hover .age,nav:focus-within .age,.v .age.up{max-width:160px;opacity:1}.v .age.up{color:#86efac}" +
      "@media (hover:none){.ar{width:20px;opacity:1}.ch{max-width:72px;padding:0 6px;opacity:1}}" +
      "svg{width:14px;height:14px;flex:none;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}" +
      "@media print{:host{display:none}}" +
      "</style>" +
      '<nav class="' + (d.n < d.latest ? "old" : "") + '" aria-label="Versions">' +
      arrow(d.prev, "Previous version", "m15 18-6-6 6-6") +
      '<a class="v" href="' + e(base + "_history") + '" title="' + e("v" + d.n + " · " + when + (d.note ? " · " + d.note : "")) + '">' +
      "<b>v" + d.n + "</b><span>&thinsp;/&thinsp;" + d.latest + "</span>" +
      '<span class="age' + (news ? " up" : "") + '">' + e(ageText()) + "</span></a>" +
      arrow(d.next, "Next version", "m9 18 6-6-6-6") +
      (d.prev ? '<a class="ch" href="' + e(base + "_diff?a=" + d.prev + "&b=" + d.n) + '" title="What changed in v' + d.n + '">changes</a>' : "") +
      (fresh && d.latest > d.n ? '<a class="nw" href="' + e(base + d.sub) + '" title="Open v' + d.latest + '">new</a>' : "") +
      "</nav>";
  };
  render();
  setInterval(function () {
    var age = root && root.querySelector(".age");
    if (age) age.textContent = ageText();
  }, 60000);
  var sync = function (s) {
    if (dead || !s) return;
    var gen = s.gen || 0;
    if (gen < d.gen || (gen === d.gen && !(s.rev > d.rev))) return;
    if (gen > d.gen && d.pinned) { dead = true; return; }
    d.gen = gen; d.rev = s.rev;
    if (s.deleted) { dead = true; return; }
    if (s.moved) { dead = true; return location.replace(location.origin + "/" + s.moved + "/" + (d.pinned ? "v/" + d.n + "/" : "") + d.sub); }
    if (!d.pinned) return location.reload();
    var ns = s.ns || [];
    if (ns.length && ns[ns.length - 1] > d.latest) fresh = true;
    d.latest = ns.length ? ns[ns.length - 1] : d.latest;
    d.count = ns.length;
    if (!(d.latest > d.n)) fresh = false;
    d.prev = d.next = 0;
    for (var i = 0; i < ns.length; i++) {
      if (ns[i] < d.n) d.prev = ns[i];
      else if (ns[i] > d.n && !d.next) d.next = ns[i];
    }
    render();
  };
  var opened = 0;
  var connect = function () {
    if (dead || ws) return;
    ws = new WebSocket(base.replace(/^http/, "ws") + "_live");
    ws.onopen = function () { opened = Date.now(); };
    ws.onmessage = function (m) { try { sync(JSON.parse(m.data)); } catch (_) {} };
    ws.onclose = function () {
      ws = null;
      if (opened && Date.now() - opened > 30000) tries = 0;
      opened = 0;
      if (!dead && tries < 6) setTimeout(connect, 1000 * Math.pow(2, tries++));
    };
  };
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && !ws) { tries = 0; connect(); }
  });
  connect();
})(__DATA__);`;
type BarData = {
  slug: string;
  n: number;
  latest: number;
  count: number;
  prev: number;
  next: number;
  pinned: boolean;
  sub: string;
  at: string;
  note: string;
  rev: number;
  gen: number;
  seenKey: string;
};

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
input:focus,select:focus,button:focus{outline:none;border-color:var(--mute)}
table{width:100%;border-collapse:collapse;margin-top:12px}td{padding:10px 8px;border-top:1px solid var(--line);vertical-align:top}
td+td{white-space:nowrap;text-align:right;color:var(--mute);font-size:13px}.note{margin-top:2px}.empty{padding:32px 0;color:var(--mute)}
.cmp{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:12px 0 6px}
select,button{font:inherit;font-size:13px;color:var(--fg);background:transparent;border:1px solid var(--line);border-radius:6px;padding:3px 6px;cursor:pointer}
.diff{margin-top:16px;border:1px solid var(--line);border-radius:10px;overflow:hidden;font-size:14px;line-height:1.55}
.diff>div{position:relative;padding:3px 12px 3px 30px;white-space:pre-wrap;overflow-wrap:anywhere}
.diff .eq{color:var(--mute)}.diff .del{background:rgba(239,68,68,.1)}.diff .ins{background:rgba(34,197,94,.1)}
.diff .del:before,.diff .ins:before{position:absolute;left:12px;color:var(--mute)}.diff .del:before{content:"−"}.diff .ins:before{content:"+"}
.diff del{background:rgba(239,68,68,.28);text-decoration:line-through;text-decoration-color:rgba(239,68,68,.7);border-radius:2px}
.diff ins{background:rgba(34,197,94,.28);text-decoration:none;border-radius:2px}
.diff .gap{padding:2px 12px;text-align:center;font-size:12px;color:var(--mute);background:rgba(127,127,127,.08)}`;

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
      (v, i, all) =>
        `<tr><td><a href="/${meta.slug}/v/${v.n}/">v${v.n}</a>${v.n === latest ? ` <span class="m">· latest</span>` : ""}` +
        `${all[i + 1] ? ` <span class="m">· <a href="/${meta.slug}/_diff?a=${all[i + 1].n}&b=${v.n}">changes</a></span>` : ""}` +
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

async function diffPage(env: Env, ctx: ExecutionContext, meta: Meta, url: URL): Promise<Response> {
  const pick = (n: string | null) => meta.versions.find((v) => v.n === Number(n));
  const b = pick(url.searchParams.get("b")) ?? meta.versions.at(-1)!;
  const a = pick(url.searchParams.get("a")) ?? meta.versions[Math.max(0, meta.versions.indexOf(b) - 1)];
  const path = url.searchParams.get("path") || "index.html";
  const [ha, hb] = [a, b].map((v) => (Object.hasOwn(v.files, path) ? v.files[path] : ""));
  const textual = (p: string) => /^(text\/|application\/(json|xml)|image\/svg)/.test(contentType(p));
  const result: DiffResult =
    ha === hb
      ? { added: 0, removed: 0, html: "" }
      : textual(path)
        ? await cachedDiff(env, ctx, meta.slug, ha, hb, /\.html?$/i.test(path))
        : { added: 0, removed: 0, html: "", error: `${path} isn't a text file` };

  const files = [...new Set([...Object.keys(a.files), ...Object.keys(b.files)])].sort().flatMap((p) => {
    const [x, y] = [a, b].map((v) => (Object.hasOwn(v.files, p) ? v.files[p] : ""));
    if (x === y) return [];
    const name = textual(p) && p !== path ? `<a href="?a=${a.n}&b=${b.n}&path=${encodeURIComponent(p)}">${esc(p)}</a>` : esc(p);
    return [`${name} ${!x ? "added" : !y ? "removed" : "changed"}`];
  });
  const multi = Object.keys(a.files).length > 1 || Object.keys(b.files).length > 1;
  const options = (sel: Version) =>
    meta.versions.map((v) => `<option value="${v.n}"${v === sel ? " selected" : ""}>v${v.n}</option>`).join("");
  const slug = meta.slug;
  const subpath = path === "index.html" ? "" : path.split("/").map(encodeURIComponent).join("/");
  const { added, removed } = result;

  return html(
    page(
      `${meta.title} · changes`,
      `<p class="crumb m"><a href="/">tack</a> / <a href="/${slug}/_history">${slug}</a></p><h1>What changed</h1>` +
        `<form class="cmp m"><select name="a" aria-label="From">${options(a)}</select>→<select name="b" aria-label="To">${options(b)}</select>` +
        `${path === "index.html" ? "" : `<input type="hidden" name="path" value="${esc(path)}">`}<button>Compare</button>` +
        `<span>· <a href="/${slug}/v/${a.n}/${subpath}">open v${a.n}</a> · <a href="/${slug}/v/${b.n}/${subpath}">open v${b.n}</a></span></form>` +
        `<div class="m">${result.error ? esc(result.error) : added || removed ? `+${added} −${removed} lines` : "No text changes"}${path === "index.html" ? "" : ` in ${esc(path)}`}` +
        `${result.partial ? " (only the first 150 KB / 2,000 lines of each version were compared)" : ""}</div>` +
        (multi && files.length ? `<div class="m">Files: ${files.join(" · ")}</div>` : "") +
        (added || removed ? `<div class="diff">${result.html}</div>` : ""),
    ),
  );
}

type DiffResult = { added: number; removed: number; html: string; partial?: boolean; error?: string };
const DIFF_REV = 4;
const MAX_DIFF_BYTES = 150_000;
const MAX_DIFF_LINES = 2000;

async function cachedDiff(
  env: Env,
  ctx: ExecutionContext,
  slug: string,
  ha: string,
  hb: string,
  isHtml: boolean,
): Promise<DiffResult> {
  const key = new Request(`https://diff.tack/${DIFF_REV}/${isHtml ? "html" : "text"}/${ha || "none"}/${hb || "none"}`);
  const hit = await caches.default.match(key);
  if (hit) return hit.json<DiffResult>();
  let partial = false;
  const read = async (hash: string) => {
    if (!hash || hash === EMPTY_SHA256) return [];
    const obj = await env.BUCKET.get(blobKey(slug, hash), { range: { length: MAX_DIFF_BYTES } });
    if (!obj || !("body" in obj)) return null;
    if (obj.size > MAX_DIFF_BYTES) partial = true;
    const text = await obj.text();
    const lines = isHtml ? textLines(text) : text.split(/\r?\n/);
    if (!isHtml && lines.at(-1) === "") lines.pop();
    if (lines.length > MAX_DIFF_LINES) partial = true;
    return lines.slice(0, MAX_DIFF_LINES);
  };
  const [before, after] = await Promise.all([read(ha), read(hb)]);
  if (before === null || after === null) return { added: 0, removed: 0, html: "", error: "couldn't read one of the versions" };
  const ops = diff(before, after);
  const result: DiffResult = {
    added: ops.filter(([o]) => o === 1).length,
    removed: ops.filter(([o]) => o === -1).length,
    html: renderDiff(ops),
    partial,
  };
  ctx.waitUntil(caches.default.put(key, Response.json(result, { headers: { "cache-control": "public, max-age=31536000, immutable" } })));
  return result;
}

type Op = [-1 | 0 | 1, string];

function diff(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const off = n + m + 1;
  const v = new Int32Array(2 * off + 2);
  const trace: Int32Array[] = [];
  search: for (let d = 0; d <= n + m; d++) {
    if (d > 200) return [...a.map((t): Op => [-1, t]), ...b.map((t): Op => [1, t])];
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) break search;
    }
  }
  const out: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const t = trace[d];
    const at = (k: number) => t[k + d + 1];
    const k = x - y;
    const pk = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const px = at(pk);
    const py = px - pk;
    while (x > px && y > py) out.push([0, a[--x]]), y--;
    if (d > 0) out.push(x === px ? [1, b[y - 1]] : [-1, a[x - 1]]);
    x = px;
    y = py;
  }
  return out.reverse();
}

function renderDiff(ops: Op[]): string {
  const ctx = 2;
  let budget = 4_000;
  const out: string[] = [];
  const row = (cls: string, body: string) => out.push(`<div class="${cls}">${body}</div>`);
  for (let i = 0; i < ops.length; ) {
    let j = i;
    const same = ops[i][0] === 0;
    while (j < ops.length && (ops[j][0] === 0) === same) j++;
    const run = ops.slice(i, j).map(([, t]) => t);
    if (same) {
      const head = i === 0 ? 0 : ctx;
      const tail = j === ops.length ? 0 : ctx;
      if (run.length > head + tail + 1) {
        run.slice(0, head).forEach((t) => row("eq", esc(t)));
        row("gap", `⋯ ${run.length - head - tail} unchanged`);
        run.slice(run.length - tail).forEach((t) => row("eq", esc(t)));
      } else run.forEach((t) => row("eq", esc(t)));
    } else {
      const dels = ops.slice(i, j).filter(([o]) => o === -1).map(([, t]) => t);
      const ins = ops.slice(i, j).filter(([o]) => o === 1).map(([, t]) => t);
      const pairs = dels.map((t, k) => {
        if (k >= ins.length) return null;
        const [from, to] = [t.split(/(\s+)/), ins[k].split(/(\s+)/)];
        budget -= from.length + to.length;
        return budget > 0 && from.length + to.length < 200 ? words(from, to) : null;
      });
      dels.forEach((t, k) => row("del", pairs[k]?.[0] ?? esc(t)));
      ins.forEach((t, k) => row("ins", pairs[k]?.[1] ?? esc(t)));
    }
    i = j;
  }
  return out.join("");
}

function words(from: string[], to: string[]): [string, string] {
  const ops = diff(from, to);
  const side = (keep: -1 | 1, tag: string) =>
    ops
      .filter(([o]) => o !== -keep)
      .map(([o, t]) => (o === keep ? `<${tag}>${esc(t)}</${tag}>` : esc(t)))
      .join("")
      .replaceAll(`</${tag}><${tag}>`, "");
  return [side(-1, "del"), side(1, "ins")];
}

const BLOCK_TAGS =
  /<\/?(?:p|div|h[1-6]|li|ul|ol|dl|dt|dd|tr|td|th|table|thead|tbody|section|article|header|footer|main|nav|aside|blockquote|pre|figure|figcaption|details|summary|caption|br|hr)\b[^<>]*>/gi;

function textLines(html: string): string[] {
  const [first, ...rest] = html.split("<!--");
  const uncommented = first + rest.map((p) => (p.includes("-->") ? p.slice(p.indexOf("-->") + 3) : "")).join("");
  return decodeEntities(stripHidden(uncommented).replace(BLOCK_TAGS, "\n").replace(/<[^<>]*>/g, " "))
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").replace(/ ([.,;:!?)\]}])/g, "$1").replace(/([(\[{]) /g, "$1").trim())
    .filter(Boolean);
}

function stripHidden(html: string): string {
  const lower = html.toLowerCase();
  const open = /<(script|style|head|template|svg|noscript)\b/g;
  let out = "";
  let last = 0;
  for (let m; (m = open.exec(lower)); ) {
    out += `${html.slice(last, m.index)}\n`;
    const close = lower.indexOf(`</${m[1]}`, open.lastIndex);
    if (close < 0) return out;
    last = lower.indexOf(">", close) + 1 || lower.length;
    open.lastIndex = last;
  }
  return out + html.slice(last);
}

const ENTITIES: Record<string, string> = Object.fromEntries(
  (
    "amp & lt < gt > quot \" apos ' nbsp \u00a0 ensp \u2002 emsp \u2003 thinsp \u2009 hairsp \u200a zwj \u200d zwnj \u200c " +
    "mdash — ndash – minus − hellip … middot · bull • laquo « raquo » lsaquo ‹ rsaquo › lsquo ‘ rsquo ’ ldquo “ rdquo ” " +
    "sbquo ‚ bdquo „ prime ′ Prime ″ larr ← rarr → uarr ↑ darr ↓ harr ↔ lArr ⇐ rArr ⇒ hArr ⇔ times × divide ÷ " +
    "plusmn ± le ≤ ge ≥ ne ≠ asymp ≈ infin ∞ deg ° micro µ para ¶ sect § copy © reg ® trade ™ euro € pound £ yen ¥ cent ¢ " +
    "check ✓ cross ✗ star ☆ starf ★ hearts ♥ dagger † Dagger ‡ frac12 ½ frac14 ¼ frac34 ¾ sup2 ² sup3 ³ iexcl ¡ iquest ¿"
  )
    .split(" ")
    .reduce<[string, string][]>((pairs, w, i, all) => (i % 2 ? pairs : [...pairs, [w, all[i + 1]]]), []),
);

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (all, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    }
    return Object.hasOwn(ENTITIES, e) ? ENTITIES[e] : Object.hasOwn(ENTITIES, e.toLowerCase()) ? ENTITIES[e.toLowerCase()] : all;
  });
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
  if (!segs.length || segs.includes("..") || RESERVED_PATHS.has(segs[0])) return null;
  return segs.join("/");
}

async function sha256(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hash36(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
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
