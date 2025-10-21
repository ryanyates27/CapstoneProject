// electron/preload.cjs
// Minimal, explicit bridge: only expose the IPC you actually use.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  // Optional status check used by App.jsx badge
  ping: () => ipcRenderer.invoke("ping"),

  // Annotation flow
  annotateFlyGenes: (payload) =>
    ipcRenderer.invoke("annotate:flybase", payload),

  // Save / history
  saveAnnotationRun: (payload) => ipcRenderer.invoke("annotate:save", payload),
  listAnnotationRuns: (args) => ipcRenderer.invoke("annotate:list", args),
  loadAnnotationRun: (args) => ipcRenderer.invoke("annotate:load", args),

  // CSV export pipeline
  exportEnsemblFlyBaseCSV: (payload) =>
    ipcRenderer.invoke("pipeline:ensembl-flybase-export", payload),
});
