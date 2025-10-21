//---------------------------------------------------------------------
// File: src/components/MainPage.jsx
// Purpose: Single renderer page for Fly Faster.
//          - Intake CSV/XLSX files
//          - Preview rows
//          - Normalize coordinates for IPC
//          - Run gene annotation via main-process services
//          - Save/list/load runs from local SQLite
//          - Export sponsor-style CSV per region via pipeline
// Notes:
//   • Renderer talks to main via window.api.* (preload.cjs).
//   • Keep UI state and data-shaping here; networking/FS lives in main/services.
// Owner: Ryan | Last touched: 2025-10-20
//---------------------------------------------------------------------

import React, { useCallback, useMemo, useRef, useState } from "react";
import Papa from "papaparse";
import * as XLSX from "xlsx";

//------------------------------- Styles --------------------------------
// Keep lightweight inline styles; this is an internal tool UI.
const containerStyles = {
  maxWidth: 1000,
  margin: "40px auto",
  padding: 24,
  background: "#1e1e1e",
  borderRadius: 16,
  border: "1px solid #2a2a2a",
  boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
  color: "#ddd",
  fontFamily:
    'Inter, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, Helvetica Neue, Arial, "Apple Color Emoji","Segoe UI Emoji"',
};

const dropZoneBase = {
  border: "2px dashed #3b3b3b",
  borderRadius: 14,
  padding: 28,
  textAlign: "center",
  cursor: "pointer",
  transition: "border-color 120ms ease",
  userSelect: "none",
  background: "#151515",
};

const badge = {
  display: "inline-block",
  padding: "4px 10px",
  borderRadius: 999,
  fontSize: 12,
  border: "1px solid #2d2d2d",
  background: "#0f0f0f",
  color: "#9ad",
};

const metaItem = {
  marginRight: 16,
  marginTop: 8,
  display: "inline-block",
  fontSize: 13,
  opacity: 0.9,
};

const tableWrap = {
  overflow: "auto",
  border: "1px solid #2a2a2a",
  borderRadius: 12,
};
const tableStyle = { width: "100%", borderCollapse: "collapse", fontSize: 13 };
const thtd = {
  borderBottom: "1px solid #2a2a2a",
  padding: "8px 10px",
  whiteSpace: "nowrap",
};

// File types we accept. Keep in sync with the <input accept="…"> below.
const allowedExts = [".csv", ".xlsx", ".xlsm", ".xlsb", ".xls"];

//--------------------------- Small utilities ---------------------------

/** Return the lowercase extension (including dot), or '' if none. */
function getExt(name = "") {
  const ix = name.lastIndexOf(".");
  return ix >= 0 ? name.slice(ix).toLowerCase() : "";
}

/** True if the extension is an Excel variant we can read via xlsx. */
function isExcel(ext) {
  return (
    ext === ".xlsx" || ext === ".xlsm" || ext === ".xlsb" || ext === ".xls"
  );
}

//-------------------------------- View ---------------------------------



