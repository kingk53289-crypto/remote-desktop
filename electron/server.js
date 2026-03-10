const http = require("http");
const { WebSocketServer } = require("ws");
const net = require("net");
const fs = require("fs");
const path = require("path");

const MIME = {
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

function getMime(filePath) {
  const i = filePath.lastIndexOf(".");
  return i >= 0 ? MIME[filePath.substring(i)] || "application/octet-stream" : "application/octet-stream";
}

function startServer(configPath, publicDir, port) {
  const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  const serverPort = port !== undefined ? port : (config.port || 3000);

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${serverPort}`);

    // API: list targets (no passwords)
    if (url.pathname === "/api/targets") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        targets: config.targets.map((t, i) => ({
          id: i, name: t.name, host: t.host, port: t.port || 5900,
        })),
      }));
      return;
    }

    // API: get credentials for a target
    const pwMatch = url.pathname.match(/^\/api\/targets\/(\d+)\/password$/);
    if (pwMatch) {
      const id = parseInt(pwMatch[1]);
      if (id < 0 || id >= config.targets.length) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        username: config.targets[id].username || "",
        password: config.targets[id].password || "",
      }));
      return;
    }

    // Serve static files from public/
    let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    if (filePath.includes("..")) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    const fullPath = path.join(publicDir, filePath);
    if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    res.writeHead(200, { "Content-Type": getMime(fullPath) });
    fs.createReadStream(fullPath).pipe(res);
  });

  // WebSocket server for VNC proxy
  const wss = new WebSocketServer({ server: httpServer, perMessageDeflate: false });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url, `http://127.0.0.1:${serverPort}`);
    if (!url.pathname.startsWith("/vnc/")) {
      ws.close();
      return;
    }

    const slotId = parseInt(url.pathname.split("/")[2]);
    if (isNaN(slotId) || slotId < 0 || slotId >= config.targets.length) {
      ws.close();
      return;
    }

    const target = config.targets[slotId];
    const buffer = [];
    let tcpReady = false;
    let tcp = null;

    console.log(`[${slotId}] WS open -> ${target.name} (${target.host}:${target.port || 5900})`);

    // TCP connection to VNC server
    tcp = net.createConnection(target.port || 5900, target.host, () => {
      console.log(`[${slotId}] TCP connected`);
      tcpReady = true;
      for (const msg of buffer) tcp.write(msg);
      buffer.length = 0;
    });

    tcp.on("data", (chunk) => {
      try {
        ws.send(chunk);
      } catch {
        tcp.destroy();
      }
    });

    tcp.on("close", () => {
      console.log(`[${slotId}] TCP closed`);
      try { ws.close(1000, "VNC disconnected"); } catch {}
    });

    tcp.on("error", (err) => {
      console.error(`[${slotId}] TCP error:`, err.message);
      try { ws.close(1011, "VNC error"); } catch {}
    });

    ws.on("message", (message) => {
      const buf = Buffer.isBuffer(message) ? message : Buffer.from(message);
      if (tcpReady && tcp) {
        tcp.write(buf);
      } else {
        buffer.push(buf);
      }
    });

    ws.on("close", (code) => {
      console.log(`[${slotId}] WS closed (${code})`);
      if (tcp) {
        try { tcp.destroy(); } catch {}
        tcp = null;
      }
    });
  });

  return new Promise((resolve) => {
    httpServer.listen(serverPort, "127.0.0.1", () => {
      const actualPort = httpServer.address().port;
      console.log(`\n  Remote Desktop Server (Electron)\n  --------------------------------`);
      console.log(`  http://127.0.0.1:${actualPort}\n`);
      config.targets.forEach((t, i) => {
        console.log(`    [${i}] ${t.name} -> ${t.host}:${t.port || 5900}`);
      });
      console.log();
      resolve({ httpServer, wss, port: actualPort });
    });
  });
}

module.exports = { startServer };
