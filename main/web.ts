import { initDatabase } from './db';
import { startServer } from './server';
import { initTenantRegistry, listTenants } from './tenants';

// Multi-tenant headless mode: one process serves every active tenant subdomain.
// Each tenant gets its own SQLite DB in its own data_dir (see control.db).
initTenantRegistry();

const tenants = listTenants();
if (tenants.length === 0) {
  console.warn('[Tenants] No tenants registered. Set up tenant 1 with scripts/provision-tenant.mjs');
  // Backwards-compatible single-tenant fallback for local dev.
  initDatabase();
} else {
  for (const tenant of tenants) {
    initDatabase(tenant.slug, tenant.data_dir);
  }
  console.log(`[Tenants] Loaded ${tenants.length} tenant(s): ${tenants.map(t => t.slug).join(', ')}`);
}

startServer();
