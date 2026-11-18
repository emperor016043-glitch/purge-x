import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export function expandHome(p) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function pathExists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function readText(p) {
  return fs.readFileSync(p, "utf8");
}

export function readTextSafe(p, fallback = null) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return fallback;
  }
}

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

export function writeTextAtomic(p, text) {
  ensureDir(path.dirname(p));
  const tmp = `${p}.purge-x.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, p);
  return p;
}

export function readJson(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(p, obj, indent = 2) {
  return writeTextAtomic(p, JSON.stringify(obj, null, indent) + "\n");
}

export function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function stamp(date = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return (
    date.getFullYear() +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    "-" +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  );
}

export function toPosix(p) {
  return String(p).split(path.sep).join("/");
}

export async function rmrf(p) {
  await fsp.rm(p, { recursive: true, force: true });
}

/**
 * 真写一次才算可写。Windows 上 fs.access(W_OK) 对目录的判定不可靠：
 * 目录可能允许列目录但拒绝创建文件（Program Files 就是这种）。
 */
export function hasWriteAccess(dir) {
  if (!dir) return false;
  const probe = path.join(dir, `.purge-x-wtest-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(probe, "1");
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** 短路径展示：把 home 折成 ~ */
export function prettyPath(p) {
  const home = os.homedir();
  if (!p) return p;
  return p.toLowerCase().startsWith(home.toLowerCase()) ? "~" + p.slice(home.length) : p;
}

export const ASCII = {
  ok: "[ok]",
  no: "[--]",
  warn: "[!!]",
  err: "[xx]",
  dot: "[..]",
};
