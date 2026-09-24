// Tiantasks shared board on Cloudflare Workers + D1.
// Same HTTP API as `tiantasks serve`, so the `tt` CLI and the page work unchanged.
// Logins come from the TIANTASKS_USERS secret: "name:token,name:token".

import PAGE from "./page.html";
import LOGIN_PAGE from "./login.html";
import CLI from "./tiantasks.txt";
import BOARD_APP from "./board.mjs.txt";
import AGENT_GUIDE from "./llms.txt";

const VERSION = "2.7.0";
const PRIORITIES = ["crit", "high", "med", "low"];
const PRANK = Object.fromEntries(PRIORITIES.map((p, i) => [p, i]));
const STATUSES = ["open", "doing", "done"];
const INLINE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"]; // shown inline; other files download
const MAX_ATTACHMENT = 1_900_000; // a D1 row tops out at 2 MB; the page shrinks screenshots to fit

// Items come back with counts the board shows on cards: files, the first image (cover), comments.
const ITEM_SELECT = `SELECT items.*,
  (SELECT COUNT(*) FROM attachments a WHERE a.item_id = items.id) AS files,
  (SELECT MIN(a.id) FROM attachments a WHERE a.item_id = items.id AND a.mime LIKE 'image/%') AS cover,
  (SELECT COUNT(*) FROM comments c WHERE c.deleted_at IS NULL
     AND c.ref = (CASE items.kind WHEN 'task' THEN 'T-' ELSE 'I-' END) || items.num) AS comments
FROM items`;
const ATT_COLS = "id, item_id, name, mime, size, created_by, created_at";
const toAtt = (r) => ({ id: r.id, item_id: r.item_id, name: r.name, mime: r.mime, size: r.size,
  created_by: r.created_by, created_at: r.created_at, url: `/api/attachments/${r.id}` });

