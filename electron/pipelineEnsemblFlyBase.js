//----------------------------------------------------------------------
// File: electron/pipelineEnsemblFlyBase.js
// Purpose: Ensembl→FlyBase pipeline helpers used for CSV export and
//          the fallback annotation path.
// Steps:
//   1) Query Ensembl REST for genes overlapping a region (dm6).
//   2) For each Ensembl gene ID, resolve a FlyBase FBgn via Ensembl xrefs.
//   3) For each FBgn, fetch FlyBase "auto summaries" (public API).
//   4) Optionally enrich with human orthologs (via DIOPT).
//   5) Optionally fetch UniProt protein function via EBI Proteins API.
//   6) Format sponsor-style rows and write a CSV (with BOM for Excel).
// Notes:
//   • Keep this file UI-free; it should be pure data/FS logic.
//   • Outbound HTTP is rate-limited to be polite to public APIs.
//   • CSV is written as UTF-8 with BOM so Excel opens it cleanly.
// Owner: Ryan | Last touched: 2025-12-09
//----------------------------------------------------------------------

import axios from "axios";
import fs from "fs";
import pThrottle from "p-throttle";
import path from "path"; // kept in case we use it later

/** Rate-limit outbound HTTP calls: max 5 per second. */ // CHANGED
const throttle = pThrottle({ limit: 5, interval: 1000 }); // CHANGED

// Thin GET wrapper with throttling for JSON APIs (Ensembl, FlyBase auto, DIOPT, UniProt)
const httpGet = throttle(async (url, params = {}, headers = {}) => {
  const res = await axios.get(url, {
    params,
    timeout: 20000, // 20s network timeout
    headers: {
      Accept: "application/json",
      ...headers, // callers can override if needed
    },
  });
  // For JSON APIs, axios parses and returns JS objects here.
  return res.data;
});

/**
 * Convert an array of uniform objects to CSV.
 * - Quotes fields
 * - Escapes internal quotes
 * - Uses first row's keys as header order
 * @param {Array<Record<string, any>>} data
 * @returns {string} CSV text (no BOM)
 */
function arrayToCSV(data) {
  if (!data || !data.length) return "";
  const headers = Object.keys(data[0]);
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = data.map((row) => headers.map((h) => esc(row[h])).join(","));
  return [headers.join(","), ...rows].join("\n");
}

/**
 * Truncate a long text field for compact CSV cells.
 * @param {string} text
 * @param {number} [length=120]
 * @returns {string}
 */
function truncate(text, length = 120) {
  if (!text) return "";
  return text.length > length ? text.slice(0, length) + "…" : text;
}

/**
 * Step 1: Fetch genes overlapping a region from Ensembl (dm6).
 * @param {{chrom:string, start:number, end:number}} region
 * @returns {Promise<Array<{
 *   ensembl_id:string,
 *   symbol:string,
 *   chrom:string,
 *   start:number|null,
 *   end:number|null,
 *   strand:"+"|"-"|""
 * }>>}
 */
export async function ensemblOverlapGenes({ chrom, start, end }) {
  const species = "drosophila_melanogaster";
  const region = `${chrom}:${start}-${end}`;
  const url = `https://rest.ensembl.org/overlap/region/${species}/${region}`;
  const data = await httpGet(url, { feature: "gene" });
  return (Array.isArray(data) ? data : [])
    .map((g) => ({
      ensembl_id: g.id || "",
      symbol: g.external_name || "",
      chrom: g.seq_region_name || chrom,
      start: g.start ?? null,
      end: g.end ?? null,
      strand: g.strand === 1 ? "+" : g.strand === -1 ? "-" : "",
    }))
    .filter((g) => g.ensembl_id);
}

/**
 * Step 2: Resolve a FlyBase gene (FBgn) from an Ensembl gene via xrefs.
 * @param {string} ensemblGeneId
 * @returns {Promise<string|null>} FBgn like "FBgnXXXXX" or null if none.
 */
export async function ensemblToFBgn(ensemblGeneId) {
  const url = `https://rest.ensembl.org/xrefs/id/${encodeURIComponent(
    ensemblGeneId
  )}`;
  const data = await httpGet(url);
  if (!Array.isArray(data) || !data.length) return null;

  const flybaseRows = data.filter((x) => /flybase/i.test(x.dbname || ""));
  const fbgnRow =
    flybaseRows.find((x) => /^FBgn/i.test(x.primary_id || "")) ||
    flybaseRows.find((x) => /^FBgn/i.test(x.id || "")) ||
    null;

  if (!fbgnRow) return null;

  // Prefer primary_id when it looks like an FBgn; otherwise fall back to id.
  return fbgnRow.primary_id?.match(/^FBgn/i)
    ? fbgnRow.primary_id
    : fbgnRow.id?.match(/^FBgn/i)
    ? fbgnRow.id
    : null;
}

