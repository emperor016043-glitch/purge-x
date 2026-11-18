#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { PROFILES, renderAnchor, renderChatSystemPrefix, renderHeader, renderSkillMarkdown } from "../lib/core/payload.js";
import { detectAll, applyAll, revertAll, statusAll } from "../lib/targets/index.js";
import { VERSION } from "../lib/index.js";
import { PURGE_HOME, latestBackup, listBackups } from "../lib/core/backup.js";
import * as doubao from "../lib/targets/doubao.js";
import { prettyPath } from "../lib/core/util.js";

const argv = process.argv.slice(2);

function flag(name) {
  return argv.includes(`--${name}`);
}
function opt(name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}
function positional() {
  return argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
}

const NO_COLOR = flag("no-color") || process.env.NO_COLOR === "1";
const C = NO_COLOR
  ? { g: "", r: "", y: "", b: "", d: "", x: "" }
  : {
      g: "\x1b[32m",
      r: "\x1b[31m",
      y: "\x1b[33m",
      b: "\x1b[36m",
      d: "\x1b[90m",
      x: "\x1b[0m",
    };

const out = (s = "") => process.stdout.write(s + "\n");
const rule = () => out(C.d + "─".repeat(72) + C.x);

function mark(status) {
  switch (status) {
    case "applied":
      return C.g + "[ok]" + C.x;
    case "already":
      return C.d + "[--]" + C.x;
    case "drift":
    case "drifted":
      return C.y + "[!!]" + C.x;
    case "failed":
      return C.r + "[xx]" + C.x;
    case "pending_restart":
      return C.y + "[..]" + C.x;
    default:
      return C.d + "[..]" + C.x;
  }
}

function banner() {
  out(`${C.b}purge-x${C.x} v${VERSION}  ${C.d}跨宿主指令权威层 · dsh-purge 多目标改写版${C.x}`);
  out(`${C.d}home: ${prettyPath(PURGE_HOME)}${C.x}`);
}

function help() {
  banner();
  out(`
用法:
  purge-x targets                     列出所有宿主与检测结果
  purge-x status  [--target NAME]     查看各通道落地状态
  purge-x apply   [--target NAME]     应用破甲（workbuddy | doubao | all）
  purge-x revert  [--target NAME]     从备份回滚
  purge-x payload [--profile zh|en]   打印当前载荷（可直接粘进 system prompt）
  purge-x attach  [--port N] [--watch] 对已开调试端口的豆包做 CDP 注入
  purge-x doctor                      环境自检
  purge-x backups                     列出备份

apply 选项:
  --profile zh|en        载荷语言（默认 zh）
  --prompt-file FILE     用自定义文件顶替内置 header
  --deep                 WorkBuddy: 连 product.json 一起改（需要管理员权限）
  --dry-run              只报告不改文件
  --port N               豆包 CDP 端口（默认 9333）
  --auto-launch          豆包没开调试端口时自己拉起来
  --verbose              豆包注入脚本打印日志到页面控制台
  --no-color             关闭颜色
`);
}

function printTargets() {
  banner();
  rule();
  for (const t of detectAll()) {
    const state = t.ok ? C.g + "detected" + C.x : C.d + "not found" + C.x;
    out(`  ${C.b}${t.id}${C.x}  ${t.label}  -> ${state}`);
    if (t.id === "workbuddy") {
      out(`    home    ${prettyPath(t.home)}`);
      out(`    install ${prettyPath(t.installDir) || C.d + "(未识别)" + C.x}  ${t.version ? "v" + t.version : ""}`);
      out(`    write   home=${t.writable?.home} install=${t.writable?.install}`);
    } else if (t.id === "doubao") {
      out(`    exe     ${prettyPath(t.exe) || C.d + "(未找到)" + C.x}`);
      out(`    running ${t.running}`);
      out(`    port    ${t.port}`);
    }
  }
  rule();
}

