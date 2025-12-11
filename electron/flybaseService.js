// FlyMine Template I'm using: https://www.flymine.org/flymine/templates/ChromLocation_Gene

//----------------------------------------------------------------------
// File: electron/flybaseService.js
// Purpose: Data-layer utilities for nearby-gene annotation.
//          1) Try FlyMine OVERLAPS for a region.
//          2) If no hits, fall back to Ensembl overlap → FBgn map → FlyBase summary.
// Notes:
//   • Keep this file UI-free. It should be pure data fetching/normalization.
//   • Main process wires IPC to `annotateRegions`.
//   • Renderer passes rows with either full windows (chrom:start-end) or single positions.
// Owner: Ryan | Last touched: 2025-12-09
//----------------------------------------------------------------------

import {
  ensemblOverlapGenes,
  ensemblToFBgn,
  fetchFlyBaseSummary,
  fbgnToEntrez, // FBgn → Entrez
  humanOrthologsFromEntrez, // Entrez → human orthologs (DIOPT)
  fetchUniProtProteinSummary, // NEW: UniProt function via EBI Proteins API
} from "./pipelineEnsemblFlyBase.js";

// FlyMine PathQuery endpoint (InterMine API)
const FLYMINE_ENDPOINT =
  "https://www.flymine.org/flymine/service/query/results";

// NEW: Alliance of Genome Resources — automated description for a FlyBase FBgn
async function fetchAllianceAutomatedDescription(fbgnId) {
  if (!fbgnId || !/^FBgn/i.test(fbgnId)) return null; // expect "FBgn0040070" only  // NEW

  const allianceId = `FB:${fbgnId}`; // Alliance expects "FB:FBgn0040070"        // NEW
  const url = `https://www.alliancegenome.org/api/gene/${encodeURIComponent(
    allianceId
  )}`; // NEW

  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" }, // NEW
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => ""); // NEW
      console.warn(
        "[fetchAllianceAutomatedDescription] HTTP",
        res.status,
        res.statusText,
        txt.slice(0, 200)
      );
      return null; // NEW
    }

    const data = await res.json().catch(() => null); // NEW
    if (!data) return null; // NEW

    const automatedDescription =
      typeof data.automatedGeneSynopsis === "string"
        ? data.automatedGeneSynopsis.trim()
        : ""; // NEW

    const allianceSymbol =
      typeof data.symbol === "string" ? data.symbol.trim() : ""; // NEW
    const allianceName = typeof data.name === "string" ? data.name.trim() : ""; // NEW

    return {
      automatedDescription, // NEW
      allianceSymbol,
      allianceName,
      raw: data,
    };
  } catch (err) {
    console.warn(
      "[fetchAllianceAutomatedDescription] failed",
      fbgnId,
      err?.message || err
    ); // NEW
    return null;
  }
}

/**
 * Build a FlyMine PathQuery payload for "genes overlapping a region".
 */