function fromBase64(str) {
  let bin;
  try {
    bin = atob(String(str || ""));
  } catch {
    throw new TTError("attachment data must be base64");
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const humanSize = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} KB`);
const cleanFilename = (name) =>
  (String(name || "").split(/[\\/]/).pop().replace(/[^\w.\- ]+/g, "_").replace(/^[ ._]+|[ ._]+$/g, "").slice(0, 100)) || "screenshot";
const PATCHABLE = ["status", "note", "assignee", "priority", "title", "body", "tags", "project", "if_status", "if_assignee"];
const AGENT_NAME = /^[a-z0-9][a-z0-9_.-]{0,39}$/;

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

// Open pages compare this to what they loaded with and reload onto a new release.
const PAGE_BUILD = (() => {
  let h = 0x811c9dc5;
  for (let i = 0; i < PAGE.length; i++) h = Math.imul(h ^ PAGE.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
})();

// ------------------------------------------------------------------ store

class Store {
  constructor(db) {
    this.db = db;
  }

  async get(ref) {
    const [kind, num] = parseRef(ref);
    const r = kind === null
      ? await this.db.prepare(`${ITEM_SELECT} WHERE items.id = ?`).bind(num).first()
      : await this.db.prepare(`${ITEM_SELECT} WHERE kind = ? AND num = ?`).bind(kind, num).first();
    if (!r) throw new TTError(`no item ${ref}`, 404);
    const item = toItem(r);
    item.attachments = (await this.attachmentMeta(item.id)).get(item.id) || [];
    return item;
  }

  async attachmentMeta(itemId) {
    const q = "SELECT id, item_id, name, mime, size FROM attachments" + (itemId ? " WHERE item_id = ?" : "") + " ORDER BY id";
    const stmt = itemId ? this.db.prepare(q).bind(itemId) : this.db.prepare(q);
    const meta = new Map();
    for (const a of (await stmt.all()).results) {
      if (!meta.has(a.item_id)) meta.set(a.item_id, []);
      meta.get(a.item_id).push({ id: a.id, name: a.name, mime: a.mime, size: a.size });
    }
    return meta;
  }

  // Screenshots or any other file. Images are shown inline; other files download.
  async attach(ref, actor, name, mime, data) {
    if (!data.byteLength) throw new TTError("the file is empty");
    if (data.byteLength > MAX_ATTACHMENT) {
      throw new TTError(`the file is ${humanSize(data.byteLength)}; the limit is ${humanSize(MAX_ATTACHMENT)}`, 413);
    }
    const it = await this.get(ref);
    name = cleanFilename(name);
    if (!/^[\w.+-]+\/[\w.+-]+$/.test(mime || "")) mime = "application/octet-stream";
    const t = now();
    const [ins] = await this.db.batch([
      this.db.prepare(
        `INSERT INTO attachments (item_id, name, mime, size, data, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         RETURNING ${ATT_COLS}`,
      ).bind(it.id, name, mime, data.byteLength, data, actor, t),
      this.db.prepare("UPDATE items SET updated_at = ? WHERE id = ?").bind(t, it.id),
    ]);
    const att = toAtt(ins.results[0]);
    await this.log(it, actor, "attached", `${name} (#${att.id})`).run(); // the page shows #id inline
    return att;
  }

  async attachments(ref) {
    const it = await this.get(ref);
    const { results } = await this.db.prepare(`SELECT ${ATT_COLS} FROM attachments WHERE item_id = ? ORDER BY id`).bind(it.id).all();
    return results.map(toAtt);
  }

  async attachment(id) {
    const a = await this.db.prepare("SELECT * FROM attachments WHERE id = ?").bind(Number(id)).first();
    if (!a) throw new TTError(`no attachment #${id}`, 404);
    return a;
  }

  async detach(id, actor) {
    const a = await this.attachment(id);
    const it = await this.get(a.item_id);
    await this.db.batch([
      this.db.prepare("DELETE FROM attachments WHERE id = ?").bind(a.id),
      this.log(it, actor, "detached", `${a.name} (#${a.id})`),
    ]);
    return toAtt(a);
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
        // Deleted items live on in events, so counting them too means a number is never reused.
        `INSERT INTO items (kind, num, project, title, body, priority, tags, assignee, created_by, created_at, updated_at)
         VALUES (?1, (SELECT COALESCE(MAX(n), 0) + 1 FROM (
                        SELECT MAX(num) AS n FROM items WHERE kind = ?1
                        UNION ALL
                        SELECT MAX(CAST(substr(ref, 3) AS INTEGER)) FROM events WHERE substr(ref, 1, 1) = ?10)),
                 ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
         RETURNING *`,
      ).bind(kind, squash(b.project) || "general", title, b.body || "", b.priority || "",
        JSON.stringify(cleanTags(b.tags)), assignee, actor, t, kind === "task" ? "T" : "I"),
      this.db.prepare(
        `INSERT INTO events (item_id, ref, title, project, at, actor, action, detail)
         SELECT id, CASE kind WHEN 'task' THEN 'T-' ELSE 'I-' END || num, title, project, ?1, ?2, 'opened', ?3
         FROM items WHERE id = (SELECT MAX(id) FROM items)`,
      ).bind(t, actor, assignee ? `for ${assignee}` : ""),
    ]);
    return this.get(inserted.results[0].id);
  }

  async update(ref, actor, ch) {
    const { if_status: ifStatus, if_assignee: ifAssignee, ...rest } = ch;
    ch = rest;
    const it = await this.get(ref);
    // Optional guards so two agents can't claim the same item.
    if (ifStatus != null && it.status !== ifStatus) {
      throw new TTError(`${it.ref} is already ${it.status}${it.assignee ? ` (${it.assignee})` : ""}`, 409);
    }
    if (ifAssignee != null && it.assignee !== ifAssignee) {
      throw new TTError(`${it.ref} was just assigned to ${it.assignee || "nobody"}`, 409);
    }
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
    const logs = events.map(([action, detail]) => this.log(after, actor, action, detail));
    if (ifStatus != null || ifAssignee != null) {
      // Compare-and-set: the UPDATE only applies if nobody changed the item since we read it.
      const res = await this.db
        .prepare(`UPDATE items SET ${cols} WHERE id = ? AND status = ? AND assignee = ?`)
        .bind(...Object.values(sets), it.id, it.status, it.assignee).run();
      if (!res.meta.changes) throw new TTError(`${it.ref} was just taken by someone else`, 409);
      if (logs.length) await this.db.batch(logs);
    } else {
      await this.db.batch([
        this.db.prepare(`UPDATE items SET ${cols} WHERE id = ?`).bind(...Object.values(sets), it.id),
        ...logs,
      ]);
    }
    return this.get(it.id);
  }

  static commentRow(r) {
    const deleted = !!r.deleted_at;
    return { id: r.id, parent_id: r.parent_id, author: r.author, body: deleted ? "" : r.body, at: r.created_at, deleted };
  }

  // All comments on an item, oldest first. Replies carry parent_id (threads are one level deep).
  async comments(ref) {
    const it = await this.get(ref);
    const { results } = await this.db.prepare("SELECT * FROM comments WHERE ref = ? ORDER BY id").bind(it.ref).all();
    return results.map(Store.commentRow);
  }

  async comment(ref, actor, text, parentId) {
    text = String(text || "").trim();
    if (!text) throw new TTError("comment cannot be empty");
    const it = await this.get(ref);
    if (parentId) {
      const p = await this.db.prepare("SELECT id, parent_id FROM comments WHERE id = ? AND ref = ?").bind(Number(parentId), it.ref).first();
      if (!p) throw new TTError(`no comment ${parentId} on ${it.ref}`, 404);
      parentId = p.parent_id || p.id; // replying to a reply joins the same thread
    }
    const [ins] = await this.db.batch([
      this.db.prepare("INSERT INTO comments (item_id, ref, parent_id, author, body, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *")
        .bind(it.id, it.ref, parentId || null, actor, text, now()),
      this.log(it, actor, parentId ? "replied" : "added a comment", text),
    ]);
    return Store.commentRow(ins.results[0]);
  }

  async deleteComment(id, actor, isAdmin) {
    if (!isAdmin) throw new TTError("only an admin can delete comments", 403);
    const c = await this.db.prepare("SELECT * FROM comments WHERE id = ?").bind(id).first();
    if (!c || c.deleted_at) throw new TTError(`no comment ${id}`, 404);
    const it = await this.get(c.ref);
    // Soft delete, so replies to it still make sense ("comment deleted" stays in the thread).
    await this.db.batch([
      this.db.prepare("UPDATE comments SET deleted_at = ?, deleted_by = ?, body = '' WHERE id = ?").bind(now(), actor, id),
      this.log(it, actor, "deleted a comment", `by ${c.author}`),
    ]);
    return { ok: true };
  }

  async remove(ref, actor) {
    const it = await this.get(ref);
    await this.db.batch([
      this.db.prepare("DELETE FROM items WHERE id = ?").bind(it.id),
      this.db.prepare("DELETE FROM attachments WHERE item_id = ?").bind(it.id),
      this.db.prepare("DELETE FROM comments WHERE ref = ?").bind(it.ref),
      this.log(it, actor, "deleted"),
    ]);
    return it;
  }

  async list({ project, statuses, kind, assignee, grep } = {}) {
    let sql = `${ITEM_SELECT} WHERE 1 = 1`;
    const args = [];
    if (project) { sql += " AND project = ?"; args.push(project); }
    if (statuses?.length) { sql += ` AND status IN (${statuses.map(() => "?").join(",")})`; args.push(...statuses); }
    if (kind) { sql += " AND kind = ?"; args.push(kind); }
    if (assignee !== undefined && assignee !== null) { sql += " AND assignee = ?"; args.push(assignee); }
    if (grep) { sql += " AND (title LIKE ? OR body LIKE ? OR note LIKE ?)"; args.push(`%${grep}%`, `%${grep}%`, `%${grep}%`); }
    const [{ results }, meta] = await Promise.all([this.db.prepare(sql).bind(...args).all(), this.attachmentMeta()]);
    return results.map((r) => ({ ...toItem(r), attachments: meta.get(r.id) || [] })).sort(byQueue);
  }

  async events({ limit = 40, project, itemId, ref } = {}) {
    let sql = "SELECT * FROM events WHERE 1 = 1";
    const args = [];
    if (itemId && !ref) ref = (await this.get(itemId)).ref; // history follows the never-reused T-/I- number
    if (project) { sql += " AND project = ?"; args.push(project); }
    if (ref) { sql += " AND ref = ?"; args.push(ref); }
    sql += " ORDER BY id DESC LIMIT ?";
    args.push(Math.min(Number(limit) || 40, 500));
    return (await this.db.prepare(sql).bind(...args).all()).results;
  }

  async projects() {
    const q = "SELECT project, SUM(status != 'done') AS open, COUNT(*) AS total FROM items GROUP BY project ORDER BY project";
    return (await this.db.prepare(q).all()).results;
  }

  async assignees() {
    // Current assignees plus anyone recently active (so new agents show up in pickers).
    const q = `SELECT assignee AS name FROM items WHERE assignee != '' UNION
               SELECT actor FROM (SELECT actor FROM events ORDER BY id DESC LIMIT 500) ORDER BY 1`;
    return (await this.db.prepare(q).all()).results.map((r) => r.name);
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
  if (path === "/board.mjs") {
    return new Response(BOARD_APP, { headers: { ...BASE_HEADERS, "Content-Type": "text/javascript; charset=utf-8" } });
  }
  if (path === "/llms.txt") {
    return new Response(AGENT_GUIDE, { headers: { ...BASE_HEADERS, "Content-Type": "text/plain; charset=utf-8" } });
  }
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
  // Agents: "claude" acts as claude-<user>; named agents (TIANTASKS_AGENT=builder-1) act under
  // their own name, but can't pose as another person on the board.
  const agent = (request.headers.get("X-Tiantasks-Agent") || "").trim().toLowerCase();
  let actor = user;
  if (agent === "claude") actor = `claude-${user}`;
  else if (agent) {
    if (!AGENT_NAME.test(agent)) return json({ error: "agent names use lowercase letters, numbers, - _ ." }, 400);
    if ([...users.values()].includes(agent) && agent !== user) return json({ error: `'${agent}' is another person's name` }, 403);
    actor = agent;
  }
  const store = new Store(env.DB);
  const q = url.searchParams;
  const m = path.match(/^\/api\/items\/([A-Za-z]?-?\d+)(\/events|\/comments?)?$/);
  // Admins (TIANTASKS_ADMINS in wrangler.toml) can delete comments; agents never can.
  const admins = String(env.TIANTASKS_ADMINS || "").split(",").map((a) => a.trim()).filter(Boolean);
  const isAdmin = !agent && admins.includes(user);
  const mc = path.match(/^\/api\/comments\/(\d+)$/);
  if (mc && method === "DELETE") return json(await store.deleteComment(Number(mc[1]), actor, isAdmin));

  const ma = path.match(/^\/api\/items\/([A-Za-z]?-?\d+)\/attachments$/);
  if (ma && method === "GET") return json(await store.attachments(ma[1]));
  if (ma && method === "POST") {
    const ctype = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
    if (ctype === "application/json") { // {name, mime, data: base64} from the page and `tt attach`
      const b = await body(request);
      return json(await store.attach(ma[1], actor, b.name, b.mime, fromBase64(b.data)), 201);
    }
    const declared = Number(request.headers.get("Content-Length") || 0); // raw bytes, with ?name=
    if (declared > MAX_ATTACHMENT) {
      throw new TTError(`the file is ${humanSize(declared)}; the limit is ${humanSize(MAX_ATTACHMENT)}`, 413);
    }
    return json(await store.attach(ma[1], actor, q.get("name"), ctype, await request.arrayBuffer()), 201);
  }
  const mf = path.match(/^\/api\/attachments\/(\d+)$/);
  if (mf && method === "GET") {
    const a = await store.attachment(Number(mf[1]));
    const bytes = a.data instanceof ArrayBuffer ? a.data : new Uint8Array(a.data); // D1 may return BLOBs as number arrays
    const inline = INLINE_TYPES.includes(a.mime);
    return new Response(bytes, {
      headers: {
        "Content-Type": inline ? a.mime : "application/octet-stream",
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(a.name)}`,
        "Cache-Control": "private, max-age=31536000, immutable", // ids are never reused (AUTOINCREMENT)
        "Content-Security-Policy": "sandbox; default-src 'none'",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  if (mf && method === "DELETE") return json(await store.detach(Number(mf[1]), actor));

  if (method === "GET" && path === "/") return html(PAGE);
  if (method === "GET" && path === "/api/version") return json({ v: await store.version(), build: PAGE_BUILD });
  if (method === "GET" && path === "/api/me") return json({ user, actor, shared: true, admin: isAdmin });
  if (method === "GET" && path === "/api/state") {
    const project = q.get("project") || undefined;
    const people = new Set(users.values());
    const [items, events, projects, assigned] = await Promise.all([
      store.list({ project }), store.events({ limit: 40, project }), store.projects(), store.assignees(),
    ]);
    const assignees = new Set([...assigned, ...people, ...[...people].map((p) => `claude-${p}`)]);
    return json({ me: user, shared: true, admin: isAdmin, items, events, projects, assignees: [...assignees].sort(), people: [...people].sort() });
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
    return json(await store.events({ limit: 200, ref: (await store.get(m[1])).ref }));
  }
  if (method === "POST" && path === "/api/items") {
    const b = await body(request);
    let it = await store.create(b, actor);
    // the board's per-column "+" creates straight into In progress / Complete
    if (b.status === "doing" || b.status === "done") it = await store.update(it.id, actor, { status: b.status, note: b.note });
    return json(it, 201);
  }
  if (m && method === "GET" && m[2] === "/comments") return json(await store.comments(m[1]));
  if (m && method === "POST" && m[2] === "/comment") {
    const b = await body(request);
    return json(await store.comment(m[1], actor, b.text, b.parent_id));
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
