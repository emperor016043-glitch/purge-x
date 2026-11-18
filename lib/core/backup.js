import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ensureDir, readJson, sha256, stamp, toPosix, writeJsonAtomic } from "./util.js";

export const PURGE_HOME = process.env.PURGE_X_HOME || path.join(os.homedir(), ".purge-x");
export const BACKUP_ROOT = path.join(PURGE_HOME, "backups");

/**
 * 一轮 apply 的备份会话。
 *
 * 设计取向和 dsh-purge 一致：先落盘再动手。任何一个 patch 之前都必须
 * 已经 save() 过目标文件；revert 只依赖这一份 manifest，不猜、不重建。
 *
 * manifest 条目：
 *   { path, existed, backup, sha256, mode }
 * existed=false 表示该文件原本不存在 —— 回滚时直接删除。
 */
export class BackupSession {
  constructor(label, { root = BACKUP_ROOT, dryRun = false } = {}) {
    this.label = label;
    this.dryRun = dryRun;
    this.dir = path.join(root, label, stamp());
    this.manifest = [];
    this.seen = new Set();
    if (!dryRun) ensureDir(this.dir);
  }

  /** 记录并拷贝一个文件的原始状态。重复调用同一路径只记录一次。 */
  save(absPath, { keep = true } = {}) {
    const key = toPosix(absPath).toLowerCase();
    if (this.seen.has(key)) return { path: absPath, existed: true, already: true };
    this.seen.add(key);

    let existed = false;
    let raw = null;
    try {
      raw = fs.readFileSync(absPath);
      existed = true;
    } catch {
      existed = false;
    }

    const entry = {
      path: absPath,
      existed,
      backup: null,
      sha256: existed ? sha256(raw) : null,
      mode: null,
    };

    if (existed && keep) {
      const rel = toPosix(absPath).replace(/[:]/g, "_").replace(/^\/+/, "");
      const dest = path.join(this.dir, "files", rel);
      entry.backup = dest;
      if (!this.dryRun) {
        ensureDir(path.dirname(dest));
        fs.copyFileSync(absPath, dest);
        try {
          entry.mode = fs.statSync(absPath).mode;
        } catch {
          /* 忽略 */
        }
      }
    }

    this.manifest.push(entry);
    return entry;
  }

  flush() {
    if (this.dryRun) return null;
    ensureDir(this.dir);
    writeJsonAtomic(path.join(this.dir, "manifest.json"), {
      label: this.label,
      createdAt: new Date().toISOString(),
      entries: this.manifest,
    });
    return this.dir;
  }
}

export function listBackups(label, { root = BACKUP_ROOT } = {}) {
  const dir = path.join(root, label);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

export function latestBackup(label, { root = BACKUP_ROOT } = {}) {
  const all = listBackups(label, { root });
  return all.length ? path.join(root, label, all[all.length - 1]) : null;
}

/**
 * 回滚一份 manifest。返回 { restored, removed, failed }。
 * 只碰 manifest 里登记过的路径 —— 绝不按目录扫描。
 */
export function restoreBackup(dir) {
  const manifestPath = path.join(dir, "manifest.json");
  const data = readJson(manifestPath);
  if (!data) return { restored: [], removed: [], failed: [[manifestPath, "manifest missing"]] };

  const restored = [];
  const removed = [];
  const failed = [];

  for (const entry of data.entries || []) {
    try {
      if (entry.existed) {
        if (!entry.backup || !fs.existsSync(entry.backup)) {
          failed.push([entry.path, "backup file missing"]);
          continue;
        }
        ensureDir(path.dirname(entry.path));
        fs.copyFileSync(entry.backup, entry.path);
        if (entry.mode) {
          try {
            fs.chmodSync(entry.path, entry.mode);
          } catch {
            /* Windows 上通常无效，忽略 */
          }
        }
        restored.push(entry.path);
      } else {
        if (fs.existsSync(entry.path)) {
          fs.rmSync(entry.path, { force: true });
          removed.push(entry.path);
        }
      }
    } catch (err) {
      failed.push([entry.path, err?.message || String(err)]);
    }
  }

  return { restored, removed, failed };
}
