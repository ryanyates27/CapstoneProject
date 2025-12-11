//---------------------------------------------------------------------
// File: src/components/MainPage.jsx
// Purpose: Fly Faster UI
//  - Two modes: Manual Search + File Upload
//  - Each builds a list of regions with:
//      • SNP Location
//      • Base Pair (Range)  => total window size (e.g. 1000 -> ±500)
//      • JBrowse Entry      => auto-generated "chr:start..end"
//  - Sends normalized regions to main via window.api.annotateFlyGenes
//  - Shows Nearby Gene Annotations table + modal (unchanged behavior)
// Owner: Ryan
//---------------------------------------------------------------------

import React, { useCallback, useMemo, useRef, useState } from "react";
import Papa from "papaparse";
import * as XLSX from "xlsx";

// -------------------------- Styling helpers --------------------------

const containerStyles = {
  maxWidth: 1100,
  margin: "32px auto",
  padding: "20px 24px 28px",
  background: "#101010",
  borderRadius: 18,
  boxShadow: "0 16px 40px rgba(0,0,0,0.6)",
  color: "#f3f3f3",
  fontFamily:
    'Inter, system-ui, -apple-system, Segoe UI, Roboto, "Helvetica Neue", Arial, sans-serif',
  border: "1px solid #252525",
};

const sectionTitle = {
  fontSize: 16,
  fontWeight: 600,
  margin: "0 0 10px",
};

const subtleLabel = {
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: 0.6,
  opacity: 0.7,
};

const chip = {
  display: "inline-block",
  padding: "4px 10px",
  borderRadius: 999,
  fontSize: 11,
  border: "1px solid #2d2d2d",
  background: "#0f172a",
  color: "#93c5fd",
};

const tabRow = {
  display: "flex",
  gap: 10,
  marginTop: 18,
  marginBottom: 14,
};

const tabButton = (active) => ({
  flex: 1,
  padding: "8px 0",
  borderRadius: 999,
  border: active ? "1px solid #60a5fa" : "1px solid #303030",
  background: active ? "#111827" : "#050608",
  color: active ? "#e5f0ff" : "#c7c7c7",
  fontSize: 13,
  fontWeight: 500,
  cursor: "pointer",
  boxShadow: active
    ? "0 0 0 1px rgba(37,99,235,0.5)"
    : "0 0 0 1px rgba(0,0,0,0)",
  transition:
    "background 120ms ease, border-color 120ms ease, box-shadow 120ms ease, color 120ms ease",
});

const gridHeaderRow = {
  display: "grid",
  gridTemplateColumns: "1.6fr 1.1fr 1.8fr 40px",
  padding: "8px 12px",
  borderRadius: 10,
  background: "#18181b",
  border: "1px solid #27272f",
  fontSize: 12,
  fontWeight: 600,
};

const gridBodyWrapper = {
  marginTop: 6,
  borderRadius: 12,
  border: "1px solid #202023",
  background: "#09090b",
  maxHeight: 260,
  overflowY: "auto",
};

const gridRow = {
  display: "grid",
  gridTemplateColumns: "1.6fr 1.1fr 1.8fr 40px",
  alignItems: "center",
  padding: "6px 12px",
  borderBottom: "1px solid #18181b",
};

const cellLabel = {
  fontSize: 11,
  opacity: 0.7,
  marginBottom: 3,
};

const cellInput = {
  width: "100%",
  padding: "6px 8px",
  borderRadius: 8,
  border: "1px solid #2f2f34",
  background: "#18181b",
  color: "#f5f5f5",
  fontSize: 13,
};