export default function MainPage() {
  //------------------------------ State --------------------------------
  const [file, setFile] = useState(null);

  // File parsing state
  const [sheetNames, setSheetNames] = useState([]);
  const [activeSheet, setActiveSheet] = useState("");
  const [rows, setRows] = useState([]); // parsed rows (objects)
  const [headers, setHeaders] = useState([]); // header list
  const [error, setError] = useState("");

  // Annotation params & results
  const [assembly, setAssembly] = useState("dm6"); // NEW
  const [radius, setRadius] = useState(5000); // NEW
  const [annotating, setAnnotating] = useState(false); // NEW
  const [annotations, setAnnotations] = useState([]); // NEW
  const [annotError, setAnnotError] = useState(""); // NEW
  const [info, setInfo] = useState({ totalRows: 0, parsedAt: null });

  // Save/load (SQLite)
  const [lastSavedJobId, setLastSavedJobId] = useState(null); // NEW (already present in your file)
  const [history, setHistory] = useState([]); // NEW (already present in your file)

  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef(null);

  //---------------------------- File intake ----------------------------
  const onPickClick = () => inputRef.current?.click();

  /**
   * Handle new files dropped or selected.
   * Resets previous UI state and dispatches to CSV/Excel parser accordingly.
   */
  const handleFiles = useCallback(async (fileList) => {
    const f = fileList?.[0];
    if (!f) return;

    // Reset UI state for a new intake
    setError("");
    setFile(f);
    setSheetNames([]);
    setActiveSheet("");
    setRows([]);
    setHeaders([]);
    setInfo({ totalRows: 0, parsedAt: null });
    setAnnotations([]); // CHANGED: clear previous annotations on new file
    setLastSavedJobId(null); // CHANGED
    setHistory([]); // CHANGED

    // Basic file-type guard
    const ext = getExt(f.name);
    if (!allowedExts.includes(ext)) {
      setError(
        `Unsupported file type: ${
          ext || "(none)"
        }.\nAllowed: ${allowedExts.join(", ")}`
      );
      return;
    }

    try {
      if (ext === ".csv") {
        await parseCSV(f);
      } else if (isExcel(ext)) {
        await parseExcel(f);
      }
    } catch (e) {
      console.error(e);
      setError(`Failed to parse file: ${e?.message || e}`);
    }
  }, []);

  /**
   * Parse CSV → array of objects using first row as header.
   * Uses Papa’s worker mode to keep UI responsive on large files.
   */
  const parseCSV = useCallback((f) => {
    return new Promise((resolve, reject) => {
      Papa.parse(f, {
        header: true,
        skipEmptyLines: "greedy",
        worker: true,
        dynamicTyping: false, // keep strings; downstream normalization is explicit
        complete: (res) => {
          const parsedRows = res.data || [];
          const hdrs = res.meta?.fields || [];
          setRows(parsedRows);
          setHeaders(hdrs);
          setInfo({
            totalRows: parsedRows.length,
            parsedAt: new Date().toISOString(),
          });
          resolve();
        },
        error: (err) => reject(err),
      });
    });
  }, []);

  /**
   * Parse the first sheet of an Excel workbook → array of objects.
   * Note: user can change sheets later via the dropdown; we re-read the chosen sheet.
   */
  const parseExcel = useCallback(async (f) => {
    const ab = await f.arrayBuffer();
    const wb = XLSX.read(ab, { type: "array" });
    const sheets = wb.SheetNames || [];
    setSheetNames(sheets);
    const first = sheets[0] || "";
    setActiveSheet(first);
    if (first) {
      const ws = wb.Sheets[first];
      const json = XLSX.utils.sheet_to_json(ws, { defval: "" }); // defval keeps blanks consistent
      const hdrs = Object.keys(json[0] || {});
      setRows(json);
      setHeaders(hdrs);
      setInfo({
        totalRows: json.length,
        parsedAt: new Date().toISOString(),
      });
    }
  }, []);

  //-------------------------- Drag-and-drop -----------------------------
  const onDrop = useCallback(
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      const fl = e.dataTransfer?.files;
      if (fl?.length) handleFiles(fl);
    },
    [handleFiles]
  );

  const onDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isDragging) setIsDragging(true);
  };
  const onDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  //--------------------------- Data preview -----------------------------

  /** Limit preview to 50 rows for perf and readability. */
  const previewRows = useMemo(() => rows.slice(0, 50), [rows]);

  /** Remember current extension for UI metadata. */
  const ext = useMemo(() => (file ? getExt(file.name) : ""), [file]);

  /**
   * Filter out columns that are entirely empty in the preview slice.
   * This makes the preview table narrower and more useful.
   */
  const filteredHeaders = useMemo(() => {
    const hdrs =
      headers.length > 0 ? headers : Object.keys(previewRows[0] || {});
    return hdrs.filter((h) =>
      previewRows.some((r) => r[h] != null && String(r[h]).trim() !== "")
    );
  }, [headers, previewRows]);

  //----------------------------- Downloads -----------------------------

  /** Download the parsed input rows as JSON (debug / export helper). */
  const downloadJSON = () => {
    const blob = new Blob([JSON.stringify(rows, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.download = (file?.name || "data") + ".json";
    a.href = url;
    a.click();
    URL.revokeObjectURL(url);
  };

  //------------------------- Input normalization -----------------------
  // Convert many sponsor-style input shapes into a normalized form the IPC
  // expects: either a region {chrom,start,end} or a single position {chrom,pos}.
  // This keeps annotation logic in the main process simple and consistent.
  const normalizedRows = useMemo(() => {
    // Parse strings like:
    //  "2L:123..456"
    //  "2L:123-456"
    //  "2L:123"
    const parseJBrowse = (s) => {
      if (!s) return null;
      const str = String(s).trim();

      let m = str.match(/^([^:\s]+)\s*:\s*(\d+)\s*\.\.\s*(\d+)$/); // double-dot range
      if (m) return { chrom: m[1], start: Number(m[2]), end: Number(m[3]) };

      m = str.match(/^([^:\s]+)\s*:\s*(\d+)\s*-\s*(\d+)$/); // hyphen range
      if (m) return { chrom: m[1], start: Number(m[2]), end: Number(m[3]) };

      m = str.match(/^([^:\s]+)\s*:\s*(\d+)$/); // single position
      if (m) return { chrom: m[1], pos: Number(m[2]) };

      return null;
    };

    // Parse "SNP Location" variants like "2L _ 9613765" / "2L_9613765" / "2L 9613765"
    const parseSnpLocation = (s) => {
      if (!s) return null;
      // Accept "2L _ 9613765", "2L_9613765", "2L 9613765"
      const m = String(s)
        .trim()
        .match(/^(\S+)\s*[_\s]\s*(\d+)$/);
      return m ? { chrom: m[1], pos: Number(m[2]) } : null;
    };

    return rows.map((r) => {
      // 1) Best: JBrowse field, if present
      const jb =
        r["Enter This into Jbrowse (via FlyBase)"] ||
        r["JBrowse"] ||
        r["Genome Window"];
      let parsed = parseJBrowse(jb);
      if (parsed) return parsed;

      // 2) Computed bounds (-1000 / 1000) override if both present
      const left = r["-1000"];
      const right = r["1000"];
      const arm =
        r["Chromosome Arm"] ||
        r["Chromosome"] ||
        r["Chr"] ||
        r["chrom"] ||
        r["chr"];

      if (
        arm &&
        Number.isFinite(Number(left)) &&
        Number.isFinite(Number(right))
      ) {
        return {
          chrom: String(arm).trim(),
          start: Number(left),
          end: Number(right),
        };
      }

      // 3) SNP Location fallback like "2L _ 9613765"
      const snpLoc = parseSnpLocation(r["SNP Location"] || r["SNP"]);
      if (snpLoc) return snpLoc;

      // 4) Last resort: individual columns (handles varied casing).
      const chrom = arm || r.chrom || r.chr || r.chromosome;
      const pos = r.Position ?? r.pos ?? r.POS ?? r.start ?? r.Start;
      const end = r.end ?? r.End;

      const out = {
        chrom: chrom ? String(chrom).trim() : undefined,
        // If only a single coordinate is present, treat as 'pos'.
        pos: pos != null && end == null ? Number(pos) : undefined,
        // If both are present, interpret as a range.
        start:
          pos != null && end != null
            ? Number(pos)
            : r.start != null
            ? Number(r.start)
            : undefined,
        end: end != null ? Number(end) : undefined,
      };

      // Clean impossible ranges such as start > end by swapping.
      if (out.start != null && out.end != null && out.end < out.start) {
        const t = out.start;
        out.start = out.end;
        out.end = t;
      }
      return out;
    });
  }, [rows]);

  //------------------------ IPC Gene annotation ----------------------------

  /**
   * Kick off annotation in main process:
   *   - main will expand single positions to [pos-radius, pos+radius]
   *   - main tries FlyMine OVERLAPS first, then Ensembl→FBgn→FlyBase fallback
   *   - returns per-row {region, genes}|{error}
   */
  const runAnnotation = async () => {
    setAnnotError("");
    setAnnotations([]);
    if (!rows.length) {
      setAnnotError("No rows to annotate.");
      return;
    }
    setAnnotating(true);
    try {
      const payload = {
        assembly,
        radius: Number(radius),
        rows: normalizedRows,
      };
      const res = await window.api?.annotateFlyGenes?.(payload);
      if (!res?.ok) {
        setAnnotError("Annotation failed.");
      } else {
        setAnnotations(res.items || []);
      }
    } catch (e) {
      setAnnotError(String(e?.message || e));
    } finally {
      setAnnotating(false);
    }
  };

  //----------------------- IPC: save / history ------------------------

  /** Persist the current annotation run into SQLite via main. */
  async function saveRun() {
    if (!annotations.length) return;
    try {
      const payload = {
        assembly,
        radius: Number(radius),
        sourceFile: file?.name || null,
        sourceHash: null, // TODO: optional content hash for dedupe/integrity
        items: annotations, // same shape as annotate returns
      };
      const res = await window.api?.saveAnnotationRun?.(payload);
      if (res?.ok) setLastSavedJobId(res.jobId);
    } catch (e) {
      setAnnotError(`Save failed: ${e?.message || e}`);
    }
  }

  /** Refresh the list of recent saved runs. */
  async function refreshHistory() {
    try {
      const res = await window.api?.listAnnotationRuns?.({ limit: 20 });
      if (res?.ok) setHistory(res.items || []);
    } catch (e) {
      setAnnotError(`History failed: ${e?.message || e}`);
    }
  }

  /** Load a specific saved run and populate UI state. */
  async function loadRun(jobId) {
    try {
      const res = await window.api?.loadAnnotationRun?.({ jobId });
      if (res?.ok) {
        setAnnotations(res.data.items || []);
        setAssembly(res.data.job.assembly);
        setRadius(res.data.job.radius);
        setLastSavedJobId(jobId);
      } else {
        setAnnotError(res?.error || "Load failed");
      }
    } catch (e) {
      setAnnotError(`Load failed: ${e?.message || e}`);
    }
  }

  //------------------------------- JSX --------------------------------

  return (
    <div style={containerStyles}>
      {/* ===========================
        HEADER SECTION
        Title + small badge showing accepted file types
    ============================ */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 12,
        }}
      >
        <h1 style={{ fontSize: 22, margin: 0 }}>Main Page: File Intake</h1>
        <span style={badge}>CSV & Excel</span>
      </div>

      {/* Intro paragraph explaining what this page does */}
      <p style={{ margin: "6px 0 18px", opacity: 0.9, lineHeight: 1.5 }}>
        Drop a file here, or click <strong>Choose File</strong>. We’ll parse CSV
        with headers and Excel (first sheet by default), show a preview, then
        annotate regions and export summaries.
      </p>

      {/* ===========================
        DROPZONE AREA
        Handles drag-and-drop or manual file selection
    ============================ */}
      <div
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        style={{
          ...dropZoneBase,
          borderColor: isDragging ? "#5b8cff" : dropZoneBase.borderColor,
        }}
      >
        {/* Hidden file input; triggered programmatically when user clicks the button */}
        <input
          ref={inputRef}
          type="file"
          accept={allowedExts.join(",")}
          onChange={(e) => handleFiles(e.target.files)}
          style={{ display: "none" }}
        />

        {/* Dropzone inner text and button */}
        <div style={{ fontSize: 14, opacity: 0.9 }}>
          <div style={{ fontSize: 15, marginBottom: 6 }}>
            <strong>Drag & drop</strong> a file here
          </div>
          or
          <div style={{ marginTop: 8 }}>
            <button
              type="button"
              onClick={onPickClick}
              style={{
                padding: "8px 14px",
                borderRadius: 10,
                background: "#2a2a2a",
                border: "1px solid #3a3a3a",
                color: "#eaeaea",
                cursor: "pointer",
              }}
            >
              Choose File
            </button>
          </div>
          <div style={{ marginTop: 10, fontSize: 12, opacity: 0.7 }}>
            Allowed: {allowedExts.join(", ")}
          </div>
        </div>
      </div>

      {/* ===========================
        FILE PARSING ERRORS
        Displays any errors from unsupported type or parsing failure
    ============================ */}
      {error && (
        <div
          style={{
            marginTop: 16,
            padding: "10px 12px",
            borderRadius: 10,
            background: "#2a1111",
            border: "1px solid #5a2020",
            color: "#f4bbbb",
          }}
        >
          {String(error)}
        </div>
      )}

      {/* ===========================
        FILE METADATA SUMMARY
        Displays name, type, extension, parse time, and row count
    ============================ */}
      {file && (
        <div style={{ marginTop: 16, fontSize: 14 }}>
          <div style={{ ...metaItem }}>
            <strong>File:</strong> {file.name}
          </div>
          <div style={{ ...metaItem }}>
            <strong>Type:</strong> {file.type || "(unknown)"}
          </div>
          <div style={{ ...metaItem }}>
            <strong>Ext:</strong> {ext}
          </div>
          {info.parsedAt && (
            <div style={{ ...metaItem }}>
              <strong>Parsed:</strong>{" "}
              {new Date(info.parsedAt).toLocaleString()}
            </div>
          )}
          {info.totalRows ? (
            <div style={{ ...metaItem }}>
              <strong>Rows:</strong> {info.totalRows.toLocaleString()}
            </div>
          ) : null}
        </div>
      )}

      {/* ===========================
        SHEET PICKER (Excel only)
        Appears only when workbook has multiple sheets
    ============================ */}
      {sheetNames.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <label
            htmlFor="sheetSel"
            style={{ fontSize: 13, opacity: 0.85, marginRight: 8 }}
          >
            Sheet:
          </label>
          <select
            id="sheetSel"
            value={activeSheet}
            onChange={(e) => {
              const name = e.target.value;
              setActiveSheet(name);
              // On sheet change, re-parse that sheet immediately
              if (file) {
                file.arrayBuffer().then((ab) => {
                  const wb = XLSX.read(ab, { type: "array" });
                  const ws = wb.Sheets[name];
                  const json = XLSX.utils.sheet_to_json(ws, { defval: "" });
                  const hdrs = Object.keys(json[0] || {});
                  setRows(json);
                  setHeaders(hdrs);
                  setInfo({
                    totalRows: json.length,
                    parsedAt: new Date().toISOString(),
                  });
                });
              }
            }}
            style={{
              padding: "6px 10px",
              background: "#171717",
              color: "#ddd",
              borderRadius: 8,
              border: "1px solid #2e2e2e",
            }}
          >
            {sheetNames.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* ===========================
        ACTION BAR
        Appears once rows are parsed; allows JSON export for debugging
    ============================ */}
      {rows.length > 0 && (
        <div
          style={{
            marginTop: 14,
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          {/* Export parsed data as JSON (debug tool) */}
          <button
            type="button"
            onClick={downloadJSON}
            style={{
              padding: "8px 14px",
              borderRadius: 10,
              background: "#223341",
              border: "1px solid #2e4a5f",
              color: "#d9edf7",
              cursor: "pointer",
            }}
            title="Download parsed data as JSON"
          >
            Export JSON
          </button>

          <span style={{ fontSize: 12, opacity: 0.7 }}>
            Tip: You can now annotate rows and save runs locally.
          </span>
        </div>
      )}

      {/* ===========================
        PREVIEW TABLE
        Displays first 50 rows of parsed file for confirmation
    ============================ */}
      {rows.length > 0 && (
        <>
          <h2 style={{ marginTop: 22, fontSize: 18, marginBottom: 10 }}>
            Preview (first {previewRows.length} rows)
          </h2>
          <div style={tableWrap}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  {filteredHeaders.map((h) => (
                    <th key={h} style={thtd}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {previewRows.map((r, i) => (
                  <tr key={i}>
                    {filteredHeaders.map((h) => (
                      <td key={h} style={thtd}>
                        {String(r[h] ?? "")}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 10, fontSize: 12, opacity: 0.7 }}>
            Showing up to 50 rows. Total parsed:{" "}
            {info.totalRows.toLocaleString()}.
          </div>
        </>
      )}

      {/* ===========================
        ANNOTATION CONTROLS
        Appears when rows are available. User sets radius and triggers IPC annotation.
    ============================ */}
      {rows.length > 0 && (
        <div
          style={{
            marginTop: 18,
            display: "flex",
            gap: 12,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          {/* Assembly dropdown — currently fixed to dm6 */}
          <label style={{ fontSize: 13, opacity: 0.9 }}>
            Assembly:&nbsp;
            <select
              value={assembly}
              onChange={(e) => setAssembly(e.target.value)}
              style={{
                padding: "6px 8px",
                background: "#171717",
                color: "#ddd",
                borderRadius: 8,
                border: "1px solid #2e2e2e",
              }}
            >
              <option value="dm6">dm6 (D. melanogaster)</option>
            </select>
          </label>

          {/* Radius input — defines search window for single positions */}
          <label style={{ fontSize: 13, opacity: 0.9 }}>
            Radius (bp):&nbsp;
            <input
              type="number"
              value={radius}
              onChange={(e) => setRadius(e.target.value)}
              min={0}
              step={100}
              style={{
                width: 120,
                padding: "6px 8px",
                background: "#171717",
                color: "#ddd",
                borderRadius: 8,
                border: "1px solid #2e2e2e",
              }}
            />
          </label>

          {/* Trigger annotation run via IPC */}
          <button
            type="button"
            disabled={annotating}
            onClick={runAnnotation}
            style={{
              padding: "8px 14px",
              borderRadius: 10,
              background: annotating ? "#2a2a2a" : "#294a32",
              border: "1px solid #335a3e",
              color: "#d3f0d8",
              cursor: annotating ? "default" : "pointer",
            }}
          >
            {annotating ? "Annotating…" : "Annotate Nearby Genes"}
          </button>
        </div>
      )}

      {/* ===========================
        SAVE / HISTORY CONTROLS
        Appears once annotations exist
    ============================ */}
      {annotations.length > 0 && (
        <div
          style={{
            marginTop: 12,
            display: "flex",
            gap: 10,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          {/* Save current run into SQLite */}
          <button
            type="button"
            onClick={saveRun}
            style={{
              padding: "8px 14px",
              borderRadius: 10,
              background: "#2c3a2f",
              border: "1px solid #3f5a49",
              color: "#d9f0e0",
              cursor: "pointer",
            }}
            title="Save this annotation run to local SQLite"
          >
            Save Run
          </button>

          {/* Fetch list of previous runs */}
          <button
            type="button"
            onClick={refreshHistory}
            style={{
              padding: "8px 14px",
              borderRadius: 10,
              background: "#243246",
              border: "1px solid #384c66",
              color: "#d6e6f7",
              cursor: "pointer",
            }}
            title="Show recent saved runs"
          >
            History
          </button>

          {/* Small indicator of last saved job */}
          {lastSavedJobId && (
            <span style={{ fontSize: 12, opacity: 0.75 }}>
              Saved job #{lastSavedJobId}
            </span>
          )}
        </div>
      )}

      {/* ===========================
        ANNOTATION ERROR BOX
        Appears if any IPC or processing errors occur
    ============================ */}
      {annotError && (
        <div
          style={{
            marginTop: 12,
            padding: "10px 12px",
            borderRadius: 10,
            background: "#2a1111",
            border: "1px solid #5a2020",
            color: "#f4bbbb",
          }}
        >
          {annotError}
        </div>
      )}

      {/* ===========================
        ANNOTATION RESULTS
        Shows each input region, genes found, and per-region export button
    ============================ */}
      {annotations.length > 0 && (
        <>
          <h2 style={{ marginTop: 22, fontSize: 18, marginBottom: 10 }}>
            Nearby Gene Annotations
          </h2>
          <div style={{ display: "grid", gap: 12 }}>
            {annotations.map((item, idx) => (
              <div
                key={idx}
                style={{
                  padding: 12,
                  border: "1px solid #2a2a2a",
                  borderRadius: 12,
                  background: "#141414",
                }}
              >
                {/* Show which region this result refers to */}
                <div style={{ fontSize: 13, opacity: 0.9, marginBottom: 6 }}>
                  <strong>Input:</strong>{" "}
                  {item.region
                    ? `${item.region.chrom}:${item.region.start}-${item.region.end} (${item.region.assembly})`
                    : "(invalid coordinates)"}
                </div>

                {/* Either an error message or a small gene table */}
                {item.error ? (
                  <div style={{ color: "#f6bfbf" }}>{item.error}</div>
                ) : item.genes?.length ? (
                  <table
                    style={{
                      width: "100%",
                      borderCollapse: "collapse",
                      fontSize: 13,
                    }}
                  >
                    <thead>
                      <tr>
                        <th style={thtd}>Gene ID</th>
                        <th style={thtd}>Symbol</th>
                        <th style={thtd}>Region</th>
                        <th style={thtd}>Strand</th>
                        <th style={thtd}>Human Orthologs</th>
                        <th style={thtd}>Source</th>
                      </tr>
                    </thead>
                    <tbody>
                      {item.genes.map((g) => (
                        <tr key={g.gene_id}>
                          <td style={thtd}>{g.gene_id}</td>
                          <td style={thtd}>{g.symbol}</td>
                          <td
                            style={thtd}
                          >{`${g.chrom}:${g.start}-${g.end}`}</td>
                          <td style={thtd}>{g.strand}</td>
                          <td style={thtd}>
                            {(g.human_orthologs || []).join(", ") || "—"}
                          </td>
                          <td style={thtd}>{g.source}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div style={{ opacity: 0.8 }}>No genes found in window.</div>
                )}

                {/* Per-region export button */}
                {item.region && (
                  <div style={{ marginTop: 8 }}>
                    <button
                      type="button"
                      onClick={async () => {
                        const r = item.region;
                        const res = await window.api?.exportEnsemblFlyBaseCSV?.(
                          {
                            chrom: r.chrom,
                            start: r.start,
                            end: r.end,
                            assembly: r.assembly || "dm6",
                          }
                        );
                        if (res?.ok) {
                          alert(`Saved ${res.count} rows to:\n${res.savePath}`);
                        } else if (res?.error !== "User canceled") {
                          alert(
                            `Export failed: ${res?.error || "unknown error"}`
                          );
                        }
                      }}
                      style={{
                        padding: "6px 12px",
                        borderRadius: 8,
                        border: "1px solid #2e4a5f",
                        background: "#233444",
                        color: "#d8ecff",
                        cursor: "pointer",
                      }}
                      title="Export a CSV with FlyBase summaries for this region using Ensembl overlap → FlyBase"
                    >
                      Export via Ensembl→FlyBase
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {/* ===========================
        HISTORY LIST
        Appears when user has fetched saved runs from SQLite
    ============================ */}
      {history.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <h3 style={{ fontSize: 16, marginBottom: 8 }}>Recent Runs</h3>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {history.map((h) => (
              <li key={h.id} style={{ marginBottom: 6 }}>
                <button
                  type="button"
                  onClick={() => loadRun(h.id)}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    padding: "8px 12px",
                    borderRadius: 10,
                    background: "#171b22",
                    border: "1px solid #2a3342",
                    color: "#dbe7ff",
                    cursor: "pointer",
                  }}
                  title="Load this saved run"
                >
                  #{h.id} • {h.created_at} • {h.assembly} • radius {h.radius} •{" "}
                  {h.source_file || "no file"}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
