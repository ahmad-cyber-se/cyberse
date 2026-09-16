import { NextRequest } from 'next/server';
import { z } from 'zod';
import { sql } from '@/lib/db';
import { accessContext } from '@/lib/access';
import { audit } from '@/lib/audit';
import { badRequest, created, forbidden, notFound, ok, serverError, unauthorized } from '@/lib/http';
import { randomToken, sha256 } from '@/lib/security';

export const runtime='nodejs';
type Params={params:Promise<{path:string[]}>};
async function p(ctx:Params){return (await ctx.params).path?.join('/')||'';}
async function admin(){const a=await accessContext();return a?.isPlatformAdmin?a:null;}

export async function GET(request:NextRequest,ctx:Params){
  try{
    const access=await admin();if(!access)return (await accessContext())?forbidden():unauthorized();const path=await p(ctx);const q=request.nextUrl.searchParams;
    if(path==='overview'){
      const [users,orgs,inquiries,engagements,content,applications]=await Promise.all([
        sql`SELECT count(*)::int total,count(*) FILTER(WHERE active)::int active FROM users`,
        sql`SELECT count(*)::int total,count(*) FILTER(WHERE active)::int active FROM organizations`,
        sql`SELECT count(*)::int total,count(*) FILTER(WHERE status NOT IN ('won','lost','archived'))::int open FROM contact_inquiries`,
        sql`SELECT count(*)::int total,count(*) FILTER(WHERE status='active')::int active FROM engagements`,
        sql`SELECT (SELECT count(*) FROM insight_posts)::int insights,(SELECT count(*) FROM case_studies)::int case_studies,(SELECT count(*) FROM content_pages)::int pages,(SELECT count(*) FROM career_openings)::int careers`,
        sql`SELECT count(*)::int total,count(*) FILTER(WHERE status='received')::int received FROM career_applications`
      ]);return ok({users:users[0],organizations:orgs[0],inquiries:inquiries[0],engagements:engagements[0],content:content[0],careerApplications:applications[0]});
    }
    if(path==='users') return ok({items:await sql`SELECT u.id::text,u.email,u.display_name,u.role,u.active,u.created_at,array_remove(array_agg(DISTINCT m.role::text),NULL) roles FROM users u LEFT JOIN organization_memberships m ON m.user_id=u.id AND m.active=true GROUP BY u.id ORDER BY u.created_at DESC`});
    if(path==='organizations') return ok({items:await sql`SELECT o.id::text,o.name,o.slug,o.kind,o.website,o.industry,o.country_code,o.active,o.created_at,count(m.id)::int members FROM organizations o LEFT JOIN organization_memberships m ON m.organization_id=o.id AND m.active=true GROUP BY o.id ORDER BY o.name`});
    if(path==='memberships'){const organizationId=q.get('organizationId');if(!organizationId)return badRequest('organizationId is required');return ok({items:await sql`SELECT m.id::text,m.role,m.active,m.joined_at,u.id::text user_id,u.email,u.display_name FROM organization_memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=${organizationId} ORDER BY u.display_name`});}
    if(path==='inquiries'){const id=q.get('id');if(id){const rows=await sql`SELECT * FROM contact_inquiries WHERE id=${id}`;if(!rows.length)return notFound();const notes=await sql`SELECT n.id::text,n.body,n.created_at,u.display_name author_name FROM inquiry_notes n JOIN users u ON u.id=n.author_user_id WHERE n.inquiry_id=${id} ORDER BY n.created_at`;return ok({item:rows[0],notes});}return ok({items:await sql`SELECT id::text,reference_code,status,full_name,work_email,company_name,service_code,assigned_user_id::text,created_at,updated_at FROM contact_inquiries ORDER BY created_at DESC LIMIT 1000`});}
    if(path==='content'){
      const kind=q.get('kind')||'insights';
      if(kind==='insights')return ok({items:await sql`SELECT * FROM insight_posts ORDER BY updated_at DESC`});
      if(kind==='case-studies')return ok({items:await sql`SELECT * FROM case_studies ORDER BY updated_at DESC`});
      if(kind==='careers')return ok({items:await sql`SELECT * FROM career_openings ORDER BY posted_at DESC`});
      if(kind==='pages')return ok({items:await sql`SELECT * FROM content_pages ORDER BY updated_at DESC`});
      return badRequest('Unknown content kind');
    }
    if(path==='career-applications') return ok({items:await sql`SELECT a.id::text,a.full_name,a.email,a.phone,a.current_location,a.linkedin_url,a.portfolio_url,a.cover_note,a.resume_storage_key,a.status,a.created_at,o.title opening_title FROM career_applications a LEFT JOIN career_openings o ON o.id=a.opening_id ORDER BY a.created_at DESC`});
    if(path==='release-runs')return ok({items:await sql`SELECT id::text,release_code,environment,status,readiness_percent,pass_count,warning_count,blocker_count,summary,created_at FROM production_release_runs ORDER BY created_at DESC LIMIT 100`});
    return badRequest('Unknown admin route');
  }catch(e){return serverError(e);}
}

