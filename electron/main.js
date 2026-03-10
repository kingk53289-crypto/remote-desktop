const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");
const { startServer } = require("./server");

let mainWindow;
let server;

function getPublicDir() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "public");
  }
  return path.join(__dirname, "..", "public");
}

function getConfigPath() {
  const userConfig = path.join(app.getPath("userData"), "config.json");
  if (fs.existsSync(userConfig)) return userConfig;

  // Copy default config to userData on first run
  const defaultConfig = app.isPackaged
    ? path.join(process.resourcesPath, "config.example.json")
    : path.join(__dirname, "..", "config.example.json");

  if (fs.existsSync(defaultConfig)) {
    fs.mkdirSync(path.dirname(userConfig), { recursive: true });
    fs.copyFileSync(defaultConfig, userConfig);
  }
  return userConfig;
}

// GPU acceleration for 4x canvas rendering
app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("enable-zero-copy");
app.commandLine.appendSwitch("ignore-gpu-blocklist");

app.whenReady().then(async () => {
  const configPath = getConfigPath();
  const publicDir = getPublicDir();

  // Start embedded HTTP/WS server on random port
  // Fixed port so localStorage (credentials) persists across launches
  server = await startServer(configPath, publicDir, 19280);

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 12, y: 12 },
    backgroundColor: "#0a0a14",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${server.port}`);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
});

app.on("window-all-closed", () => {
  if (server) {
    server.wss.close();
    server.httpServer.close();
  }
  app.quit();
});
