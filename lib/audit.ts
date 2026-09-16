import { sql } from './db';
import { requestContext } from './security';

export async function audit(request: Request, entry: {
  userId?: string | number | null;
  organizationId?: string | number | null;
  engagementId?: string | number | null;
  action: string;
  entityType: string;
  entityId?: string | number | null;
  outcome?: string;
  metadata?: unknown;
}) {
  const ctx = requestContext(request);
  await sql`
    INSERT INTO audit_events(user_id,organization_id,engagement_id,action,entity_type,entity_id,outcome,source_ip,user_agent,metadata)
    VALUES (${entry.userId ?? null},${entry.organizationId ?? null},${entry.engagementId ?? null},${entry.action},${entry.entityType},${entry.entityId == null ? null : String(entry.entityId)},${entry.outcome ?? 'success'},${ctx.sourceIp},${ctx.userAgent},${entry.metadata == null ? null : sql.json(entry.metadata as any)})
  `;
}
