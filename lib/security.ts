import { createHash, randomBytes } from 'crypto';

export function normalizeEmail(value: string) { return value.trim().toLowerCase(); }
export function sha256(value: string) { return createHash('sha256').update(value).digest('hex'); }
export function randomToken(bytes = 32) { return randomBytes(bytes).toString('base64url'); }
export function requestContext(request: Request) {
  const forwarded = request.headers.get('x-forwarded-for');
  return {
    sourceIp: forwarded?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || null,
    userAgent: request.headers.get('user-agent') || null,
  };
}
