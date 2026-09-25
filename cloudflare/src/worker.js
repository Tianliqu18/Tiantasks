// Tiantasks shared board on Cloudflare Workers + D1.
// Same HTTP API as `tiantasks serve`, so the `tt` CLI and the page work unchanged.
// Logins come from the TIANTASKS_USERS secret: "name:token,name:token".

import PAGE from "./page.html";
import LOGIN_PAGE from "./login.html";
import CLI from "./tiantasks.txt";
import BOARD_APP from "./board.mjs.txt";
import AGENT_GUIDE from "./llms.txt";
import SCHEMA from "./schema.txt";

// Open pages compare this to what they loaded with and reload onto a new release.
const PAGE_BUILD = (() => {
  let h = 0x811c9dc5;
  for (let i = 0; i < PAGE.length; i++) h = Math.imul(h ^ PAGE.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
})();

const VERSION = "2.8.1";
const PRIORITIES = ["crit", "high", "med", "low"];
const PRANK = Object.fromEntries(PRIORITIES.map((p, i) => [p, i]));
const STATUSES = ["open", "doing", "done"];
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX_ATTACHMENT = 1_900_000; // D1 rows top out at 2 MB; the page shrinks screenshots to fit
const humanSize = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} KB`);
const cleanFilename = (name) =>
  (String(name || "").split(/[\\/]/).pop().replace(/[^\w.\- ]+/g, "_").replace(/^[ ._]+|[ ._]+$/g, "").slice(0, 100)) || "screenshot";
const PATCHABLE = ["status", "note", "assignee", "priority", "title", "body", "tags", "project", "if_status", "if_assignee", "fields"];
const AGENT_NAME = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const INITIATIVE_SLUG = /^[a-z0-9][a-z0-9_.-]{0,40}(\/[a-z0-9][a-z0-9_.-]{0,60})?$/;
const AGENT_STATES = ["working", "idle", "waiting", "offline"];
const FLAG_STATES = ["sent", "delivered", "acked", "failed", "escalated", "closed"];
const FLAG_OPEN = ["sent", "delivered", "failed", "escalated"];
const BUMP_SQL = "INSERT INTO changes (id, n) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET n = n + 1";
const clip = (v, n) => String(v ?? "").slice(0, n);

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
    const item = toItem(r);
    item.attachments = (await this.attachmentMeta(item.id)).get(item.id) || [];
    item.fields = (await this.fieldMap(item.id)).get(item.id) || {};
    return item;
  }

  async fieldMap(itemId) {
    const q = "SELECT item_id, key, value FROM item_fields" + (itemId ? " WHERE item_id = ?" : "");
    const stmt = itemId ? this.db.prepare(q).bind(itemId) : this.db.prepare(q);
    const out = new Map();
    for (const r of (await stmt.all()).results) {
      if (!out.has(r.item_id)) out.set(r.item_id, {});
      out.get(r.item_id)[r.key] = r.value;
    }
    return out;
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

  async attach(ref, actor, name, mime, data) {
    if (!IMAGE_TYPES.includes(mime)) throw new TTError("only PNG, JPEG, WebP or GIF images can be attached", 415);
    if (!data.byteLength) throw new TTError("the image is empty");
    if (data.byteLength > MAX_ATTACHMENT) {
      throw new TTError(`the image is ${humanSize(data.byteLength)}; the limit is ${humanSize(MAX_ATTACHMENT)}`, 413);
    }
    const it = await this.get(ref);
    name = cleanFilename(name);
    const [ins] = await this.db.batch([
      this.db.prepare(
        "INSERT INTO attachments (item_id, name, mime, size, data, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
      ).bind(it.id, name, mime, data.byteLength, data, actor, now()),
      this.log(it, actor, "attached", name),
    ]);
    return { id: ins.results[0].id, name, mime, size: data.byteLength };
  }

  async attachment(id) {
    const a = await this.db.prepare("SELECT * FROM attachments WHERE id = ?").bind(id).first();
    if (!a) throw new TTError("no such attachment", 404);
    return a;
  }

  async deleteAttachment(id, actor) {
    const a = await this.db.prepare("SELECT id, item_id, name FROM attachments WHERE id = ?").bind(id).first();
    if (!a) throw new TTError("no such attachment", 404);
    const it = await this.get(a.item_id);
    await this.db.batch([
      this.db.prepare("DELETE FROM attachments WHERE id = ?").bind(id),
      this.log(it, actor, "removed screenshot", a.name),
    ]);
    return { ok: true };
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
    return toItem(inserted.results[0]);
  }

  async update(ref, actor, ch) {
    const { if_status: ifStatus, if_assignee: ifAssignee, fields, ...rest } = ch;
    ch = rest;
    if (fields && Object.keys(fields).length) await this.setFields(ref, actor, fields);
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
      this.db.prepare("DELETE FROM item_fields WHERE item_id = ?").bind(it.id),
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
    const [{ results }, meta, fields] = await Promise.all([
      this.db.prepare(sql).bind(...args).all(), this.attachmentMeta(), this.fieldMap()]);
    return results.map((r) => ({ ...toItem(r), attachments: meta.get(r.id) || [], fields: fields.get(r.id) || {} })).sort(byQueue);
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
    // Every write adds an event or bumps `changes`, so this sum is a change counter (one tiny read).
    return (await this.db.prepare(
      "SELECT (SELECT COALESCE(MAX(id), 0) FROM events) + (SELECT COALESCE(MAX(n), 0) FROM changes) AS v").first()).v;
  }

  bump() {
    return this.db.prepare(BUMP_SQL);
  }

  // ---- fields
  async setFields(ref, actor, fields) {
    const it = await this.get(ref);
    const stmts = [];
    for (let [key, value] of Object.entries(fields || {})) {
      key = String(key).trim().toLowerCase();
      value = String(value ?? "").trim();
      if (!/^[a-z][a-z0-9_]{0,30}$/.test(key)) throw new TTError(`field names use lowercase letters, numbers and _ (got '${key}')`);
      if (value === (it.fields[key] || "")) continue;
      if (value) {
        stmts.push(this.db.prepare(
          "INSERT INTO item_fields (item_id, key, value) VALUES (?, ?, ?) ON CONFLICT (item_id, key) DO UPDATE SET value = excluded.value",
        ).bind(it.id, key, value.slice(0, 500)), this.log(it, actor, "set field", `${key}: ${value.slice(0, 200)}`));
      } else {
        stmts.push(this.db.prepare("DELETE FROM item_fields WHERE item_id = ? AND key = ?").bind(it.id, key),
          this.log(it, actor, "cleared field", key));
      }
    }
    if (stmts.length) await this.db.batch(stmts);
    return this.get(it.id);
  }

  // ---- agents
  // Record that an agent just acted and return its name on this board. Two people's chats can
  // share a name (everyone has a 'concierge'); the second person's becomes name-<person>.
  async touchAgent(name, principal) {
    let row = await this.db.prepare("SELECT principal FROM agents WHERE name = ?").bind(name).first();
    if (row && row.principal && principal && row.principal !== principal) {
      name = `${name}-${principal}`.slice(0, 64);
      row = await this.db.prepare("SELECT principal FROM agents WHERE name = ?").bind(name).first();
      if (row && row.principal && row.principal !== principal) throw new TTError(`agent '${name}' works for ${row.principal}, not ${principal}`, 403);
    }
    const t = now();
    await this.db.prepare(
      `INSERT INTO agents (name, principal, first_seen, last_seen) VALUES (?, ?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET last_seen = excluded.last_seen,
         principal = CASE WHEN agents.principal = '' THEN excluded.principal ELSE agents.principal END`,
    ).bind(name, principal || "", t, t).run();
    return name;
  }

  async reportAgent(name, principal, info) {
    name = String(name).trim().toLowerCase();
    if (!AGENT_NAME.test(name)) throw new TTError("agent names use lowercase letters, numbers, - _ .");
    if (info.state != null && !AGENT_STATES.includes(info.state)) throw new TTError(`state must be one of ${AGENT_STATES.join(", ")}`);
    name = await this.touchAgent(name, principal);
    const cur = await this.db.prepare("SELECT * FROM agents WHERE name = ?").bind(name).first();
    const sets = {};
    for (const k of ["kind", "host", "project", "initiative", "state", "doing"]) {
      if (info[k] != null && clip(info[k], 300) !== cur[k]) sets[k] = clip(info[k], 300);
    }
    if ("state" in sets) sets.state_since = now();
    if (Object.keys(sets).length) {
      const cols = Object.keys(sets).map((k) => `${k} = ?`).join(", ");
      await this.db.batch([this.db.prepare(`UPDATE agents SET ${cols} WHERE name = ?`).bind(...Object.values(sets), name), this.bump()]);
    }
    return this.db.prepare("SELECT * FROM agents WHERE name = ?").bind(name).first();
  }

  async agents() {
    return (await this.db.prepare("SELECT * FROM agents ORDER BY principal, name").all()).results;
  }

  async removeAgent(name, user) {
    const a = await this.db.prepare("SELECT principal FROM agents WHERE name = ?").bind(name).first();
    if (!a) throw new TTError(`no agent ${name}`, 404);
    if (a.principal && a.principal !== user) throw new TTError(`${name} works for ${a.principal}; only they can remove it`, 403);
    await this.db.batch([this.db.prepare("DELETE FROM agents WHERE name = ?").bind(name), this.bump()]);
    return { ok: true };
  }

  async removeInitiative(slug, user) {
    const i = await this.initiative(slug);
    if (i.principal && i.principal !== user) throw new TTError(`${slug} belongs to ${i.principal}; only they can remove it`, 403);
    await this.db.batch([this.db.prepare("DELETE FROM initiatives WHERE slug = ?").bind(slug), this.bump()]);
    return { ok: true };
  }

  async principalOf(name) {
    const r = await this.db.prepare("SELECT principal FROM agents WHERE name = ?").bind(name).first();
    return (r && r.principal) || name;
  }

  // ---- initiatives
  async initiatives() {
    return (await this.db.prepare("SELECT * FROM initiatives ORDER BY project, slug").all()).results;
  }

  async initiative(slug) {
    const r = await this.db.prepare("SELECT * FROM initiatives WHERE slug = ?").bind(slug).first();
    if (!r) throw new TTError(`no initiative ${slug}`, 404);
    return r;
  }

  async putInitiative(slug, principal, info) {
    slug = String(slug).trim().toLowerCase();
    if (!INITIATIVE_SLUG.test(slug)) throw new TTError("initiative ids look like project/name (lowercase letters, numbers, - _ .)");
    if (info.status != null && !["active", "paused", "done"].includes(info.status)) throw new TTError("status must be active, paused or done");
    const t = now();
    const cur = await this.db.prepare("SELECT * FROM initiatives WHERE slug = ?").bind(slug).first();
    if (!cur) {
      await this.db.batch([this.db.prepare(
        `INSERT INTO initiatives (slug, project, title, summary, status, owner, principal, link, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(slug, info.project || slug.split("/")[0], squash(info.title || slug.split("/").pop()), info.summary || "",
        info.status || "active", info.owner || "", info.principal || principal || "", info.link || "", t, t), this.bump()]);
    } else {
      const sets = {};
      for (const k of ["project", "title", "summary", "status", "owner", "principal", "link"]) {
        if (info[k] != null && String(info[k]) !== cur[k]) sets[k] = String(info[k]);
      }
      if (Object.keys(sets).length) {
        sets.updated_at = t;
        const cols = Object.keys(sets).map((k) => `${k} = ?`).join(", ");
        await this.db.batch([this.db.prepare(`UPDATE initiatives SET ${cols} WHERE slug = ?`).bind(...Object.values(sets), slug), this.bump()]);
      }
    }
    return this.initiative(slug);
  }

  // ---- checkpoints
  async checkpoint(actor, principal, b) {
    const text = squash(b.text);
    if (!text) throw new TTError("a checkpoint needs some text");
    const source = b.source || "agent";
    if (!["agent", "auto", "person"].includes(source)) throw new TTError("source must be agent, auto or person");
    const it = b.ref ? await this.get(b.ref) : null;
    const initiative = b.initiative || (it ? it.fields.initiative || "" : "");
    if (!it && !initiative) throw new TTError("say which item or initiative this checkpoint is about");
    const [ins] = await this.db.batch([
      this.db.prepare(
        `INSERT INTO checkpoints (ref, initiative, actor, principal, text, link, attachment, source, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      ).bind(it ? it.ref : "", initiative, actor, principal || "", text.slice(0, 500), clip(b.link, 500),
        b.attachment ?? null, source, now()),
      ...(it ? [this.log(it, actor, "checkpoint", text.slice(0, 500))] : []),
      this.bump(),
    ]);
    return ins.results[0];
  }

  async checkpoints({ ref, initiative, limit } = {}) {
    let sql = "SELECT * FROM checkpoints WHERE 1 = 1";
    const args = [];
    if (ref) { sql += " AND ref = ?"; args.push((await this.get(ref)).ref); }
    if (initiative) { sql += " AND initiative = ?"; args.push(initiative); }
    sql += " ORDER BY id DESC LIMIT ?";
    args.push(Math.min(Number(limit) || 100, 500));
    return (await this.db.prepare(sql).bind(...args).all()).results;
  }

  // ---- flags and asks
  async flagTarget(it, initiative, kind, principal) {
    if (kind === "ask") return principal;
    if (it && it.assignee) return it.assignee;
    const slug = initiative || (it ? it.fields.initiative : "");
    if (slug) {
      const r = await this.db.prepare("SELECT owner, principal FROM initiatives WHERE slug = ?").bind(slug).first();
      if (r && (r.owner || r.principal)) return r.owner || r.principal;
    }
    throw new TTError("nobody owns that yet; say who it's for (--to NAME)");
  }

  async flag(actor, principal, b) {
    const text = String(b.text || "").trim();
    const kind = b.kind || "flag";
    if (!text) throw new TTError("a flag needs some text");
    if (!["flag", "ask"].includes(kind)) throw new TTError("kind must be flag or ask");
    const it = b.ref ? await this.get(b.ref) : null;
    const initiative = b.initiative || (it ? it.fields.initiative || "" : "");
    const to = String(b.to || "").trim().toLowerCase() || await this.flagTarget(it, initiative, kind, principal);
    const [ins] = await this.db.batch([
      this.db.prepare(
        `INSERT INTO flags (kind, ref, initiative, to_name, from_actor, from_principal, text, urgent, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      ).bind(kind, it ? it.ref : "", initiative, to, actor, principal || "", text.slice(0, 2000), b.urgent ? 1 : 0, now()),
      ...(it ? [this.log(it, actor, kind === "ask" ? "asked" : "flagged", `${to}: ${text.slice(0, 300)}`)] : []),
      this.bump(),
    ]);
    return ins.results[0];
  }

  async getFlag(id) {
    const r = await this.db.prepare("SELECT * FROM flags WHERE id = ?").bind(Number(id)).first();
    if (!r) throw new TTError(`no flag F-${id}`, 404);
    return r;
  }

  async flags({ to, status, ref, initiative, limit } = {}) {
    let sql = "SELECT * FROM flags WHERE 1 = 1";
    const args = [];
    if (to) { sql += " AND to_name = ?"; args.push(to); }
    if (status) {
      const st = status === "open" ? FLAG_OPEN : status.split(",");
      sql += ` AND status IN (${st.map(() => "?").join(",")})`; args.push(...st);
    }
    if (ref) { sql += " AND ref = ?"; args.push((await this.get(ref)).ref); }
    if (initiative) { sql += " AND initiative = ?"; args.push(initiative); }
    sql += " ORDER BY id DESC LIMIT ?";
    args.push(Math.min(Number(limit) || 100, 500));
    return (await this.db.prepare(sql).bind(...args).all()).results;
  }

  // Delivery states come from the target's person (their adapter); the target itself or its
  // person acknowledges; anyone can close one.
  async setFlag(id, actor, user, isAgent, status, note = "") {
    if (!FLAG_STATES.includes(status)) throw new TTError(`status must be one of ${FLAG_STATES.join(", ")}`);
    const f = await this.getFlag(id);
    const targetPrincipal = await this.principalOf(f.to_name);
    if (["delivered", "failed", "escalated"].includes(status) && (isAgent || user !== targetPrincipal)) {
      throw new TTError(`only ${targetPrincipal} (or their adapter) reports delivery of F-${f.id}`, 403);
    }
    if (status === "acked" && actor !== f.to_name && user !== targetPrincipal) throw new TTError(`F-${f.id} is for ${f.to_name}`, 403);
    const sets = { status };
    const stamp = { delivered: "delivered_at", acked: "acked_at", escalated: "escalated_at" }[status];
    if (stamp) sets[stamp] = now();
    if (note) sets.note = String(note).trim().slice(0, 1000);
    const cols = Object.keys(sets).map((k) => `${k} = ?`).join(", ");
    const stmts = [this.db.prepare(`UPDATE flags SET ${cols} WHERE id = ?`).bind(...Object.values(sets), f.id), this.bump()];
    if (f.ref && (status === "acked" || status === "closed")) {
      const it = await this.get(f.ref);
      stmts.push(this.log(it, actor, status === "acked" ? "acknowledged" : "closed a flag", `F-${f.id}${note ? `: ${note}` : ""}`));
    }
    await this.db.batch(stmts);
    return this.getFlag(f.id);
  }

  // ---- directives ("my person told me to")
  async directive(actor, principal, quote, ref, what) {
    quote = squash(quote);
    if (!quote) return null;
    await this.db.batch([this.db.prepare(
      "INSERT INTO directives (actor, principal, ref, what, quote, at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(actor, principal || "", ref || "", clip(what, 200), quote.slice(0, 1000), now()), this.bump()]);
  }

  async directives({ ref, unchecked, limit } = {}) {
    let sql = "SELECT * FROM directives WHERE 1 = 1";
    const args = [];
    if (ref) { sql += " AND ref = ?"; args.push((await this.get(ref)).ref); }
    if (unchecked) sql += " AND verified IS NULL";
    sql += " ORDER BY id DESC LIMIT ?";
    args.push(Math.min(Number(limit) || 100, 500));
    return (await this.db.prepare(sql).bind(...args).all()).results;
  }

  async checkDirective(id, user, verified) {
    const r = await this.db.prepare("SELECT * FROM directives WHERE id = ?").bind(Number(id)).first();
    if (!r) throw new TTError(`no directive ${id}`, 404);
    if (r.principal && r.principal !== user) throw new TTError(`only ${r.principal} can check that directive`, 403);
    await this.db.batch([this.db.prepare("UPDATE directives SET verified = ?, checked_at = ? WHERE id = ?")
      .bind(verified ? 1 : 0, now(), r.id), this.bump()]);
    return this.db.prepare("SELECT * FROM directives WHERE id = ?").bind(r.id).first();
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
  const isAgent = !!agent;
  if (isAgent) actor = await store.touchAgent(actor, user); // every agent write is attributed to its person
  let touchedRef = ""; // the item a checkpoint or flag was about, for its directive
  const res = await route();
  // "My person told me to": recorded next to the change it justified.
  const quote = request.headers.get("X-Tiantasks-Directive");
  if (quote && isAgent && method !== "GET" && res.status >= 200 && res.status < 300) {
    const mi = path.match(/^\/api\/items\/([A-Za-z]?-?\d+)/);
    const refIn = touchedRef || (mi && method !== "DELETE" ? mi[1] : "");
    await store.directive(actor, user, decodeURIComponent(quote), refIn ? (await store.get(refIn)).ref : "", `${method} ${path}`);
  }
  return res;

  async function route() {
    // ---- agents, initiatives, checkpoints, flags, directives
    const mg = path.match(/^\/api\/agents\/([^/]+)$/);
    if (method === "GET" && path === "/api/agents") return json(await store.agents());
    if (method === "PUT" && mg) {
      const name = decodeURIComponent(mg[1]).toLowerCase();
      if (isAgent && name !== actor && name !== agent) throw new TTError("an agent can only report on itself", 403);
      return json(await store.reportAgent(name, user, await body(request)));
    }
    if (method === "DELETE" && mg) {
      if (isAgent) throw new TTError("only a person can remove an agent", 403);
      return json(await store.removeAgent(decodeURIComponent(mg[1]).toLowerCase(), user));
    }
    const mi = path.match(/^\/api\/initiatives\/(.+)$/);
    if (method === "GET" && path === "/api/initiatives") return json(await store.initiatives());
    if (method === "GET" && mi) return json(await store.initiative(decodeURIComponent(mi[1])));
    if (method === "DELETE" && mi) {
      if (isAgent) throw new TTError("only a person can remove an initiative", 403);
      return json(await store.removeInitiative(decodeURIComponent(mi[1]), user));
    }
    if (method === "PUT" && mi) return json(await store.putInitiative(decodeURIComponent(mi[1]), user, await body(request)));
    if (method === "GET" && path === "/api/checkpoints") {
      return json(await store.checkpoints({ ref: q.get("ref"), initiative: q.get("initiative"), limit: q.get("limit") }));
    }
    if (method === "POST" && path === "/api/checkpoints") {
      const b = await body(request);
      touchedRef = b.ref || "";
      return json(await store.checkpoint(actor, user, { ...b, source: b.source || (isAgent ? "agent" : "person") }), 201);
    }
    const mfl = path.match(/^\/api\/flags\/(\d+)(\/ack)?$/);
    if (method === "GET" && path === "/api/flags") {
      const to = q.get("to") === "me" ? actor : q.get("to");
      return json(await store.flags({ to, status: q.get("status"), ref: q.get("ref"), initiative: q.get("initiative"), limit: q.get("limit") }));
    }
    if (method === "POST" && path === "/api/flags") {
      const b = await body(request);
      touchedRef = b.ref || "";
      return json(await store.flag(actor, user, b), 201);
    }
    if (method === "POST" && mfl && mfl[2]) return json(await store.setFlag(mfl[1], actor, user, isAgent, "acked", (await body(request)).note || ""));
    if (method === "PATCH" && mfl) {
      const b = await body(request);
      return json(await store.setFlag(mfl[1], actor, user, isAgent, b.status, b.note || ""));
    }
    const md = path.match(/^\/api\/directives\/(\d+)$/);
    if (method === "GET" && path === "/api/directives") {
      return json(await store.directives({ ref: q.get("ref"), unchecked: q.get("unchecked") === "1", limit: q.get("limit") }));
    }
    if (method === "PATCH" && md) {
      if (isAgent) throw new TTError("agents can't check directives", 403);
      return json(await store.checkDirective(md[1], user, !!(await body(request)).verified));
    }

    const m = path.match(/^\/api\/items\/([A-Za-z]?-?\d+)(\/events|\/comments?)?$/);
    // Admins (TIANTASKS_ADMINS in wrangler.toml) can delete comments; agents never can.
    const admins = String(env.TIANTASKS_ADMINS || "").split(",").map((a) => a.trim()).filter(Boolean);
    const isAdmin = !agent && admins.includes(user);
    const mc = path.match(/^\/api\/comments\/(\d+)$/);
    if (mc && method === "DELETE") return json(await store.deleteComment(Number(mc[1]), actor, isAdmin));

    const ma = path.match(/^\/api\/items\/([A-Za-z]?-?\d+)\/attachments$/);
    if (ma && method === "GET") {
      const it = await store.get(ma[1]);
      return json(it.attachments.map((a) => ({ ...a, url: `/api/attachments/${a.id}` })));
    }
    if (ma && method === "POST") {
      const declared = Number(request.headers.get("Content-Length") || 0);
      if (declared > MAX_ATTACHMENT) {
        throw new TTError(`the image is ${humanSize(declared)}; the limit is ${humanSize(MAX_ATTACHMENT)}`, 413);
      }
      const mime = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
      return json(await store.attach(ma[1], actor, q.get("name"), mime, await request.arrayBuffer()), 201);
    }
    const mf = path.match(/^\/api\/attachments\/(\d+)$/);
    if (mf && method === "GET") {
      const a = await store.attachment(Number(mf[1]));
      const bytes = a.data instanceof ArrayBuffer ? a.data : new Uint8Array(a.data); // D1 may return BLOBs as number arrays
      return new Response(bytes, {
        headers: {
          "Content-Type": IMAGE_TYPES.includes(a.mime) ? a.mime : "application/octet-stream",
          "Cache-Control": "private, max-age=31536000, immutable", // ids are never reused (AUTOINCREMENT)
          "Content-Security-Policy": "default-src 'none'",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    if (mf && method === "DELETE") return json(await store.deleteAttachment(Number(mf[1]), actor));

    if (method === "GET" && path === "/") return html(PAGE);
    if (method === "GET" && path === "/api/version") return json({ v: await store.version(), build: PAGE_BUILD });
    if (method === "GET" && path === "/api/me") return json({ user, actor, shared: true, admin: isAdmin });
    if (method === "GET" && path === "/api/state") {
      const project = q.get("project") || undefined;
      const people = new Set(users.values());
      const [items, events, projects, assigned, agents, initiatives, checkpoints, flags] = await Promise.all([
        store.list({ project }), store.events({ limit: 40, project }), store.projects(), store.assignees(),
        store.agents(), store.initiatives(), store.checkpoints({ limit: 300 }), store.flags({ limit: 200 }),
      ]);
      const assignees = new Set([...assigned, ...people, ...[...people].map((p) => `claude-${p}`)]);
      return json({ me: user, shared: true, admin: isAdmin, items, events, projects, assignees: [...assignees].sort(),
        people: [...people].sort(), agents, initiatives, checkpoints, flags });
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
      if (b.fields && Object.keys(b.fields).length) it = await store.setFields(it.id, actor, b.fields);
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
}

// New tables appear on their own: every statement is CREATE ... IF NOT EXISTS, run once per
// Worker instance, so a deploy never needs a separate database step (or D1 permissions).
let schemaReady = null;
function ensureSchema(db) {
  const sql = SCHEMA.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n"); // comments first: they can contain ";"
  schemaReady ??= db.batch(sql.split(";").map((s) => s.trim()).filter(Boolean).map((s) => db.prepare(s)))
    .catch((e) => { schemaReady = null; throw e; });
  return schemaReady;
}

export default {
  async fetch(request, env) {
    try {
      if (env.DB) await ensureSchema(env.DB);
      return await handle(request, env);
    } catch (e) {
      if (e instanceof TTError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: "internal error" }, 500);
    }
  },
};
