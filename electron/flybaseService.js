//FlyMine Template I'm using: https://www.flymine.org/flymine/templates/ChromLocation_Gene

//----------------------------------------------------------------------
// File: electron/flybaseService.js
// Purpose: Data-layer utilities for nearby-gene annotation.
//          1) Try FlyMine OVERLAPS for a region.
//          2) If no hits, fall back to Ensembl overlap → FBgn map → FlyBase summary.
// Notes:
//   • Keep this file UI-free. It should be pure data fetching/normalization.
//   • Main process wires IPC to `annotateRegions`.
//   • Renderer passes rows with either full windows (chrom:start-end) or single positions.
// Owner: Ryan | Last touched: 2025-10-20
//----------------------------------------------------------------------

import {
  ensemblOverlapGenes,
  ensemblToFBgn,
  fetchFlyBaseSummary,
} from "./pipelineEnsemblFlyBase.js";

// FlyMine PathQuery endpoint (InterMine API)
const FLYMINE_ENDPOINT = "https://www.flymine.org/flymine/service/query/results";

/**
 * Build a FlyMine PathQuery payload for "genes overlapping a region".
 * WHY: InterMine expects a PathQuery object (model/from/select/where/sortOrder).
 * @param {{chrom:string,start:number,end:number,organism?:string}} args
 * @returns {object} PathQuery JSON
 */
function buildOverlapPQ({ chrom, start, end, organism = "Drosophila melanogaster" }) {
  return {
    model: { name: "genomic" },
    from: "Gene",
    select: [
      "primaryIdentifier",
      "symbol",
      "chromosomeLocation.locatedOn.primaryIdentifier",
      "chromosomeLocation.start",
      "chromosomeLocation.end",
      "chromosomeLocation.strand",
      "organism.name",
    ],
    where: {
      chromosomeLocation: { OVERLAPS: [`${chrom}:${start}..${end}`] },
      "organism.name": organism,
    },
    sortOrder: [["chromosomeLocation.start", "ASC"]],
  };
}

/**
 * Query FlyMine for genes overlapping a region and normalize fields.
 * WHY: FlyMine sometimes returns slightly different shapes; we normalize to a stable row.
 *
 * @param {{chrom:string,start:number,end:number}} region
 * @returns {Promise<Array<{
 *   source: "flymine:overlaps",
 *   gene_id: string,
 *   symbol: string,
 *   chrom: string,
 *   start: number|null,
 *   end: number|null,
 *   strand: string|number,
 *   human_orthologs: string[]
 * }>>}
 * @throws {Error} when FlyMine responds non-OK
 */
export async function fetchGenesForRegionOverlap({ chrom, start, end }) {
  const pq = buildOverlapPQ({ chrom, start, end });

  // InterMine endpoints accept x-www-form-urlencoded with a "query" JSON string.
  const form = new URLSearchParams();
  form.set("query", JSON.stringify(pq));
  form.set("format", "json");
  form.set("size", "1000");
  form.set("start", "0");

  const res = await fetch(FLYMINE_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });

  if (!res.ok) {
    // Return server text when available — helps troubleshooting template/path errors.
    const txt = await res.text().catch(() => "");
    throw new Error(`FlyMine query failed: ${res.status} ${res.statusText}\n${txt}`);
  }

  // InterMine may wrap in {results:[…]} or return the array directly.
  const data = await res.json();
  const rows = Array.isArray(data) ? data : data.results ?? data;

  // Normalize result row shape into our stable schema.
  return (rows || []).map((row) => {
    // Some responses prefix keys with "Gene." or nest under row.Gene — unify access.
    const get = (k) =>
      row[k] ??
      row[k?.replace(/^Gene\./, "")] ??
      row.Gene?.[k?.split(".").slice(1).join(".")] ??
      null;

    return {
      source: "flymine:overlaps",
      gene_id: get("Gene.primaryIdentifier") || get("primaryIdentifier") || "",
      symbol: get("Gene.symbol") || get("symbol") || "",
      chrom:
        get("Gene.chromosomeLocation.locatedOn.primaryIdentifier") ||
        get("chromosomeLocation.locatedOn.primaryIdentifier") ||
        "",
      start: Number(get("Gene.chromosomeLocation.start") || get("chromosomeLocation.start")) || null,
      end: Number(get("Gene.chromosomeLocation.end") || get("chromosomeLocation.end")) || null,
      strand: get("Gene.chromosomeLocation.strand") || get("chromosomeLocation.strand") || "",
      human_orthologs: [], // reserved for future enrichment
    };
  });
}