const cellReadonly = {
  width: "100%",
  minHeight: 32,
  borderRadius: 8,
  border: "1px solid #27272f",
  background: "#050608",
  color: "#e5e7eb",
  fontSize: 13,
  display: "flex",
  alignItems: "center",
  padding: "4px 8px",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const plusButton = {
  marginTop: 10,
  display: "inline-flex",
  justifyContent: "center",
  width: 34,
  height: 34,
  borderRadius: "999px",
  border: "1px solid #15803d",
  background: "#052e16",
  color: "#bbf7d0",
  cursor: "pointer",
  fontSize: 20,
  fontWeight: 600,
};

const trashButton = {
  width: 26,
  height: 26,
  borderRadius: 999,
  border: "1px solid #4b1d1d",
  background: "#1f0b0b",
  color: "#fecaca",
  cursor: "pointer",
  fontSize: 13,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  marginLeft: 2, // nudge a bit from the left edge
};


const dropZoneBase = {
  border: "2px dashed #374151",
  borderRadius: 14,
  padding: 18,
  textAlign: "center",
  background: "#020617",
  cursor: "pointer",
  userSelect: "none",
};

// annotation results table styles (close to your screenshot)
const tableWrap = {
  overflow: "auto",
  border: "1px solid #27272f",
  borderRadius: 16,
};
const tableStyle = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 13,
};
const thtd = {
  borderBottom: "1px solid #27272f",
  padding: "8px 10px",
  whiteSpace: "nowrap",
};
const rowBase = {
  cursor: "pointer",
  transition: "background 120ms ease, border-color 120ms ease",
};

// ------------------------ Parsing helpers ----------------------------

function getExt(name = "") {
  const ix = name.lastIndexOf(".");
  return ix >= 0 ? name.slice(ix).toLowerCase() : "";
}

const allowedExts = [".csv", ".xlsx", ".xlsm", ".xlsb", ".xls"];

/** Parse "2L:9613765", "2L 9613765", "2L_9613765" */
function parseSnpLocation(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const m = s.match(/^(\S+)[\s:_-]+(\d+)$/);
  if (!m) return null;
  return { chrom: m[1], pos: Number(m[2]) };
}

/** Parse "2L:9613000..9616500" or "2L:9613000-9616500" */
function parseJBrowseEntry(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  let m = s.match(/^([^:]+):(\d+)\.\.(\d+)$/);
  if (m) return { chrom: m[1], start: Number(m[2]), end: Number(m[3]) };
  m = s.match(/^([^:]+):(\d+)-(\d+)$/);
  if (m) return { chrom: m[1], start: Number(m[2]), end: Number(m[3]) };
  return null;
}

/**
 * Given SNP + base-pair window size + existing JBrowse value,
 * compute a region and a canonical "chr:start..end" string.
 *
 * - Base Pair (Range) is the TOTAL window (e.g. 1000 → ±500)
 * - If missing / invalid, we fall back to defaultRadius.
 */
function computeRegionFromInputs({ snp, basePairStr, jbrowse, defaultRadius }) {
  const parsedSnp = parseSnpLocation(snp);
  let chrom = parsedSnp?.chrom;
  let pos = parsedSnp?.pos ?? null;

  const windowSize = parseInt(basePairStr, 10);
  let halfWindow = defaultRadius;
  if (Number.isFinite(windowSize) && windowSize > 0) {
    halfWindow = Math.floor(windowSize / 2);
  }

  let start = null;
  let end = null;

  if (chrom && pos != null) {
    start = Math.max(1, pos - halfWindow);
    end = pos + halfWindow;
  } else {
    const parsedJ = parseJBrowseEntry(jbrowse);
    if (parsedJ) {
      chrom = parsedJ.chrom;
      start = parsedJ.start;
      end = parsedJ.end;
    }
  }

  let jbrowseText = jbrowse || "";
  if (chrom && start != null && end != null) {
    jbrowseText = `${chrom}:${start}..${end}`;
  }

  return { chrom, pos, start, end, jbrowseText };
}

// ------------------------------ Component -----------------------------

