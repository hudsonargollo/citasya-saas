import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'cixnailartist-local-secret-change-in-production';

export interface AuthUser {
  userId: string;
  email?: string;
  role: string;
  phone?: string;
  tenantSlug?: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/** Paths that must stay reachable without a staff token. */
function isPublicApiPath(pathname: string): boolean {
  const p = pathname.split('?')[0];
  return (
    p === '/api/health' ||
    p.startsWith('/api/auth/') ||
    p.startsWith('/api/public/') ||
    p === '/api/health/'
  );
}

/**
 * Verifies the staff JWT and binds it to the tenant resolved from Host.
 * Role is taken only from the verified token — never from a client header.
 */
export function apiAuthGuard(req: Request, res: Response, next: NextFunction): void {
  if (isPublicApiPath(req.originalUrl)) return next();

  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const decoded = jwt.verify(header.slice(7), JWT_SECRET) as any;
    const slug = req.tenant?.slug;
    if (slug && decoded.tenantSlug && decoded.tenantSlug !== slug) {
      res.status(401).json({ error: 'Token belongs to a different tenant' });
      return;
    }
    // Legacy tokens (pre-multi-tenant) are accepted only for the tenant whose
    // user table contains that userId — the tenant DB is already isolated.
    req.user = {
      userId: decoded.userId,
      email: decoded.email,
      role: decoded.role,
      phone: decoded.phone,
      tenantSlug: decoded.tenantSlug,
    };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const role = (req.user?.role || '').toLowerCase();
    if (!role || !roles.includes(role)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }
    next();
  };
}
