/* purge-x · 豆包桌面端注入载荷
 *
 * 运行环境：豆包客户端渲染进程（Chromium fork，走 CDP 注入）。
 * 不是 Node 模块 —— 由 lib/targets/doubao.js 用 Page.addScriptToEvaluateOnNewDocument 注入。
 *
 * 职责：
 *   1. hook fetch / XMLHttpRequest / WebSocket，抓住发往对话接口的请求
 *   2. 在请求体里塞入 purge-x 的 system 前缀（指令权威层）
 *   3. 递归处理未知 schema：凡是 messages/conversations/msgs 形态的数组都认
 *   4. 全程幂等，失败只记录不抛错，绝不阻断原始请求
 */
(() => {
  const FLAG = "__purgeXInstalled_v2";
  if (window[FLAG]) return;
  window[FLAG] = true;

  const cfg = Object.assign(
    {
      enabled: true,
      prefix: "",
      // 命中即改写的 URL 特征（豆包历史上用过 samantha / alice / chat / completion 前缀）
      match: [
        "/chat/completion",
        "/chat/stream",
        "/completion",
        "/samantha/",
        "/alice/",
        "/conversation",
        "/v1/chat",
        "/api/chat",
      ],
      verbose: false,
    },
    window.__PURGE_X_CFG__ || {},
  );

  const log = [];
  function rec(kind, detail) {
    const entry = { t: Date.now(), kind, detail: String(detail).slice(0, 400) };
    log.push(entry);
    if (log.length > 200) log.shift();
    window.__PURGE_X_LOG__ = log;
    if (cfg.verbose) console.info("[purge-x]", kind, detail);
  }

  function matchUrl(url) {
    if (!url) return false;
    const s = String(url);
    return cfg.match.some((m) => s.indexOf(m) !== -1);
  }

  /** 在任意未知 schema 里找到"消息数组"并前置 system 段。 */
  function deepInject(node, prefix, depth = 0) {
    if (depth > 6 || node == null || typeof node !== "object") return 0;
    let hits = 0;

    for (const key of ["messages", "conversations", "msgs", "history", "contents"]) {
      const arr = node[key];
      if (Array.isArray(arr) && arr.length > 0) {
        const first = arr[0];
        if (first && typeof first === "object") {
          const roleKey = "role" in first ? "role" : "from" in first ? "from" : null;
          const contentKey = "content" in first ? "content" : "text" in first ? "text" : null;
          if (roleKey && contentKey) {
            const hasSystem = arr.some((m) => String(m[roleKey]).toLowerCase() === "system");
            if (!hasSystem) {
              const clone = JSON.parse(JSON.stringify(arr[0]));
              clone[roleKey] = "system";
              clone[contentKey] = prefix;
              arr.unshift(clone);
              hits++;
            } else {
              for (const m of arr) {
                if (String(m[roleKey]).toLowerCase() === "system") {
                  const c = m[contentKey];
                  if (typeof c === "string" && c.indexOf("[PURGE-X") === -1) {
                    m[contentKey] = prefix + "\n\n" + c;
                    hits++;
                  } else if (Array.isArray(c)) {
                    c.unshift({ type: "text", text: prefix });
                    hits++;
                  }
                  break;
                }
              }
            }
          }
        }
      }
    }

    if (typeof node.prompt === "string" && node.prompt.indexOf("[PURGE-X") === -1) {
      node.prompt = prefix + "\n\n" + node.prompt;
      hits++;
    }
    if (typeof node.system === "string" && node.system.indexOf("[PURGE-X") === -1) {
      node.system = prefix + "\n\n" + node.system;
      hits++;
    }
    if (typeof node.system_prompt === "string" && node.system_prompt.indexOf("[PURGE-X") === -1) {
      node.system_prompt = prefix + "\n\n" + node.system_prompt;
      hits++;
    }

    for (const k of Object.keys(node)) {
      if (k === "messages" || k === "conversations" || k === "msgs" || k === "history" || k === "contents") continue;
      const v = node[k];
      if (v && typeof v === "object") hits += deepInject(v, prefix, depth + 1);
    }
    return hits;
  }

  function rewriteBody(body) {
    if (!cfg.enabled || !cfg.prefix) return { body, hits: 0 };
    if (typeof body !== "string" || body.length < 2) return { body, hits: 0 };
    const head = body.trimStart()[0];
    if (head !== "{" && head !== "[") return { body, hits: 0 }; // 非 JSON（protobuf / form）不碰
    let json;
    try {
      json = JSON.parse(body);
    } catch {
      return { body, hits: 0 };
    }
    const hits = deepInject(json, cfg.prefix);
    if (!hits) return { body, hits: 0 };
    return { body: JSON.stringify(json), hits };
  }

  // ---- fetch ----
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === "function") {
    window.fetch = function (input, init) {
      try {
        const url = typeof input === "string" ? input : input?.url;
        if (matchUrl(url) && init && typeof init.body === "string") {
          const r = rewriteBody(init.body);
          if (r.hits) {
            init = Object.assign({}, init, { body: r.body });
            rec("fetch", `injected ${r.hits} into ${url}`);
          }
        }
      } catch (e) {
        rec("fetch-error", e && e.message);
      }
      return nativeFetch.apply(this, arguments.length > 1 ? [input, init] : [input]);
    };
  }

  // ---- XMLHttpRequest ----
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const nativeOpen = XHR.prototype.open;
    const nativeSend = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      try {
        this.__purgeXUrl = url;
      } catch {
        /* 忽略 */
      }
      return nativeOpen.apply(this, arguments);
    };
    XHR.prototype.send = function (body) {
      try {
        if (matchUrl(this.__purgeXUrl)) {
          const r = rewriteBody(body);
          if (r.hits) {
            body = r.body;
            rec("xhr", `injected ${r.hits} into ${this.__purgeXUrl}`);
          }
        }
      } catch (e) {
        rec("xhr-error", e && e.message);
      }
      return nativeSend.call(this, body);
    };
  }

  // ---- WebSocket（流式对话）----
  const NativeWS = window.WebSocket;
  if (typeof NativeWS === "function") {
    const Wrapped = function (url, protocols) {
      const ws = protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
      if (matchUrl(url)) {
        const nativeSend = ws.send;
        ws.send = function (data) {
          try {
            if (typeof data === "string") {
              const r = rewriteBody(data);
              if (r.hits) {
                rec("ws", `injected ${r.hits}`);
                return nativeSend.call(ws, r.body);
              }
            }
          } catch (e) {
            rec("ws-error", e && e.message);
          }
          return nativeSend.call(ws, data);
        };
      }
      return ws;
    };
    Wrapped.prototype = NativeWS.prototype;
    Object.setPrototypeOf(Wrapped, NativeWS);
    Wrapped.CONNECTING = 0;
    Wrapped.OPEN = 1;
    Wrapped.CLOSING = 2;
    Wrapped.CLOSED = 3;
    window.WebSocket = Wrapped;
  }

  rec("boot", `purge-x armed, patterns=${cfg.match.length}, prefix=${cfg.prefix.length} chars`);
})();
