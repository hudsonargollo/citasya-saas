import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

export interface Tenant {
  slug: string;
  name: string;
  plan: string;
  status: string;
  public_url: string;
  data_dir: string;
}

export const DEFAULT_SUFFIX = '.clubemkt.digital';

export function controlDbPath(): string {
  return process.env.CITASYA_CONTROL_DB || path.join(resolveRoot(), 'control.db');
}

function resolveRoot(): string {
  return process.env.CITASYA_DATA_DIR || process.env.CIXNAILARTIST_DATA_DIR || '/var/lib/citasya-saas';
}

export function initTenantRegistry(): void {
  const p = controlDbPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const db = new Database(p);
  db.exec(`
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
  db.close();
}

export function getTenantBySlug(slug: string): Tenant | null {
  const db = new Database(controlDbPath(), { readonly: true });
  try {
    const row = db.prepare('SELECT * FROM tenants WHERE slug = ? AND status = ?').get(slug, 'active') as any;
    if (!row) return null;
    return {
      slug: row.slug,
      name: row.name,
      plan: row.plan,
      status: row.status,
      public_url: row.public_url || `https://${row.slug}${DEFAULT_SUFFIX}`,
      data_dir: row.data_dir,
    };
  } finally {
    db.close();
  }
}

export function listTenants(): Tenant[] {
  const db = new Database(controlDbPath(), { readonly: true });
  try {
    return db.prepare('SELECT * FROM tenants ORDER BY slug').all() as Tenant[];
  } finally {
    db.close();
  }
}

export function upsertTenant(t: Pick<Tenant, 'slug' | 'name' | 'data_dir'> & Partial<Tenant>): void {
  const db = new Database(controlDbPath());
  try {
    db.prepare(`INSERT INTO tenants (slug, name, plan, status, public_url, data_dir)
      VALUES (@slug, @name, @plan, @status, @public_url, @data_dir)
      ON CONFLICT(slug) DO UPDATE SET
        name=excluded.name, plan=excluded.plan, status=excluded.status,
        public_url=excluded.public_url, data_dir=excluded.data_dir`)
      .run({
        slug: t.slug,
        name: t.name,
        plan: t.plan || 'starter',
        status: t.status || 'active',
        public_url: t.public_url || `https://${t.slug}${DEFAULT_SUFFIX}`,
        data_dir: t.data_dir,
      });
  } finally {
    db.close();
  }
}

/** Resolve a request Host header to a tenant slug. */
export function slugFromHost(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  const hostname = hostHeader.split(',')[0].trim().split(':')[0].toLowerCase();
  if (hostname.endsWith(DEFAULT_SUFFIX)) {
    const slug = hostname.slice(0, -DEFAULT_SUFFIX.length);
    return /^[a-z0-9-]+$/.test(slug) ? slug : null;
  }
  // Local/dev/testing: explicit override lets one process serve a tenant on localhost.
  if (process.env.CITASYA_TENANT_OVERRIDE && hostname === 'localhost') {
    return process.env.CITASYA_TENANT_OVERRIDE;
  }
  return null;
}
