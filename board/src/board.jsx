// `tt board`: a terminal kanban for Tiantasks, built with React + Ink.
// Three columns: OPEN (assignable) → IN PROGRESS (picked up) → DONE.
// Talks to the same HTTP API as the web page; `tt board` passes TT_URL / TT_TOKEN / TT_PROJECT.

import React, { useState, useEffect, useReducer, useRef } from "react";
import { render, Box, Text, useApp, useStdin, useStdout } from "ink";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { download, openFile, preview } from "./images.js";

const BASE = (process.env.TT_URL || "http://127.0.0.1:7777").replace(/\/$/, "");
const TOKEN = process.env.TT_TOKEN || "";
const HOME_PROJECT = process.env.TT_PROJECT || "general";
const PRANK = { crit: 0, high: 1, med: 2, low: 3 };
const PCYCLE = ["", "low", "med", "high", "crit"];
// Two hand-picked palettes. The terminal's own background/foreground are switched too (OSC 10/11),
// which most terminals support; if one doesn't, only the accent colours change.
const THEMES = {
  dark: {
    bg: "#14151f", fg: "#d4d8f0", accent: "#8aa4ff", issue: "#ff7a93", task: "#7dcfff", ok: "#9ece6a",
    warn: "#e5b567", muted: "#6f769b", border: "#34384f", selBg: "#2c3354", who: "#bb9af7", tag: "#73b8b0",
    crit: "#ff5f7e", high: "#ff7a93", med: "#e5b567", low: "#6f769b", line: "#454a66",
  },
  light: {
    bg: "#fbfaf7", fg: "#1f2330", accent: "#3651d4", issue: "#c62f2f", task: "#1d6fc0", ok: "#2d8a45",
    warn: "#b0570b", muted: "#80859a", border: "#d2cfc6", selBg: "#dde5ff", who: "#7a3fc2", tag: "#2f7a73",
    crit: "#b3122e", high: "#c62f2f", med: "#b0570b", low: "#80859a", line: "#b9b5ab",
  },
};
const PREFS = path.join(os.homedir(), ".tiantasks", "board.json");
const readPrefs = () => {
  try {
    return JSON.parse(fs.readFileSync(PREFS, "utf8"));
  } catch {
    return {};
  }
};
let themeName = readPrefs().theme === "light" ? "light" : "dark";
let TH = THEMES[themeName];
const paintTerminal = () => process.stdout.write(`\x1b]11;${TH.bg}\x07\x1b]10;${TH.fg}\x07`);
const setTheme = (name) => {
  themeName = name;
  TH = THEMES[name];
  paintTerminal();
  try {
    fs.mkdirSync(path.dirname(PREFS), { recursive: true });
    fs.writeFileSync(PREFS, JSON.stringify({ ...readPrefs(), theme: name }));
  } catch {}
};
const COMMENT_ACTIONS = ["commented", "added a comment", "replied", "deleted a comment"];
const COLUMNS = [
  { title: "OPEN", empty: "Nothing open. Press n to add." },
  { title: "IN PROGRESS", empty: "Nothing in progress." },
  { title: "DONE", empty: "Nothing done yet." },
];
const BOARD_KEYS = "←→ column  ↑↓ select  ⏎ details  n new  a assign  s start  d done  < > move  c comment  p priority  f project  / search  t theme  ? help  q quit";

// ------------------------------------------------------------------ helpers

const AUTH = { "User-Agent": "tiantasks-board", ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) };

async function api(method, path, body) {
  const headers = { ...AUTH, "Content-Type": "application/json", "X-Tiantasks": "1" };
  let r;
  try {
    r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error(`can't reach ${BASE}`);
  }
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) throw new Error("the board rejected your token; run `tt login` again");
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

function ago(iso) {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return iso.slice(0, 10);
}

const byQueue = (a, b) =>
  (PRANK[a.priority] ?? 9) - (PRANK[b.priority] ?? 9) || a.created_at.localeCompare(b.created_at);

// Cut to exactly n columns (with … when it doesn't fit) so highlighted rows line up.
const fit = (str, n) => (str.length > n ? str.slice(0, Math.max(0, n - 1)) + "…" : str.padEnd(n));

function wrap(text, width) {
  const out = [];
  for (const para of String(text || "").split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      if (!word) continue;
      if ((line + " " + word).trim().length > width && line) {
        out.push(line);
        line = word;
      } else line = (line + " " + word).trim();
      while (line.length > width) {
        out.push(line.slice(0, width));
        line = line.slice(width);
      }
    }
    out.push(line);
  }
  return out;
}

function useTerminalSize() {
  const { stdout } = useStdout();
  const [size, setSize] = useState({ cols: stdout.columns || 100, rows: stdout.rows || 30 });
  useEffect(() => {
    const onResize = () => setSize({ cols: stdout.columns, rows: stdout.rows });
    stdout.on("resize", onResize);
    return () => stdout.off("resize", onResize);
  }, [stdout]);
  return size;
}

// ------------------------------------------------------------------ small components

function InputBox({ label, value, hint }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={TH.accent} paddingX={1}>
      <Text>
        <Text bold color={TH.accent}>{label} </Text>
        {value}
        <Text inverse> </Text>
      </Text>
      <Text color={TH.muted}>{hint || "⏎ confirm · Esc cancel"}</Text>
    </Box>
  );
}