export default function MainPage() {
  const [activeMode, setActiveMode] = useState("manual"); // "manual" | "file"

  // Manual rows: { id, snp, bp, jbrowse }
  const [manualRows, setManualRows] = useState([
    { id: 1, snp: "", bp: "", jbrowse: "" },
  ]);

  // File rows: same shape as manual rows
  const [fileRows, setFileRows] = useState([]);
  const [file, setFile] = useState(null);
  const [parseError, setParseError] = useState("");

  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef(null);

  // Annotation
  const [annotations, setAnnotations] = useState([]);
  const [annotError, setAnnotError] = useState("");
  const [annotating, setAnnotating] = useState(false);

  // Modal for full gene details
  const [modalOpen, setModalOpen] = useState(false);
  const [modalGene, setModalGene] = useState(null);
  const [modalRegion, setModalRegion] = useState(null);
  const [hoveredRowKey, setHoveredRowKey] = useState(null);

  const defaultRadius = 5000; // used when bp window not provided

  // --------------- Manual rows: update / add / remove -----------------

  const recomputeManualRow = useCallback(
    (row) => {
      const region = computeRegionFromInputs({
        snp: row.snp,
        basePairStr: row.bp,
        jbrowse: row.jbrowse,
        defaultRadius,
      });
      return { ...row, jbrowse: region.jbrowseText };
    },
    [defaultRadius]
  );

  const updateManualRow = (id, field, value) => {
    setManualRows((prev) =>
      prev.map((row) =>
        row.id === id ? recomputeManualRow({ ...row, [field]: value }) : row
      )
    );
  };

  const addManualRow = () => {
    setManualRows((prev) => {
      const nextId = prev.length ? Math.max(...prev.map((r) => r.id)) + 1 : 1;
      return [...prev, { id: nextId, snp: "", bp: "", jbrowse: "" }];
    });
  };

  const removeManualRow = (id) => {
    setManualRows((prev) =>
      prev.length > 1 ? prev.filter((r) => r.id !== id) : prev
    );
  };

  // ------------------------- File parsing -----------------------------

  const handleFileChosen = async (fileList) => {
    const f = fileList?.[0];
    if (!f) return;

    setFile(f);
    setParseError("");
    setFileRows([]);

    const ext = getExt(f.name);
    if (!allowedExts.includes(ext)) {
      setParseError(
        `Unsupported file type: ${ext || "(none)"}. Allowed: ${allowedExts.join(
          ", "
        )}`
      );
      return;
    }

    try {
      if (ext === ".csv") {
        await parseCSV(f);
      } else {
        await parseExcel(f);
      }
    } catch (e) {
      console.error(e);
      setParseError(`Failed to parse file: ${e?.message || e}`);
    }
  };

  const parseCSV = useCallback(
    (f) => {
      return new Promise((resolve, reject) => {
        Papa.parse(f, {
          header: true,
          skipEmptyLines: "greedy",
          worker: true,
          complete: (res) => {
            const data = res.data || [];
            const transformed = data.map((row, idx) =>
              mapRecordToSimpleRow(row, idx, defaultRadius)
            );
            setFileRows(transformed);
            resolve();
          },
          error: (err) => reject(err),
        });
      });
    },
    [defaultRadius]
  );

  const parseExcel = useCallback(
    async (f) => {
      const ab = await f.arrayBuffer();
      const wb = XLSX.read(ab, { type: "array" });
      const firstSheet = wb.SheetNames?.[0];
      if (!firstSheet) {
        setParseError("No sheets found in workbook.");
        return;
      }
      const ws = wb.Sheets[firstSheet];
      const json = XLSX.utils.sheet_to_json(ws, { defval: "" });
      const transformed = json.map((row, idx) =>
        mapRecordToSimpleRow(row, idx, defaultRadius)
      );
      setFileRows(transformed);
    },
    [defaultRadius]
  );

  function mapRecordToSimpleRow(record, idx, defaultRadius) {
    const snp =
      record["SNP Location"] ||
      record["snp_location"] ||
      record["SNP"] ||
      record["snp"] ||
      "";
    const bp =
      record["Base Pair (Range)"] ||
      record["Base Pair Range"] ||
      record["Window"] ||
      record["bp_window"] ||
      "";
    const jbrowseRaw =
      record["JBrowse Entry"] ||
      record["JBrowse"] ||
      record["JBrowse Entry (FlyBase)"] ||
      "";

    const region = computeRegionFromInputs({
      snp,
      basePairStr: String(bp),
      jbrowse: jbrowseRaw,
      defaultRadius,
    });

    return {
      id: idx + 1,
      snp: snp || "",
      bp: bp || "",
      jbrowse: region.jbrowseText || "",
    };
  }

  // ------------------------ File drag & drop --------------------------

  const onDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const fl = e.dataTransfer?.files;
    if (fl?.length) handleFileChosen(fl);
  }, []);

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

  // ------------------------ Build normalized rows ---------------------

  const activeRows = activeMode === "manual" ? manualRows : fileRows;

  const normalizedRows = useMemo(() => {
    return activeRows
      .map((row) => {
        const region = computeRegionFromInputs({
          snp: row.snp,
          basePairStr: row.bp,
          jbrowse: row.jbrowse,
          defaultRadius,
        });

        return {
          snpLocation: row.snp,
          basePairRange: row.bp,
          jbrowseEntry: region.jbrowseText,
          chrom: region.chrom,
          start: region.start,
          end: region.end,
          pos: region.pos,
        };
      })
      .filter((r) => r.chrom && r.start != null && r.end != null);
  }, [activeRows, defaultRadius]);

  // -------------------- Run annotation via IPC ------------------------

  const runAnnotation = async () => {
    setAnnotError("");
    setAnnotations([]);

    if (!normalizedRows.length) {
      setAnnotError(
        activeMode === "manual"
          ? "Please add at least one valid manual row."
          : "No valid rows found from the file."
      );
      return;
    }

    setAnnotating(true);
    try {
      const payload = {
        assembly: "dm6",
        radius: defaultRadius,
        rows: normalizedRows,
      };
      const res = await window.api?.annotateFlyGenes?.(payload);
      if (!res?.ok) {
        setAnnotError(res?.error || "Annotation failed.");
      } else {
        setAnnotations(res.items || []);
      }
    } catch (e) {
      setAnnotError(String(e?.message || e));
    } finally {
      setAnnotating(false);
    }
  };

  // -------------------------- Export all CSV --------------------------

  const exportAllAnnotations = async () => {
    if (!annotations.length) return;
    try {
      const allRows = [];
      for (const item of annotations) {
        if (!item.genes) continue;
        for (const g of item.genes) {
          const snpLoc = item.region?.pos
            ? `${item.region.chrom}:${item.region.pos}`
            : "";
          const genomeWindow =
            item.region?.start && item.region?.end
              ? `${item.region.start}-${item.region.end}`
              : "";
          const flybaseId = /^FBgn/i.test(g.gene_id || "") ? g.gene_id : "";

          allRows.push({
            region_chrom: item.region?.chrom || "",
            region_start: item.region?.start != null ? item.region.start : "",
            region_end: item.region?.end != null ? item.region.end : "",
            snp_location: snpLoc,
            genome_window: genomeWindow,
            gene_name: g.gene_name || "",
            symbol: g.symbol || "",
            annotation_symbol: g.annotation_symbol || "",
            flybase_id: flybaseId,
            gene_summary: g.gene_summary || "",
            automated_description: g.automated_description || "",
            auto_summary: g.auto_summary || "",
            gene_group: g.gene_group || "",
            protein_function: g.protein_function || "",
          });
        }
      }

      const header =
        "region_chrom,region_start,region_end,snp_location,genome_window,gene_name,symbol,annotation_symbol,flybase_id,gene_summary,automated_description,auto_summary,gene_group,protein_function\n";
      const body = allRows
        .map((r) =>
          [
            r.region_chrom,
            r.region_start,
            r.region_end,
            r.snp_location,
            r.genome_window,
            r.gene_name,
            r.symbol,
            r.annotation_symbol,
            r.flybase_id,
            JSON.stringify(r.gene_summary),
            JSON.stringify(r.automated_description),
            JSON.stringify(r.auto_summary),
            JSON.stringify(r.gene_group),
            JSON.stringify(r.protein_function),
          ].join(",")
        )
        .join("\n");

      const blob = new Blob([header + body], {
        type: "text/csv;charset=utf-8;",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "all_annotations.csv";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert("Export failed: " + e.message);
    }
  };

  // --------------------------- Render --------------------------------

  return (
    <div style={containerStyles}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 4,
        }}
      >
        <h1 style={{ fontSize: 22, margin: 0 }}>Nearby Gene Finder</h1>
        <span style={chip}>FlyBase / FlyMine / Ensembl</span>
      </div>
      <p style={{ margin: "6px 0 0", opacity: 0.85, fontSize: 13.5 }}>
        Choose how you want to provide SNP locations and windows, then run
        annotations to see nearby genes.
      </p>

      {/* Mode Tabs */}
      <div style={tabRow}>
        <button
          type="button"
          style={tabButton(activeMode === "manual")}
          onClick={() => setActiveMode("manual")}
        >
          Manual Search
        </button>
        <button
          type="button"
          style={tabButton(activeMode === "file")}
          onClick={() => setActiveMode("file")}
        >
          File Upload
        </button>
      </div>

      {/* ------------------ MANUAL MODE ------------------ */}
      {activeMode === "manual" && (
        <div style={{ marginTop: 4 }}>
          <div style={sectionTitle}>Manual SNP Entries</div>
          <div style={{ fontSize: 12.5, opacity: 0.8, marginBottom: 10 }}>
            Enter a SNP location and a total base-pair range. JBrowse entry will
            be generated as <code>chr:start..end</code>.
          </div>

          <div style={gridHeaderRow}>
            <div>SNP Location</div>
            <div>Base Pair (Range)</div>
            <div>JBrowse Entry</div>
            <div />
          </div>

          <div style={gridBodyWrapper}>
            {manualRows.map((row) => (
              <div key={row.id} style={gridRow}>
                <div style={{ paddingRight: 20 }}>
                  <div style={cellLabel}>e.g. 2L:9614000</div>
                  <input
                    style={cellInput}
                    value={row.snp}
                    onChange={(e) =>
                      updateManualRow(row.id, "snp", e.target.value)
                    }
                    placeholder="Chrom:Position"
                  />
                </div>
                <div style={{ paddingRight: 20 }}>
                  <div style={cellLabel}>Total window in bp</div>
                  <input
                    style={cellInput}
                    type="number"
                    min={0}
                    value={row.bp}
                    onChange={(e) =>
                      updateManualRow(row.id, "bp", e.target.value)
                    }
                    placeholder="e.g. 1000"
                  />
                </div>
                <div style={{ paddingRight: 8 }}>
                  <div style={cellLabel}>Auto-generated</div>
                  <div style={cellReadonly}>
                    {row.jbrowse || <span style={{ opacity: 0.5 }}>—</span>}
                  </div>
                </div>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "flex-end", // push to the right
                    alignItems: "flex-end", // push down
                    paddingRight: 0,
                    paddingBottom: 0,
                    paddingTop: 18,
                  }}
                >
                  <button
                    type="button"
                    style={trashButton}
                    onClick={() => removeManualRow(row.id)}
                    title="Remove row"
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>

          <button type="button" style={plusButton} onClick={addManualRow}>
            +
          </button>
        </div>
      )}

      {/* ------------------ FILE MODE ------------------ */}
      {activeMode === "file" && (
        <div style={{ marginTop: 4 }}>
          <div style={sectionTitle}>File Upload</div>
          <p style={{ fontSize: 12.5, opacity: 0.8, marginBottom: 10 }}>
            Upload a CSV or Excel file containing columns{" "}
            <strong>SNP Location</strong>, <strong>Base Pair (Range)</strong>,
            and optionally <strong>JBrowse Entry</strong>. We’ll auto-generate
            JBrowse if needed.
          </p>

          <div
            style={{
              ...dropZoneBase,
              borderColor: isDragging ? "#60a5fa" : dropZoneBase.border,
            }}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onClick={() => fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept={allowedExts.join(",")}
              style={{ display: "none" }}
              onChange={(e) => handleFileChosen(e.target.files)}
            />
            <div style={{ fontSize: 14, opacity: 0.9 }}>
              Drag & drop a file here or{" "}
              <span style={{ color: "#93c5fd" }}>click to choose</span>
              <div style={{ marginTop: 6, fontSize: 12, opacity: 0.75 }}>
                Allowed: {allowedExts.join(", ")}
              </div>
            </div>
            {file && (
              <div style={{ marginTop: 8, fontSize: 12, opacity: 0.8 }}>
                Current file: <strong>{file.name}</strong> (
                {fileRows.length.toLocaleString()} rows)
              </div>
            )}
          </div>

          {parseError && (
            <div
              style={{
                marginTop: 10,
                padding: "8px 10px",
                borderRadius: 10,
                background: "#2b1111",
                border: "1px solid #7f1d1d",
                fontSize: 12.5,
              }}
            >
              {parseError}
            </div>
          )}

          {fileRows.length > 0 && (
            <>
              <div
                style={{
                  ...subtleLabel,
                  marginTop: 16,
                  marginBottom: 6,
                  textTransform: "none",
                }}
              >
                Preview (scrollable, shows all rows)
              </div>

              <div style={gridHeaderRow}>
                <div>SNP Location</div>
                <div>Base Pair (Range)</div>
                <div>JBrowse Entry</div>
                <div />
              </div>

              <div style={gridBodyWrapper}>
                {fileRows.map((row) => (
                  <div key={row.id} style={gridRow}>
                    <div style={{ paddingRight: 8 }}>
                      <div style={cellLabel}>SNP Location</div>
                      <div style={cellReadonly}>
                        {row.snp || <span style={{ opacity: 0.5 }}>—</span>}
                      </div>
                    </div>
                    <div style={{ paddingRight: 8 }}>
                      <div style={cellLabel}>Base Pair (Range)</div>
                      <div style={cellReadonly}>
                        {row.bp || <span style={{ opacity: 0.5 }}>—</span>}
                      </div>
                    </div>
                    <div style={{ paddingRight: 8 }}>
                      <div style={cellLabel}>JBrowse Entry</div>
                      <div style={cellReadonly}>
                        {row.jbrowse || <span style={{ opacity: 0.5 }}>—</span>}
                      </div>
                    </div>
                    <div />
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* --------------- Shared: annotate button + errors --------------- */}
      <div
        style={{
          marginTop: 18,
          display: "flex",
          gap: 12,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <button
          type="button"
          disabled={annotating}
          onClick={runAnnotation}
          style={{
            padding: "9px 18px",
            borderRadius: 999,
            background: annotating ? "#374151" : "#166534",
            border: "1px solid #15803d",
            color: "#e5f9ed",
            cursor: annotating ? "default" : "pointer",
            fontSize: 13.5,
            fontWeight: 500,
          }}
        >
          {annotating ? "Annotating…" : "Annotate Nearby Genes"}
        </button>

        <span style={{ fontSize: 12, opacity: 0.7 }}>
          Current mode:{" "}
          <strong>{activeMode === "manual" ? "Manual" : "File"}</strong>
        </span>
      </div>

      {annotError && (
        <div
          style={{
            marginTop: 10,
            padding: "8px 10px",
            borderRadius: 10,
            background: "#2b1111",
            border: "1px solid #7f1d1d",
            fontSize: 12.5,
          }}
        >
          {annotError}
        </div>
      )}

      {/* ================== ANNOTATION RESULTS ================== */}
      {annotations.length > 0 && (
        <>
          <h2 style={{ marginTop: 24, fontSize: 17, marginBottom: 8 }}>
            Nearby Gene Annotations
          </h2>

          <div
            style={{
              marginBottom: 12,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <button
              type="button"
              onClick={exportAllAnnotations}
              style={{
                padding: "8px 14px",
                borderRadius: 999,
                background: "#1f2937",
                border: "1px solid #4b5563",
                color: "#e5e7eb",
                cursor: "pointer",
                fontSize: 13,
              }}
            >
              Export All Annotations
            </button>

            <span style={{ fontSize: 12, opacity: 0.7 }}>
              Hover and click any row to open the detailed view.
            </span>
          </div>

          <div style={tableWrap}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thtd}>SNP Location</th>
                  <th style={thtd}>Genome Window</th>
                  <th style={thtd}>Gene Name</th>
                  <th style={thtd}>Symbol</th>
                  <th style={thtd}>Annotation Symbol</th>
                  <th style={thtd}>FlyBase ID</th>
                </tr>
              </thead>
              <tbody>
                {annotations.flatMap((item, regionIndex) =>
                  (item.genes || []).map((g, gi) => {
                    const rowKey = `${regionIndex}-${gi}`;
                    const isHovered = hoveredRowKey === rowKey;

                    const snpLoc = item.region?.pos
                      ? `${item.region.chrom}:${item.region.pos}`
                      : "—";
                    const genomeWindow =
                      item.region?.start && item.region?.end
                        ? `${item.region.start}-${item.region.end}`
                        : "—";

                    const displayGeneName =
                      g.gene_name || g.symbol || g.gene_id || "—";
                    const annotationSymbol = g.annotation_symbol || "—";
                    const flybaseId = /^FBgn/i.test(g.gene_id || "")
                      ? g.gene_id
                      : "—";

                    const onRowClick = () => {
                      setModalRegion(item.region);
                      setModalGene(g);
                      setModalOpen(true);
                    };

                    return (
                      <tr
                        key={rowKey}
                        onClick={onRowClick}
                        onMouseEnter={() => setHoveredRowKey(rowKey)}
                        onMouseLeave={() => setHoveredRowKey(null)}
                        style={{
                          ...rowBase,
                          borderLeft: isHovered
                            ? "2px solid #d4af37"
                            : "2px solid transparent",
                          borderRight: isHovered
                            ? "2px solid #d4af37"
                            : "2px solid transparent",
                          background: isHovered ? "#18130a" : "transparent",
                        }}
                      >
                        <td style={thtd}>{snpLoc}</td>
                        <td style={thtd}>{genomeWindow}</td>
                        <td style={thtd}>{displayGeneName}</td>
                        <td style={thtd}>{g.symbol || "—"}</td>
                        <td style={thtd}>{annotationSymbol}</td>
                        <td style={thtd}>{flybaseId}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* ================== MODAL ================== */}
          {modalOpen && modalGene && (
            <div
              style={{
                position: "fixed",
                inset: 0,
                background: "rgba(0,0,0,0.65)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                zIndex: 10000,
              }}
            >
              <div
                style={{
                  background: "#111",
                  width: "90%",
                  maxWidth: 1100,
                  height: "85vh",
                  borderRadius: 12,
                  display: "flex",
                  flexDirection: "column",
                  overflow: "hidden",
                  border: "1px solid #333",
                }}
              >
                {/* Header bar */}
                <div
                  style={{
                    padding: "12px 16px",
                    borderBottom: "1px solid #333",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    background: "#181818",
                  }}
                >
                  <div style={{ fontSize: 18, fontWeight: 600, color: "#eee" }}>
                    {modalGene.gene_name ||
                      modalGene.symbol ||
                      modalGene.gene_id ||
                      "Gene Details"}
                  </div>

                  <div style={{ display: "flex", gap: 10 }}>
                    {/* Export single gene */}
                    <button
                      onClick={() => {
                        const snpLoc = modalRegion?.pos
                          ? `${modalRegion.chrom}:${modalRegion.pos}`
                          : "";
                        const genomeWindow =
                          modalRegion?.start && modalRegion?.end
                            ? `${modalRegion.start}-${modalRegion.end}`
                            : "";
                        const flybaseId = /^FBgn/i.test(
                          modalGene?.gene_id || ""
                        )
                          ? modalGene.gene_id
                          : "";

                        const fields = {
                          snp_location: snpLoc,
                          genome_window: genomeWindow,
                          gene_name: modalGene.gene_name || "",
                          symbol: modalGene.symbol || "",
                          annotation_symbol: modalGene.annotation_symbol || "",
                          flybase_id: flybaseId,
                          gene_summary: modalGene.gene_summary || "",
                          automated_description:
                            modalGene.automated_description || "",
                          auto_summary: modalGene.auto_summary || "",
                          gene_group: modalGene.gene_group || "",
                          protein_function: modalGene.protein_function || "",
                        };

                        const header =
                          "snp_location,genome_window,gene_name,symbol,annotation_symbol,flybase_id,gene_summary,automated_description,auto_summary,gene_group,protein_function\n";

                        const row = [
                          fields.snp_location,
                          fields.genome_window,
                          fields.gene_name,
                          fields.symbol,
                          fields.annotation_symbol,
                          fields.flybase_id,
                          JSON.stringify(fields.gene_summary),
                          JSON.stringify(fields.automated_description),
                          JSON.stringify(fields.auto_summary),
                          JSON.stringify(fields.gene_group),
                          JSON.stringify(fields.protein_function),
                        ].join(",");

                        const blob = new Blob([header + row], {
                          type: "text/csv;charset=utf-8;",
                        });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = `${
                          modalGene.symbol || "gene"
                        }_annotation.csv`;
                        a.click();
                        URL.revokeObjectURL(url);
                      }}
                      style={{
                        padding: "6px 10px",
                        borderRadius: 8,
                        border: "1px solid #444",
                        background: "#1f3550",
                        color: "#cfe3ff",
                        cursor: "pointer",
                        fontSize: 12,
                      }}
                    >
                      Export
                    </button>

                    {/* Close */}
                    <button
                      onClick={() => setModalOpen(false)}
                      style={{
                        padding: "6px 10px",
                        borderRadius: 8,
                        background: "#333",
                        color: "#eee",
                        border: "1px solid #444",
                        cursor: "pointer",
                        fontSize: 12,
                      }}
                    >
                      Close
                    </button>
                  </div>
                </div>

                {/* Content */}
                <div
                  style={{
                    padding: "24px 0",
                    overflowY: "auto",
                    display: "flex",
                    justifyContent: "center",
                  }}
                >
                  <div
                    style={{
                      width: "100%",
                      maxWidth: 900,
                      padding: "0 24px 24px",
                    }}
                  >
                    <h2
                      style={{
                        textAlign: "center",
                        margin: "0 0 24px",
                        fontSize: 20,
                        color: "#eee",
                      }}
                    >
                      Nearby Gene Annotations
                    </h2>

                    {/* Top small boxes */}
                    <div style={{ maxWidth: 450, margin: "0 auto 28px" }}>
                      {[
                        [
                          "Genome Window",
                          modalRegion?.start && modalRegion?.end
                            ? `${modalRegion.start}-${modalRegion.end}`
                            : "—",
                        ],
                        [
                          "Gene Name",
                          modalGene.gene_name ||
                            modalGene.symbol ||
                            modalGene.gene_id ||
                            "—",
                        ],
                        ["Symbol", modalGene.symbol || "—"],
                        [
                          "FlyBase ID",
                          /^FBgn/i.test(modalGene?.gene_id || "")
                            ? modalGene.gene_id
                            : "—",
                        ],
                        [
                          "Annotation Symbol",
                          modalGene.annotation_symbol || "—",
                        ],
                        [
                          "Human Orthologs (DIOPT)",
                          modalGene?.human_orthologs?.length
                            ? modalGene.human_orthologs.join(", ")
                            : "—",
                        ],
                      ].map(([label, value]) => (
                        <div key={label} style={{ marginBottom: 14 }}>
                          <div
                            style={{
                              background: "#181818",
                              borderRadius: 4,
                              padding: "6px 10px",
                              fontSize: 13,
                              fontWeight: 600,
                              border: "1px solid #333",
                            }}
                          >
                            {label}
                          </div>
                          <div
                            style={{
                              fontSize: 14,
                              marginTop: 4,
                              paddingLeft: 2,
                            }}
                          >
                            {value}
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Long text boxes */}
                    {[
                      [
                        "Gene Summary",
                        modalGene.curated_summary ||
                          modalGene.gene_summary ||
                          modalGene.auto_summary ||
                          modalGene.protein_function ||
                          "",
                        "FlyBase / UniProtKB",
                      ],
                      [
                        "Automated Description",
                        modalGene.automated_description || "",
                        "Alliance of Genome Resources",
                      ],
                      [
                        "Automatically Generated Summary",
                        modalGene.auto_summary || modalGene.gene_summary || "",
                        "FlyBase",
                      ],
                      ["Gene Group", modalGene.gene_group || "", "FlyBase"],
                      [
                        "Protein Function",
                        modalGene.protein_function || "",
                        "UniProtKB",
                      ],
                    ].map(([title, text, source]) => (
                      <div
                        key={title}
                        style={{
                          background: "#0d0d0d",
                          border: "1px solid #333",
                          borderRadius: 8,
                          marginBottom: 24,
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            padding: "6px 10px",
                            borderBottom: "1px solid #333",
                            background: "#181818",
                            fontSize: 13,
                          }}
                        >
                          <span>{title}</span>
                          {source && (
                            <span style={{ opacity: 0.8 }}>From: {source}</span>
                          )}
                        </div>
                        <div
                          style={{
                            padding: "10px 12px",
                            minHeight: 80,
                            fontSize: 14,
                            lineHeight: 1.45,
                            color: "#ddd",
                            whiteSpace: "pre-wrap",
                          }}
                        >
                          {text || "—"}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
