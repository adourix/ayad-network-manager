const { app, BrowserWindow, shell, session } = require("electron");
const path = require("node:path");

const isDev = Boolean(process.env.ELECTRON_START_URL);
const startUrl = process.env.ELECTRON_START_URL;

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#f4f1eb",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once("ready-to-show", () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  if (isDev) {
    win.loadURL(startUrl);
  } else {
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

app.whenReady().then(() => {
  // The gateway normally uses an internal HTTPS certificate. Only trust a
  // certificate error for the configured API host; never disable TLS globally.
  app.on("certificate-error", (event, webContents, url, error, certificate, callback) => {
    const configured = process.env.VITE_API_BASE_URL;
    if (!configured) return callback(false);

    try {
      const apiHost = new URL(configured).hostname;
      const requestHost = new URL(url).hostname;
      if (apiHost === requestHost && certificate && error) {
        event.preventDefault();
        callback(true);
        return;
      }
    } catch {
      // Fall through to normal certificate validation.
    }

    callback(false);
  });

  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
