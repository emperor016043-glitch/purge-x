import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CDP, addInitScript, enableDomains, evaluate, injectIntoAllContexts, injectIntoChildTargets, probe } from "../channels/cdp.js";
import { renderChatSystemPrefix } from "../core/payload.js";
import { PURGE_HOME, latestBackup, restoreBackup } from "../core/backup.js";
import {
  ensureDir,
  isDir,
  isFile,
  pathExists,
  prettyPath,
  readJson,
  readText,
  readTextSafe,
  writeJsonAtomic,
  writeTextAtomic,
} from "../core/util.js";

export const id = "doubao";
export const label = "豆包桌面端（字节 Chromium fork / liblark）";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INJECT_SRC = path.join(HERE, "..", "channels", "doubao-inject.js");

const EXE_CANDIDATES = [
  "D:\\Program Files (x86)\\Doubao\\Doubao.exe",
  "C:\\Program Files (x86)\\Doubao\\Doubao.exe",
  "C:\\Program Files\\Doubao\\Doubao.exe",
  "D:\\Program Files\\Doubao\\Doubao.exe",
  path.join(os.homedir(), "AppData", "Local", "Doubao", "Application", "Doubao.exe"),
];

export function stateDir() {
  return path.join(PURGE_HOME, "doubao");
}

export function statePath() {
  return path.join(stateDir(), "state.json");
}

export function launcherPath() {
  return path.join(stateDir(), "start-doubao.ps1");
}

export function readyScriptPath() {
  return path.join(stateDir(), "inject.ready.js");
}

function userDataDir() {
  return path.join(os.homedir(), "AppData", "Local", "Doubao", "User Data");
}

export function findExe() {
  for (const p of EXE_CANDIDATES) if (isFile(p)) return p;
  return null;
}

export function isRunning() {
  if (process.platform !== "win32") return false;
  try {
    const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq Doubao.exe", "/NH"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 4000,
    });
    return /Doubao\.exe/i.test(out);
  } catch {
    return false;
  }
}

export function detect() {
  const exe = findExe();
  const data = userDataDir();
  const state = readJson(statePath());
  return {
    id,
    label,
    ok: Boolean(exe) || isDir(data),
    exe,
    userDataDir: data,
    stateDir: stateDir(),
    running: isRunning(),
    port: state?.port || 9333,
    applied: Boolean(state?.appliedAt),
    state,
  };
}

/** 生成真正注入到页面的脚本：把 cfg 直接内联，避免新文档丢配置。 */
export function buildInjectedScript({ profile = "zh", extra = "", port = 9333, verbose = false, match = null }) {
  const template = readText(INJECT_SRC);
  const prefix = renderChatSystemPrefix(profile, extra);
  const cfg = { enabled: true, prefix, verbose, port };
  if (match) cfg.match = match;
  const withCfg = template.replace("window.__PURGE_X_CFG__ || {}", JSON.stringify(cfg));
  if (withCfg === template) {
    // 模板被改过（没有占位符）时，退化为运行时先设配置
    return `window.__PURGE_X_CFG__ = ${JSON.stringify(cfg)};\n${template}`;
  }
  return withCfg;
}

export async function attach({ port = 9333, profile = "zh", extra = "", verbose = false, match = null, allContexts = true } = {}) {
  const info = await probe(port);
  if (!info.ok) return { ok: false, error: `CDP 未开启（127.0.0.1:${port}）：${info.error}` };

  const pages = (info.targets || []).filter((t) => t.webSocketDebuggerUrl);
  if (pages.length === 0) return { ok: false, error: "没有可注入的 target" };

  const script = buildInjectedScript({ profile, extra, port, verbose, match });
  ensureDir(stateDir());
  writeTextAtomic(readyScriptPath(), script);

  const results = [];
  for (const page of pages) {
    const client = await CDP.connect(page.webSocketDebuggerUrl);
    try {
      await enableDomains(client);
      await addInitScript(client, script);
      if (allContexts) {
        // 已经存在的 iframe 走 contextId；新文档走 addInitScript
        const ctxResults = await injectIntoAllContexts(client, script);
        results.push({
          url: page.url,
          type: page.type,
          ok: ctxResults.some((r) => r.ok) || ctxResults.length === 0,
          contexts: ctxResults.length,
          detail: ctxResults,
        });
      } else {
        await evaluate(client, script);
        results.push({ url: page.url, type: page.type, ok: true, contexts: 1 });
      }

      // 聊天区是 OOPIF：/json/list 看不到，只有 Target.getTargets 能看到
      if (/doubao-chat\/chat/.test(page.url)) {
        const kids = await injectIntoChildTargets(client, script, { waitMs: 300 });
        const okKids = kids.filter((k) => k.ok);
        results.push({
          url: `${page.url} ::child-targets`,
          type: "opif",
          ok: okKids.length > 0 || kids.length === 0,
          contexts: okKids.length,
          detail: kids,
        });
      }
    } catch (err) {
      results.push({ url: page.url, type: page.type, ok: false, error: err?.message || String(err) });
    } finally {
      client.close();
    }
  }

  writeJsonAtomic(statePath(), {
    port,
    profile,
    appliedAt: new Date().toISOString(),
    script: readyScriptPath(),
    results,
  });

  return { ok: results.some((r) => r.ok), results, scriptPath: readyScriptPath() };
}