function buildOverlapPQ({
  chrom,
  start,
  end,
  organism = "Drosophila melanogaster",
}) {
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
 *
 * Enrichment (now via FlyBase summaries API + UniProt JSON API + Alliance):
 *   • If gene_id is FBgn, attach:
 *       gene_name, annotation_symbol, gene_group, curated_summary,
 *       automated_description (Alliance-first), auto_summary, gene_summary,
 *       protein_function (UniProt)
 *
 * @param {{chrom:string,start:number,end:number}} region
 */
export async function fetchGenesForRegionOverlap({ chrom, start, end }) {
  const pq = buildOverlapPQ({ chrom, start, end });

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
    const txt = await res.text().catch(() => "");
    throw new Error(
      `FlyMine query failed: ${res.status} ${res.statusText}\n${txt}`
    );
  }

  const data = await res.json();
  const rows = Array.isArray(data) ? data : data.results ?? data;

  const genes = await Promise.all(
    (rows || []).map(async (row) => {
      const get = (k) =>
        row[k] ??
        row[k?.replace(/^Gene\./, "")] ??
        row.Gene?.[k?.split(".").slice(1).join(".")] ??
        null;

      const gene_id =
        get("Gene.primaryIdentifier") || get("primaryIdentifier") || "";

      const gene = {
        source: "flymine:overlaps",
        gene_id,
        symbol: get("Gene.symbol") || get("symbol") || "",
        chrom:
          get("Gene.chromosomeLocation.locatedOn.primaryIdentifier") ||
          get("chromosomeLocation.locatedOn.primaryIdentifier") ||
          "",
        start:
          Number(
            get("Gene.chromosomeLocation.start") ||
              get("chromosomeLocation.start")
          ) || null,
        end:
          Number(
            get("Gene.chromosomeLocation.end") || get("chromosomeLocation.end")
          ) || null,
        strand:
          get("Gene.chromosomeLocation.strand") ||
          get("chromosomeLocation.strand") ||
          "",
        human_orthologs: [],
      };

      // Enrichment for FBgn IDs via FlyBase summaries + UniProt + Alliance
      if (gene_id && /^FBgn/i.test(gene_id)) {
        try {
          // CHANGED: add Alliance to the enrichment bundle
          const [auto, uniProtFn, alliance] = await Promise.all([
            fetchFlyBaseSummary(gene_id),
            fetchUniProtProteinSummary(gene_id),
            fetchAllianceAutomatedDescription(gene_id),
          ]); // CHANGED

          const allianceText = alliance?.automatedDescription || ""; // NEW

          Object.assign(gene, {
            gene_name: auto?.geneName || "",
            annotation_symbol: auto?.annotationSymbol || "",

            // Treat the API geneSummary as both curated+auto for now
            curated_summary: auto?.geneSummary || auto?.summary || "",
            gene_summary: auto?.geneSummary || auto?.summary || "",

            // CHANGED: Automated Description prefers Alliance
            automated_description:
              allianceText ||
              auto?.automatedDescription ||
              auto?.autoSummary ||
              auto?.geneSummary ||
              "", // CHANGED

            // Automatically generated summary (FlyBase)
            auto_summary: auto?.geneSummary || auto?.autoSummary || "",

            // Gene Group text from summaries API
            gene_group: auto?.geneGroup || "",

            // Protein function from UniProt JSON API
            protein_function: uniProtFn || "",

            // OPTIONAL Alliance metadata
            alliance_symbol: alliance?.allianceSymbol || "", // NEW
            alliance_name: alliance?.allianceName || "", // NEW
          });
        } catch (err) {
          console.warn(
            "FlyBase/UniProt/Alliance enrichment failed",
            gene_id,
            err
          );
        }
      }
      return gene;
    })
  );

  return genes;
}

/**
 * Fallback pipeline when FlyMine returns no hits:
 *   Ensembl overlap → Ensembl→FBgn xref → FlyBase auto summary.
 *
 * Enrichment (no HTML scraping):
 *   • FlyBase summary fields (similar to FlyMine path).
 *   • UniProt protein function (EBI Proteins API).
 *   • Alliance automated description.
 *   • Human orthologs via DIOPT (FBgn → Entrez → human).
 */
