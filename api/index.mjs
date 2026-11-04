// Board API for State & County Picker, deployed as a Neon Function.
// No dependencies: it talks to Neon Postgres over HTTPS (the /sql endpoint) and uses only Node built-ins.
import { randomBytes, scrypt, timingSafeEqual, createHmac } from "node:crypto";

const ALLOWED_ORIGINS = new Set([
  "https://iafahim.github.io",
  "http://127.0.0.1:8765",
  "http://localhost:8765",
]);

const RAW_DB = process.env.BOARD_DB_URL || process.env.DATABASE_URL || "";
const DB = (() => {
  if (!RAW_DB) return null;
  const u = new URL(RAW_DB);
  u.searchParams.delete("channel_binding");
  return { host: u.host, cs: u.toString() };
})();
const SECRET = process.env.TOKEN_SECRET || "";

const SLUG = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
const RESERVED = new Set(["api", "new", "assets", "admin", "static", "counties", "index", "login", "home"]);
const COLOR = /^#[0-9a-f]{6}$/i;
const TOKEN_MS = 12 * 3600 * 1000;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/* ---------- database ---------- */
const q = (query, params = []) => ({ query, params });
async function sql(queries) {
  if (!DB) throw new HttpError(500, "Database is not configured");
  const r = await fetch(`https://${DB.host}/sql`, {
    method: "POST",
    headers: { "Neon-Connection-String": DB.cs, "Content-Type": "application/json" },
    body: JSON.stringify({ queries }),
  });
  if (!r.ok) throw new Error(`db ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  return j.results.map((x) => x.rows);
}
const one = async (query, params) => (await sql([q(query, params)]))[0];

/* ---------- helpers ---------- */
const arr = (list) => "{" + list.map((s) => `"${s}"`).join(",") + "}";
const ids = (v, len) => {
  if (!Array.isArray(v)) return [];
  const re = new RegExp(`^\\d{${len}}$`);
  return [...new Set(v.filter((x) => typeof x === "string" && re.test(x)))].slice(0, 3300);
};
const clean = (s, n) => String(s ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, n);
const cleanName = (s) => clean(s, 24) || "Guest";
const cleanColor = (s) => (COLOR.test(String(s)) ? String(s).toLowerCase() : "#555555");
const num = (v) => (typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 1e6 ? String(Math.round(v * 100) / 100) : null);
const scryptP = (pw, salt) => new Promise((res, rej) => scrypt(pw, salt, 32, (e, k) => (e ? rej(e) : res(k))));

function checkSlug(slug) {
  if (typeof slug !== "string" || !SLUG.test(slug)) throw new HttpError(400, "Use 3 to 32 letters, numbers or dashes.");
  if (RESERVED.has(slug)) throw new HttpError(400, "That name is reserved.");
  return slug;
}

const sign = (slug, exp) => createHmac("sha256", SECRET).update(`${slug}.${exp}`).digest("base64url");
const makeToken = (slug) => { const exp = Date.now() + TOKEN_MS; return `${exp}.${sign(slug, exp)}`; };
function validToken(slug, token) {
  if (!SECRET || typeof token !== "string") return false;
  const [exp, sig] = token.split(".");
  if (!(Number(exp) > Date.now()) || !sig) return false;
  const good = sign(slug, exp);
  return sig.length === good.length && timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}

async function allow(ip, kind, max, windowSec) {
  const rows = await one(
    `WITH ins AS (INSERT INTO hits (ip, kind) VALUES ($1, $2))
     SELECT count(*)::int AS n FROM hits WHERE ip = $1 AND kind = $2 AND ts > now() - ($3 || ' seconds')::interval`,
    [ip, kind, String(windowSec)],
  );
  return rows[0].n < max;
}

const lockedCache = new Map();
async function boardLocked(slug) {
  if (lockedCache.has(slug)) return lockedCache.get(slug);
  const rows = await one("SELECT locked FROM boards WHERE slug = $1", [slug]);
  if (!rows.length) return null;
  lockedCache.set(slug, rows[0].locked);
  return rows[0].locked;
}
async function gate(slug, token) {
  const locked = await boardLocked(slug);
  if (locked === null) throw new HttpError(404, "Board not found");
  if (locked && !validToken(slug, token)) throw new HttpError(401, "This board is locked");
  return locked;
}

/* ---------- routes ---------- */
const MAX_LAYERS = 12;
const layerId = (v) => (Number.isInteger(v) && v >= 0 && v < MAX_LAYERS ? v : null);
const cleanLayerName = (s) => clean(s, 32) || "Layer";
const KINDS = [["s", 2], ["c", 5], ["o", 5]];

const insItems = (slug, layer, kind, list, name, color) =>
  q(`INSERT INTO items (slug, layer, kind, id, by_name, by_color)
     SELECT $1, $2::smallint, '${kind}', x, $3, $4 FROM unnest($5::text[]) x
     WHERE EXISTS (SELECT 1 FROM layers WHERE slug = $1 AND id = $2::smallint)
     ON CONFLICT DO NOTHING RETURNING id`, [slug, String(layer), name, color, arr(list)]);
const delItems = (slug, layer, kind, list) =>
  q(`DELETE FROM items WHERE slug = $1 AND layer = $2::smallint AND kind = '${kind}' AND id = ANY($3::text[]) RETURNING id`, [slug, String(layer), arr(list)]);
const bumpAndLog = (slug, name, color, text) => [
  q("UPDATE boards SET version = version + 1, last_active = now() WHERE slug = $1 RETURNING version", [slug]),
  q("INSERT INTO activity (slug, who, color, text) VALUES ($1, $2, $3, $4)", [slug, name, color, clean(text, 120) || "made a change"]),
  q("DELETE FROM activity WHERE slug = $1 AND seq < (SELECT COALESCE(max(seq), 0) - 60 FROM activity WHERE slug = $1)", [slug]),
];

const routes = {
  async "/board/info"(b) {
    const slug = checkSlug(b.slug);
    const locked = await boardLocked(slug);
    return { exists: locked !== null, locked: !!locked };
  },

  async "/board/create"(b, ip) {
    const slug = checkSlug(b.slug);
    const locked = b.locked === true;
    const pw = typeof b.password === "string" ? b.password : "";
    if (locked && (pw.length < 4 || pw.length > 64)) throw new HttpError(400, "Choose a password of 4 to 64 characters.");
    if (!(await allow(ip, "create", 8, 3600))) throw new HttpError(429, "Too many boards created. Try again later.");
    let salt = null, hash = null;
    if (locked) {
      salt = randomBytes(16).toString("hex");
      hash = (await scryptP(pw, salt)).toString("hex");
    }
    const made = await one(
      "INSERT INTO boards (slug, locked, salt, pw_hash) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING slug",
      [slug, String(locked), salt, hash],
    );
    if (!made.length) throw new HttpError(409, "That name is taken. Pick another.");
    lockedCache.set(slug, locked);
    const name = cleanName(b.name), color = cleanColor(b.color);
    let layers = Array.isArray(b.layers) ? b.layers.slice(0, MAX_LAYERS) : [];
    if (!layers.length) layers = [{ name: "Layer 1", color: "#111111" }];
    const stmts = [];
    let total = 0;
    layers.forEach((L, i) => {
      stmts.push(q("INSERT INTO layers (slug, id, name, color, pos) VALUES ($1, $2::smallint, $3, $4, $2::int)", [slug, String(i), cleanLayerName(L.name), cleanColor(L.color)]));
    });
    layers.forEach((L, i) => {
      for (const [kind, len] of KINDS) {
        const list = ids(L[kind], len);
        total += list.length;
        if (list.length) stmts.push(insItems(slug, i, kind, list, name, color));
      }
    });
    stmts.push(q("INSERT INTO activity (slug, who, color, text) VALUES ($1, $2, $3, $4)", [slug, name, color, total ? `created the board with ${total} items` : "created the board"]));
    if (total) stmts.push(q("UPDATE boards SET version = version + 1 WHERE slug = $1", [slug]));
    await sql(stmts);
    return { ok: true, token: locked ? makeToken(slug) : null };
  },

  async "/board/unlock"(b, ip) {
    const slug = checkSlug(b.slug);
    if (!(await allow(ip, "unlock:" + slug, 8, 600))) throw new HttpError(429, "Too many tries. Wait a few minutes.");
    const rows = await one("SELECT locked, salt, pw_hash FROM boards WHERE slug = $1", [slug]);
    if (!rows.length) throw new HttpError(404, "Board not found");
    if (!rows[0].locked) return { ok: true, token: null };
    const pw = typeof b.password === "string" ? b.password.slice(0, 64) : "";
    const got = await scryptP(pw, rows[0].salt);
    const want = Buffer.from(rows[0].pw_hash, "hex");
    if (got.length !== want.length || !timingSafeEqual(got, want)) throw new HttpError(403, "Wrong password");
    return { ok: true, token: makeToken(slug) };
  },

  async "/board/sync"(b) {
    const slug = checkSlug(b.slug);
    await gate(slug, b.token);
    const client = typeof b.client === "string" && /^[a-z0-9]{6,24}$/.test(b.client) ? b.client : null;
    if (!client) throw new HttpError(400, "Bad client id");
    const name = cleanName(b.name), color = cleanColor(b.color);
    const hover = typeof b.hover === "string" && /^[sc]\d{2,5}$/.test(b.hover) ? b.hover : null;
    const since = Number.isInteger(b.act) && b.act >= 0 ? b.act : 0;
    const [, ver, peers, acts] = await sql([
      q(`INSERT INTO presence (slug, client, name, color, x, y, hover, seen) VALUES ($1, $2, $3, $4, $5, $6, $7, now())
         ON CONFLICT (slug, client) DO UPDATE SET name = $3, color = $4, x = $5, y = $6, hover = $7, seen = now()`,
        [slug, client, name, color, num(b.x), num(b.y), hover]),
      q("SELECT version FROM boards WHERE slug = $1", [slug]),
      q(`SELECT client, name, color, x, y, hover FROM presence
         WHERE slug = $1 AND client <> $2 AND seen > now() - interval '8 seconds' ORDER BY seen DESC LIMIT 40`, [slug, client]),
      q(`SELECT seq, who, color, text, extract(epoch from ts)::bigint AS ts FROM activity
         WHERE slug = $1 AND seq > $2::bigint ORDER BY seq DESC LIMIT 30`, [slug, String(since)]),
    ]);
    const v = Number(ver[0].version);
    const out = { v, peers, act: acts.reverse(), now: Math.floor(Date.now() / 1000) };
    if (b.full === true || b.v !== v) {
      const [items, layers] = await sql([
        q("SELECT layer, kind, id, by_name, by_color FROM items WHERE slug = $1", [slug]),
        q("SELECT id, name, color FROM layers WHERE slug = $1 ORDER BY pos, id", [slug]),
      ]);
      out.items = items.map((r) => [Number(r.layer), r.kind, r.id, r.by_name, r.by_color]);
      out.layers = layers.map((r) => ({ id: Number(r.id), name: r.name, color: r.color }));
    }
    if (Math.random() < 0.03) {
      sql([
        q("DELETE FROM presence WHERE seen < now() - interval '2 minutes'"),
        q("DELETE FROM hits WHERE ts < now() - interval '1 day'"),
      ]).catch(() => {});
    }
    return out;
  },

  async "/board/ops"(b, ip) {
    const slug = checkSlug(b.slug);
    await gate(slug, b.token);
    if (!(await allow(ip, "ops", 90, 60))) throw new HttpError(429, "Slow down a little.");
    const name = cleanName(b.name), color = cleanColor(b.color);
    const stmts = [];
    for (const g of (Array.isArray(b.layers) ? b.layers.slice(0, MAX_LAYERS) : [])) {
      const lid = layerId(g && g.id);
      if (lid === null) continue;
      for (const [kind, len] of KINDS) {
        const add = ids(g.adds && g.adds[kind], len), rem = ids(g.removes && g.removes[kind], len);
        if (add.length) stmts.push(insItems(slug, lid, kind, add, name, color));
        if (rem.length) stmts.push(delItems(slug, lid, kind, rem));
      }
    }
    if (!stmts.length) return { v: null };
    const res = await sql(stmts);
    const changed = res.reduce((n, rows) => n + rows.length, 0);
    if (!changed) {
      const [r] = await one("SELECT version FROM boards WHERE slug = $1", [slug]);
      return { v: Number(r.version) };
    }
    const [bump] = await sql(bumpAndLog(slug, name, color, b.text || `changed ${changed} items`));
    return { v: Number(bump[0].version) };
  },

  async "/board/layer"(b, ip) {
    const slug = checkSlug(b.slug);
    await gate(slug, b.token);
    if (!(await allow(ip, "layer", 40, 60))) throw new HttpError(429, "Slow down a little.");
    const name = cleanName(b.who), color = cleanColor(b.whoColor);
    if (b.op === "add") {
      const rows = await one("SELECT id FROM layers WHERE slug = $1", [slug]);
      if (rows.length >= MAX_LAYERS) throw new HttpError(409, `A board can have up to ${MAX_LAYERS} layers.`);
      const used = new Set(rows.map((r) => Number(r.id)));
      let id = 0;
      while (used.has(id)) id++;
      const lname = cleanLayerName(b.name);
      const out = await sql([
        q("INSERT INTO layers (slug, id, name, color, pos) VALUES ($1, $2::smallint, $3, $4, (SELECT COALESCE(max(pos), -1) + 1 FROM layers WHERE slug = $1))", [slug, String(id), lname, cleanColor(b.color)]),
        ...bumpAndLog(slug, name, color, `added the layer ${lname}`),
      ]);
      return { id, v: Number(out[1][0].version) };
    }
    const id = layerId(b.id);
    if (id === null) throw new HttpError(400, "Bad layer");
    if (b.op === "update") {
      const sets = [], params = [slug, String(id)];
      if (typeof b.name === "string") { params.push(cleanLayerName(b.name)); sets.push(`name = $${params.length}`); }
      if (typeof b.color === "string") { params.push(cleanColor(b.color)); sets.push(`color = $${params.length}`); }
      if (!sets.length) return { v: null };
      const out = await sql([
        q(`UPDATE layers SET ${sets.join(", ")} WHERE slug = $1 AND id = $2::smallint RETURNING id`, params),
        q("UPDATE boards SET version = version + 1 WHERE slug = $1 RETURNING version", [slug]),
      ]);
      return { v: Number(out[1][0].version) };
    }
    if (b.op === "delete") {
      const rows = await one("SELECT id, name FROM layers WHERE slug = $1", [slug]);
      if (rows.length <= 1) throw new HttpError(400, "A board needs at least one layer.");
      const target = rows.find((r) => Number(r.id) === id);
      if (!target) throw new HttpError(404, "Layer not found");
      const out = await sql([
        q("DELETE FROM items WHERE slug = $1 AND layer = $2::smallint", [slug, String(id)]),
        q("DELETE FROM layers WHERE slug = $1 AND id = $2::smallint", [slug, String(id)]),
        ...bumpAndLog(slug, name, color, `deleted the layer ${target.name}`),
      ]);
      return { v: Number(out[2][0].version) };
    }
    throw new HttpError(400, "Unknown layer operation");
  },
};

/* ---------- entry ---------- */
export default {
  async fetch(request) {
    const origin = request.headers.get("origin") || "";
    const okOrigin = !origin || ALLOWED_ORIGINS.has(origin);
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : "null",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    };
    const reply = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (!okOrigin) return reply({ error: "Origin not allowed" }, 403);
    const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
    if (request.method === "GET" && path === "/") return reply({ ok: true, service: "board-api", db: !!DB, secret: !!SECRET });
    if (request.method !== "POST" || !routes[path]) return reply({ error: "Not found" }, 404);

    try {
      const text = await request.text();
      if (text.length > 300000) throw new HttpError(413, "Request too large");
      let body;
      try { body = JSON.parse(text || "{}"); } catch { throw new HttpError(400, "Bad JSON"); }
      if (!body || typeof body !== "object") throw new HttpError(400, "Bad request");
      const ip = (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
      return reply(await routes[path](body, ip));
    } catch (e) {
      if (e instanceof HttpError) return reply({ error: e.message }, e.status);
      console.error(e);
      return reply({ error: "Something went wrong on the server." }, 500);
    }
  },
};