/**
 * 守护模式：豆包每次开新窗口 / 新 webview 都会产生新 target，
 * 一次性 attach 覆盖不到。这里轮询 /json/list，补注入新出现的 target。
 */
export async function watch({ port = 9333, profile = "zh", extra = "", verbose = false, intervalMs = 2500, onInjected } = {}) {
  const seen = new Set();
  const script = buildInjectedScript({ profile, extra, port, verbose });
  ensureDir(stateDir());
  writeTextAtomic(readyScriptPath(), script);

  let stopped = false;

  async function tick() {
    const info = await probe(port);
    if (!info.ok) return;
    for (const t of info.targets || []) {
      if (!t.webSocketDebuggerUrl) continue;
      const key = `${t.id}:${t.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const client = await CDP.connect(t.webSocketDebuggerUrl);
        await enableDomains(client);
        await addInitScript(client, script);
        const ctx = await injectIntoAllContexts(client, script);
        client.close();
        onInjected?.({ target: t, contexts: ctx.length });
      } catch (err) {
        onInjected?.({ target: t, error: err?.message || String(err) });
      }
    }
  }

  await tick();
  const timer = setInterval(() => {
    if (stopped) return;
    tick().catch(() => {});
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    seen,
  };
}

export function writeLauncher({ port = 9333 } = {}) {
  const exe = findExe();
  if (!exe) return null;
  ensureDir(stateDir());
  const ps = [
    "# purge-x · 豆包调试端口启动器",
    "# 用这个脚本启动豆包，CDP 端口才会开着，purge-x 才能注入。",
    `$exe = ${JSON.stringify(exe)}`,
    `$args = @("--remote-debugging-port=${port}", "--remote-allow-origins=*")`,
    'Start-Process -FilePath $exe -ArgumentList $args',
  ].join("\n");
  writeTextAtomic(launcherPath(), ps + "\n");
  return launcherPath();
}

export function status(target = detect()) {
  const ready = isFile(readyScriptPath()) ? readTextSafe(readyScriptPath(), "") : "";
  return {
    id,
    label,
    detected: target.ok,
    exe: target.exe,
    exePretty: prettyPath(target.exe),
    userDataDir: target.userDataDir,
    running: target.running,
    port: target.port,
    launcher: isFile(launcherPath()) ? launcherPath() : null,
    inject: {
      applied: target.applied,
      script: isFile(readyScriptPath()) ? readyScriptPath() : null,
      chars: ready.length,
      installedAt: target.state?.appliedAt || null,
    },
    backup: latestBackup(id),
  };
}

export async function apply(opts = {}) {
  const { port = 9333, profile = "zh", extra = "", verbose = false, match = null, autoLaunch = false } = opts;
  const target = detect();
  const report = [];

  if (!target.ok) {
    return { ok: false, error: "未检测到豆包客户端（Doubao.exe / User Data 都不在默认位置）", report };
  }

  const launcher = writeLauncher({ port });
  report.push({
    id: "launcher",
    name: "调试端口启动器",
    status: launcher ? "applied" : "failed",
    note: launcher ? prettyPath(launcher) : "找不到 Doubao.exe",
  });

  const info = await probe(port);
  if (!info.ok) {
    if (autoLaunch && target.exe) {
      spawn(target.exe, [`--remote-debugging-port=${port}`, "--remote-allow-origins=*"], {
        detached: true,
        stdio: "ignore",
      }).unref();
      report.push({ id: "launch", name: "启动客户端", status: "applied", note: `pid spawned, port ${port}` });
      await new Promise((r) => setTimeout(r, 4000));
    } else {
      report.push({
        id: "attach",
        name: "CDP 注入",
        status: "pending_restart",
        note: target.running
          ? `客户端在跑但没开调试端口：先退出豆包，再运行 ${prettyPath(launcherPath())} 后重跑 apply`
          : `客户端未运行：用 ${prettyPath(launcherPath())} 启动，然后重跑 apply`,
      });
      writeJsonAtomic(statePath(), {
        port,
        profile,
        appliedAt: null,
        pending: true,
        launcher: launcherPath(),
      });
      return { ok: true, pending: true, report };
    }
  }

  const attached = await attach({ port, profile, extra, verbose, match });
  report.push({
    id: "attach",
    name: "CDP 注入",
    status: attached.ok ? "applied" : "failed",
    note: attached.ok ? `${attached.results.length} target(s)` : attached.error,
  });
  for (const r of attached.results || []) {
    report.push({ id: "target", name: r.url, status: r.ok ? "applied" : "failed", note: r.error || "" });
  }
  return { ok: attached.ok, report, scriptPath: attached.scriptPath };
}

export function revert() {
  const dir = latestBackup(id);
  const removed = [];
  for (const f of [readyScriptPath(), launcherPath(), statePath()]) {
    try {
      if (pathExists(f)) {
        fs.rmSync(f, { force: true });
        removed.push(f);
      }
    } catch {
      /* 忽略 */
    }
  }
  const restored = dir ? restoreBackup(dir) : null;
  return { ok: true, removed, restored };
}