export async function fallbackEnsemblGenesForRegion({ chrom, start, end }) {
  const overlaps = await ensemblOverlapGenes({ chrom, start, end });
  if (!Array.isArray(overlaps) || !overlaps.length) return [];

  const out = [];
  for (const g of overlaps) {
    let fbgn = null;
    try {
      fbgn = await ensemblToFBgn(g.ensembl_id);
    } catch {
      /* best-effort mapping */
    }

    if (fbgn && !/^FBgn/i.test(fbgn)) fbgn = null;

    let polishedSymbol = g.symbol || "";
    let flybaseSummary = null;
    let uniProtFn = ""; // NEW
    let allianceAuto = null; // NEW

    if (fbgn && /^FBgn/i.test(fbgn)) {
      try {
        // CHANGED: include Alliance helper in enrichment
        const [s, pf, alliance] = await Promise.all([
          fetchFlyBaseSummary(fbgn),
          fetchUniProtProteinSummary(fbgn),
          fetchAllianceAutomatedDescription(fbgn),
        ]); // CHANGED
        flybaseSummary = s || null;
        uniProtFn = pf || "";
        allianceAuto = alliance || null; // NEW
        if (s?.symbol) polishedSymbol = s.symbol;
      } catch (e) {
        console.warn(
          `[fallbackEnsemblGenesForRegion] FlyBase/UniProt/Alliance enrichment failed for ${fbgn}:`,
          e?.message || e
        );
      }
    }

    // DIOPT human orthologs (optional)
    let human_orthologs = [];
    if (fbgn) {
      try {
        const entrez = await fbgnToEntrez(fbgn);
        if (entrez) {
          human_orthologs = await humanOrthologsFromEntrez(entrez, 3);
        }
      } catch (e) {
        console.warn(
          `[fallbackEnsemblGenesForRegion] DIOPT lookup failed for ${fbgn}:`,
          e?.message || e
        );
      }
    }

    const gene = {
      source: fbgn ? "ensembl→flybase" : "ensembl",
      gene_id: fbgn || g.ensembl_id,
      symbol: polishedSymbol || "",
      chrom: g.chrom || chrom,
      start: g.start ?? null,
      end: g.end ?? null,
      strand: g.strand ?? "",
      human_orthologs,
    };

    // Attach FlyBase + Alliance enrichment if we have it
    if (flybaseSummary) {
      Object.assign(gene, {
        gene_name: flybaseSummary?.geneName || "",
        annotation_symbol: flybaseSummary?.annotationSymbol || "",

        gene_group: flybaseSummary?.geneGroup || "",

        curated_summary:
          flybaseSummary?.geneSummary || flybaseSummary?.summary || "",
        gene_summary:
          flybaseSummary?.geneSummary || flybaseSummary?.summary || "",

        // CHANGED: prefer Alliance description; fall back to FlyBase fields
        automated_description:
          allianceAuto?.automatedDescription ||
          flybaseSummary?.automatedDescription ||
          flybaseSummary?.autoSummary ||
          flybaseSummary?.geneSummary ||
          "", // CHANGED

        auto_summary:
          flybaseSummary?.geneSummary || flybaseSummary?.autoSummary || "",

        // Protein function from UniProt JSON API
        protein_function: uniProtFn || "",

        alliance_symbol: allianceAuto?.allianceSymbol || "", // NEW
        alliance_name: allianceAuto?.allianceName || "", // NEW
      });
    } else {
      // Even if FlyBase summary failed, keep UniProt function if we got it.
      if (uniProtFn) {
        gene.protein_function = uniProtFn;
      }
    }

    out.push(gene);
  }
  return out;
}

/**
 * Top-level batch annotator used by the main process IPC.
 */
export async function annotateRegions(payload) {
  const { assembly = "dm6", rows = [], radius: payloadRadius } = payload || {};

  if (assembly !== "dm6") throw new Error(`Unsupported assembly: ${assembly}`);

  const defaultRadius = 5000;
  const rad = Number.isFinite(Number(payloadRadius))
    ? Number(payloadRadius)
    : defaultRadius;

  const out = [];
  for (const r of rows) {
    let chrom = r.chrom;
    let start = r.start;
    let end = r.end;

    if (!chrom && r.coordinate) {
      const m = String(r.coordinate).match(/^([^:]+):(\d+)(?:-(\d+))?$/);
      if (m) {
        chrom = m[1];
        start = parseInt(m[2], 10);
        end = m[3] ? parseInt(m[3], 10) : undefined;
      }
    }

    if (!end && (start || r.pos)) {
      const pos = start ?? r.pos;
      start = Math.max(1, pos - rad);
      end = pos + rad;
    }

    if (!chrom || start == null || end == null) {
      out.push({ input: r, error: "Invalid or missing coordinates" });
      continue;
    }

    try {
      let genes = [];

      try {
        genes = await fetchGenesForRegionOverlap({ chrom, start, end });
      } catch {
        // ignore FlyMine errors, fall through to Ensembl
      }

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
