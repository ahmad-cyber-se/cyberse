import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';
import { randomUUID } from 'crypto';
import { sql } from './db';

const COOKIE = 'cyberse_session';
const MAX_AGE = 60 * 60 * 24;

function key() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
  return new TextEncoder().encode(secret);
}

export type CurrentUser = { id: string; email: string; displayName: string; role: 'user'|'admin'; avatarUrl: string|null };

export async function createSession(userId: string | number, request: Request) {
  const id = randomUUID().replaceAll('-', '');
  const expires = new Date(Date.now() + MAX_AGE * 1000);
  const sourceIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || request.headers.get('x-real-ip');
  const ua = request.headers.get('user-agent');
  await sql`INSERT INTO sessions(id,user_id,expires_at,source_ip,user_agent) VALUES (${id},${userId},${expires},${sourceIp},${ua})`;
  const token = await new SignJWT({ id }).setProtectedHeader({alg:'HS256'}).setIssuedAt().setExpirationTime(Math.floor(expires.getTime()/1000)).sign(key());
  const store = await cookies();
  store.set(COOKIE, token, { httpOnly:true, secure: process.env.NODE_ENV === 'production', sameSite:'lax', path:'/', maxAge:MAX_AGE });
  return id;
}

export async function clearSession() {
  const store = await cookies();
  store.set(COOKIE, '', { httpOnly:true, secure: process.env.NODE_ENV === 'production', sameSite:'lax', path:'/', maxAge:0 });
}

export async function getSessionId() {
  const store = await cookies();
  const token = store.get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key());
    return typeof payload.id === 'string' ? payload.id : null;
  } catch { return null; }
}

export async function currentUser(): Promise<CurrentUser|null> {
  const sessionId = await getSessionId();
  if (!sessionId) return null;
  const rows = await sql`
    SELECT u.id::text,u.email,u.display_name,u.role,u.avatar_url
    FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.id=${sessionId} AND s.expires_at>now() AND u.active=true LIMIT 1`;
  if (!rows.length) return null;
  await sql`UPDATE sessions SET last_accessed=now() WHERE id=${sessionId}`;
  const u = rows[0] as any;
  return { id:u.id, email:u.email, displayName:u.display_name, role:u.role, avatarUrl:u.avatar_url };
}

export async function destroyCurrentSession() {
  const sessionId = await getSessionId();
  if (sessionId) await sql`DELETE FROM sessions WHERE id=${sessionId}`;
  await clearSession();
}
