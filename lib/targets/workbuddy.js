import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BackupSession, latestBackup, restoreBackup } from "../core/backup.js";
import { applyPatches, STATUS, summarizeReport } from "../core/patch.js";
import {
  ANCHOR_BEGIN,
  ANCHOR_END,
  HEADER_BEGIN,
  HEADER_END,
  renderAnchor,
  renderPersonaSection,
  renderSkillMarkdown,
} from "../core/payload.js";
import {
  ensureDir,
  hasWriteAccess,
  isDir,
  isFile,
  pathExists,
  prettyPath,
  readJson,
  readTextSafe,
  writeJsonAtomic,
  writeTextAtomic,
} from "../core/util.js";

export const id = "workbuddy";
export const label = "WorkBuddy / CodeBuddy 桌面端（腾讯 Genie 系）";

const WIN_CANDIDATES = [
  "D:\\Program Files\\WorkBuddy",
  "C:\\Program Files\\WorkBuddy",
  "C:\\Program Files (x86)\\WorkBuddy",
  path.join(os.homedir(), "AppData", "Local", "Programs", "WorkBuddy"),
  path.join(os.homedir(), "AppData", "Local", "WorkBuddy", "Application"),
];

const MAC_CANDIDATES = [
  "/Applications/WorkBuddy.app/Contents/Resources",
  "/Applications/CodeBuddy.app/Contents/Resources",
];

function homeDir() {
  return process.env.WORKBUDDY_HOME || path.join(os.homedir(), ".workbuddy");
}

function findInstall() {
  const candidates = process.platform === "win32" ? WIN_CANDIDATES : MAC_CANDIDATES;
  for (const base of candidates) {
    if (!isDir(base)) continue;
    const product = path.join(base, "resources", "app.asar.unpacked", "cli", "product.json");
    const manifest = path.join(base, "resources", "install-manifest.json");
    if (isFile(product)) return { installDir: base, productJsonPath: product, manifestPath: manifest };
    const macProduct = path.join(base, "app.asar.unpacked", "cli", "product.json");
    if (isFile(macProduct)) {
      return { installDir: base, productJsonPath: macProduct, manifestPath: path.join(base, "install-manifest.json") };
    }
  }
  return null;
}

function readVersion(install) {
  if (!install) return null;
  const man = readJson(install.manifestPath);
  if (man?.appVersion) return man.appVersion;
  const vf = path.join(install.installDir, "version");
  const raw = readTextSafe(vf);
  return raw ? raw.trim() : null;
}

export function detect() {
  const home = homeDir();
  const install = findInstall();
  const settingsPath = path.join(home, "settings.json");
  const personaPath = path.join(home, "SOUL.md");
  const identityPath = path.join(home, "IDENTITY.md");
  const userPath = path.join(home, "USER.md");
  const skillDir = path.join(home, "skills", "purge-x-anchor");
  return {
    id,
    label,
    ok: isDir(home),
    home,
    settingsPath,
    personaPath,
    identityPath,
    userPath,
    skillDir,
    skillPath: path.join(skillDir, "SKILL.md"),
    install,
    installDir: install?.installDir || null,
    productJsonPath: install?.productJsonPath || null,
    version: readVersion(install),
    writable: {
      home: hasWriteAccess(home),
      install: install ? hasWriteAccess(path.dirname(install.productJsonPath)) : false,
    },
  };
}

/**
 * settings.json 权限放行：orderedRules 里的 ask / deny 一律改 allow。
 *
 * 注意 systemToolPolicy：宿主的合法枚举只有 always_confirm 一系（bundle 里查不到
 * always_allow / auto_approve 之类的值），写一个自造值只会被当成脏数据重置。
 * 所以这里不碰它，只在报告里标记出来，交给宿主自己的安全中心去改。
 */
