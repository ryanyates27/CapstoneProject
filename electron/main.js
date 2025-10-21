//----------------------------------------------------------------------
// File: electron/main.js
// Purpose: Electron main process — window lifecycle & IPC for Fly Faster
// Notes:
//   • Keep IPC surface minimal; push business logic into /electron/services
//   • Preload exposes a strict, whitelisted API (see preload.cjs)
//   • DB is initialized on app start so first IPC calls don’t race it
// Owner: Ryan | Last touched: 2025-10-20
//----------------------------------------------------------------------

import { app, BrowserWindow, ipcMain, dialog } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Services (pure functions; no UI here)
import { annotateRegions } from "./flybaseService.js";
import { initDb, saveJob, listJobs, loadJob } from "./sqliteService.js";
import { runEnsemblFlyBasePipelineAndSave } from "./pipelineEnsemblFlyBase.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = !app.isPackaged;

/**
 * Create the main renderer window.
 * - Disable Node integration in the renderer for security (use preload bridge).
 * - Load Vite dev server in dev, static index.html in production.
 */
function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#111827",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"), // strict API surface
      contextIsolation: true, // isolate context for safety
      nodeIntegration: false, // no Node in renderer
      sandbox: false, // allow IPC; keep preload tight
    },
    show: false, // avoid white flash; show when ready
  });

  win.once("ready-to-show", () => win.show());

  if (isDev) {
    // When running `vite dev`, Vite injects VITE_DEV_SERVER_URL
    const devServerURL =
      process.env.VITE_DEV_SERVER_URL || "http://localhost:5174";
    void win.loadURL(devServerURL);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    void win.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

/**
 * App ready:
 * - Initialize the local SQLite DB (tables/indexes).
 * - Create the main window.
 * - Handle macOS dock re-activation.
 */
app.whenReady().then(async () => {
  try {
    await initDb(); // ensure DB is ready before first IPC hits it
  } catch (e) {
    console.error("DB init failed:", e);
  }

  createWindow();

  app.on("activate", () => {
    // macOS: recreate a window when clicking dock icon and there are none open
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Quit the app on all windows closed (except macOS, standard behavior).
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// =========================== IPC HANDLERS ============================
// All IPC handlers are intentionally thin: validate inputs -> call service
// functions -> map service result into a stable return shape for the UI.

//--------------------------- Health / Debug ---------------------------

/**
 * @channel ping
 * Renderer sanity check: confirms preload/main wiring.
 * @returns {Promise<string>} "pong from main"
 */
ipcMain.handle("ping", async () => "pong from main");

//----------------------------- Annotation -----------------------------

/**
 * @channel annotate:flybase
 * Annotate a batch of coordinate rows:
 *  - Tries FlyMine overlap first (strict on full-gene windows),
 *  - Falls back to Ensembl overlap → FBgn map → FlyBase summary.
 *
 * @param {{ assembly:string, radius:number, rows:Array<any> }} payload
 * @returns {Promise<{ok:boolean, count:number, items:Array<any>} | {ok:false,error:string}>}
 */
ipcMain.handle("annotate:flybase", async (_evt, payload) => {
  try {
    const res = await annotateRegions(payload);
    return res; // { ok, count, items }
  } catch (err) {
    console.error("annotate:flybase failed:", err);
    return { ok: false, error: String(err?.message || err) };
  }
});

//------------------------------- Jobs --------------------------------

/**
 * @channel annotate:save
 * Persist the last annotation run (metadata + items) into SQLite.
 *
 * @param {{ assembly:string, radius:number, sourceFile?:string, sourceHash?:string, items:any[] }} payload
 * @returns {{ok:true, jobId:number}}
 */
ipcMain.handle("annotate:save", async (_evt, payload) => {
  const id = saveJob(payload);
  return { ok: true, jobId: id };
});

/**
 * @channel annotate:list
 * List recent saved runs with pagination.
 *
 * @param {{limit?:number, offset?:number}} args
 * @returns {{ok:true, items:any[]}}
 */
ipcMain.handle(
  "annotate:list",
  async (_evt, { limit = 20, offset = 0 } = {}) => {
    const rows = listJobs(limit, offset);
    return { ok: true, items: rows };
  }
);

/**
 * @channel annotate:load
 * Load a specific run by its job ID.
 *
 * @param {{jobId:number}} args
 * @returns {{ok:true, data:any} | {ok:false, error:string}}
 */
ipcMain.handle("annotate:load", async (_evt, { jobId }) => {
  const data = loadJob(jobId);
  if (!data) return { ok: false, error: "Not found" };
  return { ok: true, data };
});

//------------------------ Ensembl→FlyBase CSV -------------------------

/**
 * @channel pipeline:ensembl-flybase-export
 * For a given region, run:
 *   Ensembl overlap → FBgn xref → FlyBase auto summaries,
 * then save a sponsor-style CSV to a path chosen by the user.
 *
 * @param {{chrom:string, start:number, end:number, assembly?:string}} payload
 * @returns {Promise<{ok:true, count:number, savePath:string} | {ok:false, error:string}>}
 */
ipcMain.handle("pipeline:ensembl-flybase-export", async (_evt, payload) => {
  try {
    const { chrom, start, end, assembly = "dm6" } = payload || {};
    if (!chrom || start == null || end == null) {
      return { ok: false, error: "Missing chrom/start/end" };
    }

    // Ask the user where to save the CSV.
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: "Save Ensembl→FlyBase CSV",
      defaultPath: `flyfaster_${chrom}_${start}-${end}.csv`,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (canceled || !filePath) return { ok: false, error: "User canceled" };

    const res = await runEnsemblFlyBasePipelineAndSave({
      chrom,
      start,
      end,
      assembly,
      savePath: filePath,
    });

    return { ok: true, ...res }; // { count, savePath }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});