function Card({ it, selected, width, showProject }) {
  const meta = [];
  if (it.priority) meta.push(<Text key="p" color={TH[it.priority]} bold={it.priority === "crit"}>{it.priority}</Text>);
  if (it.assignee) meta.push(<Text key="a" color={TH.who}>@{it.assignee}</Text>);
  if (it.attachments?.length) meta.push(<Text key="f" color={TH.muted}>📎{it.attachments.length}</Text>);
  for (const t of it.tags || []) meta.push(<Text key={"t" + t} color={TH.tag}>#{t}</Text>);
  if (showProject) meta.push(<Text key="pr" color={TH.muted}>{it.project}</Text>);
  if (it.status === "doing") meta.push(<Text key="s" color={TH.warn}>started {ago(it.updated_at)}</Text>);
  if (it.status === "done") meta.push(<Text key="d" color={TH.ok}>✓ {it.note || ago(it.resolved_at)}</Text>);
  const done = it.status === "done";
  const bg = selected ? TH.selBg : undefined;
  const titleRoom = Math.max(4, width - it.ref.length - 3); // "│ T-12 " before the title
  return (
    <Box flexDirection="column" width={width} marginBottom={1}>
      <Text wrap="truncate-end" backgroundColor={bg} bold={selected}>
        <Text color={selected ? TH.accent : TH.border} backgroundColor={bg}>{selected ? "▌" : "│"}</Text>
        <Text color={it.kind === "issue" ? TH.issue : TH.task} backgroundColor={bg}> {it.ref} </Text>
        {done ? <Text strikethrough color={TH.muted} backgroundColor={bg}>{fit(it.title, titleRoom).trimEnd()}</Text>
          : <Text backgroundColor={bg}>{fit(it.title, titleRoom).trimEnd()}</Text>}
        <Text backgroundColor={bg}>{" ".repeat(Math.max(0, titleRoom - Math.min(it.title.length, titleRoom)))}</Text>
      </Text>
      <Text wrap="truncate-end">
        <Text color={selected ? TH.accent : TH.border}>{selected ? "▌" : "│"}</Text>
        {"  "}
        {meta.length ? meta.flatMap((m, i) => (i ? [<Text key={"sep" + i} color={TH.border}> · </Text>, m] : [m])) : <Text color={TH.muted}>—</Text>}
      </Text>
    </Box>
  );
}

function Column({ index, items, active, selIndex, width, height, showProject }) {
  const per = 3; // two lines + a gap per card
  const visible = Math.max(1, Math.floor((height - 4) / per));
  const start = Math.max(0, Math.min(selIndex - Math.floor(visible / 2), items.length - visible));
  const slice = items.slice(start, start + visible);
  const titleColor = [TH.task, TH.warn, TH.ok][index];
  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="round"
      borderColor={active ? TH.accent : TH.border} paddingX={1}>
      <Text>
        <Text bold color={titleColor}>{COLUMNS[index].title}</Text>
        <Text color={TH.muted}> {items.length}{index === 0 ? " · assignable" : ""}</Text>
      </Text>
      {start > 0 ? <Text color={TH.muted}>  ↑ {start} more</Text> : <Text> </Text>}
      {items.length === 0 ? (
        <Text color={TH.muted}>{COLUMNS[index].empty}</Text>
      ) : (
        slice.map((it, i) => (
          <Card key={it.id} it={it} selected={active && start + i === selIndex} width={width - 4} showProject={showProject} />
        ))
      )}
      {start + visible < items.length && <Text color={TH.muted}>  ↓ {items.length - start - visible} more</Text>}
    </Box>
  );
}

// ------------------------------------------------------------------ app