/**
 * Fallback pipeline when FlyMine returns no hits:
 *   Ensembl overlap → Ensembl→FBgn xref → FlyBase auto summary polish.
 * WHY: Some services only return a gene if the window spans the entire gene.
 *      Ensembl overlap is more permissive and often finds candidates near a locus.
 *
 * @param {{chrom:string,start:number,end:number}} region
 * @returns {Promise<Array<{
 *   source: "ensembl"|"ensembl→flybase",
 *   gene_id: string,            // FBgn if mapped, else Ensembl gene id
 *   symbol: string,
 *   chrom: string,
 *   start: number|null,
 *   end: number|null,
 *   strand: string,
 *   human_orthologs: string[]
 * }>>}
 */
export async function fallbackEnsemblGenesForRegion({ chrom, start, end }) {
  const overlaps = await ensemblOverlapGenes({ chrom, start, end });
  if (!Array.isArray(overlaps) || !overlaps.length) return [];

  const out = [];
  for (const g of overlaps) {
    // Map Ensembl gene → FBgn when possible.
    let fbgn = null;
    try {
      fbgn = await ensemblToFBgn(g.ensembl_id);
    } catch { /* best-effort mapping */ }

    // Guard: only accept true FBgn identifiers.
    if (fbgn && !/^FBgn/i.test(fbgn)) fbgn = null;

    // Prefer FlyBase symbol if we have an FBgn; it’s often cleaner/more canonical.
    let polishedSymbol = g.symbol || "";
    if (fbgn && /^FBgn/i.test(fbgn)) {
      try {
        const s = await fetchFlyBaseSummary(fbgn);
        if (s?.symbol) polishedSymbol = s.symbol;
      } catch { /* summaries are best-effort */ }
    }

    out.push({
      source: fbgn ? "ensembl→flybase" : "ensembl",
      gene_id: fbgn || g.ensembl_id,
      symbol: polishedSymbol || "",
      chrom: g.chrom || chrom,
      start: g.start ?? null,
      end: g.end ?? null,
      strand: g.strand ?? "",
      human_orthologs: [],
    });
  }
  return out;
}

/**
 * Top-level batch annotator used by the main process IPC.
 * Input rows may be:
 *   • full windows: { chrom, start, end }
 *   • single positions: { chrom, pos } or encoded strings in `coordinate`
 * The function:
 *   1) Normalizes each row to a region window: [pos-radius, pos+radius] if needed.
 *   2) Tries FlyMine OVERLAPS.
 *   3) Falls back to Ensembl→FBgn→FlyBase if FlyMine is empty/fails.
 *
 * @param {{assembly?:string, radius?:number, rows:Array<any>}} payload
 * @returns {Promise<{ok:true, count:number, items:Array<{
 *   input:any,
 *   region?:{chrom:string,start:number,end:number,assembly:string},
 *   genes?:Array<any>,
 *   error?:string
 * }>}>>}
 * @throws {Error} when unsupported assemblies are requested
 */
export async function annotateRegions(payload) {
  const { assembly = "dm6", rows = [], radius: payloadRadius } = payload || {};

  // Guard assembly up front to keep downstream calls simple.
  if (assembly !== "dm6") throw new Error(`Unsupported assembly: ${assembly}`);

  // Single-position rows expand to a window of ±radius (default 5kb).
  const defaultRadius = 5000;
  const rad = Number.isFinite(Number(payloadRadius)) ? Number(payloadRadius) : defaultRadius;

  const out = [];
  for (const r of rows) {
    // Accept multiple input shapes. Prefer explicit chrom/start/end, else parse a coordinate string.
    let chrom = r.chrom;
    let start = r.start;
    let end = r.end;

    // e.g., "2L:12345-67890"
    if (!chrom && r.coordinate) {
      const m = String(r.coordinate).match(/^([^:]+):(\d+)(?:-(\d+))?$/);
      if (m) {
        chrom = m[1];
        start = parseInt(m[2], 10);
        end = m[3] ? parseInt(m[3], 10) : undefined;
      }
    }

    // If only a single position is present, inflate to a symmetric window by radius.
    if (!end && (start || r.pos)) {
      const pos = start ?? r.pos;
      start = Math.max(1, pos - rad);
      end = pos + rad;
    }

    // Validate before calling services.
    if (!chrom || start == null || end == null) {
      out.push({ input: r, error: "Invalid or missing coordinates" });
      continue;
    }

    try {
      let genes = [];

      // First attempt: FlyMine overlap (often stricter; may require full-gene windows)
      try {
        genes = await fetchGenesForRegionOverlap({ chrom, start, end });
      } catch {
        // Swallow FlyMine errors here so we can still try the fallback path.
      }

      // Fallback: Ensembl overlap → FBgn map → FlyBase summary
      if (!genes?.length) {
        genes = await fallbackEnsemblGenesForRegion({ chrom, start, end });
      }

      out.push({ input: r, region: { chrom, start, end, assembly }, genes });
    } catch (e) {
      out.push({
        input: r,
        region: { chrom, start, end, assembly },
        error: String(e?.message || e),
      });
    }
  }

  return { ok: true, count: out.length, items: out };
}
