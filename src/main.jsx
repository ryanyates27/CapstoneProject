//----------------------------------------------------------------------
// File: src/main.jsx
// Purpose: React entry point for the renderer process.
//          - Mounts <App /> into the DOM.
//          - Wraps in React.StrictMode for dev warnings.
//          - Imports global CSS reset (index.css).
// Notes:
//   • This is executed by Vite’s renderer entry (see vite.config).
//   • For production builds, Electron loads the bundled dist/index.html.
//   • Keep this file minimal—no app logic here.
// Owner: Ryan | Last touched: 2025-10-20
//----------------------------------------------------------------------

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// Global stylesheet — applies base styles, dark theme colors, etc.
import "./index.css";

// Root application component (contains MainPage + IPC badge).
import App from "./App.jsx";

// Find the DOM element created in index.html where React will mount.
// In Vite’s default template, <div id="root"></div> is defined there.
const rootElement = document.getElementById("root");

// Create the React root and render the app.
// StrictMode enables helpful warnings for dev; has no effect in production.
createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);
