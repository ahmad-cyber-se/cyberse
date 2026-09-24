import { randomBytes } from 'crypto';
import { sql } from './db';
import { accessContext, authorizedEngagementScope } from './access';
import { audit } from './audit';
import { badRequest, conflict, forbidden, notFound, ok, serverError, unauthorized } from './http';

const deliveryRoles = ['platform_admin','project_manager','security_lead','security_consultant','software_engineer','risk_analyst'];
const architectureRoles = ['platform_admin','project_manager','security_lead','security_consultant','software_engineer'];
const engineeringRoles = ['platform_admin','project_manager','software_engineer','security_lead'];
const engagementManagerRoles = ['platform_admin','project_manager','executive'];
const teamManagerRoles = ['platform_admin','project_manager','security_lead'];

async function jsonBody(request: Request) {
  try { return await request.json() as any; }
  catch { throw new Error('Invalid JSON request body'); }
}

function isInternal(scope: Awaited<ReturnType<typeof authorizedEngagementScope>>) {
  return !!scope && (scope.access.isPlatformAdmin || scope.access.memberships.some((m:any)=>m.organization_kind==='internal'));
}

function hasInternalRole(scope: Awaited<ReturnType<typeof authorizedEngagementScope>>, roles: string[]) {
  return !!scope && (scope.access.isPlatformAdmin || scope.access.memberships.some((m:any)=>m.organization_kind==='internal' && roles.includes(m.role)));
}

function scopeHas(scope: Awaited<ReturnType<typeof authorizedEngagementScope>>, id: unknown) {
  return !!scope && scope.engagementIds.includes(String(id));
}

export async function handleExtendedGET(path: string, request: Request): Promise<Response | null> {
  try {
    const scope = await authorizedEngagementScope();

    if (path === 'assessment-targets') {
      if (!scope) return unauthorized();
      const engagementId = new URL(request.url).searchParams.get('engagementId');
      if (!engagementId || !/^\d+$/.test(engagementId)) return badRequest('Invalid engagement');
      if (!scopeHas(scope, engagementId)) return forbidden();
      const internal = isInternal(scope);
      const targets = await sql`SELECT id::text,name,target_type,identifier,environment,criticality,in_scope,notes FROM assessment_targets WHERE engagement_id=${engagementId} ORDER BY created_at DESC`;
      const assessments = internal
        ? await sql`SELECT id::text,title,assessment_type,status FROM assessments WHERE engagement_id=${engagementId} ORDER BY created_at DESC`
        : await sql`SELECT id::text,title,assessment_type,status FROM assessments WHERE engagement_id=${engagementId} AND client_visible=true ORDER BY created_at DESC`;
      const links = await sql`SELECT l.target_id::text,l.assessment_id::text,a.title FROM assessment_target_links l JOIN assessments a ON a.id=l.assessment_id WHERE a.engagement_id=${engagementId}`;
      return ok({
        targets: targets.map((t:any)=>({
          ...t,
          assessmentIds: links.filter((l:any)=>l.target_id===t.id).map((l:any)=>l.assessment_id),
          assessmentTitles: links.filter((l:any)=>l.target_id===t.id).map((l:any)=>l.title),
        })),
        assessments,
        canManage: hasInternalRole(scope, deliveryRoles),
      }, { headers:{'Cache-Control':'no-store'} });
    }

    if (path === 'engagement-team') {
      if (!scope) return unauthorized();
      const engagementId = new URL(request.url).searchParams.get('engagementId');
      if (!engagementId || !/^\d+$/.test(engagementId)) return badRequest('Invalid engagement');
      if (!scopeHas(scope, engagementId)) return forbidden();
      const [engagement] = await sql`SELECT client_organization_id::text FROM engagements WHERE id=${engagementId} LIMIT 1`;
      if (!engagement) return notFound('Engagement not found');
      const members = await sql`
        SELECT em.id::text AS member_id,em.user_id::text,u.display_name,u.email,em.responsibility,em.can_view_sensitive_findings,em.can_approve
        FROM engagement_members em JOIN users u ON u.id=em.user_id
        WHERE em.engagement_id=${engagementId} AND em.active=true ORDER BY u.display_name`;
      const eligible = await sql`
        SELECT DISTINCT u.id::text AS user_id,u.display_name,u.email,o.name AS organization_name,m.role
        FROM organization_memberships m JOIN organizations o ON o.id=m.organization_id JOIN users u ON u.id=m.user_id
        WHERE m.active=true AND u.active=true AND o.active=true AND (o.kind='internal' OR m.organization_id=${engagement.client_organization_id})
        ORDER BY u.display_name`;
      const existing = new Set(members.map((m:any)=>m.user_id));
      return ok({ members, eligibleUsers: eligible.filter((u:any)=>!existing.has(u.user_id)), canManage: hasInternalRole(scope, teamManagerRoles) }, { headers:{'Cache-Control':'no-store'} });
    }

    return null;
  } catch (error) {
    console.error('Extended portal GET failed', path, error);
    return serverError(error);
  }
}

