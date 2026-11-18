import * as workbuddy from "./workbuddy.js";
import * as doubao from "./doubao.js";

export const registry = { workbuddy, doubao };

export function targetIds() {
  return Object.keys(registry);
}

export function resolveTarget(name) {
  if (!name || name === "all") return targetIds().map((k) => registry[k]);
  const t = registry[name];
  if (!t) throw new Error(`未知目标: ${name}（可选: ${targetIds().join(", ")}, all）`);
  return [t];
}

export function detectAll() {
  return targetIds().map((k) => {
    try {
      return registry[k].detect();
    } catch (err) {
      return { id: k, label: k, ok: false, error: err?.message || String(err) };
    }
  });
}

export function statusAll() {
  return resolveTarget("all").map((t) => {
    try {
      return t.status();
    } catch (err) {
      return { id: t.id, label: t.label, detected: false, error: err?.message || String(err) };
    }
  });
}

export async function applyAll(names, opts = {}) {
  const out = [];
  for (const t of resolveTarget(names)) {
    if (t.id === "doubao") {
      out.push({ id: t.id, label: t.label, ...(await t.apply(opts)) });
    } else {
      out.push({ id: t.id, label: t.label, ...t.apply(t.detect(), opts) });
    }
  }
  return out;
}

export function revertAll(names) {
  return resolveTarget(names).map((t) => {
    try {
      return { id: t.id, label: t.label, ...t.revert() };
    } catch (err) {
      return { id: t.id, label: t.label, ok: false, error: err?.message || String(err) };
    }
  });
}
