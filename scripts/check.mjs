#!/usr/bin/env node
/**
 * 语法自检：对 bin/lib/scripts/test 下所有 js/mjs 跑 node --check。
 * 顺带 import 一次纯定义模块，确认没有循环依赖 / 顶层侧效应导致的加载失败。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIRS = ["bin", "lib", "scripts", "test"];
const SKIP_DIRS = new Set(["node_modules", ".git"]);

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (/\.(m?js)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

let failed = 0;
const files = [];
for (const d of DIRS) {
  const abs = path.join(ROOT, d);
  if (fs.existsSync(abs)) files.push(...walk(abs));
}

for (const file of files) {
  const rel = path.relative(ROOT, file);
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    console.log(`[ok] syntax ${rel}`);
  } catch (err) {
    failed++;
    console.error(`[xx] syntax ${rel}`);
    console.error(String(err.stderr || err.message).trim());
  }
}

const IMPORTABLE = [
  "lib/index.js",
  "lib/core/util.js",
  "lib/core/patch.js",
  "lib/core/backup.js",
  "lib/core/payload.js",
  "lib/channels/ws.js",
  "lib/channels/cdp.js",
  "lib/targets/index.js",
  "lib/targets/workbuddy.js",
  "lib/targets/doubao.js",
];

for (const rel of IMPORTABLE) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  try {
    await import(pathToFileURL(abs).href);
    console.log(`[ok] import ${rel}`);
  } catch (err) {
    failed++;
    console.error(`[xx] import ${rel}: ${err?.message || err}`);
  }
}

console.log(`\n${files.length} files checked, ${failed} failure(s)`);
process.exitCode = failed ? 1 : 0;