export async function handleExtendedPOST(path: string, request: Request): Promise<Response | null> {
  try {
    if (path === 'architecture-status') {
      const scope = await authorizedEngagementScope(); if (!scope) return unauthorized();
      const input = await jsonBody(request); if (!input.decisionId) return badRequest('decisionId is required');
      const [row] = await sql`SELECT id::text,engagement_id::text,status,client_visible FROM architecture_decisions WHERE id=${input.decisionId} LIMIT 1`;
      if (!row || !scopeHas(scope,row.engagement_id)) return forbidden();
      if (!hasInternalRole(scope, architectureRoles)) return forbidden('Architecture delivery role required');
      if (row.status==='approved' && input.status && input.status!=='superseded') return conflict('An approved architecture decision can only be superseded; create a new ADR for replacement decisions');
      const status = input.status ?? row.status; const clientVisible = input.clientVisible ?? row.client_visible;
      await sql`UPDATE architecture_decisions SET status=${status},client_visible=${clientVisible},updated_at=now() WHERE id=${input.decisionId}`;
      await audit(request,{userId:scope.access.user.id,engagementId:row.engagement_id,action:'architecture_decision.updated',entityType:'architecture_decision',entityId:input.decisionId,metadata:{status,clientVisible}});
      return ok({ok:true});
    }

    if (path === 'assessment') {
      const scope = await authorizedEngagementScope(); if (!scope) return unauthorized(); const input=await jsonBody(request);
      if (!input.engagementId || !input.title || !input.assessmentType) return badRequest('engagementId, title and assessmentType are required');
      if (!scopeHas(scope,input.engagementId)) return forbidden(); if (!hasInternalRole(scope,deliveryRoles)) return forbidden('Delivery role required');
      const [row] = await sql`INSERT INTO assessments(engagement_id,title,assessment_type,status,methodology,scope_text,rules_of_engagement,planned_start_at,planned_end_at,lead_user_id,created_by_user_id,client_visible)
        VALUES (${input.engagementId},${input.title},${input.assessmentType},'planned',${input.methodology||null},${input.scopeText||null},${input.rulesOfEngagement||null},${input.plannedStartAt||null},${input.plannedEndAt||null},${scope.access.user.id},${scope.access.user.id},${!!input.clientVisible}) RETURNING id::text`;
      await audit(request,{userId:scope.access.user.id,engagementId:input.engagementId,action:'assessment.created',entityType:'assessment',entityId:row.id,metadata:{assessmentType:input.assessmentType,clientVisible:!!input.clientVisible}});
      return ok({id:row.id});
    }

    if (path === 'assessment-status') {
      const scope=await authorizedEngagementScope(); if(!scope)return unauthorized(); const input=await jsonBody(request);
      if(!input.assessmentId||!input.status)return badRequest('assessmentId and status are required');
      const [row]=await sql`SELECT id::text,engagement_id::text FROM assessments WHERE id=${input.assessmentId} LIMIT 1`;
      if(!row||!scopeHas(scope,row.engagement_id))return forbidden(); if(!hasInternalRole(scope,['platform_admin','project_manager','security_lead','security_consultant','risk_analyst']))return forbidden('Assessment management role required');
      const startedAt=input.status==='in_progress'?new Date():null; const completedAt=['completed','cancelled'].includes(input.status)?new Date():null;
      await sql`UPDATE assessments SET status=${input.status},started_at=CASE WHEN ${input.status}='in_progress' THEN COALESCE(started_at,now()) ELSE started_at END,completed_at=${completedAt},updated_at=now() WHERE id=${input.assessmentId}`;
      await audit(request,{userId:scope.access.user.id,engagementId:row.engagement_id,action:'assessment.status_changed',entityType:'assessment',entityId:input.assessmentId,metadata:{status:input.status,startedAt}});
      return ok({ok:true});
    }

    if (path === 'assessment-targets') {
      const scope=await authorizedEngagementScope(); if(!scope)return unauthorized(); const input=await jsonBody(request);
      if(!input.engagementId||!input.name||!input.targetType||!input.identifier)return badRequest('Required assessment target fields are missing');
      if(!scopeHas(scope,input.engagementId))return forbidden(); if(!hasInternalRole(scope,deliveryRoles))return forbidden('Delivery role required');
      const assessmentIds=Array.isArray(input.assessmentIds)?input.assessmentIds.map(String):[];
      if(assessmentIds.length){const rows=await sql`SELECT id::text FROM assessments WHERE engagement_id=${input.engagementId} AND id=ANY(${assessmentIds}::bigint[])`;if(rows.length!==assessmentIds.length)return badRequest('One or more assessments do not belong to this engagement');}
      const result=await sql.begin(async tx=>{const [created]=await tx`INSERT INTO assessment_targets(engagement_id,name,target_type,identifier,environment,criticality,in_scope,notes) VALUES (${input.engagementId},${input.name},${input.targetType},${input.identifier},${input.environment||null},${input.criticality||'medium'},${input.inScope!==false},${input.notes||null}) RETURNING id::text`;
        for(const assessmentId of assessmentIds)await tx`INSERT INTO assessment_target_links(assessment_id,target_id) VALUES (${assessmentId},${created.id}) ON CONFLICT DO NOTHING`;
        return created;});
      await audit(request,{userId:scope.access.user.id,engagementId:input.engagementId,action:'assessment_target.created',entityType:'assessment_target',entityId:result.id,metadata:{targetType:input.targetType,assessmentIds}});
      return ok({id:result.id});
    }

    if (path === 'engagement-status') {
      const scope=await authorizedEngagementScope(); if(!scope)return unauthorized(); const input=await jsonBody(request);
      if(!input.engagementId||!input.status)return badRequest('engagementId and status are required'); if(!scopeHas(scope,input.engagementId))return forbidden();
      if(!hasInternalRole(scope,engagementManagerRoles))return forbidden('Engagement management role required');
      await sql`UPDATE engagements SET status=${input.status},actual_end_date=CASE WHEN ${input.status}='completed' THEN now() WHEN ${input.status}='active' THEN NULL ELSE actual_end_date END,updated_at=now() WHERE id=${input.engagementId}`;
      await audit(request,{userId:scope.access.user.id,engagementId:input.engagementId,action:'engagement.status_changed',entityType:'engagement',entityId:input.engagementId,metadata:{status:input.status}}); return ok({ok:true});
    }

    if (path === 'engagement-team') {
      const scope=await authorizedEngagementScope(); if(!scope)return unauthorized(); const input=await jsonBody(request);
      if(!input.engagementId||!input.action)return badRequest('engagementId and action are required'); if(!scopeHas(scope,input.engagementId))return forbidden(); if(!hasInternalRole(scope,teamManagerRoles))return forbidden('Team management role required');
      const actor=String(scope.access.user.id);
      if(input.action==='add'){
        if(!input.userId)return badRequest('userId is required'); const [eng]=await sql`SELECT client_organization_id::text,code,title FROM engagements WHERE id=${input.engagementId} LIMIT 1`; if(!eng)return notFound('Engagement not found');
        const eligible=await sql`SELECT m.id FROM organization_memberships m JOIN organizations o ON o.id=m.organization_id WHERE m.user_id=${input.userId} AND m.active=true AND o.active=true AND (o.kind='internal' OR m.organization_id=${eng.client_organization_id}) LIMIT 1`; if(!eligible.length)return badRequest('User is not eligible for this engagement');
        const existing=await sql`SELECT id::text FROM engagement_members WHERE engagement_id=${input.engagementId} AND user_id=${input.userId} LIMIT 1`;
        if(existing.length)await sql`UPDATE engagement_members SET active=true,responsibility=${input.responsibility||null},can_view_sensitive_findings=${!!input.canViewSensitiveFindings},can_approve=${!!input.canApprove} WHERE id=${existing[0].id}`;
        else await sql`INSERT INTO engagement_members(engagement_id,user_id,responsibility,can_view_sensitive_findings,can_approve,active) VALUES (${input.engagementId},${input.userId},${input.responsibility||null},${!!input.canViewSensitiveFindings},${!!input.canApprove},true)`;
        await sql`INSERT INTO notifications(user_id,type,title,body,url) VALUES (${input.userId},'engagement_assignment','Assigned to CyberSE engagement',${`You have been added to ${eng.code} · ${eng.title}.`},${`/portal/engagements/${input.engagementId}`})`;
        await audit(request,{userId:actor,engagementId:input.engagementId,action:'engagement.member_added',entityType:'user',entityId:input.userId,metadata:{responsibility:input.responsibility||null,canViewSensitiveFindings:!!input.canViewSensitiveFindings,canApprove:!!input.canApprove}});
      }else if(input.action==='remove'){
        if(!input.memberId)return badRequest('memberId is required'); const [member]=await sql`SELECT id::text,user_id::text FROM engagement_members WHERE id=${input.memberId} AND engagement_id=${input.engagementId} LIMIT 1`; if(!member)return notFound('Team member not found'); if(member.user_id===actor)return badRequest('You cannot remove yourself from the engagement'); await sql`UPDATE engagement_members SET active=false WHERE id=${input.memberId}`; await audit(request,{userId:actor,engagementId:input.engagementId,action:'engagement.member_removed',entityType:'user',entityId:member.user_id});
      }else return badRequest('Unknown team action');
      return ok({ok:true});
    }

    if (path === 'engineering-release-status') {
      const scope=await authorizedEngagementScope(); if(!scope)return unauthorized(); const input=await jsonBody(request); if(!input.releaseId)return badRequest('releaseId is required');
      const [row]=await sql`SELECT id::text,engagement_id::text,status,client_visible,released_at FROM software_releases WHERE id=${input.releaseId} LIMIT 1`; if(!row||!scopeHas(scope,row.engagement_id))return forbidden(); if(!hasInternalRole(scope,engineeringRoles))return forbidden('Engineering delivery role required');
      const next=input.status??row.status;
      if(next==='ready'&&row.status!=='ready'){const approval=await sql`SELECT id FROM approvals WHERE engagement_id=${row.engagement_id} AND entity_type='software_release' AND entity_id=${String(input.releaseId)} AND status='approved' LIMIT 1`;if(!approval.length)return conflict('Release readiness requires an approved software release approval request');}
      if(next==='released'&&row.status!=='ready')return conflict('Only a formally approved ready release can be released');
      if(row.status==='ready'&&!['ready','released','rolled_back','cancelled'].includes(next))return conflict('A formally approved ready release cannot be moved back into development states');
      if(row.status==='released'&&!['released','rolled_back'].includes(next))return conflict('A released version may only remain released or be rolled back');
      const clientVisible=input.clientVisible??row.client_visible; await sql`UPDATE software_releases SET status=${next},client_visible=${clientVisible},released_at=CASE WHEN ${next}='released' THEN COALESCE(released_at,now()) ELSE released_at END,updated_at=now() WHERE id=${input.releaseId}`;
      await audit(request,{userId:scope.access.user.id,engagementId:row.engagement_id,action:'software_release.updated',entityType:'software_release',entityId:input.releaseId,metadata:{previousStatus:row.status,status:next,clientVisible}}); return ok({ok:true});
    }

    if (path === 'engineering-requirement-status') {
      const scope=await authorizedEngagementScope(); if(!scope)return unauthorized(); const input=await jsonBody(request); if(!input.requirementId)return badRequest('requirementId is required');
      const [row]=await sql`SELECT id::text,engagement_id::text,status,client_visible FROM engineering_requirements WHERE id=${input.requirementId} LIMIT 1`; if(!row||!scopeHas(scope,row.engagement_id))return forbidden(); if(!hasInternalRole(scope,engineeringRoles))return forbidden('Engineering delivery role required'); const next=input.status??row.status;
      if(row.status==='verified'&&next!=='verified')return conflict('A formally verified requirement cannot be regressed; create a replacement requirement when its intent changes');
      if(next==='verified'&&row.status!=='verified'){const approval=await sql`SELECT id FROM approvals WHERE engagement_id=${row.engagement_id} AND entity_type='engineering_requirement' AND entity_id=${String(input.requirementId)} AND status='approved' LIMIT 1`;if(!approval.length)return conflict('Requirement verification requires an approved engineering requirement approval request');}
      const clientVisible=input.clientVisible??row.client_visible; await sql`UPDATE engineering_requirements SET status=${next},client_visible=${clientVisible},updated_at=now() WHERE id=${input.requirementId}`; await audit(request,{userId:scope.access.user.id,engagementId:row.engagement_id,action:'engineering_requirement.updated',entityType:'engineering_requirement',entityId:input.requirementId,metadata:{status:next,clientVisible}}); return ok({ok:true});
    }

    if (path === 'milestone') {
      const scope=await authorizedEngagementScope(); if(!scope)return unauthorized(); const input=await jsonBody(request); if(!input.engagementId||!input.title)return badRequest('engagementId and title are required'); if(!scopeHas(scope,input.engagementId))return forbidden(); if(!hasInternalRole(scope,['platform_admin','project_manager','security_lead','software_engineer']))return forbidden('Delivery management role required');
      const [count]=await sql`SELECT count(*)::int AS count FROM engagement_milestones WHERE engagement_id=${input.engagementId}`; const [row]=await sql`INSERT INTO engagement_milestones(engagement_id,title,description,due_date,sort_order,client_visible) VALUES (${input.engagementId},${input.title},${input.description||null},${input.dueDate||null},${Number(count?.count||0)+1},${!!input.clientVisible}) RETURNING id::text`; await audit(request,{userId:scope.access.user.id,engagementId:input.engagementId,action:'milestone.created',entityType:'milestone',entityId:row.id,metadata:{clientVisible:!!input.clientVisible}}); return ok({id:row.id});
    }

    if (path === 'milestone-status') {
      const scope=await authorizedEngagementScope(); if(!scope)return unauthorized(); const input=await jsonBody(request); if(!input.milestoneId)return badRequest('milestoneId is required'); const [row]=await sql`SELECT id::text,engagement_id::text FROM engagement_milestones WHERE id=${input.milestoneId} LIMIT 1`; if(!row||!scopeHas(scope,row.engagement_id))return forbidden(); if(!hasInternalRole(scope,['platform_admin','project_manager','security_lead','software_engineer']))return forbidden('Delivery management role required'); await sql`UPDATE engagement_milestones SET completed_at=${input.completed?new Date():null} WHERE id=${input.milestoneId}`; await audit(request,{userId:scope.access.user.id,engagementId:row.engagement_id,action:input.completed?'milestone.completed':'milestone.reopened',entityType:'milestone',entityId:input.milestoneId}); return ok({ok:true});
    }

    if (path === 'task') {
      const scope=await authorizedEngagementScope(); if(!scope)return unauthorized(); const input=await jsonBody(request); if(!input.engagementId||!input.title)return badRequest('engagementId and title are required'); if(!scopeHas(scope,input.engagementId))return forbidden(); if(!hasInternalRole(scope,deliveryRoles))return forbidden('Delivery role required'); const actor=scope.access.user.id; const [row]=await sql`INSERT INTO engagement_tasks(engagement_id,title,description,status,priority,due_at,assignee_user_id,created_by_user_id,client_visible) VALUES (${input.engagementId},${input.title},${input.description||null},'todo',${input.priority||'medium'},${input.dueAt||null},${actor},${actor},${!!input.clientVisible}) RETURNING id::text`; await audit(request,{userId:actor,engagementId:input.engagementId,action:'task.created',entityType:'task',entityId:row.id,metadata:{priority:input.priority||'medium',clientVisible:!!input.clientVisible}}); return ok({id:row.id});
    }

    if (path === 'task-status') {
      const scope=await authorizedEngagementScope(); if(!scope)return unauthorized(); const input=await jsonBody(request); if(!input.taskId||!input.status)return badRequest('taskId and status are required'); const [row]=await sql`SELECT id::text,engagement_id::text FROM engagement_tasks WHERE id=${input.taskId} LIMIT 1`; if(!row||!scopeHas(scope,row.engagement_id))return forbidden(); if(!hasInternalRole(scope,deliveryRoles))return forbidden('Delivery role required'); await sql`UPDATE engagement_tasks SET status=${input.status},completed_at=CASE WHEN ${input.status}='done' THEN now() ELSE NULL END,updated_at=now() WHERE id=${input.taskId}`; await audit(request,{userId:scope.access.user.id,engagementId:row.engagement_id,action:'task.status_changed',entityType:'task',entityId:input.taskId,metadata:{status:input.status}}); return ok({ok:true});
    }

    if (path === 'notifications') {
      const access=await accessContext(); if(!access)return unauthorized(); const input=await jsonBody(request); if(input.markAllRead)await sql`UPDATE notifications SET read_at=now() WHERE user_id=${access.user.id} AND read_at IS NULL`; else if(input.notificationId)await sql`UPDATE notifications SET read_at=now() WHERE id=${input.notificationId} AND user_id=${access.user.id}`; else return badRequest('notificationId or markAllRead is required'); return ok({ok:true},{headers:{'Cache-Control':'no-store'}});
    }

    return null;
  } catch (error) {
    console.error('Extended portal POST failed', path, error);
    return serverError(error);
  }
}

export function nextControlledVersion(current: string) {
  const match=current.match(/^(\d+)(?:\.(\d+))?$/); return match?`${Number(match[1])}.${Number(match[2]||0)+1}`:'1.1';
}

export function controlledDocumentCode() { return `DOC-${randomBytes(3).toString('hex').toUpperCase()}`; }