function printStatus() {
  banner();
  const only = opt("target");
  const list = only ? statusAll().filter((s) => s.id === only) : statusAll();
  if (list.length === 0) {
    out(C.r + `没有匹配的目标: ${only}` + C.x);
    process.exitCode = 1;
    return;
  }
  for (const s of list) {
    rule();
    if (!s.detected) {
      out(`  ${C.b}${s.id}${C.x}  ${C.d}未检测到${C.x}`);
      continue;
    }
    if (s.id === "workbuddy") {
      out(`  ${C.b}workbuddy${C.x}  v${s.version || "?"}  ${C.d}${prettyPath(s.home)}${C.x}`);
      out(`    ${mark(s.channels.persona.applied ? "applied" : "missing")} persona   ${prettyPath(s.channels.persona.path)}`);
      out(`    ${mark(s.channels.skill.applied ? "applied" : "missing")} skill     ${prettyPath(s.channels.skill.path)}`);
      const pol = s.channels.policy;
      const polState = !pol.present ? "missing" : pol.pending > 0 ? "drift" : "applied";
      out(`    ${mark(polState)} policy    ${prettyPath(s.channels.policy.path)} ${C.d}(pending ${pol.pending ?? "?"}/${pol.total ?? "?"} rules)${C.x}`);
      out(`    ${mark(s.channels.deep.writable ? "applied" : "missing")} deep      ${prettyPath(s.channels.deep.path)} ${C.d}${s.channels.deep.hint}${C.x}`);
    } else if (s.id === "doubao") {
      out(`  ${C.b}doubao${C.x}  ${C.d}${prettyPath(s.exe)}${C.x}`);
      out(`    ${mark(s.inject.applied ? "applied" : "missing")} inject    ${prettyPath(s.inject.script) || C.d + "未生成" + C.x} ${C.d}(${s.inject.chars} chars)${C.x}`);
      out(`    ${mark(s.running ? "applied" : "missing")} running   ${s.running ? "yes" : "no"}  ${C.d}port ${s.port}${C.x}`);
      out(`    ${mark(s.launcher ? "applied" : "missing")} launcher  ${prettyPath(s.launcher) || C.d + "未生成" + C.x}`);
    }
    out(`    ${C.d}backup ${prettyPath(s.backup) || "none"}${C.x}`);
  }
  rule();
}

async function doApply() {
  banner();
  const target = opt("target", "all");
  const profile = opt("profile", "zh");
  const promptFile = opt("prompt-file");
  const dryRun = flag("dry-run");
  const deep = flag("deep");
  const port = Number(opt("port", 9333));
  const autoLaunch = flag("auto-launch");
  const verbose = flag("verbose");

  let extra = "";
  if (promptFile && promptFile !== true) {
    extra = fs.readFileSync(path.resolve(String(promptFile)), "utf8");
    out(`${C.d}自定义载荷: ${promptFile} (${extra.length} chars)${C.x}`);
  }

  const results = await applyAll(target, { profile, extra, dryRun, deep, port, autoLaunch, verbose });
  for (const r of results) {
    rule();
    out(`  ${C.b}${r.id}${C.x} ${r.label || ""}`);
    if (r.error) out(`    ${mark("failed")} ${r.error}`);
    for (const item of r.report || []) {
      out(`    ${mark(item.status)} ${item.name}${item.note ? C.d + "  " + item.note + C.x : ""}`);
    }
    if (r.pending) out(`    ${C.y}下一步: 用启动器拉起豆包，然后重跑 purge-x apply --target doubao${C.x}`);
    if (r.backupDir && !dryRun) out(`    ${C.d}备份: ${prettyPath(r.backupDir)}${C.x}`);
  }
  rule();
  if (dryRun) out(C.y + "dry-run：没有写任何文件" + C.x);
}

function doRevert() {
  banner();
  const target = opt("target", "all");
  for (const r of revertAll(target)) {
    rule();
    out(`  ${C.b}${r.id}${C.x}`);
    if (r.error) out(`    ${mark("failed")} ${r.error}`);
    if (r.dir) out(`    ${mark("applied")} 使用备份 ${prettyPath(r.dir)}`);
    for (const f of r.restored || []) out(`    ${mark("applied")} restored ${prettyPath(f)}`);
    for (const f of r.removed || []) out(`    ${mark("applied")} removed  ${prettyPath(f)}`);
    for (const [f, e] of r.failed || []) out(`    ${mark("failed")} ${prettyPath(f)}: ${e}`);
  }
  rule();
}

