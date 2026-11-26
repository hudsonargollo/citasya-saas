import { Request, Response, NextFunction } from 'express';
import { getTenantBySlug, slugFromHost, Tenant } from '../tenants';
import { runWithTenant } from '../db';

declare global {
  namespace Express {
    interface Request {
      tenant?: Tenant;
    }
  }
}

/**
 * Resolves the tenant from the request Host and runs the rest of the request
 * inside that tenant's DB context. Registers BEFORE all API routes so every
 * getDatabase() call sees the correct isolated database.
 */
export function tenantMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Health endpoint must work without a tenant (monitoring / load balancer).
  if (req.path === '/api/health') return next();

  const forwarded = req.headers['x-forwarded-host'];
  const hostHeader = Array.isArray(forwarded) ? forwarded[0] : (forwarded || req.headers.host);
  const slug = slugFromHost(hostHeader);
  if (!slug) {
    // Dev/test only: localhost requests fall back to the single configured tenant.
    if (process.env.NODE_ENV !== 'production' && process.env.CITASYA_TENANT_OVERRIDE) {
      const fallback = getTenantBySlug(process.env.CITASYA_TENANT_OVERRIDE);
      if (fallback) {
        req.tenant = fallback;
        return runWithTenant(fallback.slug, () => next());
      }
    }
    res.status(404).json({ error: 'Unknown tenant host' });
    return;
  }

  const tenant = getTenantBySlug(slug);
  if (!tenant) {
    res.status(404).json({ error: 'Unknown tenant' });
    return;
  }

  req.tenant = tenant;
  runWithTenant(slug, () => next());
}
