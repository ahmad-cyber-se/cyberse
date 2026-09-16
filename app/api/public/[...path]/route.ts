import { NextRequest } from 'next/server';
import { z } from 'zod';
import { sql } from '@/lib/db';
import { audit } from '@/lib/audit';
import { badRequest, created, notFound, ok, serverError } from '@/lib/http';
import { sha256, requestContext } from '@/lib/security';
import { storePrivateFile } from '@/lib/storage';

export const runtime='nodejs';
type Params={params:Promise<{path:string[]}>};
async function p(ctx:Params){return (await ctx.params).path?.join('/')||'';}

async function publicRateLimit(request:Request,eventType:string,subject:string,limit=8,minutes=30){
  const c=requestContext(request); const subjectHash=sha256(`${eventType}|${c.sourceIp||''}|${subject.toLowerCase()}`);
  const rows=await sql`SELECT count(*)::int AS count FROM public_rate_limit_events WHERE event_type=${eventType} AND subject_hash=${subjectHash} AND created_at>now()-(${minutes}||' minutes')::interval`;
  if(Number(rows[0]?.count||0)>=limit) throw new Error('RATE_LIMIT');
  await sql`INSERT INTO public_rate_limit_events(event_type,source_ip,subject_hash) VALUES (${eventType},${c.sourceIp},${subjectHash})`;
}

export async function GET(request:NextRequest,ctx:Params){
  try{
    const path=await p(ctx);
    if(path==='content'){
      const kind=request.nextUrl.searchParams.get('kind')||'insights';
      if(kind==='insights') return ok({items:await sql`SELECT id::text,slug,title,excerpt,category,tags,featured,published_at FROM insight_posts WHERE status='published' AND published_at IS NOT NULL AND published_at<=now() ORDER BY featured DESC,published_at DESC`});
      if(kind==='case-studies') return ok({items:await sql`SELECT id::text,slug,title,client_label,industry,challenge,solution,outcome,services,featured,published_at FROM case_studies WHERE status='published' AND published_at IS NOT NULL AND published_at<=now() ORDER BY featured DESC,published_at DESC`});
      if(kind==='careers') return ok({items:await sql`SELECT id::text,slug,title,location,employment_type,summary,description,posted_at,closes_at FROM career_openings WHERE active=true AND (closes_at IS NULL OR closes_at>now()) ORDER BY posted_at DESC`});
      if(kind==='pages') return ok({items:await sql`SELECT id::text,slug,title,eyebrow,summary,seo_title,seo_description,published_at FROM content_pages WHERE status='published' AND published_at IS NOT NULL AND published_at<=now() ORDER BY title`});
      return badRequest('Unknown content kind');
    }
    if(path==='item'){
      const kind=request.nextUrl.searchParams.get('kind'); const slug=request.nextUrl.searchParams.get('slug');
      if(!slug) return badRequest('slug is required');
      let rows:any[]=[];
      if(kind==='insight') rows=await sql`SELECT id::text,slug,title,excerpt,body,category,tags,published_at FROM insight_posts WHERE slug=${slug} AND status='published' AND published_at<=now() LIMIT 1`;
      else if(kind==='career') rows=await sql`SELECT id::text,slug,title,location,employment_type,summary,description,posted_at,closes_at FROM career_openings WHERE slug=${slug} AND active=true AND (closes_at IS NULL OR closes_at>now()) LIMIT 1`;
      else if(kind==='page') rows=await sql`SELECT id::text,slug,title,eyebrow,summary,body,seo_title,seo_description,published_at FROM content_pages WHERE slug=${slug} AND status='published' AND published_at<=now() LIMIT 1`;
      else if(kind==='case-study') rows=await sql`SELECT id::text,slug,title,client_label,industry,challenge,solution,outcome,services,published_at FROM case_studies WHERE slug=${slug} AND status='published' AND published_at<=now() LIMIT 1`;
      if(!rows.length) return notFound(); return ok({item:rows[0]});
    }
    if(path==='services') return ok({items:await sql`SELECT id::text,code,name,summary,sort_order FROM service_catalog WHERE active=true ORDER BY sort_order,id`});
    return badRequest('Unknown public route');
  }catch(e){return serverError(e);}
}

