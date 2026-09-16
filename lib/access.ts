import { sql } from './db';
import { currentUser } from './auth';

export async function accessContext() {
  const user = await currentUser();
  if (!user) return null;
  const memberships = await sql`
    SELECT m.id::text,m.organization_id::text,m.role,o.name AS organization_name,o.kind AS organization_kind
    FROM organization_memberships m JOIN organizations o ON o.id=m.organization_id
    WHERE m.user_id=${user.id} AND m.active=true AND o.active=true`;
  const isPlatformAdmin = user.role === 'admin' || memberships.some((m:any)=>m.role==='platform_admin');
  return { user, memberships, isPlatformAdmin };
}

export async function authorizedEngagementScope() {
  const access = await accessContext();
  if (!access) return null;
  if (access.isPlatformAdmin) {
    const all = await sql`SELECT id::text FROM engagements`;
    const ids = all.map((r:any)=>r.id);
    return { access, engagementIds:ids, sensitiveEngagementIds:ids };
  }
  const memberRows = await sql`SELECT engagement_id::text,can_view_sensitive_findings FROM engagement_members WHERE user_id=${access.user.id} AND active=true`;
  const clientOrgIds = access.memberships.filter((m:any)=>m.organization_kind==='client').map((m:any)=>m.organization_id);
  const clientRows = clientOrgIds.length ? await sql`SELECT id::text FROM engagements WHERE client_organization_id = ANY(${clientOrgIds}::bigint[])` : [];
  const engagementIds = [...new Set([...memberRows.map((r:any)=>r.engagement_id),...clientRows.map((r:any)=>r.id)])];
  const sensitiveEngagementIds = memberRows.filter((r:any)=>r.can_view_sensitive_findings).map((r:any)=>r.engagement_id);
  return { access, engagementIds, sensitiveEngagementIds };
}

export function assertEngagement(scope: Awaited<ReturnType<typeof authorizedEngagementScope>>, id: string) {
  return !!scope && scope.engagementIds.includes(id);
}
