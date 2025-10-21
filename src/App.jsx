//----------------------------------------------------------------------
// File: src/App.jsx
// Purpose: Renderer entry component.
//          - Renders the app shell and mounts MainPage.
//          - Performs a simple IPC sanity check via preload (window.api.ping).
// Notes:
//   • If you remove the status badge, you can also remove `ping` from
//     preload.cjs and the 'ping' handler in electron/main.js.
// Owner: Ryan | Last touched: 2025-10-20
//----------------------------------------------------------------------

import { useEffect, useState } from "react";
import MainPage from "./components/MainPage.jsx";

/**
 * Root renderer component.
 * Provides a minimal layout (dark background) and an IPC status badge.
 */
export default function App() {
  // Live message from main process ("pong from main" when wired correctly).
  const [msg, setMsg] = useState("...");

  useEffect(() => {
    // On first mount, call into preload -> main to verify IPC wiring.
    async function run() {
      try {
        // Optional chaining keeps this safe if preload isn’t injected.
        const res = await window.api?.ping?.();
        setMsg(res || "no api"); // 'no api' helps diagnose preload exposure
      } catch (err) {
        setMsg(String(err)); // surface any exception text
      }
    }
    run();
  }, []);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0b1220",
        color: "white",
        display: "grid",
        placeItems: "center",
        fontFamily:
          "system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, sans-serif",
        padding: 16, // keep badge off the very edge
      }}
    >
      {/* ---------------- Status badge (Electron/IPC) ----------------
          Useful during development to confirm main <-> preload <-> renderer. */}
      <div
        style={{
          position: "fixed",
          top: 10,
          right: 10,
          fontSize: 12,
          padding: "6px 10px",
          borderRadius: 999,
          border: "1px solid #333",
          background: "#121212",
          color: "#9ad",
          zIndex: 10,
        }}
      >
        Electron ✓ | IPC: {msg || "…"}
      </div>

      {/* ---------------- App content shell ----------------
          Title + the single page UI. Keep width constrained for readability. */}
      <div style={{ textAlign: "center", width: "100%" }}>
        <h1>Fly Faster</h1>
        <p>
          IPC check: <code>{msg}</code>
        </p>

        {/* Mount the main page (file intake + annotation UI). */}
        <div style={{ maxWidth: 1100, margin: "24px auto" }}>
          <MainPage />
        </div>
      </div>
    </div>
  );
}