export async function POST(request:NextRequest,ctx:Params){
  try{
    const path=await p(ctx);
    if(path==='inquiries'){
      const body=z.object({fullName:z.string().min(2).max(120),workEmail:z.string().email().max(254),phone:z.string().max(40).optional().nullable(),companyName:z.string().max(160).optional().nullable(),jobTitle:z.string().max(120).optional().nullable(),countryCode:z.string().length(2).optional().nullable(),serviceCode:z.string().max(40).optional().nullable(),budgetBand:z.string().max(80).optional().nullable(),timeline:z.string().max(120).optional().nullable(),message:z.string().min(10).max(6000),consentPrivacy:z.literal(true),consentMarketing:z.boolean().optional().default(false)}).parse(await request.json());
      await publicRateLimit(request,'inquiry',body.workEmail,5,30);
      const code=`CY-${new Date().toISOString().slice(0,10).replaceAll('-','')}-${crypto.randomUUID().slice(0,8).toUpperCase()}`;
      const [row]=await sql`INSERT INTO contact_inquiries(reference_code,full_name,work_email,phone,company_name,job_title,country_code,service_code,budget_band,timeline,message,source,consent_privacy,consent_marketing) VALUES (${code},${body.fullName},${body.workEmail.toLowerCase()},${body.phone??null},${body.companyName??null},${body.jobTitle??null},${body.countryCode?.toUpperCase()??null},${body.serviceCode??null},${body.budgetBand??null},${body.timeline??null},${body.message},'website',true,${body.consentMarketing}) RETURNING id::text,reference_code,created_at`;
      await audit(request,{action:'inquiry.created',entityType:'contact_inquiry',entityId:(row as any).id,metadata:{referenceCode:(row as any).reference_code,serviceCode:body.serviceCode||null}});
      return created({inquiry:row});
    }
    if(path==='career-apply'){
      const form=await request.formData();
      const email=String(form.get('email')||''); const openingId=String(form.get('openingId')||'');
      const body=z.object({fullName:z.string().min(2).max(120),email:z.string().email(),phone:z.string().max(40).optional(),currentLocation:z.string().max(120).optional(),linkedinUrl:z.string().url().optional().or(z.literal('')),portfolioUrl:z.string().url().optional().or(z.literal('')),coverNote:z.string().max(5000).optional(),openingId:z.string().regex(/^\d+$/).optional()}).parse({fullName:String(form.get('fullName')||''),email,phone:String(form.get('phone')||'')||undefined,currentLocation:String(form.get('currentLocation')||'')||undefined,linkedinUrl:String(form.get('linkedinUrl')||''),portfolioUrl:String(form.get('portfolioUrl')||''),coverNote:String(form.get('coverNote')||'')||undefined,openingId:openingId||undefined});
      if(String(form.get('consentPrivacy'))!=='true') return badRequest('Privacy consent is required');
      await publicRateLimit(request,'career-application',body.email,3,60);
      let resumeKey:null|string=null; const resume=form.get('resume');
      if(resume instanceof File && resume.size){ const stored=await storePrivateFile(resume,'career-resumes'); resumeKey=stored.key; }
      const [row]=await sql`INSERT INTO career_applications(opening_id,full_name,email,phone,current_location,linkedin_url,portfolio_url,cover_note,resume_storage_key,consent_privacy) VALUES (${body.openingId??null},${body.fullName},${body.email.toLowerCase()},${body.phone??null},${body.currentLocation??null},${body.linkedinUrl||null},${body.portfolioUrl||null},${body.coverNote??null},${resumeKey},true) RETURNING id::text,created_at`;
      await audit(request,{action:'career.application_received',entityType:'career_application',entityId:(row as any).id});
      return created({application:row});
    }
    return badRequest('Unknown public route');
  }catch(e:any){ if(e?.message==='RATE_LIMIT') return badRequest('Too many requests. Try again later.'); if(e?.name==='ZodError') return badRequest(e.issues?.[0]?.message||'Invalid input'); return serverError(e); }
}
