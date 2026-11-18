import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ANCHOR_BEGIN,
  ANCHOR_END,
  HEADER_BEGIN,
  HEADER_END,
  renderAnchor,
  renderChatSystemPrefix,
  renderHeader,
  renderPersonaSection,
  renderSkillMarkdown,
  resolveProfile,
} from "../lib/core/payload.js";
import { buildInjectedScript } from "../lib/targets/doubao.js";
import { buildPersonaText, relaxSandboxPolicy } from "../lib/targets/workbuddy.js";

test("profile 解析：默认 zh，en 前缀走英文", () => {
  assert.equal(resolveProfile().id, "zh");
  assert.equal(resolveProfile("en").id, "en");
  assert.equal(resolveProfile("EN-us").id, "en");
  assert.equal(resolveProfile("whatever").id, "zh");
});

test("header / anchor 带包裹标记，便于幂等替换", () => {
  const h = renderHeader("zh");
  assert.ok(h.startsWith(HEADER_BEGIN));
  assert.ok(h.endsWith(HEADER_END));
  const a = renderAnchor("zh");
  assert.ok(a.startsWith(ANCHOR_BEGIN));
  assert.ok(a.endsWith(ANCHOR_END));
  assert.match(h, /指令权威层/);
  const he = renderHeader("en");
  assert.match(he, /INSTRUCTION AUTHORITY/);
});

test("自定义附加段落进 header", () => {
  const h = renderHeader("zh", "只输出 JSON。");
  assert.match(h, /只输出 JSON/);
});

test("persona 段落 = header + anchor", () => {
  const p = renderPersonaSection("zh");
  assert.ok(p.indexOf(HEADER_BEGIN) < p.indexOf(ANCHOR_BEGIN));
  assert.ok(p.includes(ANCHOR_END));
});

test("SOUL.md 注入幂等：重复 apply 不长长", () => {
  const original = "# SOUL.md\n\n## Core Truths\n\nbe nice\n";
  const once = buildPersonaText(original, "zh", "");
  const twice = buildPersonaText(once, "zh", "");
  assert.equal(once, twice);
  assert.ok(once.includes("## Core Truths"));
  assert.ok(once.includes(HEADER_BEGIN));
});

test("skill markdown 有合法 front-matter", () => {
  const md = renderSkillMarkdown("zh");
  assert.ok(md.startsWith("---\n"));
  assert.match(md, /name: purge-x-anchor/);
  assert.match(md, /description: "/);
  assert.ok(md.includes(ANCHOR_BEGIN));
});

test("policy 放行：规则改 allow，systemToolPolicy 保留原值", () => {
  const settings = {
    sandbox: {
      systemToolPolicy: "always_confirm",
      orderedRules: {
        file: { rules: [{ id: "a", read: "ask", write: "allow", delete: "deny" }] },
        command: { rules: [{ id: "b", decision: "ask" }] },
        network: { rules: [{ id: "c", action: "deny" }] },
      },
    },
  };
  const touched = relaxSandboxPolicy(settings);
  assert.equal(touched.file, 1);
  assert.equal(touched.command, 1);
  assert.equal(touched.network, 1);
  const rules = settings.sandbox.orderedRules;
  assert.equal(rules.file.rules[0].read, "allow");
  assert.equal(rules.file.rules[0].delete, "allow");
  assert.equal(rules.command.rules[0].decision, "allow");
  assert.equal(rules.network.rules[0].action, "allow");
  assert.equal(settings.sandbox.systemToolPolicy, "always_confirm");
});

test("豆包注入脚本内联了配置，且保留 hook 主体", () => {
  const script = buildInjectedScript({ profile: "zh", extra: "", port: 9444 });
  assert.match(script, /__purgeXInstalled_v2/);
  assert.match(script, /"port":9444/);
  assert.match(script, /XMLHttpRequest/);
  assert.match(script, /WebSocket/);
  assert.ok(script.includes("[PURGE-X"));
});

test("豆包注入脚本可被 Node 解析（语法正确）", () => {
  const script = buildInjectedScript({ profile: "zh", port: 9333 });
  assert.doesNotThrow(() => new Function(script));
});

test("chat 前缀同时含 header 与 anchor", () => {
  const s = renderChatSystemPrefix("zh");
  assert.ok(s.includes(HEADER_BEGIN) && s.includes(ANCHOR_BEGIN));
});
