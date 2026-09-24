// Tiantasks shared board on Cloudflare Workers + D1.
// Same HTTP API as `tiantasks serve`, so the `tt` CLI and the page work unchanged.
// Logins come from the TIANTASKS_USERS secret: "name:token,name:token".

import PAGE from "./page.html";
import LOGIN_PAGE from "./login.html";
import CLI from "./tiantasks.txt";

const VERSION = "2.2.1";
const PRIORITIES = ["crit", "high", "med", "low"];
const PRANK = Object.fromEntries(PRIORITIES.map((p, i) => [p, i]));
const STATUSES = ["open", "doing", "done"];
const PATCHABLE = ["status", "note", "assignee", "priority", "title", "body", "tags", "project"];

class TTError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const now = () => new Date().toISOString().slice(0, 19) + "Z";
const squash = (s) => String(s ?? "").split(/\s+/).filter(Boolean).join(" ");

function cleanTags(tags) {
  if (typeof tags === "string") tags = tags.split(/[,\s]+/);
  return (tags || []).map((t) => String(t).replace(/^#+/, "").trim()).filter(Boolean);
}

function parseRef(ref) {
  ref = String(ref).trim().replace(/^#/, "");
  if (/^\d+$/.test(ref)) return [null, Number(ref)];
  const m = ref.match(/^([TtIi])-?(\d+)$/);
  if (!m) throw new TTError(`'${ref}' is not a valid id (expected something like T-3 or I-12)`);
  return [m[1].toUpperCase() === "T" ? "task" : "issue", Number(m[2])];
}

function checkPriority(p) {
  if (p && !PRIORITIES.includes(p)) throw new TTError(`priority must be one of ${PRIORITIES.join(", ")}`);
}

const byQueue = (a, b) =>
  (a.status === "doing" ? 0 : 1) - (b.status === "doing" ? 0 : 1) ||
  (PRANK[a.priority] ?? 9) - (PRANK[b.priority] ?? 9) ||
  (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0);

const toItem = (r) => ({ ...r, tags: JSON.parse(r.tags), ref: `${r.kind === "task" ? "T" : "I"}-${r.num}` });

// ------------------------------------------------------------------ store

class Store {
  constructor(db) {
    this.db = db;
  }

  async get(ref) {
    const [kind, num] = parseRef(ref);
    const r = kind === null
      ? await this.db.prepare("SELECT * FROM items WHERE id = ?").bind(num).first()
      : await this.db.prepare("SELECT * FROM items WHERE kind = ? AND num = ?").bind(kind, num).first();
    if (!r) throw new TTError(`no item ${ref}`, 404);
    return toItem(r);
  }

  log(item, actor, action, detail = "") {
    return this.db
      .prepare("INSERT INTO events (item_id, ref, title, project, at, actor, action, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(item.id, item.ref, item.title, item.project, now(), actor, action, detail);
  }

  async create(b, actor) {
    const kind = b.kind || "task";
    const title = squash(b.title);
    const assignee = b.assignee || "";
    if (!title) throw new TTError("title cannot be empty");
    if (!["task", "issue"].includes(kind)) throw new TTError("kind must be task or issue");
    checkPriority(b.priority);
    const t = now();
    // One batch = one transaction, so two people adding at once can't get the same number.
    const [inserted] = await this.db.batch([
      this.db.prepare(
        `INSERT INTO items (kind, num, project, title, body, priority, tags, assignee, created_by, created_at, updated_at)
         SELECT ?1, COALESCE(MAX(num), 0) + 1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9 FROM items WHERE kind = ?1
         RETURNING *`,
      ).bind(kind, squash(b.project) || "general", title, b.body || "", b.priority || "",
        JSON.stringify(cleanTags(b.tags)), assignee, actor, t),
      this.db.prepare(
        `INSERT INTO events (item_id, ref, title, project, at, actor, action, detail)
         SELECT id, CASE kind WHEN 'task' THEN 'T-' ELSE 'I-' END || num, title, project, ?1, ?2, 'opened', ?3
         FROM items WHERE id = (SELECT MAX(id) FROM items)`,
      ).bind(t, actor, assignee ? `for ${assignee}` : ""),
    ]);
    return toItem(inserted.results[0]);
  }

  async update(ref, actor, ch) {
    const it = await this.get(ref);
    const sets = {};
    const events = [];
    let note = ch.note ?? null;
    const status = ch.status;
    if (status && status !== it.status) {
      if (!STATUSES.includes(status)) throw new TTError(`status must be one of ${STATUSES.join(", ")}`);
      sets.status = status;
      if (status === "done") {
        sets.resolved_at = now();
        sets.note = String(note || "").trim();
        events.push(["resolved", sets.note]);
        note = null;
      } else if (it.status === "done") {
        sets.resolved_at = null;
        sets.note = "";
        events.push(["reopened", ""]);
        if (status === "doing") events.push(["started", ""]);
      } else {
        events.push([status === "doing" ? "started" : "paused", ""]);
      }
    }
    if (note !== null && String(note).trim() !== it.note) {
      sets.note = String(note).trim();
      events.push(["noted", sets.note]);
    }
    if ("assignee" in ch && (ch.assignee || "") !== it.assignee) {
      sets.assignee = ch.assignee || "";
      events.push(["assigned", ch.assignee ? `to ${ch.assignee}` : "to nobody"]);
    }
    if ("priority" in ch && (ch.priority || "") !== it.priority) {
      checkPriority(ch.priority);
      sets.priority = ch.priority || "";
      events.push(["reprioritized", ch.priority || "none"]);
    }
    if ("title" in ch && squash(ch.title) && squash(ch.title) !== it.title) {
      sets.title = squash(ch.title);
      events.push(["renamed", `from “${it.title}”`]);
    }
    if ("body" in ch && (ch.body || "") !== it.body) {
      sets.body = ch.body || "";
      events.push(["edited", "description"]);
    }
    if ("tags" in ch && JSON.stringify(cleanTags(ch.tags)) !== JSON.stringify(it.tags)) {
      sets.tags = JSON.stringify(cleanTags(ch.tags));
      events.push(["tagged", cleanTags(ch.tags).join(", ") || "none"]);
    }
    if ("project" in ch && squash(ch.project) && squash(ch.project) !== it.project) {
      sets.project = squash(ch.project);
      events.push(["moved", `to ${sets.project}`]);
    }
    if (!Object.keys(sets).length) return it;
    sets.updated_at = now();
    const cols = Object.keys(sets).map((k) => `${k} = ?`).join(", ");
    const after = { ...it, ...sets };
    await this.db.batch([
      this.db.prepare(`UPDATE items SET ${cols} WHERE id = ?`).bind(...Object.values(sets), it.id),
      ...events.map(([action, detail]) => this.log(after, actor, action, detail)),
    ]);
    return this.get(it.id);
  }

  async comment(ref, actor, text) {
    if (!String(text || "").trim()) throw new TTError("comment cannot be empty");
    const it = await this.get(ref);
    await this.log(it, actor, "commented", String(text).trim()).run();
    return it;
  }

  async remove(ref, actor) {
    const it = await this.get(ref);
    await this.db.batch([
      this.db.prepare("DELETE FROM items WHERE id = ?").bind(it.id),
      this.log(it, actor, "deleted"),
    ]);
    return it;
  }

  async list({ project, statuses, kind, assignee, grep } = {}) {
    let sql = "SELECT * FROM items WHERE 1 = 1";
    const args = [];
    if (project) { sql += " AND project = ?"; args.push(project); }
    if (statuses?.length) { sql += ` AND status IN (${statuses.map(() => "?").join(",")})`; args.push(...statuses); }
    if (kind) { sql += " AND kind = ?"; args.push(kind); }
    if (assignee !== undefined && assignee !== null) { sql += " AND assignee = ?"; args.push(assignee); }
    if (grep) { sql += " AND (title LIKE ? OR body LIKE ? OR note LIKE ?)"; args.push(`%${grep}%`, `%${grep}%`, `%${grep}%`); }
    const { results } = await this.db.prepare(sql).bind(...args).all();
    return results.map(toItem).sort(byQueue);
  }

  async events({ limit = 40, project, itemId } = {}) {
    let sql = "SELECT * FROM events WHERE 1 = 1";
    const args = [];
    if (project) { sql += " AND project = ?"; args.push(project); }
    if (itemId) { sql += " AND item_id = ?"; args.push(itemId); }
    sql += " ORDER BY id DESC LIMIT ?";
    args.push(Math.min(Number(limit) || 40, 500));
    return (await this.db.prepare(sql).bind(...args).all()).results;
  }

  async projects() {
    const q = "SELECT project, SUM(status != 'done') AS open, COUNT(*) AS total FROM items GROUP BY project ORDER BY project";
    return (await this.db.prepare(q).all()).results;
  }

  async assignees() {
    const q = "SELECT DISTINCT assignee FROM items WHERE assignee != '' ORDER BY assignee";
    return (await this.db.prepare(q).all()).results.map((r) => r.assignee);
  }

  async version() {
    // Every write adds an event, so the newest event id is a change counter (a 1-row read).
    return (await this.db.prepare("SELECT COALESCE(MAX(id), 0) AS v FROM events").first()).v;
  }
}

// ------------------------------------------------------------------ auth

function parseUsers(spec) {
  const users = new Map();
  for (const part of String(spec || "").split(",").map((p) => p.trim()).filter(Boolean)) {
    const i = part.indexOf(":");
    const name = part.slice(0, i), token = part.slice(i + 1);
    if (i > 0 && /^[a-z0-9_.]+$/.test(name) && token.length >= 20) users.set(token, name);
  }
  return users;
}

function userFor(users, token) {
  if (!token) return null;
  const given = new TextEncoder().encode(token);
  let found = null;
  for (const [known, name] of users) {
    const k = new TextEncoder().encode(known);
    if (k.byteLength === given.byteLength && crypto.subtle.timingSafeEqual(k, given)) found = name;
  }
  return found;
}

function cookieToken(request) {
  for (const part of (request.headers.get("Cookie") || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === "tt_token") return decodeURIComponent(v.join("="));
  }
  return null;
}

const tokenCookie = (value, maxAge) =>
  `tt_token=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;

// ------------------------------------------------------------------ http

const BASE_HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, "Content-Type": "application/json" } });

const html = (body, status = 200) =>
  new Response(body, { status, headers: { ...BASE_HEADERS, "Content-Type": "text/html; charset=utf-8" } });

const redirect = (cookie) =>
  new Response(null, { status: 303, headers: { ...BASE_HEADERS, Location: "/", "Set-Cookie": cookie } });

async function body(request) {
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new TTError("request body must be JSON");
  }
}

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/ping") return json({ app: "tiantasks", version: VERSION });
  if (path === "/tiantasks") {
    return new Response(CLI, { headers: { ...BASE_HEADERS, "Content-Type": "text/x-python; charset=utf-8" } });
  }

  const users = parseUsers(env.TIANTASKS_USERS);
  if (!users.size) return json({ error: "board has no logins configured (set TIANTASKS_USERS)" }, 503);

  if (path === "/logout") return redirect(tokenCookie("", 0));
  if (path === "/login") {
    if (method !== "POST") return html(LOGIN_PAGE);
    const form = await request.formData();
    const token = String(form.get("token") || "").trim();
    if (userFor(users, token)) return redirect(tokenCookie(token, 60 * 60 * 24 * 365));
    return html(LOGIN_PAGE.replace("<!--err-->", "That token isn't valid."), 401);
  }

  const auth = request.headers.get("Authorization") || "";
  const user = userFor(users, auth.startsWith("Bearer ") ? auth.slice(7).trim() : cookieToken(request));
  if (!user) return method === "GET" && path === "/" ? html(LOGIN_PAGE) : json({ error: "not signed in" }, 401);

  // Writes need a custom header, which other websites can't send cross-origin.
  if (method !== "GET" && request.headers.get("X-Tiantasks") !== "1") {
    return json({ error: "missing X-Tiantasks header" }, 403);
  }
  const actor = request.headers.get("X-Tiantasks-Agent") === "claude" ? `claude-${user}` : user;
  const store = new Store(env.DB);
  const q = url.searchParams;
  const m = path.match(/^\/api\/items\/([A-Za-z]?-?\d+)(\/events|\/comment)?$/);

  if (method === "GET" && path === "/") return html(PAGE);
  if (method === "GET" && path === "/api/version") return json({ v: await store.version() });
  if (method === "GET" && path === "/api/me") return json({ user, actor, shared: true });
  if (method === "GET" && path === "/api/state") {
    const project = q.get("project") || undefined;
    const people = new Set(users.values());
    const [items, events, projects, assigned] = await Promise.all([
      store.list({ project }), store.events({ limit: 40, project }), store.projects(), store.assignees(),
    ]);
    const assignees = new Set([...assigned, ...people, ...[...people].map((p) => `claude-${p}`)]);
    return json({ me: user, shared: true, items, events, projects, assignees: [...assignees].sort() });
  }
  if (method === "GET" && path === "/api/items") {
    return json(await store.list({
      project: q.get("project") || undefined,
      statuses: q.get("status") ? q.get("status").split(",") : undefined,
      kind: q.get("kind") || undefined,
      assignee: q.has("assignee") ? q.get("assignee") : undefined,
      grep: q.get("grep") || undefined,
    }));
  }
  if (method === "GET" && path === "/api/events") {
    return json(await store.events({
      limit: q.get("limit"), project: q.get("project") || undefined,
      itemId: q.get("item_id") ? Number(q.get("item_id")) : undefined,
    }));
  }
  if (method === "GET" && path === "/api/projects") return json(await store.projects());
  if (m && method === "GET" && !m[2]) return json(await store.get(m[1]));
  if (m && method === "GET" && m[2] === "/events") {
    return json(await store.events({ limit: 200, itemId: (await store.get(m[1])).id }));
  }
  if (method === "POST" && path === "/api/items") return json(await store.create(await body(request), actor), 201);
  if (m && method === "POST" && m[2] === "/comment") {
    return json(await store.comment(m[1], actor, (await body(request)).text));
  }
  if (m && method === "PATCH" && !m[2]) {
    const b = await body(request);
    const ch = Object.fromEntries(Object.entries(b).filter(([k]) => PATCHABLE.includes(k)));
    return json(await store.update(m[1], actor, ch));
  }
  if (m && method === "DELETE" && !m[2]) return json(await store.remove(m[1], actor));
  return json({ error: "not found" }, 404);
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (e) {
      if (e instanceof TTError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: "internal error" }, 500);
    }
  },
};
