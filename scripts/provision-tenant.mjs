#!/usr/bin/env node
/**
 * Provision a tenant: create its data dir, seed or copy its SQLite DB, and
 * register it in the control DB. Idempotent.
 *
 * Usage:
 *   node scripts/provision-tenant.mjs <slug> <name> [--data-dir=/path] [--source-db=/path] [--public-url=https://...]
 */
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

const [, , slugArg, nameArg, ...flags] = process.argv;

function flag(name) {
  const prefix = `--${name}=`;
  return flags.find(f => f.startsWith(prefix))?.slice(prefix.length);
}

if (!slugArg || !nameArg || !/^[a-z0-9-]+$/.test(slugArg)) {
  console.error('Usage: node scripts/provision-tenant.mjs <slug> <name> [--data-dir=...] [--source-db=...] [--public-url=...]');
  console.error('slug must be lowercase alphanumeric with hyphens (e.g. cixnailspa)');
  process.exit(1);
}

const slug = slugArg;
const name = nameArg;
const root = process.env.CITASYA_DATA_DIR || process.env.CIXNAILARTIST_DATA_DIR || '/var/lib/citasya-saas';
const dataDir = flag('data-dir') || path.join(root, slug);
const controlDbPath = process.env.CITASYA_CONTROL_DB || path.join(root, 'control.db');
const sourceDb = flag('source-db');
const publicUrl = flag('public-url') || `https://${slug}.clubemkt.digital`;

fs.mkdirSync(path.dirname(controlDbPath), { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.join(dataDir, 'backups'), { recursive: true });
fs.mkdirSync(path.join(dataDir, 'assets'), { recursive: true });

const dbFile = path.join(dataDir, 'cixnailartist.db');
if (!fs.existsSync(dbFile)) {
  if (sourceDb) {
    // Checkpoint the source WAL into its main DB first, then copy the file.
    // This captures all committed data without relying on async backup races.
    const src = new Database(sourceDb);
    src.pragma('wal_checkpoint(TRUNCATE)');
    src.close();
    fs.copyFileSync(sourceDb, dbFile);
    console.log(`Copied DB (WAL checkpointed) from ${sourceDb} → ${dbFile}`);
  } else {
    console.log(`No DB at ${dbFile}; it will be created and seeded on first server start.`);
  }
}

const control = new Database(controlDbPath);
control.exec(`
  CREATE TABLE IF NOT EXISTS tenants (
    slug TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    plan TEXT NOT NULL DEFAULT 'starter',
    status TEXT NOT NULL DEFAULT 'active',
    public_url TEXT NOT NULL DEFAULT '',
    data_dir TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);
control.prepare(`INSERT INTO tenants (slug, name, public_url, data_dir) VALUES (?, ?, ?, ?)
  ON CONFLICT(slug) DO UPDATE SET name=excluded.name, public_url=excluded.public_url, data_dir=excluded.data_dir`)
  .run(slug, name, publicUrl, dataDir);
control.close();

console.log(`Tenant '${slug}' ready. URL: ${publicUrl}  Data: ${dataDir}`);
