//----------------------------------------------------------------------
// File: electron/sqliteService.js
// Purpose: Local persistence for Fly Faster runs using better-sqlite3.
// Design:
//   • One DB file per user profile (app.getPath('userData')).
//   • Init on app start; run simple "migrations" to ensure tables exist.
//   • Expose a tiny API used by IPC handlers in main.js:
//       - initDb()
//       - saveJob({ assembly, radius, sourceFile, sourceHash, items })
//       - listJobs(limit?, offset?)
//       - loadJob(jobId)
// Notes:
//   • better-sqlite3 is synchronous and fast; we wrap inserts in a transaction.
//   • WAL mode improves concurrent r/w reliability for desktop apps.
// Owner: Ryan | Last touched: 2025-10-20
//----------------------------------------------------------------------

import Database from "better-sqlite3";
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

// Singleton DB handle for the process (main only).
let db;

/**
 * Initialize (or open) the SQLite database.
 * - Creates the DB file under Electron's userData dir.
 * - On first run, executes a lightweight migration to create tables/indexes.
 * - Enables WAL for better durability and concurrent reads.
 *
 * @returns {Database} better-sqlite3 handle
 */
export function initDb() {
  const dir = app.getPath("userData");
  const file = path.join(dir, "flyfaster.db");

  const firstTime = !fs.existsSync(file);
  db = new Database(file); // open/create DB
  if (firstTime) migrate(); // create schema on first open

  return db;
}

/**
 * One-shot schema creation & PRAGMAs.
 * - Keep this idempotent (CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS)
 *   so re-running doesn't harm existing installations.
 */
function migrate() {
  db.exec(`
    -- Improve write patterns for desktop apps
    PRAGMA journal_mode=WAL;

    -- High-level job metadata (one row per saved run)
    CREATE TABLE IF NOT EXISTS jobs (
      id            INTEGER PRIMARY KEY,
      created_at    TEXT NOT NULL,  -- ISO timestamp (UTC)
      assembly      TEXT NOT NULL,  -- e.g., "dm6"
      radius        INTEGER NOT NULL,
      source_file   TEXT,           -- original filename (if any)
      source_hash   TEXT            -- future: content hash for dedupe/integrity
    );

    -- One row per input item (region or position) in a job
    CREATE TABLE IF NOT EXISTS results (
      id            INTEGER PRIMARY KEY,
      job_id        INTEGER NOT NULL,
      input_json    TEXT NOT NULL,  -- serialized input row ({chrom,start/end|pos,...})
      region_json   TEXT,           -- normalized region ({chrom,start,end,assembly})
      error         TEXT,           -- error string if annotation failed
      FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );

    -- Deduplicated gene records (shared across many results)
    CREATE TABLE IF NOT EXISTS genes (
      id            INTEGER PRIMARY KEY,
      gene_id       TEXT NOT NULL UNIQUE,   -- FBgn... or Ensembl if fallback
      symbol        TEXT,
      chrom         TEXT,
      start         INTEGER,
      end           INTEGER,
      strand        TEXT
    );

    -- Link table: many-to-many between results and genes
    CREATE TABLE IF NOT EXISTS result_genes (
      result_id     INTEGER NOT NULL,
      gene_id_fk    INTEGER NOT NULL,
      source        TEXT,                 -- e.g., "flymine:overlaps", "ensembl", "ensembl→flybase"
      human_orthologs_json TEXT,          -- JSON array of ortholog IDs/labels
      PRIMARY KEY (result_id, gene_id_fk),
      FOREIGN KEY(result_id) REFERENCES results(id) ON DELETE CASCADE,
      FOREIGN KEY(gene_id_fk) REFERENCES genes(id) ON DELETE CASCADE
    );

    -- Helpful indexes
    CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at);
    CREATE INDEX IF NOT EXISTS idx_genes_geneid ON genes(gene_id);
  `);
}

/**
 * Persist a completed annotation run (job + results + genes).
 * Inserts are wrapped in a single transaction for atomicity & speed.
 *
 * @param {{
 *   assembly: string,
 *   radius: number,
 *   sourceFile?: string|null,
 *   sourceHash?: string|null,
 *   items: Array<{
 *     input: any,
 *     region?: { chrom:string, start:number, end:number, assembly:string }|null,
 *     error?: string|null,
 *     genes?: Array<{
 *       gene_id: string,
 *       symbol?: string|null,
 *       chrom?: string|null,
 *       start?: number|null,
 *       end?: number|null,
 *       strand?: string|null,
 *       source?: string|null,
 *       human_orthologs?: string[]|null
 *     }>
 *   }>
 * }} payload
 * @returns {number} jobId
 */
