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
  // Internal gateways may use a self-signed certificate. Never blanket-trust
  // TLS errors: accept only a currently valid certificate with an explicit
  // fingerprint pin for the configured HTTPS API host.
  const expectedFingerprint = (process.env.AYAD_API_CERT_FINGERPRINT ?? "")
    .replace(/[^a-fA-F0-9]/g, "")
    .toLowerCase();
  app.on("certificate-error", (event, webContents, url, error, certificate, callback) => {
    if (!expectedFingerprint || expectedFingerprint.length < 40) return callback(false);

    try {
      const configured = process.env.VITE_API_BASE_URL;
      if (!configured || !certificate) return callback(false);
      const apiUrl = new URL(configured);
      const requestUrl = new URL(url);
      const actualFingerprint = (certificate.fingerprint ?? "")
        .replace(/[^a-fA-F0-9]/g, "")
        .toLowerCase();
      const nowSeconds = Math.floor(Date.now() / 1000);
      const isCurrentlyValid = certificate.validStart <= nowSeconds && certificate.validExpiry > nowSeconds;
      if (
        apiUrl.protocol === "https:"
        && requestUrl.protocol === "https:"
        && apiUrl.hostname === requestUrl.hostname
        && actualFingerprint === expectedFingerprint
        && isCurrentlyValid
        && error === "net::ERR_CERT_AUTHORITY_INVALID"
      ) {
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
