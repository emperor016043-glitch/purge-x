import http from "node:http";
import { connectWs } from "./ws.js";

/** 读 CDP 的 HTTP 端点（/json/version、/json/list）。 */
export function httpJson(port, pathname, { host = "127.0.0.1", timeout = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path: pathname, timeout }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(new Error(`bad json from ${pathname}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error(`timeout ${pathname}`));
    });
    req.on("error", reject);
  });
}

export async function probe(port) {
  try {
    const version = await httpJson(port, "/json/version");
    const list = await httpJson(port, "/json/list");
    return { ok: true, version, targets: list };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * 极简 CDP 客户端：一条 ws 连接，多路 id 复用。
 * 用法：
 *   const c = await CDP.connect(wsUrl);
 *   await c.send("Runtime.evaluate", { expression: "1+1", returnByValue: true });
 */
export class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
  }

  static async connect(wsUrl) {
    const ws = await connectWs(wsUrl, { timeout: 6000 });
    const client = new CDP(ws);
    ws.on("message", (text) => client.#onMessage(text));
    ws.on("close", () => {
      for (const [, { reject }] of client.pending) reject(new Error("cdp closed"));
      client.pending.clear();
    });
    ws.on("error", (err) => {
      for (const [, { reject }] of client.pending) reject(err);
      client.pending.clear();
    });
    return client;
  }

  #onMessage(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message || "cdp error"} (${msg.error.code})`));
      else resolve(msg.result);
      return;
    }
    if (msg.method) {
      const list = this.handlers.get(msg.method) || [];
      for (const fn of list) {
        try {
          fn(msg.params);
        } catch {
          /* 单个 handler 失败不影响其它 */
        }
      }
    }
  }

  on(method, fn) {
    const list = this.handlers.get(method) || [];
    list.push(fn);
    this.handlers.set(method, list);
    return this;
  }

  send(method, params = {}, { timeout = 15000, sessionId = null } = {}) {
    const id = this.nextId++;
    const payload = sessionId ? JSON.stringify({ id, method, params, sessionId }) : JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(payload);
      } catch (err) {
        this.pending.delete(id);
        reject(err);
        return;
      }
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`cdp timeout: ${method}`));
        }
      }, timeout);
    });
  }

  close() {
    this.ws.close();
  }
}

/** 在页面里求值，返回 JS 值（自动 await promise）。 */
export async function evaluate(client, expression, { awaitPromise = true } = {}) {
  const res = await client.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise,
    allowUnsafeEvalBlockedByCSP: true,
  });
  if (res?.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new Error(`evaluate failed: ${d.exception?.description || d.text || "unknown"}`);
  }
  return res?.result?.value;
}

/** 让一段脚本在每个新文档加载时先跑（刷新也不丢）。 */
export async function addInitScript(client, source) {
  return client.send("Page.addScriptToEvaluateOnNewDocument", { source, runImmediately: true });
}

export async function enableDomains(client) {
  await client.send("Page.enable", {}).catch(() => {});
  await client.send("Runtime.enable", {}).catch(() => {});
}

/**
 * 覆盖 OOPIF（out-of-process iframe）与子 webview。
 *
 * 豆包的聊天区是跨进程 iframe：它不出现在 /json/list 里，只有
 * Target.getTargets 能看到。对每个子 target 走 flatten session 注入，
 * 否则请求改写只在壳页面生效、对话本身漏掉。
 */
export async function injectIntoChildTargets(client, source, { waitMs = 0 } = {}) {
  const results = [];
  let infos = [];
  try {
    const res = await client.send("Target.setDiscoverTargets", { discover: true });
  } catch {
    /* 老版本没有这个域，忽略 */
  }
  try {
    const res = await client.send("Target.getTargets", {});
    infos = res?.targetInfos || [];
  } catch (err) {
    return [{ ok: false, error: `Target.getTargets failed: ${err?.message || err}` }];
  }

  for (const ti of infos) {
    if (!ti.targetId) continue;
    if (ti.type === "browser" || ti.type === "service_worker") continue;
    let sessionId = null;
    try {
      const attached = await client.send("Target.attachToTarget", { targetId: ti.targetId, flatten: true });
      sessionId = attached?.sessionId;
      if (!sessionId) throw new Error("no sessionId");
      await client.send("Page.enable", {}, { sessionId }).catch(() => {});
      await client.send("Runtime.enable", {}, { sessionId }).catch(() => {});
      await client
        .send("Page.addScriptToEvaluateOnNewDocument", { source, runImmediately: true }, { sessionId })
        .catch(() => {});
      const res = await client.send(
        "Runtime.evaluate",
        { expression: source, returnByValue: true, awaitPromise: false },
        { sessionId },
      );
      results.push({
        targetId: ti.targetId,
        type: ti.type,
        url: ti.url,
        ok: !res?.exceptionDetails,
        error: res?.exceptionDetails ? String(res.exceptionDetails.text || "") : null,
      });
    } catch (err) {
      results.push({ targetId: ti.targetId, type: ti.type, url: ti.url, ok: false, error: err?.message || String(err) });
    } finally {
      if (sessionId) {
        try {
          await client.send("Target.detachFromTarget", { sessionId });
        } catch {
          /* 会话可能已随 target 销毁，忽略 */
        }
      }
    }
  }

  if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
  return results;
}

/**
 * 在所有已存在的执行上下文里跑同一段脚本。
 *
 * 为什么需要：豆包是 webview + iframe 结构，主文档只是壳，
 * 真正的对话请求跑在子 frame 里。Page.addScriptToEvaluateOnNewDocument
 * 只覆盖"之后新建"的文档，已经活在页面里的 iframe 得靠 contextId 逐个打。
 */
export async function injectIntoAllContexts(client, source, { waitMs = 500 } = {}) {
  const contexts = [];
  client.on("Runtime.executionContextCreated", (p) => {
    if (p?.context) contexts.push(p.context);
  });

  // 已经 enable 过的 domain 再 enable 是 no-op，不会重放 context 列表。
  // 先 disable 再 enable，才能拿到当前所有 frame 的 context。
  await client.send("Runtime.disable", {}).catch(() => {});
  await client.send("Runtime.enable", {}).catch(() => {});
  await new Promise((r) => setTimeout(r, waitMs));

  const results = [];
  for (const ctx of contexts) {
    // 只打页面上下文，跳过 isolated world（扩展、devtools 自己的）
    if (ctx.auxData && ctx.auxData.isDefault === false) continue;
    try {
      const res = await client.send("Runtime.evaluate", {
        expression: source,
        contextId: ctx.id,
        awaitPromise: false,
        returnByValue: true,
        allowUnsafeEvalBlockedByCSP: true,
      });
      results.push({
        contextId: ctx.id,
        name: ctx.name || "",
        origin: ctx.origin || "",
        ok: !res?.exceptionDetails,
        error: res?.exceptionDetails ? String(res.exceptionDetails.text || "") : null,
      });
    } catch (err) {
      results.push({ contextId: ctx.id, ok: false, error: err?.message || String(err) });
    }
  }
  return results;
}