export async function POST(request:NextRequest,ctx:Params){
  try{
    const access=await admin();if(!access)return (await accessContext())?forbidden():unauthorized();const path=await p(ctx);const body:any=await request.json();
    if(path==='organizations'){
      const b=z.object({name:z.string().min(2).max(200),slug:z.string().regex(/^[a-z0-9-]+$/).max(100),kind:z.enum(['internal','client','partner']),website:z.string().url().optional().nullable().or(z.literal('')),industry:z.string().max(160).optional().nullable(),countryCode:z.string().length(2).optional().nullable()}).parse(body);const [row]=await sql`INSERT INTO organizations(name,slug,kind,website,industry,country_code) VALUES (${b.name},${b.slug},${b.kind}::organization_kind,${b.website||null},${b.industry??null},${b.countryCode?.toUpperCase()??null}) RETURNING id::text,name,slug,kind`;await audit(request,{userId:access.user.id,organizationId:(row as any).id,action:'admin.organization_created',entityType:'organization',entityId:(row as any).id});return created({item:row});
    }
    if(path==='memberships'){
      const b=z.object({organizationId:z.union([z.string(),z.number()]),userId:z.union([z.string(),z.number()]),role:z.enum(['platform_admin','executive','sales','project_manager','security_lead','security_consultant','software_engineer','risk_analyst','client_admin','client_member','auditor','content_editor']),active:z.boolean().optional().default(true)}).parse(body);await sql`INSERT INTO organization_memberships(organization_id,user_id,role,active,invited_by_user_id) VALUES (${b.organizationId},${b.userId},${b.role}::membership_role,${b.active},${access.user.id}) ON CONFLICT(organization_id,user_id) DO UPDATE SET role=excluded.role,active=excluded.active`;await audit(request,{userId:access.user.id,organizationId:b.organizationId,action:'admin.membership_upserted',entityType:'user',entityId:b.userId,metadata:{role:b.role,active:b.active}});return ok({success:true});
    }
    if(path==='invite'){
      const b=z.object({email:z.string().email(),displayName:z.string().min(2).max(120),organizationId:z.union([z.string(),z.number()]),role:z.enum(['platform_admin','executive','sales','project_manager','security_lead','security_consultant','software_engineer','risk_analyst','client_admin','client_member','auditor','content_editor'])}).parse(body);const token=randomToken();const [row]=await sql`INSERT INTO user_invitations(email,display_name,organization_id,membership_role,invited_by_user_id,token_hash,expires_at) VALUES (${b.email.toLowerCase()},${b.displayName},${b.organizationId},${b.role}::membership_role,${access.user.id},${sha256(token)},now()+interval '7 days') RETURNING id::text,email,expires_at`;await audit(request,{userId:access.user.id,organizationId:b.organizationId,action:'admin.invitation_created',entityType:'user_invitation',entityId:(row as any).id,metadata:{role:b.role}});const base=process.env.NEXT_PUBLIC_APP_URL||request.nextUrl.origin;return created({item:row,inviteUrl:`${base}/accept-invite?token=${encodeURIComponent(token)}`});
    }
    if(path==='user-security'){
      const b=z.object({userId:z.union([z.string(),z.number()]),active:z.boolean().optional(),revokeSessions:z.boolean().optional()}).parse(body);if(String(b.userId)===access.user.id&&b.active===false)return badRequest('You cannot disable your own administrator account');if(typeof b.active==='boolean')await sql`UPDATE users SET active=${b.active},updated_at=now() WHERE id=${b.userId}`;if(b.revokeSessions)await sql`DELETE FROM sessions WHERE user_id=${b.userId}`;await audit(request,{userId:access.user.id,action:'admin.user_security_changed',entityType:'user',entityId:b.userId,metadata:{active:b.active,revokeSessions:!!b.revokeSessions}});return ok({success:true});
    }
    if(path==='inquiry-note'){
      const b=z.object({inquiryId:z.union([z.string(),z.number()]),body:z.string().min(1).max(5000)}).parse(body);const [row]=await sql`INSERT INTO inquiry_notes(inquiry_id,author_user_id,body) VALUES (${b.inquiryId},${access.user.id},${b.body}) RETURNING id::text,created_at`;await audit(request,{userId:access.user.id,action:'inquiry.note_added',entityType:'contact_inquiry',entityId:b.inquiryId});return created({item:row});
    }
    if(path==='inquiry-status'){
      const b=z.object({inquiryId:z.union([z.string(),z.number()]),status:z.enum(['new','qualified','discovery','proposal','won','lost','archived']),assignedUserId:z.union([z.string(),z.number()]).optional().nullable()}).parse(body);await sql`UPDATE contact_inquiries SET status=${b.status}::lead_status,assigned_user_id=${b.assignedUserId??null},updated_at=now() WHERE id=${b.inquiryId}`;await audit(request,{userId:access.user.id,action:'inquiry.status_changed',entityType:'contact_inquiry',entityId:b.inquiryId,metadata:{status:b.status}});return ok({success:true});
    }
    if(path==='content'){
      const b=z.object({kind:z.enum(['insights','case-studies','careers','pages']),id:z.union([z.string(),z.number()]).optional(),slug:z.string().regex(/^[a-z0-9-]+$/),title:z.string().min(2),summary:z.string().optional().nullable(),body:z.string().optional().nullable(),status:z.enum(['draft','review','scheduled','published','archived']).optional(),publishedAt:z.string().datetime().optional().nullable(),extra:z.record(z.any()).optional()}).parse(body);let row:any;
      if(b.kind==='insights') {
        if(b.id) [row]=await sql`UPDATE insight_posts SET slug=${b.slug},title=${b.title},excerpt=${b.summary??''},body=${b.body??''},category=${b.extra?.category??null},tags=${b.extra?.tags??[]},status=${b.status??'draft'}::content_status,featured=${!!b.extra?.featured},published_at=${b.publishedAt??null},updated_at=now() WHERE id=${b.id} RETURNING id::text,title,status`;
        else [row]=await sql`INSERT INTO insight_posts(slug,title,excerpt,body,category,tags,status,featured,author_user_id,published_at) VALUES (${b.slug},${b.title},${b.summary??''},${b.body??''},${b.extra?.category??null},${b.extra?.tags??[]},${b.status??'draft'}::content_status,${!!b.extra?.featured},${access.user.id},${b.publishedAt??null}) RETURNING id::text,title,status`;
      } else if(b.kind==='case-studies') {
        if(b.id) [row]=await sql`UPDATE case_studies SET slug=${b.slug},title=${b.title},client_label=${b.extra?.clientLabel??null},industry=${b.extra?.industry??null},challenge=${b.extra?.challenge??''},solution=${b.extra?.solution??''},outcome=${b.extra?.outcome??''},services=${b.extra?.services??[]},status=${b.status??'draft'}::content_status,featured=${!!b.extra?.featured},published_at=${b.publishedAt??null},updated_at=now() WHERE id=${b.id} RETURNING id::text,title,status`;
        else [row]=await sql`INSERT INTO case_studies(slug,title,client_label,industry,challenge,solution,outcome,services,status,featured,published_at) VALUES (${b.slug},${b.title},${b.extra?.clientLabel??null},${b.extra?.industry??null},${b.extra?.challenge??''},${b.extra?.solution??''},${b.extra?.outcome??''},${b.extra?.services??[]},${b.status??'draft'}::content_status,${!!b.extra?.featured},${b.publishedAt??null}) RETURNING id::text,title,status`;
      } else if(b.kind==='careers') {
        if(b.id) [row]=await sql`UPDATE career_openings SET slug=${b.slug},title=${b.title},location=${b.extra?.location??null},employment_type=${b.extra?.employmentType??null},summary=${b.summary??''},description=${b.body??''},active=${b.status!=='archived'},closes_at=${b.extra?.closesAt??null} WHERE id=${b.id} RETURNING id::text,title,active`;
        else [row]=await sql`INSERT INTO career_openings(slug,title,location,employment_type,summary,description,active,closes_at) VALUES (${b.slug},${b.title},${b.extra?.location??null},${b.extra?.employmentType??null},${b.summary??''},${b.body??''},${b.status!=='archived'},${b.extra?.closesAt??null}) RETURNING id::text,title,active`;
      } else {
        if(b.id) [row]=await sql`UPDATE content_pages SET slug=${b.slug},title=${b.title},eyebrow=${b.extra?.eyebrow??null},summary=${b.summary??null},body=${b.body??''},seo_title=${b.extra?.seoTitle??null},seo_description=${b.extra?.seoDescription??null},status=${b.status??'draft'}::content_status,published_at=${b.publishedAt??null},updated_at=now() WHERE id=${b.id} RETURNING id::text,title,status`;
        else [row]=await sql`INSERT INTO content_pages(slug,title,eyebrow,summary,body,seo_title,seo_description,status,published_at,author_user_id) VALUES (${b.slug},${b.title},${b.extra?.eyebrow??null},${b.summary??null},${b.body??''},${b.extra?.seoTitle??null},${b.extra?.seoDescription??null},${b.status??'draft'}::content_status,${b.publishedAt??null},${access.user.id}) RETURNING id::text,title,status`;
      }
      if(!row) return badRequest('Content record was not found');
      await audit(request,{userId:access.user.id,action:'content.saved',entityType:b.kind,entityId:(row as any).id,metadata:{status:b.status||'draft'}});return ok({item:row});
    }
    if(path==='career-application-status'){
      const b=z.object({id:z.union([z.string(),z.number()]),status:z.string().min(2).max(40)}).parse(body);await sql`UPDATE career_applications SET status=${b.status} WHERE id=${b.id}`;await audit(request,{userId:access.user.id,action:'career.application_status_changed',entityType:'career_application',entityId:b.id,metadata:{status:b.status}});return ok({success:true});
    }
    if(path==='release-run'){
      const b=z.object({releaseCode:z.string().min(4),environment:z.string().min(2),status:z.string().min(2),readinessPercent:z.number().int().min(0).max(100),passCount:z.number().int().nonnegative(),warningCount:z.number().int().nonnegative(),blockerCount:z.number().int().nonnegative(),summary:z.record(z.any()).default({})}).parse(body);const [row]=await sql`INSERT INTO production_release_runs(release_code,environment,status,readiness_percent,pass_count,warning_count,blocker_count,summary,initiated_by_user_id) VALUES (${b.releaseCode},${b.environment},${b.status},${b.readinessPercent},${b.passCount},${b.warningCount},${b.blockerCount},${sql.json(b.summary)},${access.user.id}) RETURNING id::text,release_code,status,readiness_percent,created_at`;await audit(request,{userId:access.user.id,action:'production.release_gate_captured',entityType:'production_release_run',entityId:(row as any).id,metadata:{releaseCode:b.releaseCode,status:b.status,readinessPercent:b.readinessPercent}});return created({item:row});
    }
    return badRequest('Unknown admin route');
  }catch(e:any){if(e?.name==='ZodError')return badRequest(e.issues?.[0]?.message||'Invalid input');return serverError(e);}
}