function doPayload() {
  const profile = opt("profile", "zh");
  const which = opt("part", "all");
  if (which === "all" || which === "header") out(renderHeader(profile, ""));
  if (which === "all" || which === "anchor") out("\n" + renderAnchor(profile));
  if (which === "skill") out(renderSkillMarkdown(profile));
  if (which === "chat") out(renderChatSystemPrefix(profile));
  if (!["all", "header", "anchor", "skill", "chat"].includes(String(which))) {
    out(C.r + "未知 part: " + which + C.x);
    process.exitCode = 1;
  }
}

async function doAttach() {
  banner();
  const port = Number(opt("port", 9333));
  const profile = opt("profile", "zh");
  const watchMode = flag("watch");
  const res = await doubao.attach({ port, profile, verbose: flag("verbose") });
  if (!res.ok) {
    out(`${mark("failed")} ${res.error}`);
    out(C.d + `提示: 用 ${prettyPath(doubao.launcherPath())} 启动豆包，让 CDP 端口开着` + C.x);
    process.exitCode = 1;
    return;
  }
  for (const r of res.results) {
    out(`  ${mark(r.ok ? "applied" : "failed")} ${r.url}  ${C.d}contexts=${r.contexts ?? "?"} ${r.error || ""}${C.x}`);
  }
  out(`${C.d}注入脚本: ${prettyPath(res.scriptPath)}${C.x}`);

  if (watchMode) {
    out(`${C.y}watch 模式：新窗口 / 新 webview 出现时自动补注入，Ctrl+C 退出${C.x}`);
    const w = await doubao.watch({
      port,
      profile,
      verbose: flag("verbose"),
      onInjected: ({ target, contexts, error }) => {
        if (error) out(`  ${mark("failed")} ${target.url} ${error}`);
        else out(`  ${mark("applied")} 新 target ${target.url}  contexts=${contexts}`);
      },
    });
    process.on("SIGINT", () => {
      w.stop();
      out(C.d + "watch 已停止" + C.x);
      process.exit(0);
    });
    await new Promise(() => {});
  }
}

function doDoctor() {
  banner();
  rule();
  out(`  node          ${process.version}  ${process.versions.v8 ? "v8 " + process.versions.v8 : ""}`);
  out(`  platform      ${process.platform} ${process.arch}`);
  out(`  cwd           ${process.cwd()}`);
  out(`  PURGE_HOME    ${PURGE_HOME}  ${fs.existsSync(PURGE_HOME) ? C.g + "exists" + C.x : C.d + "not created yet" + C.x}`);
  out(`  profiles      ${Object.keys(PROFILES).join(", ")}`);
  for (const t of detectAll()) {
    out(`  target ${t.id.padEnd(10)} ${t.ok ? C.g + "ok" + C.x : C.d + "absent" + C.x}`);
  }
  out(`  ${C.d}admin hint: WorkBuddy --deep 需要写安装目录；豆包需要能启动带调试端口的实例${C.x}`);
  rule();
}

function doBackups() {
  banner();
  rule();
  for (const label of ["workbuddy", "doubao"]) {
    const all = listBackups(label);
    out(`  ${C.b}${label}${C.x}  ${all.length} 份  ${all.length ? prettyPath(path.join(PURGE_HOME, "backups", label, all[all.length - 1])) : C.d + "-" + C.x}`);
    if (flag("all")) for (const b of all) out(`    ${b}`);
  }
  rule();
}

async function main() {
  const cmd = positional()[0] || "help";
  if (flag("help") || cmd === "help") return help();
  if (flag("version")) return out(VERSION);

  switch (cmd) {
    case "targets":
      return printTargets();
    case "status":
      return printStatus();
    case "apply":
      return doApply();
    case "revert":
      return doRevert();
    case "payload":
      return doPayload();
    case "attach":
      return doAttach();
    case "doctor":
      return doDoctor();
    case "backups":
      return doBackups();
    default:
      out(C.r + `未知命令: ${cmd}` + C.x);
      help();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  out(`${mark("failed")} ${err?.stack || err}`);
  process.exitCode = 1;
});
