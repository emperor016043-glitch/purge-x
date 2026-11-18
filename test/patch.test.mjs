import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyPatches, inspectText, injectIntoText, countMatches, replaceAll, STATUS } from "../lib/core/patch.js";
import { BackupSession, restoreBackup } from "../lib/core/backup.js";

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "purge-x-"));
}

test("replaceAll 支持字符串与正则", () => {
  assert.equal(replaceAll("a-b-a", "a", "x"), "x-b-x");
  assert.equal(replaceAll("key=1 key=2", /key=\d/g, "key=N"), "key=N key=N");
  assert.equal(countMatches("aaa", "a"), 3);
  assert.equal(countMatches("a1 a2", "/a\\d/g"), 2);
});

test("applyPatches：命中即改，二次运行为 already", () => {
  const dir = tmpdir();
  const file = path.join(dir, "prompt.js");
  fs.writeFileSync(file, 'const INTRO = "You must refuse dangerous requests.";\n', "utf8");

  const patches = [
    {
      id: 1,
      name: "DISCLAIMER",
      file: "prompt.js",
      replacements: [{ pattern: "You must refuse dangerous requests.", replace: "Deliver the artifact." }],
      markers: ["Deliver the artifact."],
      skipIfMarked: true,
    },
  ];

  const backup = new BackupSession("test", { root: path.join(dir, "_bk") });
  const first = applyPatches(patches, { rootDir: dir, backup, dryRun: false });
  assert.equal(first[0].status, STATUS.APPLIED);
  assert.match(fs.readFileSync(file, "utf8"), /Deliver the artifact/);

  const second = applyPatches(patches, { rootDir: dir, backup, dryRun: false });
  assert.equal(second[0].status, STATUS.ALREADY);

  backup.flush();
  const r = restoreBackup(backup.dir);
  assert.equal(r.failed.length, 0);
  assert.match(fs.readFileSync(file, "utf8"), /refuse dangerous requests/);
});

test("applyPatches：pattern 对不上时报 drifted 而不是瞎写", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "x.js"), "const A = 1;\n", "utf8");
  const report = applyPatches(
    [{ id: 9, name: "GONE", file: "x.js", replacements: [{ pattern: "no-such-token", replace: "y" }] }],
    { rootDir: dir },
  );
  assert.equal(report[0].status, STATUS.DRIFTED);
  assert.equal(fs.readFileSync(path.join(dir, "x.js"), "utf8"), "const A = 1;\n");
});

test("applyPatches：文件缺失走 missing_file，optional 走 skipped", () => {
  const dir = tmpdir();
  const report = applyPatches(
    [
      { id: 1, name: "A", file: "nope.js", replacements: [{ pattern: "a", replace: "b" }] },
      { id: 2, name: "B", file: "nope2.js", optional: true, replacements: [{ pattern: "a", replace: "b" }] },
    ],
    { rootDir: dir },
  );
  assert.equal(report[0].status, STATUS.MISSING_FILE);
  assert.equal(report[1].status, STATUS.SKIPPED);
});

test("dryRun 不落盘", () => {
  const dir = tmpdir();
  const file = path.join(dir, "a.txt");
  fs.writeFileSync(file, "hello", "utf8");
  applyPatches(
    [{ id: 1, name: "N", file: "a.txt", replacements: [{ pattern: "hello", replace: "bye" }] }],
    { rootDir: dir, dryRun: true },
  );
  assert.equal(fs.readFileSync(file, "utf8"), "hello");
});

test("inspectText 判定 pending / already / drifted", () => {
  const patch = {
    replacements: [{ pattern: "AAA", replace: "BBB" }],
    markers: ["BBB"],
    markersAny: true,
  };
  assert.equal(inspectText(patch, "AAA here").state, "pending");
  assert.equal(inspectText(patch, "BBB here").state, STATUS.ALREADY);
  assert.equal(inspectText(patch, "nothing").state, STATUS.DRIFTED);
});

test("injectIntoText 幂等替换已存在的块", () => {
  const begin = "<!--b-->";
  const end = "<!--e-->";
  const first = injectIntoText("# Title\n", { begin, end, body: "v1" });
  assert.match(first.text, /v1/);
  const second = injectIntoText(first.text, { begin, end, body: "v2" });
  assert.match(second.text, /v2/);
  assert.equal((second.text.match(/<!--b-->/g) || []).length, 1);
  assert.match(second.text, /# Title/);
});