/**
 * Step 3: Pull FlyBase "auto summaries" for a given FBgn.
 * - Parses a few common fields (symbol, gene name, etc.) from the summary text.
 * - If summary is missing or request fails, returns a minimal object.
 * @param {string} fbgnId
 * @returns {Promise<{
 *   fbgnId: string,
 *   geneName?: string,
 *   symbol?: string,
 *   annotationSymbol?: string,
 *   geneGroup?: string,
 *   geneSummary?: string,
 *   automatedDescription?: string,
 *   autoSummary?: string,
 *   summary?: string
 * }>}
 */
export async function fetchFlyBaseSummary(fbgnId) {
  const url = `https://flybase.org/api/gene/summaries/${encodeURIComponent(
    fbgnId
  )}`;

  try {
    const data = await httpGet(url);

    const result = data?.resultset?.result?.[0] || {};

    // Raw pieces from the API (be forgiving about which field has what)
    const summaryRaw = result.summary || "";
    const autoSummaryRaw = result.auto_summary || "";
    const descriptionRaw = result.description || "";

    // If absolutely nothing text-like exists, bail early
    if (!summaryRaw && !autoSummaryRaw && !descriptionRaw) {
      return { fbgnId, summary: "" };
    }

    // Choose a "best" geneSummary in priority order
    const geneSummary = summaryRaw || autoSummaryRaw || descriptionRaw || "";

    // Try to pull out some extra structured bits from the main summary text
    const geneNameMatch =
      geneSummary.match(/^The gene ([^ ](?:.*?)) is referred/) ||
      summaryRaw.match(/^The gene ([^ ](?:.*?)) is referred/);

    const symbolMatch =
      geneSummary.match(/by the symbol\s+([^\s(]+)/) ||
      summaryRaw.match(/by the symbol\s+([^\s(]+)/);

    const annotationMatch =
      geneSummary.match(/\((CG\d+),/) || summaryRaw.match(/\((CG\d+),/);

    const geneGroupMatch =
      geneSummary.match(/Gene group:\s*(.*)/i) ||
      summaryRaw.match(/Gene group:\s*(.*)/i);

    return {
      fbgnId,
      geneName: geneNameMatch ? geneNameMatch[1] : "",
      symbol: symbolMatch ? symbolMatch[1] : "",
      annotationSymbol: annotationMatch ? annotationMatch[1] : "",
      geneGroup: geneGroupMatch ? geneGroupMatch[1] : "",

      // Main text fields we expose downstream
      geneSummary, // our unified best-effort summary
      automatedDescription: descriptionRaw || "",
      autoSummary: autoSummaryRaw || "",
      summary: geneSummary,
    };
  } catch (e) {
    console.warn(`[FlyBase summaries] ${fbgnId}: ${e?.message || e}`);
    return { fbgnId, summary: "" };
  }
}

/* ====================================================================
   NEW: UniProt protein function via EBI Proteins API (no scraping)
   ==================================================================== */

/**
 * Fetch protein function summary from UniProt using the EBI Proteins API.
 * Mirrors your classmate's getProteinSummary implementation, but goes
 * through our throttled httpGet helper.
 *
 * @param {string} fbgnId FlyBase gene ID (e.g. "FBgn0040070")
 * @returns {Promise<string>} e.g. "Some function… (UniProt, Q9V3Z4)" or ""
 */
export async function fetchUniProtProteinSummary(fbgnId) {
  if (!fbgnId || typeof fbgnId !== "string") return "";

  const url = `https://www.ebi.ac.uk/proteins/api/proteins/flybase:${encodeURIComponent(
    fbgnId
  )}`;

  try {
    const data = await httpGet(
      url,
      { offset: 0, size: 100 },
      { Accept: "application/json" }
    );

    if (!Array.isArray(data) || data.length === 0) {
      // No proteins found for this FlyBase ID
      return "";
    }

    const protein = data[0];
    const proteinId = protein.accession || "Unknown";

    let summary = "";
    if (Array.isArray(protein.comments)) {
      const func = protein.comments.find((c) => c.type === "FUNCTION");
      if (func && Array.isArray(func.text)) {
        summary = func.text.map((t) => t.value).join(" ");
      }
    }

    if (!summary) return "";

    // Single string, similar to your classmate's version.
    return `${summary} (UniProt, ${proteinId})`;
  } catch (e) {
    console.warn(`[UniProt] ${fbgnId}: ${e?.message || e}`);
    return "";
  }
}

/* ====================================================================
   FBgn → Entrez → Human orthologs (DIOPT)
   ==================================================================== */

/**
 * Resolve an Entrez ID from an FBgn using Ensembl xrefs.
 * @param {string} fbgnId
 * @returns {Promise<string|null>}
 */
export async function fbgnToEntrez(fbgnId) {
  const url = `https://rest.ensembl.org/xrefs/id/${encodeURIComponent(fbgnId)}`;
  try {
    const data = await httpGet(url);
    if (!Array.isArray(data) || !data.length) return null;
    const entrezEntry = data.find(
      (x) => (x.dbname || "").toLowerCase() === "entrezgene"
    );
    return entrezEntry?.primary_id || entrezEntry?.id || null;
  } catch (e) {
    console.warn(`[fbgnToEntrez] ${fbgnId}: ${e?.message || e}`);
    return null;
  }
}

/**
 * Query DIOPT for human orthologs of a Drosophila gene (Entrez ID).
 *
 * @param {string|null} entrezId
 * @param {number} [maxOrthologs=3]
 * @returns {Promise<string[]>} e.g. ["Hsap\\GENE1 (10 of 10)", ...]
 */
export async function humanOrthologsFromEntrez(entrezId, maxOrthologs = 3) {
  if (!entrezId) return [];

  const url = `https://www.flyrnai.org/tools/diopt/web/diopt_api/v9/get_orthologs_from_entrez/7227/${encodeURIComponent(
    entrezId
  )}/9606/best_match`;

  try {
    const data = await httpGet(url);
    const results = data?.results?.[entrezId];
    if (!results) return [];

    return Object.values(results)
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, maxOrthologs)
      .map((o) => `Hsap\\${o.symbol} (${o.score} of ${o.max_score})`);
  } catch (e) {
    console.warn(
      `[humanOrthologsFromEntrez] Entrez ${entrezId}: ${e?.message || e}`
    );
    return [];
  }
}

/**
 * Internal: shape FlyBase records into sponsor-style CSV rows.
 * @param {Array<ReturnType<fetchFlyBaseSummary>>} geneDetails
 * @param {{chrom:string, start:number, end:number, assembly:string}} regionInfo
 * @returns {Array<Record<string,string>>}
 */
function buildSponsorRows(geneDetails, regionInfo) {
  return geneDetails.map((g) => ({
    "Gene Name": g.geneName || "",
    Symbol: g.symbol || "",
    "Annotation Symbol": g.annotationSymbol || "",
    "FlyBase ID": g.fbgnId || "",
    "Gene Summary": truncate(g.geneSummary),
    "Automated Description": truncate(g.automatedDescription),
    "Automatically Generated Summary": truncate(g.autoSummary),
    "Gene Group": g.geneGroup || "",
    "Input Region": `${regionInfo.chrom}:${regionInfo.start}-${regionInfo.end}`,
    Assembly: regionInfo.assembly || "dm6",
  }));
}

/**
 * Orchestrate the pipeline and save a CSV to disk.
 *
 * @param {{chrom:string, start:number, end:number, assembly?:string, savePath:string}} args
 * @returns {Promise<{count:number, savePath:string}>}
 * @throws {Error} if no overlaps are found.
 */
export async function runEnsemblFlyBasePipelineAndSave({
  chrom,
  start,
  end,
  assembly = "dm6",
  savePath,
}) {
  console.log("[Pipeline] overlap", { chrom, start, end });

  // 1) Overlap genes in region from Ensembl.
  const overlaps = await ensemblOverlapGenes({ chrom, start, end });
  console.log("[Pipeline] overlaps:", overlaps.length);
  if (!overlaps.length)
    throw new Error("No overlapping genes found from Ensembl for this region.");

  // 2) Map each Ensembl gene to an FBgn (best-effort).
  const mapped = [];
  for (const g of overlaps) {
    try {
      const fbgn = await ensemblToFBgn(g.ensembl_id);
      if (fbgn) mapped.push(fbgn);
    } catch (e) {
      console.warn("[Pipeline] xref error", g.ensembl_id, String(e));
    }
  }
  const uniqueFBgn = [...new Set(mapped)];
  console.log("[Pipeline] FBgn mapped:", uniqueFBgn.length);

  // 3) Get FlyBase summaries for each FBgn (best-effort; skip empties).
  const details = [];
  for (const fbgn of uniqueFBgn) {
    const s = await fetchFlyBaseSummary(fbgn);
    if (s?.geneSummary) details.push(s);
  }
  console.log("[Pipeline] summaries:", details.length);

  // 4) Build CSV rows and write the file (prepend BOM for Excel compatibility).
  const rows = buildSponsorRows(details, { chrom, start, end, assembly });
  const csv = arrayToCSV(rows);
  fs.writeFileSync(savePath, "\uFEFF" + csv, "utf8");

  return { count: rows.length, savePath };
}
