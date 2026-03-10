import { join } from "path";
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "fs";

const CONFIG_PATH = join(import.meta.dir, "config.json");
const EXAMPLE_PATH = join(import.meta.dir, "config.example.json");

if (!existsSync(CONFIG_PATH) && existsSync(EXAMPLE_PATH)) {
  copyFileSync(EXAMPLE_PATH, CONFIG_PATH);
}

let config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

function saveConfig() {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function getMime(path: string): string {
  const i = path.lastIndexOf(".");
  return i >= 0 ? MIME[path.substring(i)] || "application/octet-stream" : "application/octet-stream";
}

interface WsData {
  slotId: number;
  target: { name: string; host: string; port: number; password: string };
  tcp: any;
  tcpReady: boolean;
  buffer: Uint8Array[];
}

const server = Bun.serve({
  port: config.port || 3000,
  hostname: "0.0.0.0",

  async fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade for VNC proxy
    if (url.pathname.startsWith("/vnc/")) {
      const slotId = parseInt(url.pathname.split("/")[2]);
      if (isNaN(slotId) || slotId < 0 || slotId >= config.targets.length) {
        return new Response("Invalid slot", { status: 400 });
      }
      const upgraded = server.upgrade(req, {
        data: {
          slotId,
          target: config.targets[slotId],
          tcp: null,
          tcpReady: false,
          buffer: [],
        } satisfies WsData,
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 500 });
    }

    // API: list targets (no passwords)
    if (url.pathname === "/api/targets") {
      return Response.json({
        targets: config.targets.map((t: any, i: number) => ({
          id: i,
          name: t.name,
          host: t.host,
          port: t.port || 5900,
        })),
      });
    }

    // API: update targets list
    if (url.pathname === "/api/targets" && req.method === "PUT") {
      try {
        const body = await req.json();
        if (!Array.isArray(body.targets)) return new Response("Invalid body", { status: 400 });
        config.targets = body.targets.map((t: any) => ({
          name: t.name || "",
          host: t.host || "",
          port: t.port || 5900,
          username: t.username || "",
          password: t.password || "",
        }));
        saveConfig();
        return Response.json({ ok: true, count: config.targets.length });
      } catch (e) {
        return new Response("Invalid JSON", { status: 400 });
      }
    }

    // API: get credentials for a target
    if (url.pathname.match(/^\/api\/targets\/\d+\/password$/)) {
      const id = parseInt(url.pathname.split("/")[3]);
      if (id < 0 || id >= config.targets.length) return new Response("Not found", { status: 404 });
      return Response.json({
        username: config.targets[id].username || "",
        password: config.targets[id].password || "",
      });
    }

    // Serve static files from public/
    let filePath = url.pathname === "/" ? "/index.html" : url.pathname;

    // Security: prevent path traversal
    if (filePath.includes("..")) return new Response("Forbidden", { status: 403 });

    const fullPath = join(import.meta.dir, "public", filePath);
    const file = Bun.file(fullPath);

    // Check file exists before serving
    if (!(await file.exists())) {
      return new Response("Not found", { status: 404 });
    }

    return new Response(file, {
      headers: { "Content-Type": getMime(fullPath) },
    });
  },

  websocket: {
    open(ws) {
      const data = ws.data as WsData;
      const { slotId, target } = data;
      console.log(`[${slotId}] WS open -> ${target.name} (${target.host}:${target.port || 5900})`);

      Bun.connect({
        hostname: target.host,
        port: target.port || 5900,
        socket: {
          data(socket, chunk) {
            try {
              // Send VNC data as binary WebSocket frame
              ws.send(chunk);
            } catch {
              socket.end();
            }
          },
          open(socket) {
            console.log(`[${slotId}] TCP connected`);
            data.tcp = socket;
            data.tcpReady = true;
            // Flush buffered WS messages
            for (const msg of data.buffer) {
              socket.write(msg);
            }
            data.buffer = [];
          },
          close() {
            console.log(`[${slotId}] TCP closed`);
            try {
              ws.close(1000, "VNC disconnected");
            } catch {}
          },
          error(socket, err) {
            console.error(`[${slotId}] TCP error:`, err);
            try {
              ws.close(1011, "VNC error");
            } catch {}
          },
          connectError(socket, err) {
            console.error(`[${slotId}] TCP connect error:`, err);
            try {
              ws.close(1011, "Cannot connect");
            } catch {}
          },
        },
      }).catch((err) => {
        console.error(`[${slotId}] Connection failed:`, err);
        try {
          ws.close(1011, "Connection failed");
        } catch {}
      });
    },

    message(ws, message) {
      const data = ws.data as WsData;
      // Convert to Uint8Array for TCP write
      const buf =
        typeof message === "string"
          ? new TextEncoder().encode(message)
          : new Uint8Array(message as ArrayBuffer);

      if (data.tcpReady && data.tcp) {
        data.tcp.write(buf);
      } else {
        data.buffer.push(buf);
      }
    },

    close(ws, code, reason) {
      const data = ws.data as WsData;
      console.log(`[${data.slotId}] WS closed (${code})`);
      if (data.tcp) {
        try {
          data.tcp.end();
        } catch {}
        data.tcp = null;
      }
    },

    perMessageDeflate: false,
  },
});

console.log(`
  Remote Desktop Server
  ---------------------
  Local:   http://localhost:${server.port}
  Network: http://<this-ip>:${server.port}

  Targets:
${config.targets.map((t: any, i: number) => `    [${i}] ${t.name} -> ${t.host}:${t.port || 5900}`).join("\n")}
`);