export function saveJob({ assembly, radius, sourceFile, sourceHash, items }) {
  // Compose the inserts once per transaction for performance.
  const tx = db.transaction(() => {
    const insJob = db.prepare(`
      INSERT INTO jobs (created_at, assembly, radius, source_file, source_hash)
      VALUES (datetime('now'), ?, ?, ?, ?)
    `);

    const jobId = insJob.run(
      assembly,
      radius,
      sourceFile || null,
      sourceHash || null
    ).lastInsertRowid;

    const insResult = db.prepare(`
      INSERT INTO results (job_id, input_json, region_json, error)
      VALUES (?, ?, ?, ?)
    `);

    const selGene = db.prepare(`SELECT id FROM genes WHERE gene_id = ?`);

    // Upsert: keep a single row per unique gene_id; refresh attributes when seen again.
    const insGene = db.prepare(`
      INSERT INTO genes (gene_id, symbol, chrom, start, end, strand)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(gene_id) DO UPDATE SET
        symbol=excluded.symbol,
        chrom=excluded.chrom,
        start=excluded.start,
        end=excluded.end,
        strand=excluded.strand
    `);

    const link = db.prepare(`
      INSERT OR IGNORE INTO result_genes (result_id, gene_id_fk, source, human_orthologs_json)
      VALUES (?, ?, ?, ?)
    `);

    // Insert each result row and its associated genes.
    for (const item of items) {
      const resId = insResult.run(
        jobId,
        JSON.stringify(item.input || {}),
        item.region ? JSON.stringify(item.region) : null,
        item.error || null
      ).lastInsertRowid;

      // Attach zero or more genes to this result
      for (const g of item.genes || []) {
        insGene.run(
          g.gene_id,
          g.symbol || null,
          g.chrom || null,
          g.start ?? null,
          g.end ?? null,
          g.strand || null
        );

        // Resolve FK id and link
        const gid = selGene.get(g.gene_id).id;
        link.run(
          resId,
          gid,
          g.source || "mock",
          JSON.stringify(g.human_orthologs || [])
        );
      }
    }

    return jobId;
  });

  // immediate(): executes the transaction and returns its return value (jobId)
  return tx.immediate();
}

/**
 * List most recent jobs (paged).
 *
 * @param {number} [limit=20]
 * @param {number} [offset=0]
 * @returns {Array<{id:number,created_at:string,assembly:string,radius:number,source_file:string|null,source_hash:string|null}>}
 */
export function listJobs(limit = 20, offset = 0) {
  return db
    .prepare(
      `
    SELECT id, created_at, assembly, radius, source_file, source_hash
    FROM jobs
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `
    )
    .all(limit, offset);
}

/**
 * Load a job with all of its results and attached gene arrays.
 *
 * @param {number} jobId
 * @returns {{ job: any, items: Array<{input:any, region:any|null, error:string|null, genes:Array<any>}> } | null}
 */
export function loadJob(jobId) {
  const job = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(jobId);
  if (!job) return null;

  const results = db
    .prepare(
      `
    SELECT * FROM results
    WHERE job_id = ?
    ORDER BY id
  `
    )
    .all(jobId);

  const out = results.map((r) => {
    // Collect genes linked to this result
    const genes = db
      .prepare(
        `
      SELECT g.*, rg.source, rg.human_orthologs_json
      FROM result_genes rg
      JOIN genes g ON g.id = rg.gene_id_fk
      WHERE rg.result_id = ?
      ORDER BY g.symbol
    `
      )
      .all(r.id)
      .map((x) => ({
        gene_id: x.gene_id,
        symbol: x.symbol,
        chrom: x.chrom,
        start: x.start,
        end: x.end,
        strand: x.strand,
        source: x.source,
        human_orthologs: JSON.parse(x.human_orthologs_json || "[]"),
      }));

    return {
      input: JSON.parse(r.input_json),
      region: r.region_json ? JSON.parse(r.region_json) : null,
      error: r.error,
      genes,
    };
  });

  return { job, items: out };
}
