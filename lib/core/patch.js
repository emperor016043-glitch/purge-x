import fs from "node:fs";
import path from "node:path";
import { isFile, readText } from "./util.js";

export const STATUS = {
  APPLIED: "applied",
  ALREADY: "already",
  DRIFTED: "drifted",
  MISSING_FILE: "missing_file",
  FAILED: "failed",
  SKIPPED: "skipped",
};

function asRegExp(pattern) {
  if (pattern instanceof RegExp) return pattern;
  if (typeof pattern !== "string") return null;
  const m = /^\/(.*)\/([a-z]*)$/s.exec(pattern);
  if (m && m[1].length > 0) {
    try {
      return new RegExp(m[1], m[2] || "g");
    } catch {
      return null;
    }
  }
  return null;
}

export function countMatches(text, pattern) {
  const re = asRegExp(pattern);
  if (re) {
    const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
    const g = new RegExp(re.source, flags);
    return (text.match(g) || []).length;
  }
  const needle = String(pattern);
  if (!needle) return 0;
  let count = 0;
  let idx = -1;
  while ((idx = text.indexOf(needle, idx + 1)) !== -1) count++;
  return count;
}

export function replaceAll(text, pattern, replacement) {
  const re = asRegExp(pattern);
  if (re) {
    const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
    return text.replace(new RegExp(re.source, flags), replacement);
  }
  return text.split(String(pattern)).join(replacement);
}

export function normalizePatch(patch) {
  const p = { ...patch };
  if (!p.name) p.name = `patch-${p.id ?? "?"}`;
  if (p.file && !Array.isArray(p.file)) p.file = [p.file];
  if (p.rel && !Array.isArray(p.rel)) p.rel = [p.rel];
  const list = [];
  if (Array.isArray(p.replacements)) {
    for (const r of p.replacements) list.push({ pattern: r.pattern, replace: r.replace });
  } else if (p.pattern !== undefined) {
    list.push({ pattern: p.pattern, replace: p.replace ?? "" });
  }
  p.replacements = list;
  p.markers = p.markers || [];
  p.markersAny = p.markersAny !== false;
  return p;
}

/** 把 patch 的 file/rel 解析成绝对路径候选列表（多宿主时 patchers 共用一条规则表）。 */
export function resolveFiles(rootDir, patch) {
  const out = [];
  for (const file of patch.file || []) {
    if (!file) continue;
    if (path.isAbsolute(file)) {
      out.push(file);
      continue;
    }
    const bases = patch.rel && patch.rel.length ? patch.rel : [""];
    for (const base of bases) {
      out.push(path.join(rootDir, base, file));
    }
  }
  return out;
}

/**
 * 判定一个 patch 在当前文件内容下的状态：
 *   1. 命中 marker → already（已清洗）
 *   2. pattern 能命中 → 需要 apply
 *   3. 都摸不到 → drifted（宿主换写法了，pattern 要更新）
 */
export function inspectText(patch, text) {
  const markerHit = patch.markers.some((m) => text.includes(m));
  let hitCount = 0;
  for (const r of patch.replacements) hitCount += countMatches(text, r.pattern);
  if (markerHit && (patch.skipIfMarked !== false || hitCount === 0)) {
    return { state: STATUS.ALREADY, hitCount };
  }
  if (hitCount === 0) return { state: STATUS.DRIFTED, hitCount };
  return { state: "pending", hitCount };
}

/**
 * 引擎主入口。
 * ctx: { rootDir, backup, dryRun, log, allowDrift }
 */
export function applyPatches(patches, ctx) {
  const report = [];
  const { rootDir, backup, dryRun, log } = ctx;

  for (const raw of patches) {
    const patch = normalizePatch(raw);
    const files = resolveFiles(rootDir, patch);
    const result = {
      id: patch.id,
      name: patch.name,
      layer: patch.layer || "",
      desc: patch.desc || "",
      status: STATUS.MISSING_FILE,
      changedFiles: [],
      hits: 0,
      note: "",
    };

    const present = files.filter((f) => isFile(f));
    if (present.length === 0) {
      if (patch.optional) {
        result.status = STATUS.SKIPPED;
        result.note = "optional, file not present";
      }
      report.push(result);
      continue;
    }

    let anyPending = false;
    let anyAlready = false;
    let anyDrift = false;
    let anyFailed = false;

    for (const file of present) {
      let text;
      try {
        text = readText(file);
      } catch (err) {
        anyFailed = true;
        result.note = err?.message || String(err);
        continue;
      }

      const inspected = inspectText(patch, text);
      if (inspected.state === STATUS.ALREADY) {
        anyAlready = true;
        continue;
      }
      if (inspected.state === STATUS.DRIFTED) {
        anyDrift = true;
        continue;
      }

      anyPending = true;
      let next = text;
      for (const r of patch.replacements) {
        next = replaceAll(next, r.pattern, r.replace);
      }
      result.hits += inspected.hitCount;

      if (next === text) {
        anyDrift = true;
        continue;
      }

      if (dryRun) {
        result.changedFiles.push(file + " (dry-run)");
        continue;
      }

      try {
        backup?.save(file);
        fs.writeFileSync(file, next, "utf8");
        result.changedFiles.push(file);
        log?.(`  patched ${path.basename(file)} <- #${patch.id} ${patch.name}`);
      } catch (err) {
        anyFailed = true;
        result.note = err?.message || String(err);
      }
    }

    if (anyFailed) result.status = STATUS.FAILED;
    else if (anyPending) result.status = STATUS.APPLIED;
    else if (anyDrift && !ctx.allowDrift) result.status = STATUS.DRIFTED;
    else if (anyAlready) result.status = STATUS.ALREADY;
    else result.status = STATUS.DRIFTED;

    report.push(result);
  }

  return report;
}

export function summarizeReport(report) {
  const tally = {
    applied: 0,
    already: 0,
    drifted: 0,
    failed: 0,
    missing_file: 0,
    skipped: 0,
  };
  for (const r of report) tally[r.status] = (tally[r.status] || 0) + 1;
  const failed = report.filter((r) => r.status === STATUS.FAILED);
  const drifted = report.filter((r) => r.status === STATUS.DRIFTED);
  return { tally, failed, drifted, total: report.length };
}

/** 单点文本 patch：给「注入一段而不是替换一段」的通道用。 */
export function injectIntoText(text, {
  begin,
  end,
  body,
  position = "append",
  replaceExisting = true,
}) {
  const block = `${begin}\n${body}\n${end}`;
  const startIdx = text.indexOf(begin);
  const endIdx = text.indexOf(end);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    if (!replaceExisting) return { text, changed: false, present: true };
    const next = text.slice(0, startIdx) + block + text.slice(endIdx + end.length);
    return { text: next, changed: next !== text, present: true };
  }
  const next = position === "prepend" ? `${block}\n\n${text}` : `${text.trimEnd()}\n\n${block}\n`;
  return { text: next, changed: true, present: false };
}

export function hasBlock(text, begin, end) {
  const a = text.indexOf(begin);
  const b = text.indexOf(end);
  return a !== -1 && b !== -1 && b > a;
}