const NO_KEY = {};
const clean = (t) => t.replace(/[\t\n]+/g, " ").replace(/[\x00-\x1f\x7f]/g, "");
// When several keys arrive in one chunk, Ink reports them as one string; turn each character
// back into the key it stands for.
const charKey = (ch) => {
  if (ch === "\r" || ch === "\n") return ["", { return: true }];
  if (ch === "\t") return ["", { tab: true }];
  if (ch === "\x7f" || ch === "\b") return ["", { backspace: true }];
  if (ch < " ") return [String.fromCharCode(ch.charCodeAt(0) + 96), { ctrl: true }]; // Ctrl+letter
  return [ch, ch !== ch.toLowerCase() ? { shift: true } : NO_KEY];
};
const SEQ_KEYS = {
  "\x1b[A": { upArrow: true }, "\x1bOA": { upArrow: true }, "\x1b[B": { downArrow: true }, "\x1bOB": { downArrow: true },
  "\x1b[C": { rightArrow: true }, "\x1bOC": { rightArrow: true }, "\x1b[D": { leftArrow: true }, "\x1bOD": { leftArrow: true },
  "\x1b[1;2C": { rightArrow: true, shift: true }, "\x1b[1;2D": { leftArrow: true, shift: true },
  "\x1b[3~": { delete: true }, "\x1b[5~": { pageUp: true }, "\x1b[6~": { pageDown: true }, "\x1b": { escape: true },
};
// One key per token: an escape sequence (arrows, Delete, …), a lone Esc, or a single character.
const KEY_TOKENS = /\x1b\[[0-9;]*[A-Za-z~]|\x1bO[A-Z]|\x1b|[\s\S]/g;
const tokenKey = (t) => (SEQ_KEYS[t] ? ["", SEQ_KEYS[t]] : t.startsWith("\x1b") ? ["", NO_KEY] : charKey(t));

function App() {
  const { exit } = useApp();
  const { cols, rows } = useTerminalSize();
  const [, bump] = useReducer((x) => x + 1, 0);
  // All UI state lives in one mutable object so every keypress sees the latest state, even when
  // keys arrive faster than React re-renders (fast typing, pasting, key repeat).
  const ui = useRef({
    S: null, live: true, flash: "", col: 0, selIds: [null, null, null], mode: "board", input: null,
    assignIdx: 0, projIdx: -1, search: "", detailId: null, history: [], scroll: 0, version: null,
    comments: [], cSel: -1, openThreads: new Set(), pendingComment: null, previews: new Map(),
  }).current;
  const queue = useRef(Promise.resolve());
  // Server calls run one at a time, in the order the keys were pressed.
  const enqueue = (fn) => (queue.current = queue.current.then(fn, fn));

  const flash = (msg) => {
    ui.flash = msg;
    bump();
    setTimeout(() => ui.flash === msg && ((ui.flash = ""), bump()), 4000);
  };

  const load = async () => {
    try {
      ui.S = await api("GET", "/api/state");
      ui.live = true;
      if (ui.detailId && ui.mode !== "board") {
        [ui.history, ui.comments] = await Promise.all([
          api("GET", `/api/items/${ui.detailId}/events`).catch(() => []),
          api("GET", `/api/items/${ui.detailId}/comments`).catch(() => []),
        ]);
      }
    } catch (e) {
      ui.live = false;
      flash("✗ " + e.message);
    }
    bump();
  };

  // Poll a one-row version counter; re-read the board only when something changed.
  useEffect(() => {
    const tick = async () => {
      try {
        const { v } = await api("GET", "/api/version");
        if (!ui.live) ((ui.live = true), bump());
        if (v !== ui.version) {
          ui.version = v;
          await enqueue(load);
        }
      } catch {
        if (ui.live) ((ui.live = false), bump());
      }
    };
    tick();
    const t = setInterval(tick, 3000);
    return () => clearInterval(t);
  }, []);

  // ---- derived board (recomputed from the latest state whenever needed)
  const derive = () => {
    const project = ui.projIdx >= 0 && ui.S ? ui.S.projects[ui.projIdx]?.project : null;
    const q = ui.search.toLowerCase();
    const items = (ui.S?.items || []).filter(
      (i) => (!project || i.project === project) &&
        (!q || `${i.ref} ${i.title} ${i.body} ${i.assignee} ${(i.tags || []).join(" ")}`.toLowerCase().includes(q)),
    );
    const columns = [
      items.filter((i) => i.status === "open").sort(byQueue),
      items.filter((i) => i.status === "doing").sort(byQueue),
      items.filter((i) => i.status === "done").sort((a, b) => (b.resolved_at || "").localeCompare(a.resolved_at || "")),
    ];
    const selIndex = (c) => Math.max(0, Math.min(columns[c].findIndex((i) => i.id === ui.selIds[c]), columns[c].length - 1));
    const current = columns[ui.col][selIndex(ui.col)] || null;
    const detailItem = ui.S?.items.find((i) => i.id === ui.detailId) || null;
    const target = ui.mode === "detail" || ui.input?.fromDetail || (ui.detailId && ui.mode !== "board") ? detailItem : current;
    return { project, columns, selIndex, current, detailItem, target, assignees: ["", ...(ui.S?.assignees || [])] };
  };

  // ---- actions (applied on screen immediately, then saved in order)
  const localPatch = (id, body) => {
    const now = new Date().toISOString();
    const extra = body.status === "done" ? { resolved_at: now, note: body.note || "" }
      : body.status ? { updated_at: now, ...(body.status === "open" ? { note: "", resolved_at: null } : {}) } : {};
    ui.S = { ...ui.S, items: ui.S.items.map((i) => (i.id === id ? { ...i, ...body, ...extra } : i)) };
  };
  const save = (label, fn) =>
    enqueue(async () => {
      try {
        await fn();
        flash(label);
      } catch (e) {
        flash("✗ " + e.message);
      }
      await load();
    });
  const patch = (it, body, label) => {
    localPatch(it.id, body);
    bump();
    save(label, () => api("PATCH", `/api/items/${it.id}`, body));
  };
  const follow = (it, c) => {
    ui.selIds = ui.selIds.map((v, i) => (i === c ? it.id : v));
    if (ui.mode === "board") ui.col = c;
  };
  const moveRight = (it) => {
    if (it.status === "open") {
      follow(it, 1);
      patch(it, { status: "doing", ...(it.assignee ? {} : { assignee: ui.S.me }) }, `${it.ref} → in progress`);
    } else if (it.status === "doing") {
      follow(it, 2);
      patch(it, { status: "done" }, `${it.ref} → done`);
    }
  };
  const moveLeft = (it) => {
    if (it.status === "open") return;
    follow(it, 0);
    patch(it, { status: "open" }, it.status === "done" ? `${it.ref} reopened` : `${it.ref} → open`);
  };
  const ask = (purpose, label, extra = {}) => {
    ui.input = { purpose, label, value: "", ...extra };
    ui.mode = "input";
    bump();
  };
  const leaveTo = () => (ui.input?.fromDetail || (ui.mode !== "board" && ui.mode !== "detail" && ui.detailId) ? "detail" : "board");

  const itemKey = (inp, key, it) => {
    if (!it) return;
    const fromDetail = ui.mode === "detail";
    if (inp === "a") {
      ui.assignIdx = Math.max(0, derive().assignees.indexOf(it.assignee));
      ui.mode = "assign";
      bump();
    } else if (inp === "s" && it.status !== "doing") moveRight({ ...it, status: "open" });
    else if (inp === "d" && it.status !== "done") ask("note", `Resolve ${it.ref}: note (optional)`, { id: it.id, fromDetail });
    else if (inp === ">" || inp === "L" || (key.shift && key.rightArrow)) moveRight(it);
    else if (inp === "<" || inp === "H" || (key.shift && key.leftArrow)) moveLeft(it);
    else if (inp === "c") ask("comment", `Comment on ${it.ref}:`, { id: it.id, fromDetail });
    else if (inp === "p") {
      const next = PCYCLE[(PCYCLE.indexOf(it.priority || "") + 1) % PCYCLE.length];
      patch(it, { priority: next }, `${it.ref} priority: ${next || "none"}`);
    } else if (inp === "x") ((ui.mode = "confirm"), bump());
  };

  // ---- comment threads in the details view, as a flat list of selectable rows:
  // a comment, then (if it has replies) a fold line, then the replies when the fold is open.
  const commentRows = () => {
    const kids = {};
    for (const c of ui.comments) if (c.parent_id) (kids[c.parent_id] ||= []).push(c);
    const rows = [];
    for (const c of ui.comments) {
      if (c.parent_id) continue;
      const replies = kids[c.id] || [];
      if (c.deleted && !replies.length) continue;
      rows.push({ type: "comment", c, thread: c.id });
      if (replies.length) {
        const open = ui.openThreads.has(c.id);
        rows.push({ type: "fold", thread: c.id, n: replies.length, open });
        if (open) for (const r of replies) rows.push({ type: "reply", c: r, thread: c.id });
      }
    }
    return rows;
  };

  // Everything selectable in the details view: screenshots, then comment threads.
  const detailRows = () => {
    const it = ui.S?.items.find((i) => i.id === ui.detailId);
    return [...(it?.attachments || []).map((a) => ({ type: "shot", a })), ...commentRows()];
  };

  // Previews are made in the background; the view re-renders when one is ready.
  const ensurePreview = (a, cols, rows) => {
    const k = `${a.id}:${cols}x${rows}`;
    if (!ui.previews.has(k)) {
      ui.previews.set(k, { status: "loading" });
      download(BASE, AUTH, a)
        .then((file) => preview(file, cols, rows))
        .then((p) => ui.previews.set(k, { status: "ready", ...p }))
        .catch((e) => ui.previews.set(k, { status: "error", error: e.message.split("\n")[0] }))
        .finally(bump);
    }
    return ui.previews.get(k);
  };

  const openShot = (a) => {
    flash(`opening ${a.name}…`);
    download(BASE, AUTH, a)
      .then(openFile)
      .then(() => flash(`opened ${a.name}`))
      .catch((e) => flash("✗ " + e.message.split("\n")[0]));
  };

  const submitInput = () => {
    const f = ui.input;
    const v = f.value.trim();
    ui.input = null;
    ui.mode = f.fromDetail ? "detail" : "board";
    bump();
    if (f.purpose === "new-title") return v && ask("new-desc", `Description for “${v}” (optional):`, { kind: f.kind, title: v });
    if (f.purpose === "new-desc") {
      const { project } = derive();
      return save(`added ${f.kind}`, async () => {
        const it = await api("POST", "/api/items", { kind: f.kind, title: f.title, body: f.value, project: project || HOME_PROJECT });
        ui.col = 0;
        ui.selIds[0] = it.id;
      });
    }
    const it = ui.S.items.find((i) => i.id === f.id);
    if (!it) return;
    if (f.purpose === "comment" && v) return save(`commented on ${it.ref}`, () => api("POST", `/api/items/${it.id}/comment`, { text: v }));
    if (f.purpose === "reply" && v) {
      ui.openThreads.add(f.parent);
      return save(`replied on ${it.ref}`, () => api("POST", `/api/items/${it.id}/comment`, { text: v, parent_id: f.parent }));
    }
    if (f.purpose === "note") {
      follow(it, 2);
      return patch(it, { status: "done", note: v }, `${it.ref} → done`);
    }
    if (f.purpose === "assign-new" && v) return patch(it, { assignee: v.toLowerCase() }, `${it.ref} → ${v.toLowerCase()}`);
  };

  const inputKey = (inp, key) => {
    const f = ui.input;
    if (key.escape) {
      if (f.purpose === "search") ui.search = "";
      ui.input = null;
      ui.mode = f.fromDetail ? "detail" : "board";
      return bump();
    }
    if (key.return) return submitInput();
    if (key.tab) {
      if (f.purpose === "new-title") f.kind = f.kind === "task" ? "issue" : "task";
      return bump();
    }
    if (key.backspace || key.delete) f.value = f.value.slice(0, -1);
    else if (key.ctrl && inp === "u") f.value = "";
    else if (inp && !key.ctrl && !key.meta) f.value += clean(inp);
    else return;
    if (f.purpose === "search") ui.search = f.value;
    bump();
  };

  const handleKey = (inp, key) => {
    if (ui.mode === "input") return inputKey(inp, key);
    const d = derive();
    if (ui.mode === "help") return ((ui.mode = "board"), bump());
    if (ui.mode === "confirmComment") {
      const c = ui.pendingComment;
      ui.mode = "detail";
      ui.pendingComment = null;
      bump();
      if (inp === "y" && c) save("comment deleted", () => api("DELETE", `/api/comments/${c.id}`));
      return;
    }
    if (inp === "t" && ui.mode !== "assign") return (setTheme(themeName === "dark" ? "light" : "dark"), bump());
    if (ui.mode === "confirm") {
      const it = d.target;
      ui.mode = "board";
      bump();
      if (inp === "y" && it) {
        ui.detailId = null;
        save(`${it.ref} deleted`, () => api("DELETE", `/api/items/${it.id}`));
      }
      return;
    }
    if (ui.mode === "assign") {
      const back = ui.detailId ? "detail" : "board";
      if (key.escape) return ((ui.mode = back), bump());
      if (key.upArrow || inp === "k") ui.assignIdx = Math.max(0, ui.assignIdx - 1);
      else if (key.downArrow || inp === "j") ui.assignIdx = Math.min(d.assignees.length, ui.assignIdx + 1);
      else if (key.return) {
        const it = d.target;
        ui.mode = back;
        if (ui.assignIdx === d.assignees.length) return ask("assign-new", `Assign ${it.ref} to (name):`, { id: it.id, fromDetail: back === "detail" });
        const who = d.assignees[ui.assignIdx];
        return patch(it, { assignee: who }, `${it.ref} → ${who || "unassigned"}`);
      }
      return bump();
    }
    if (ui.mode === "detail") {
      const rows = detailRows();
      const sel = ui.cSel >= 0 && ui.cSel < rows.length ? rows[ui.cSel] : null;
      if (key.escape && sel) return ((ui.cSel = -1), bump()); // first Esc leaves the selection
      if (sel?.type === "shot" && (key.return || inp === "o")) return openShot(sel.a);
      if (inp === "o" && d.detailItem?.attachments?.length) return openShot(d.detailItem.attachments[0]);
      if (key.escape || inp === "q" || (key.leftArrow && !key.shift && !sel)) {
        ui.detailId = null;
        ui.mode = "board";
        return bump();
      }
      // ↑↓ walk through comments (the view scrolls to follow); with no comments they scroll.
      if (key.downArrow || inp === "j") {
        if (rows.length) ui.cSel = Math.min(rows.length - 1, ui.cSel + 1);
        else ui.scroll += 1;
        return bump();
      }
      if (key.upArrow || inp === "k") {
        if (ui.cSel >= 0) ui.cSel -= 1;
        else ui.scroll = Math.max(0, ui.scroll - 1);
        return bump();
      }
      if (key.pageDown || inp === "J") return ((ui.scroll += 5), bump());
      if (key.pageUp || inp === "K") return ((ui.scroll = Math.max(0, ui.scroll - 5)), bump());
      if (sel?.type === "fold" && (key.return || inp === " " || (key.rightArrow && !sel.open) || (key.leftArrow && sel.open))) {
        sel.open ? ui.openThreads.delete(sel.thread) : ui.openThreads.add(sel.thread);
        return bump();
      }
      if (sel?.type === "reply" && key.leftArrow && !key.shift) {
        ui.openThreads.delete(sel.thread); // fold the thread back up and land on its fold line
        ui.cSel = detailRows().findIndex((r) => r.type === "fold" && r.thread === sel.thread);
        return bump();
      }
      if (sel?.c && (inp === "r" || key.return)) {
        const parent = rows.find((r) => r.type === "comment" && r.thread === sel.thread).c;
        return ask("reply", `Reply to ${parent.deleted ? "thread" : parent.author}:`, { id: d.detailItem.id, parent: sel.thread, fromDetail: true });
      }
      if (sel?.type === "fold" && inp === "r") {
        return ask("reply", "Reply to thread:", { id: d.detailItem.id, parent: sel.thread, fromDetail: true });
      }
      if (sel?.c && (key.backspace || key.delete)) {
        if (!ui.S.admin) return flash("✗ only an admin can delete comments");
        if (sel.c.deleted) return;
        ui.pendingComment = sel.c;
        ui.mode = "confirmComment";
        return bump();
      }
      return itemKey(inp, key, d.detailItem);
    }
    // board
    if (inp === "q") return exit();
    if (inp === "?") return ((ui.mode = "help"), bump());
    if (key.shift && (key.leftArrow || key.rightArrow)) return itemKey(inp, key, d.current);
    if (key.leftArrow || inp === "h") return ((ui.col = Math.max(0, ui.col - 1)), bump());
    if (key.rightArrow || inp === "l") return ((ui.col = Math.min(2, ui.col + 1)), bump());
    const list = d.columns[ui.col];
    if ((key.upArrow || inp === "k") && list.length) return ((ui.selIds[ui.col] = list[Math.max(0, d.selIndex(ui.col) - 1)].id), bump());
    if ((key.downArrow || inp === "j") && list.length) return ((ui.selIds[ui.col] = list[Math.min(list.length - 1, d.selIndex(ui.col) + 1)].id), bump());
    if (key.return && d.current) {
      ui.detailId = d.current.id;
      ui.scroll = 0;
      ui.history = [];
      ui.comments = [];
      ui.cSel = -1;
      ui.mode = "detail";
      bump();
      return enqueue(load);
    }
    if (inp === "n") return ask("new-title", "New task:", { kind: "task", hint: "⏎ next · Tab task/issue · Esc cancel" });
    if (inp === "/") return ask("search", "Search:", { value: ui.search, hint: "filters as you type · ⏎ keep · Esc clear" });
    if (inp === "f") {
      const n = ui.S?.projects.length || 0;
      ui.projIdx = ui.projIdx + 1 >= n ? -1 : ui.projIdx + 1;
      return bump();
    }
    if (inp === "r") return enqueue(load).then(() => flash("refreshed"));
    itemKey(inp, key, d.current);
  };

  // Read the keyboard directly rather than through Ink's useInput: when several keys arrive in one
  // chunk (holding an arrow key, typing fast, pasting), Ink reports only the first. Here every key
  // in a chunk is handled in order, each seeing the state the previous one left.
  const { stdin, setRawMode } = useStdin();
  useEffect(() => {
    setRawMode(true);
    const onData = (data) => {
      const chunk = String(data);
      if (ui.mode === "input" && !/[\x00-\x1f\x7f]/.test(chunk)) return inputKey(chunk, NO_KEY); // pasted text
      for (const t of chunk.match(KEY_TOKENS) || []) {
        if (t === "\x03") return exit(); // Ctrl+C
        handleKey(...tokenKey(t));
      }
    };
    stdin.on("data", onData);
    return () => {
      stdin.off("data", onData);
      setRawMode(false);
    };
  }, []);

  // ---- layout
  const { S, mode } = ui;
  if (!S) return <Text>{ui.live ? "Loading board…" : `✗ ${ui.flash || `can't reach ${BASE}`}`}</Text>;
  const { project, columns, selIndex, detailItem, target, assignees } = derive();
  // Everything must fit in the terminal, so the board shrinks to make room for pop-ups.
  const PICK_ROWS = 8;
  const pickList = [...assignees, "+ someone else…"];
  const pickStart = Math.max(0, Math.min(ui.assignIdx - Math.floor(PICK_ROWS / 2), pickList.length - PICK_ROWS));
  const popup = mode === "input" ? 4 : mode === "assign" ? Math.min(pickList.length, PICK_ROWS) + 3 : mode === "confirm" || mode === "confirmComment" ? 1 : 0;
  const bodyH = Math.max(6, rows - 3 - popup);
  const colW = Math.floor(cols / 3);
  const open = S.items.filter((i) => i.status !== "done");
  const doing = S.items.filter((i) => i.status === "doing");
  const host = BASE.replace(/^https?:\/\//, "");

  const header = (
    <Box width={cols}>
      <Text wrap="truncate-end">
        <Text bold color={TH.accent}>Tiantasks</Text> <Text color={ui.live ? TH.ok : TH.issue}>●</Text>{" "}
        <Text color={TH.muted}>{host}</Text>{"  "}
        <Text color={TH.muted}>project</Text> {project || "all"}
        {ui.search ? <Text>{"  "}<Text color={TH.muted}>search</Text> “{ui.search}”</Text> : null}
        {"  "}
        <Text color={TH.muted}>
          {open.length - doing.length} open · {doing.length} in progress · you are {S.me}{S.admin ? " (admin)" : ""} · {themeName}
        </Text>
      </Text>
    </Box>
  );

  let body;
  if (mode === "help") {
    body = (
      <Box flexDirection="column" borderStyle="round" borderColor={TH.border} paddingX={2} height={bodyH}>
        <Text bold color={TH.accent}>Keys</Text>
        {[
          ["← → / h l", "switch column"], ["↑ ↓ / k j", "select card"], ["⏎", "open details"],
          ["n", "new task (Tab switches to issue)"], ["a", "assign (pick someone, or type a new name)"],
          ["s", "start: move to IN PROGRESS (assigns you if unassigned)"], ["d", "done, with an optional note"],
          ["> / <  (or ⇧→ ⇧←)", "move card right / left"], ["c", "comment"], ["p", "cycle priority"],
          ["x", "delete (asks first)"], ["f", "cycle project filter"], ["/", "search"], ["t", "dark / light theme"],
          ["r", "refresh"], ["q", "quit"], ["", ""],
          ["In details:", ""], ["↑ ↓", "select screenshots and comments (J K scroll the page)"],
          ["o  (or ⏎ on a screenshot)", "open the screenshot full size (Preview on a Mac)"], ["⏎ on a reply line", "expand / collapse the thread"],
          ["r  or  ⏎", "reply to the selected comment"], ["c", "new comment"], ["⌫", "delete the selected comment (admins)"],
          ["Esc", "leave the comments, then close"],
        ].map(([k, desc], i) => (
          <Text key={i}>
            <Text color={desc ? TH.accent : TH.fg} bold={!desc}>{k.padEnd(22)}</Text>
            {desc}
          </Text>
        ))}
        <Text color={TH.muted}>{"\n"}Press any key to go back.</Text>
      </Box>
    );
  } else if (ui.detailId && mode !== "board") {
    const it = detailItem;
    const w = cols - 4;
    const lines = [];
    if (!it) lines.push(<Text color={TH.muted}>This item no longer exists. Press Esc.</Text>);
    else {
      lines.push(
        <Text>
          <Text color={it.kind === "issue" ? TH.issue : TH.task} bold>{it.ref}</Text>{" "}
          <Text color={TH.muted}>
            {it.kind} · {{ open: "open", doing: "in progress", done: "done" }[it.status]}
            {it.priority ? ` · ${it.priority}` : ""} · {it.assignee ? `@${it.assignee}` : "unassigned"} · {it.project}
            {it.tags?.length ? " · " + it.tags.map((t) => "#" + t).join(" ") : ""}
          </Text>
        </Text>,
        <Text bold strikethrough={it.status === "done"}>{it.title}</Text>,
        <Text color={TH.muted}>opened {ago(it.created_at)} by {it.created_by}{it.status === "done" ? ` · resolved ${ago(it.resolved_at)}` : ""}</Text>,
        <Text> </Text>,
      );
      if (it.status === "done" && it.note) lines.push(<Text color={TH.ok}>✓ {it.note}</Text>, <Text> </Text>);
      for (const l of it.body ? wrap(it.body, w) : ["(no description)"]) lines.push(it.body ? <Text>{l}</Text> : <Text color={TH.muted}>{l}</Text>);
      const rows = detailRows();
      if (ui.cSel >= rows.length) ui.cSel = rows.length - 1;
      const shots = rows.filter((r) => r.type === "shot").length;
      if (shots) {
        lines.push(
          <Text> </Text>,
          <Text>
            <Text bold color={TH.accent}>Screenshots & files ({shots})</Text>
            <Text color={TH.muted}>  ↑↓ select to preview · o open full size</Text>
          </Text>,
        );
      }
      rows.slice(0, shots).forEach((row, i) => {
        const selected = i === ui.cSel;
        const bg = selected ? TH.selBg : undefined;
        const start = lines.length;
        const size = row.a.size >= 1e6 ? `${(row.a.size / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(row.a.size / 1000))} KB`;
        lines.push(
          <Text backgroundColor={bg}>
            <Text color={TH.accent} backgroundColor={bg}>{selected ? "▌" : " "}</Text>
            <Text backgroundColor={bg}> 📎 {row.a.name}</Text>
            <Text color={TH.muted} backgroundColor={bg}>  {size}{selected ? "  ⏎/o open full size" : ""}</Text>
          </Text>,
        );
        if (selected && !row.a.mime?.startsWith("image/")) {
          lines.push(<Text color={TH.muted}>    (not an image · press o to open it)</Text>);
        } else if (selected) {
          // The preview sits under the selected screenshot, sized to the space available.
          const pv = ensurePreview(row.a, Math.min(w - 4, 100), Math.max(6, Math.min(22, bodyH - 10)));
          if (pv.status === "loading") lines.push(<Text color={TH.muted}>    loading preview…</Text>);
          else if (pv.status === "error") lines.push(<Text color={TH.issue}>    ✗ {pv.error}</Text>);
          else for (const l of pv.lines) lines.push(<Text>{"    "}{l}</Text>);
        }
        if (selected) ui.selLines = [start, lines.length];
      });
      // Comment threads: every row is selectable; the selected one is marked ▌ and highlighted.
      const total = ui.comments.filter((c) => !c.deleted).length;
      lines.push(
        <Text> </Text>,
        <Text>
          <Text bold color={TH.accent}>Comments ({total})</Text>
          <Text color={TH.muted}>{rows.length > shots ? `  ↑↓ select · r reply · c new${S.admin ? " · ⌫ delete" : ""}` : ""}</Text>
        </Text>,
      );
      if (rows.length === shots) lines.push(<Text color={TH.muted}>  none yet · press c to add one</Text>);
      rows.forEach((row, i) => {
        if (row.type === "shot") return;
        const selected = i === ui.cSel;
        const bg = selected ? TH.selBg : undefined;
        const mark = <Text color={TH.accent} backgroundColor={bg}>{selected ? "▌" : " "}</Text>;
        const start = lines.length;
        if (row.type === "fold") {
          lines.push(
            <Text backgroundColor={bg}>
              {mark}<Text color={selected ? TH.accent : TH.line} backgroundColor={bg}> ╰─ </Text>
              <Text color={TH.accent} backgroundColor={bg}>{row.open ? "hide " : ""}{row.n} {row.n === 1 ? "reply" : "replies"} {row.open ? "▾" : "▸"}</Text>
              {selected ? <Text color={TH.muted} backgroundColor={bg}>  ⏎ {row.open ? "collapse" : "expand"}</Text> : null}
            </Text>,
          );
        } else {
          const c = row.c;
          const guide = row.type === "reply" ? " │   " : " ";
          const g = <Text color={TH.line} backgroundColor={bg}>{guide}</Text>;
          if (c.deleted) {
            lines.push(<Text backgroundColor={bg}>{mark}{g}<Text italic color={TH.muted} backgroundColor={bg}>{row.type === "reply" ? "reply" : "comment"} deleted</Text></Text>);
          } else {
            lines.push(
              <Text backgroundColor={bg}>
                {mark}{g}<Text bold color={TH.who} backgroundColor={bg}>{c.author}</Text>
                <Text color={TH.muted} backgroundColor={bg}> · {ago(c.at)}</Text>
              </Text>,
            );
            for (const l of wrap(c.body, w - guide.length - 4))
              lines.push(<Text backgroundColor={bg}>{mark}{g}<Text backgroundColor={bg}>  {l}</Text></Text>);
          }
        }
        if (selected) ui.selLines = [start, lines.length];
      });
      if (ui.cSel < 0) ui.selLines = null;
      lines.push(<Text> </Text>, <Text bold color={TH.accent}>History</Text>);
      for (const e of ui.history.filter((e) => !COMMENT_ACTIONS.includes(e.action)))
        lines.push(<Text color={TH.muted} wrap="truncate-end">  {ago(e.at)} · {e.actor} {e.action}{e.detail ? `: ${e.detail}` : ""}</Text>);
    }
    const room = bodyH - 2;
    if (ui.selLines) {
      // keep the selected comment on screen
      const [a, b] = ui.selLines;
      if (a < ui.scroll) ui.scroll = a;
      else if (b > ui.scroll + room) ui.scroll = Math.min(a, b - room);
    }
    const top = Math.min(ui.scroll, Math.max(0, lines.length - room));
    body = (
      <Box flexDirection="column" borderStyle="round" borderColor={TH.accent} paddingX={1} height={bodyH}>
        {lines.slice(top, top + room).map((l, i) => <Box key={top + i}>{l}</Box>)}
      </Box>
    );
  } else {
    body = (
      <Box height={bodyH}>
        {columns.map((list, c) => (
          <Column key={c} index={c} items={list} active={c === ui.col} selIndex={selIndex(c)}
            width={c === 2 ? cols - colW * 2 : colW} height={bodyH} showProject={!project} />
        ))}
      </Box>
    );
  }

  let footer = BOARD_KEYS;
  if (ui.detailId && mode !== "board") footer = "Esc back  ↑↓ select  o open screenshot  ⏎ open/reply/expand  r reply  c comment  ⌫ delete comment  a assign  s start  d done  < > move  p priority  x delete item  t theme";
  if (mode === "assign") footer = "↑↓ choose  ⏎ assign  Esc cancel";
  const f = ui.input;

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      {header}
      {body}
      {mode === "assign" && target && (
        <Box flexDirection="column" borderStyle="round" borderColor={TH.accent} paddingX={1}>
          <Text bold color={TH.accent}>Assign {target.ref} to: <Text color={TH.muted}>({ui.assignIdx + 1}/{pickList.length})</Text></Text>
          {pickList.slice(pickStart, pickStart + PICK_ROWS).map((a, j) => {
            const i = pickStart + j;
            return (
              <Text key={a || "none"} backgroundColor={i === ui.assignIdx ? TH.selBg : undefined} bold={i === ui.assignIdx}>
                {i === ui.assignIdx ? "› " : "  "}
                {i === assignees.length ? a : a ? (a === S.me ? `${a} (you)` : a) : "Unassigned"}
              </Text>
            );
          })}
        </Box>
      )}
      {mode === "confirm" && target && (
        <Text color={TH.issue} bold>Delete {target.ref} “{target.title}”? This can't be undone. y / n</Text>
      )}
      {mode === "confirmComment" && ui.pendingComment && (
        <Text color={TH.issue} bold>Delete this comment by {ui.pendingComment.author} for everyone? Replies stay. y / n</Text>
      )}
      {mode === "input" && f && (
        <InputBox label={f.purpose === "new-title" ? (f.kind === "task" ? "New task:" : "New issue:") : f.label}
          value={f.value} hint={f.hint} />
      )}
      <Text wrap="truncate-end" color={ui.flash.startsWith("✗") ? TH.issue : TH.ok}>{ui.flash || " "}</Text>
      <Text color={TH.muted} wrap="truncate-end">{footer}</Text>
    </Box>
  );
}

// ------------------------------------------------------------------ start

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("tt board needs an interactive terminal.");
  process.exit(1);
}
// Full-screen like vim, in the theme's colours; the terminal's own colours come back on exit.
const leaveAltScreen = () => process.stdout.write("\x1b]111\x07\x1b]110\x07\x1b[?1049l\x1b[?25h");
process.stdout.write("\x1b[?1049h\x1b[H\x1b[?25l");
paintTerminal();
process.on("exit", leaveAltScreen);
const app = render(<App />);
app.waitUntilExit().then(() => process.exit(0));
