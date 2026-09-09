const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("ayadDesktop", {
  platform: process.platform,
  isDesktop: true,
});
