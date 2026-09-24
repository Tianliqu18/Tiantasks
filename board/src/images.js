// Screenshot previews for the terminal board.
// Images are downloaded once into ~/.tiantasks/cache, shrunk with the system's image tool (sips on
// macOS, ImageMagick elsewhere) into an uncompressed BMP, and drawn with "▀" half-blocks: each
// character cell shows two pixels, the top one as the text colour and the bottom one as the background.

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const run = (cmd, args) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout: 20000 }, (err, stdout) => (err ? reject(err) : resolve(stdout))),
  );

const onPath = async (cmd) => {
  try {
    await run(process.platform === "win32" ? "where" : "which", [cmd]);
    return true;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------- download + open

export async function download(base, headers, attachment) {
  // Attachment ids never change their content, so a cached file is always good.
  const board = crypto.createHash("sha1").update(base).digest("hex").slice(0, 10);
  const dir = path.join(os.homedir(), ".tiantasks", "cache", board, String(attachment.id));
  const file = path.join(dir, path.basename(attachment.name) || "screenshot");
  if (fs.existsSync(file)) return file;
  const r = await fetch(`${base}/api/attachments/${attachment.id}`, { headers });
  if (!r.ok) throw new Error(`couldn't download ${attachment.name} (HTTP ${r.status})`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  return file;
}

export async function openFile(file) {
  if (process.platform === "darwin") return run("open", [file]);
  if (process.platform === "win32") return run("cmd", ["/c", "start", "", file]);
  return run("xdg-open", [file]);
}

// ---------------------------------------------------------------- resize to BMP

async function imageTool() {
  if (process.platform === "darwin") return "sips";
  if (await onPath("magick")) return "magick";
  if (await onPath("convert")) return "convert";
  return null;
}

async function imageSize(tool, file) {
  if (tool === "sips") {
    const out = await run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file]);
    const w = +(/pixelWidth:\s*(\d+)/.exec(out) || [])[1];
    const h = +(/pixelHeight:\s*(\d+)/.exec(out) || [])[1];
    if (!w || !h) throw new Error("couldn't read the image size");
    return [w, h];
  }
  const out = await run(tool === "magick" ? "magick" : "identify", [...(tool === "magick" ? ["identify"] : []), "-format", "%w %h", `${file}[0]`]);
  const [w, h] = out.trim().split(/\s+/).map(Number);
  return [w, h];
}

async function toBMP(tool, file, w, h) {
  const out = `${file}.${w}x${h}.bmp`;
  if (fs.existsSync(out)) return out;
  if (tool === "sips") await run("sips", ["-s", "format", "bmp", "-z", String(h), String(w), file, "--out", out]);
  else await run(tool, [`${file}[0]`, "-resize", `${w}x${h}!`, "-type", "TrueColor", `BMP3:${out}`]);
  return out;
}

// ---------------------------------------------------------------- BMP decoding (24/32-bit)

function channel(value, mask) {
  if (!mask) return 0;
  let shift = 0;
  while (!((mask >>> shift) & 1)) shift++;
  const max = mask >>> shift;
  return Math.round((((value & mask) >>> shift) / max) * 255);
}

export function readBMP(buf) {
  if (buf.toString("ascii", 0, 2) !== "BM") throw new Error("not a BMP file");
  const offset = buf.readUInt32LE(10);
  const w = buf.readInt32LE(18);
  const rawH = buf.readInt32LE(22);
  const bpp = buf.readUInt16LE(28);
  const compression = buf.readUInt32LE(30);
  if (bpp !== 24 && bpp !== 32) throw new Error(`unsupported BMP (${bpp}-bit)`);
  const h = Math.abs(rawH);
  const bottomUp = rawH > 0;
  const masks = compression === 3 || compression === 6
    ? [buf.readUInt32LE(54), buf.readUInt32LE(58), buf.readUInt32LE(62)]
    : null;
  const stride = Math.ceil((bpp * w) / 32) * 4;
  const px = (x, y) => {
    const i = offset + (bottomUp ? h - 1 - y : y) * stride + x * (bpp / 8);
    if (bpp === 32 && masks) {
      const v = buf.readUInt32LE(i);
      return masks.map((m) => channel(v, m));
    }
    return [buf[i + 2], buf[i + 1], buf[i]]; // stored as BGR(A)
  };
  return { w, h, px };
}

// ---------------------------------------------------------------- half-block rendering

const TRUECOLOR =
  /truecolor|24bit/i.test(process.env.COLORTERM || "") ||
  ["iTerm.app", "WezTerm", "vscode", "ghostty", "kitty"].includes(process.env.TERM_PROGRAM || "");

// Nearest colour in the standard 256-colour palette (6×6×6 cube or the 24 greys), for terminals
// without 24-bit colour, such as macOS Terminal.
const CUBE = [0, 95, 135, 175, 215, 255];
const nearestLevel = (v) => CUBE.reduce((best, l, i) => (Math.abs(l - v) < Math.abs(CUBE[best] - v) ? i : best), 0);
const dist = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
function ansi256(rgb) {
  const [r, g, b] = rgb.map(nearestLevel);
  const cube = [CUBE[r], CUBE[g], CUBE[b]];
  const grey = Math.max(0, Math.min(23, Math.round(((rgb[0] + rgb[1] + rgb[2]) / 3 - 8) / 10)));
  const greyV = 8 + grey * 10;
  return dist(rgb, [greyV, greyV, greyV]) < dist(rgb, cube) ? 232 + grey : 16 + 36 * r + 6 * g + b;
}

const color = (layer, c) =>
  TRUECOLOR ? `\x1b[${layer};2;${c[0]};${c[1]};${c[2]}m` : `\x1b[${layer};5;${ansi256(c)}m`;

export function halfBlocks(img) {
  const lines = [];
  for (let y = 0; y < img.h; y += 2) {
    let s = "";
    let lastTop = "";
    let lastBottom = "";
    for (let x = 0; x < img.w; x++) {
      const top = color(38, img.px(x, y));
      const bottom = y + 1 < img.h ? color(48, img.px(x, y + 1)) : "\x1b[49m";
      if (top !== lastTop) s += top;
      if (bottom !== lastBottom) s += bottom;
      lastTop = top;
      lastBottom = bottom;
      s += "▀";
    }
    lines.push(s + "\x1b[0m");
  }
  return lines;
}

// ---------------------------------------------------------------- the whole pipeline

// Returns { lines, width, height } sized to fit within maxCols × maxRows character cells.
export async function preview(file, maxCols, maxRows) {
  const tool = await imageTool();
  if (!tool) throw new Error("previews need ImageMagick here (press o to open the image instead)");
  const [iw, ih] = await imageSize(tool, file);
  // Each cell holds one pixel across and two down, which comes out roughly square.
  let w = Math.max(4, Math.min(maxCols, iw));
  let h = Math.max(2, Math.round((w * ih) / iw));
  if (h > maxRows * 2) {
    h = maxRows * 2;
    w = Math.max(4, Math.round((h * iw) / ih));
  }
  const bmp = await toBMP(tool, file, w, h);
  const img = readBMP(fs.readFileSync(bmp));
  return { lines: halfBlocks(img), width: img.w, height: Math.ceil(img.h / 2), source: [iw, ih] };
}
