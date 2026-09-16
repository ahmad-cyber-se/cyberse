import { NextRequest } from 'next/server';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { sql } from '@/lib/db';
import { audit } from '@/lib/audit';
import { createSession, currentUser, destroyCurrentSession, getSessionId } from '@/lib/auth';
import { badRequest, conflict, created, ok, serverError, unauthorized } from '@/lib/http';
import { normalizeEmail, randomToken, requestContext, sha256 } from '@/lib/security';

export const runtime = 'nodejs';

type Params = { params: Promise<{ path: string[] }> };

const passwordRule = z.string().min(12).max(128).refine(v => /[A-Z]/.test(v) && /[a-z]/.test(v) && /\d/.test(v) && /[^A-Za-z0-9]/.test(v), 'Password must include upper, lower, number and symbol');

async function routePath(ctx: Params) { return (await ctx.params).path?.join('/') || ''; }

export async function GET(request: NextRequest, ctx: Params) {
  try {
    const path = await routePath(ctx);
    if (path === 'session') {
      const user = await currentUser();
      if (!user) return unauthorized();
      return ok({ user });
    }
    if (path === 'bootstrap-status') {
      const [{ count }] = await sql`SELECT count(*)::int AS count FROM users`;
      return ok({ bootstrapRequired: Number(count) === 0 });
    }
    if (path === 'invitation') {
      const token = request.nextUrl.searchParams.get('token');
      if (!token) return badRequest('Invitation token is required');
      const rows = await sql`SELECT id::text,email,display_name,organization_id::text,membership_role,expires_at,accepted_at,revoked_at FROM user_invitations WHERE token_hash=${sha256(token)} LIMIT 1`;
      if (!rows.length) return badRequest('Invitation is invalid');
      const row:any = rows[0];
      const valid = !row.accepted_at && !row.revoked_at && new Date(row.expires_at) > new Date();
      return ok({ invitation: { ...row, valid } });
    }
    if (path === 'password-reset') {
      const token = request.nextUrl.searchParams.get('token');
      if (!token) return badRequest('Reset token is required');
      const rows = await sql`SELECT id::text,expires_at,used_at,revoked_at FROM password_reset_tokens WHERE token_hash=${sha256(token)} LIMIT 1`;
      const row:any = rows[0];
      return ok({ valid: !!row && !row.used_at && !row.revoked_at && new Date(row.expires_at) > new Date() });
    }
    return badRequest('Unknown authentication route');
  } catch (error) { return serverError(error); }
}