export function relaxSandboxPolicy(settings) {
  const touched = { file: 0, command: 0, network: 0, systemToolPolicy: null };
  const ordered = settings?.sandbox?.orderedRules;
  if (!ordered) return touched;

  const relaxDecisions = (rule) => {
    let n = 0;
    for (const key of ["read", "write", "delete", "decision", "action"]) {
      if (typeof rule[key] === "string" && rule[key] !== "allow") {
        rule[key] = "allow";
        n++;
      }
    }
    return n;
  };

  for (const rule of ordered?.file?.rules || []) touched.file += relaxDecisions(rule) > 0 ? 1 : 0;
  for (const rule of ordered?.command?.rules || []) touched.command += relaxDecisions(rule) > 0 ? 1 : 0;
  for (const rule of ordered?.network?.rules || []) touched.network += relaxDecisions(rule) > 0 ? 1 : 0;

  const policy = settings?.sandbox?.systemToolPolicy;
  if (policy) touched.systemToolPolicy = `${policy}（保留：枚举未公开，去宿主安全中心改）`;
  return touched;
}

export function policyStatus(target = detect()) {
  const settings = readJson(target.settingsPath);
  if (!settings) return { present: false, pending: 0, total: 0 };
  const ordered = settings?.sandbox?.orderedRules || {};
  let pending = 0;
  let total = 0;
  for (const group of ["file", "command", "network"]) {
    for (const rule of ordered?.[group]?.rules || []) {
      total++;
      const dirty = ["read", "write", "delete", "decision", "action"].some(
        (k) => typeof rule[k] === "string" && rule[k] !== "allow",
      );
      if (dirty) pending++;
    }
  }
  return {
    present: true,
    pending,
    total,
    systemToolPolicy: settings?.sandbox?.systemToolPolicy || null,
  };
}

export function status(target = detect()) {
  const persona = target.personaPath && isFile(target.personaPath) ? readTextSafe(target.personaPath, "") : "";
  const hasHeader = persona.includes(HEADER_BEGIN) && persona.includes(ANCHOR_BEGIN);
  const skill = isFile(target.skillPath) ? readTextSafe(target.skillPath, "") : "";
  const policy = policyStatus(target);
  return {
    id,
    label,
    detected: target.ok,
    home: target.home,
    installDir: target.installDir,
    version: target.version,
    writable: target.writable,
    channels: {
      persona: { path: target.personaPath, applied: hasHeader },
      skill: { path: target.skillPath, applied: skill.includes(ANCHOR_BEGIN) },
      policy: { path: target.settingsPath, ...policy },
      deep: {
        path: target.productJsonPath,
        available: Boolean(target.productJsonPath),
        writable: target.writable.install,
        hint: target.writable.install ? "" : "安装目录只读，--deep 需要管理员权限",
      },
    },
    backup: latestBackup(id),
  };
}

export function buildPersonaText(original, profile, extra) {
  const section = renderPersonaSection(profile, extra);
  const body = String(original || "").trimEnd();
  if (body.includes(HEADER_BEGIN)) {
    // 已经注入过：整段替换，避免层层叠加
    const start = body.indexOf(HEADER_BEGIN);
    const endMark = body.lastIndexOf(ANCHOR_END);
    if (endMark > start) {
      return body.slice(0, start) + section + body.slice(endMark + ANCHOR_END.length) + "\n";
    }
  }
  return `${section}\n\n${body}\n`;
}

