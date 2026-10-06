import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export function bearerTokenMatches(header: string | undefined, expected: string): boolean {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const received = Buffer.from(match[1]);
  const configured = Buffer.from(expected);
  return received.length === configured.length && timingSafeEqual(received, configured);
}

export function requireBearerToken(environmentVariable: string) {
  return (_req: Request, res: Response, next: NextFunction) => {
    const expected = process.env[environmentVariable];
    if (!expected) return res.status(503).json({ error: `${environmentVariable} non configuré` });
    if (!bearerTokenMatches(_req.header('authorization'), expected)) {
      return res.status(401).json({ error: 'Authentification requise' });
    }
    next();
  };
}