export async function POST(request: NextRequest, ctx: Params) {
  try {
    const path = await routePath(ctx);
    if (path === 'login') {
      const body = z.object({ email:z.string().email(), password:z.string().min(1) }).parse(await request.json());
      const email = normalizeEmail(body.email);
      const security = requestContext(request);
      const recent = await sql`SELECT count(*)::int AS failures FROM login_attempts WHERE email=${email} AND success=false AND attempted_at > now()-interval '15 minutes'`;
      if (Number(recent[0]?.failures || 0) >= 8) return badRequest('Too many failed attempts. Try again later.');
      const rows = await sql`SELECT u.id::text,u.email,u.display_name,u.role,u.avatar_url,p.password_hash FROM users u JOIN user_passwords p ON p.user_id=u.id WHERE lower(u.email)=${email} AND u.active=true LIMIT 1`;
      const valid = rows.length && await bcrypt.compare(body.password, String((rows[0] as any).password_hash));
      await sql`INSERT INTO login_attempts(email,source_ip,user_agent,success) VALUES (${email},${security.sourceIp},${security.userAgent},${!!valid})`;
      if (!valid) {
        await audit(request,{action:'security.login_failure',entityType:'user',outcome:'denied',metadata:{email}});
        return unauthorized('Invalid email or password');
      }
      const user:any = rows[0];
      const sessionId = await createSession(user.id, request);
      await audit(request,{userId:user.id,action:'security.login_success',entityType:'session',entityId:sessionId});
      return ok({ user:{id:user.id,email:user.email,displayName:user.display_name,role:user.role,avatarUrl:user.avatar_url} });
    }

    if (path === 'logout') {
      const user = await currentUser();
      const sessionId = await getSessionId();
      if (user) await audit(request,{userId:user.id,action:'security.logout',entityType:'session',entityId:sessionId});
      await destroyCurrentSession();
      return ok({ success:true });
    }

    if (path === 'bootstrap') {
      const body = z.object({ email:z.string().email(), displayName:z.string().min(2).max(120), password:passwordRule }).parse(await request.json());
      const [{ count }] = await sql`SELECT count(*)::int AS count FROM users`;
      if (Number(count) !== 0) return conflict('Initial administrator already exists');
      const email = normalizeEmail(body.email);
      const hash = await bcrypt.hash(body.password,12);
      const result = await sql.begin(async tx => {
        const [org] = await tx`INSERT INTO organizations(name,slug,kind,country_code) VALUES ('CyberSE','cyberse','internal','AE') RETURNING id::text`;
        const [user] = await tx`INSERT INTO users(email,display_name,role) VALUES (${email},${body.displayName},'admin') RETURNING id::text,email,display_name,role,avatar_url`;
        await tx`INSERT INTO user_passwords(user_id,password_hash) VALUES (${user.id},${hash})`;
        await tx`INSERT INTO user_profiles(user_id) VALUES (${user.id})`;
        await tx`INSERT INTO organization_memberships(organization_id,user_id,role) VALUES (${org.id},${user.id},'platform_admin')`;
        return {org,user};
      });
      const sessionId = await createSession(result.user.id,request);
      await audit(request,{userId:result.user.id,organizationId:result.org.id,action:'platform.bootstrap',entityType:'user',entityId:result.user.id,metadata:{bootstrap:true}});
      return created({ user:{id:result.user.id,email:result.user.email,displayName:result.user.display_name,role:result.user.role,avatarUrl:result.user.avatar_url}, sessionId });
    }

    if (path === 'accept-invitation') {
      const body = z.object({ token:z.string().min(20), password:passwordRule }).parse(await request.json());
      const tokenHash = sha256(body.token);
      const invites = await sql`SELECT * FROM user_invitations WHERE token_hash=${tokenHash} AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now() LIMIT 1`;
      if (!invites.length) return badRequest('Invitation is invalid or expired');
      const inv:any=invites[0];
      const passwordHash=await bcrypt.hash(body.password,12);
      const user = await sql.begin(async tx=>{
        const existing=await tx`SELECT id::text,email,display_name,role,avatar_url FROM users WHERE lower(email)=lower(${inv.email}) LIMIT 1`;
        const u:any=existing[0] || (await tx`INSERT INTO users(email,display_name) VALUES (${normalizeEmail(inv.email)},${inv.display_name}) RETURNING id::text,email,display_name,role,avatar_url`)[0];
        await tx`INSERT INTO user_passwords(user_id,password_hash) VALUES (${u.id},${passwordHash}) ON CONFLICT(user_id) DO UPDATE SET password_hash=excluded.password_hash,updated_at=now()`;
        await tx`INSERT INTO user_profiles(user_id) VALUES (${u.id}) ON CONFLICT(user_id) DO NOTHING`;
        await tx`INSERT INTO organization_memberships(organization_id,user_id,role,invited_by_user_id) VALUES (${inv.organization_id},${u.id},${inv.membership_role},${inv.invited_by_user_id}) ON CONFLICT(organization_id,user_id) DO UPDATE SET role=excluded.role,active=true`;
        await tx`UPDATE user_invitations SET accepted_at=now() WHERE id=${inv.id}`;
        return u;
      });
      await createSession(user.id,request);
      await audit(request,{userId:user.id,organizationId:inv.organization_id,action:'identity.invitation_accepted',entityType:'user_invitation',entityId:inv.id});
      return ok({user:{id:user.id,email:user.email,displayName:user.display_name,role:user.role,avatarUrl:user.avatar_url}});
    }

    if (path === 'change-password') {
      const user=await currentUser();
      if(!user) return unauthorized();
      const body=z.object({currentPassword:z.string().min(1),newPassword:passwordRule}).parse(await request.json());
      const rows=await sql`SELECT password_hash FROM user_passwords WHERE user_id=${user.id}`;
      if(!rows.length || !(await bcrypt.compare(body.currentPassword,String((rows[0] as any).password_hash)))) return unauthorized('Current password is incorrect');
      const hash=await bcrypt.hash(body.newPassword,12);
      await sql.begin(async tx=>{await tx`UPDATE user_passwords SET password_hash=${hash},updated_at=now() WHERE user_id=${user.id}`; await tx`DELETE FROM sessions WHERE user_id=${user.id}`;});
      await destroyCurrentSession();
      await audit(request,{userId:user.id,action:'security.password_changed',entityType:'user',entityId:user.id});
      return ok({success:true,reloginRequired:true});
    }

    if (path === 'request-password-reset') {
      const body=z.object({email:z.string().email()}).parse(await request.json());
      const rows=await sql`SELECT id::text FROM users WHERE lower(email)=lower(${body.email}) AND active=true LIMIT 1`;
      if(rows.length){
        const token=randomToken();
        await sql`INSERT INTO password_reset_tokens(user_id,token_hash,expires_at) VALUES (${(rows[0] as any).id},${sha256(token)},now()+interval '30 minutes')`;
        console.log('Password reset requested for user', (rows[0] as any).id);
      }
      return ok({success:true,message:'If the account exists, a reset workflow has been initiated.'});
    }

    if (path === 'reset-password') {
      const body=z.object({token:z.string().min(20),password:passwordRule}).parse(await request.json());
      const rows=await sql`SELECT id::text,user_id::text FROM password_reset_tokens WHERE token_hash=${sha256(body.token)} AND used_at IS NULL AND revoked_at IS NULL AND expires_at>now() LIMIT 1`;
      if(!rows.length) return badRequest('Reset token is invalid or expired');
      const row:any=rows[0]; const hash=await bcrypt.hash(body.password,12);
      await sql.begin(async tx=>{await tx`UPDATE user_passwords SET password_hash=${hash},updated_at=now() WHERE user_id=${row.user_id}`;await tx`UPDATE password_reset_tokens SET used_at=now() WHERE id=${row.id}`;await tx`DELETE FROM sessions WHERE user_id=${row.user_id}`;});
      await audit(request,{userId:row.user_id,action:'security.password_reset',entityType:'user',entityId:row.user_id});
      return ok({success:true});
    }

    return badRequest('Unknown authentication route');
  } catch (error:any) {
    if(error?.name==='ZodError') return badRequest(error.issues?.[0]?.message || 'Invalid input');
    return serverError(error);
  }
}
