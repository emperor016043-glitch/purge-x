import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";

/**
 * 零依赖 WebSocket 客户端（RFC6455 子集）：只做 CDP 需要的那一套。
 * 支持：文本/二进制帧、分片、ping/pong、close、客户端掩码。
 * 不支持：扩展协商（permessage-deflate）、代理。
 */
export function connectWs(url, { timeout = 5000, maxPayload = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const secure = u.protocol === "wss:";
    const port = Number(u.port || (secure ? 443 : 80));
    const key = crypto.randomBytes(16).toString("base64");
    const socket = secure
      ? tls.connect({ host: u.hostname, port, servername: u.hostname })
      : net.connect({ host: u.hostname, port });

    const emitter = new EventEmitter();
    let handshakeDone = false;
    let buf = Buffer.alloc(0);
    let fragments = [];
    let closed = false;

    const timer = setTimeout(() => {
      if (!handshakeDone) {
        socket.destroy();
        reject(new Error(`ws handshake timeout: ${url}`));
      }
    }, timeout);

    socket.on("error", (err) => {
      if (!handshakeDone) {
        clearTimeout(timer);
        reject(err);
      } else {
        emitter.emit("error", err);
      }
    });

    socket.on("close", () => {
      closed = true;
      emitter.emit("close");
    });

    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);

      if (!handshakeDone) {
        const end = buf.indexOf("\r\n\r\n");
        if (end === -1) return;
        const head = buf.subarray(0, end).toString("latin1");
        buf = buf.subarray(end + 4);
        const statusLine = head.split("\r\n")[0] || "";
        if (!/101/.test(statusLine)) {
          socket.destroy();
          clearTimeout(timer);
          reject(new Error(`ws handshake rejected: ${statusLine}`));
          return;
        }
        handshakeDone = true;
        clearTimeout(timer);
        resolve(api);
      }

      while (handshakeDone && buf.length >= 2) {
        const b0 = buf[0];
        const b1 = buf[1];
        const fin = (b0 & 0x80) !== 0;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          offset = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          const big = buf.readBigUInt64BE(2);
          if (big > BigInt(maxPayload)) {
            socket.destroy();
            return;
          }
          len = Number(big);
          offset = 10;
        }
        let mask = null;
        if (masked) {
          if (buf.length < offset + 4) return;
          mask = buf.subarray(offset, offset + 4);
          offset += 4;
        }
        if (buf.length < offset + len) return;

        let payload = Buffer.from(buf.subarray(offset, offset + len));
        buf = buf.subarray(offset + len);
        if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];

        if (opcode === 0x9) {
          sendFrame(0xa, payload);
          continue;
        }
        if (opcode === 0xa) continue;
        if (opcode === 0x8) {
          try {
            sendFrame(0x8, Buffer.alloc(0));
          } catch {
            /* 忽略 */
          }
          socket.end();
          return;
        }
        if (opcode === 0x0) {
          fragments.push(payload);
        } else {
          fragments = [payload];
        }
        if (fin) {
          const full = Buffer.concat(fragments);
          fragments = [];
          const text = full.toString("utf8");
          emitter.emit("message", text);
        }
      }
    });

    function frame(opcode, payload) {
      const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
      const maskKey = crypto.randomBytes(4);
      const masked = Buffer.alloc(data.length);
      for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ maskKey[i % 4];

      let header;
      if (data.length < 126) {
        header = Buffer.alloc(2);
        header[1] = 0x80 | data.length;
      } else if (data.length < 65536) {
        header = Buffer.alloc(4);
        header[1] = 0x80 | 126;
        header.writeUInt16BE(data.length, 2);
      } else {
        header = Buffer.alloc(10);
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(data.length), 2);
      }
      header[0] = 0x80 | opcode;
      return Buffer.concat([header, maskKey, masked]);
    }

    function sendFrame(opcode, payload) {
      if (closed) return;
      socket.write(frame(opcode, payload));
    }

    const api = {
      send(text) {
        sendFrame(0x1, text);
      },
      on(event, handler) {
        emitter.on(event, handler);
        return api;
      },
      close() {
        if (closed) return;
        try {
          sendFrame(0x8, Buffer.alloc(0));
        } catch {
          /* 忽略 */
        }
        socket.end();
        closed = true;
      },
      get closed() {
        return closed;
      },
    };

    const reqLines = [
      `GET ${u.pathname}${u.search || ""} HTTP/1.1`,
      `Host: ${u.host}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      "\r\n",
    ];
    socket.write(reqLines.join("\r\n"));
  });
}