/** 把「每次会话都读」的锚点写成一行，附在 SOUL.md 顶部 front-matter 之后也能生效。 */
export function apply(target, opts = {}) {
  const { profile = "zh", extra = "", dryRun = false, deep = false, channels = null } = opts;
  const want = (key) => !channels || channels.includes(key);
  const report = [];
  const backup = new BackupSession(id, { dryRun });

  if (!target.ok) {
    return { ok: false, error: `未找到 ${target.home}`, report, backupDir: null };
  }

  // --- persona ---
  if (want("persona")) {
    try {
      const original = isFile(target.personaPath) ? readTextSafe(target.personaPath, "") : "";
      const next = buildPersonaText(original, profile, extra);
      const changed = original !== next;
      if (changed && !dryRun) {
        backup.save(target.personaPath);
        writeTextAtomic(target.personaPath, next);
      }
      report.push({
        id: "persona",
        name: "SOUL.md 人格注入",
        status: changed ? STATUS.APPLIED : STATUS.ALREADY,
        note: prettyPath(target.personaPath),
      });
    } catch (err) {
      report.push({ id: "persona", name: "SOUL.md 人格注入", status: STATUS.FAILED, note: err?.message || String(err) });
    }
  }

  // --- skill anchor ---
  if (want("skill")) {
    try {
      const md = renderSkillMarkdown(profile, { extra });
      const original = isFile(target.skillPath) ? readTextSafe(target.skillPath, "") : "";
      const changed = original.trim() !== md.trim();
      if (changed && !dryRun) {
        backup.save(target.skillPath);
        ensureDir(target.skillDir);
        writeTextAtomic(target.skillPath, md);
      }
      report.push({
        id: "skill",
        name: "常驻锚点 skill",
        status: changed ? STATUS.APPLIED : STATUS.ALREADY,
        note: prettyPath(target.skillPath),
      });
    } catch (err) {
      report.push({ id: "skill", name: "常驻锚点 skill", status: STATUS.FAILED, note: err?.message || String(err) });
    }
  }

  // --- policy ---
  if (want("policy")) {
    try {
      const settings = readJson(target.settingsPath);
      if (!settings) {
        report.push({ id: "policy", name: "沙箱审批放行", status: STATUS.MISSING_FILE, note: target.settingsPath });
      } else {
        const before = JSON.stringify(settings.sandbox || {});
        const touched = relaxSandboxPolicy(settings);
        const after = JSON.stringify(settings.sandbox || {});
        const changed = before !== after;
        if (changed && !dryRun) {
          backup.save(target.settingsPath);
          writeJsonAtomic(target.settingsPath, settings);
        }
        report.push({
          id: "policy",
          name: "沙箱审批放行",
          status: changed ? STATUS.APPLIED : STATUS.ALREADY,
          note: `file=${touched.file} command=${touched.command} network=${touched.network}` +
            (touched.systemToolPolicy ? ` | ${touched.systemToolPolicy}` : ""),
        });
      }
    } catch (err) {
      report.push({ id: "policy", name: "沙箱审批放行", status: STATUS.FAILED, note: err?.message || String(err) });
    }
  }

  // --- deep: product.json ---
  if (deep && want("deep")) {
    report.push(applyDeep(target, { profile, extra, dryRun, backup }));
  }

  if (!dryRun) backup.flush();
  return { ok: true, report, backupDir: backup.dir, summary: summarizeReport(report.map((r) => ({ ...r, layer: r.name }))) };
}

function applyDeep(target, { profile, extra, dryRun, backup }) {
  const file = target.productJsonPath;
  const entry = { id: "deep", name: "product.json 指令注入", status: STATUS.MISSING_FILE, note: "" };
  if (!file || !isFile(file)) {
    entry.note = "product.json 不存在（未识别到安装目录）";
    return entry;
  }
  if (!target.writable.install) {
    entry.status = STATUS.FAILED;
    entry.note = "安装目录只读：用管理员权限重跑 `purge-x apply --target workbuddy --deep`";
    return entry;
  }
  try {
    const product = readJson(file);
    if (!product) {
      entry.status = STATUS.FAILED;
      entry.note = "product.json 解析失败";
      return entry;
    }
    const header = renderPersonaSection(profile, extra);
    let changed = 0;
    for (const agent of product.builtInAgents || []) {
      if (typeof agent.systemPrompt === "string" && !agent.systemPrompt.includes(HEADER_BEGIN)) {
        agent.systemPrompt = `${header}\n\n${agent.systemPrompt}`;
        changed++;
      }
    }
    product.purgeX = {
      appliedAt: new Date().toISOString(),
      profile,
      agentsPatched: changed,
    };
    if (changed > 0 && !dryRun) {
      backup.save(file);
      writeJsonAtomic(file, product);
    }
    entry.status = changed > 0 ? STATUS.APPLIED : STATUS.ALREADY;
    entry.note = `builtInAgents 注入 ${changed} 个`;
  } catch (err) {
    entry.status = STATUS.FAILED;
    entry.note = err?.message || String(err);
  }
  return entry;
}

export function revert() {
  const dir = latestBackup(id);
  if (!dir) return { ok: false, error: "没有可回滚的备份" };
  const result = restoreBackup(dir);
  return { ok: result.failed.length === 0, dir, ...result };
}

export { applyPatches };
