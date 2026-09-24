import { issueSignedToken, presignUrl } from '@vercel/blob';
import { randomBytes } from 'crypto';
import { audit } from './audit';
import { sql } from './db';
import { badRequest, conflict, created, ok, serverError } from './http';
import { requestContext, sha256 } from './security';

const maxResumeBytes = 20 * 1024 * 1024;
const allowedResumeTypes = new Set(['application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document']);

function token(){const value=process.env.BLOB_READ_WRITE_TOKEN;if(!value)throw new Error('Vercel Blob is not configured');return value;}
function clean(value:string){return value.replace(/[^A-Za-z0-9._-]+/g,'-').replace(/^-+/g,'').slice(-140)||'resume.pdf';}
async function input(request:Request){try{return await request.json() as any;}catch{throw new Error('Invalid JSON request body');}}

async function rateLimit(request:Request,eventType:string,subject:string,subjectLimit:number,ipLimit:number,windowMinutes:number){
  const ctx=requestContext(request);const normalized=subject.toLowerCase();const subjectHash=sha256(`${eventType}|subject|${normalized}`);const ipHash=sha256(`${eventType}|ip|${ctx.sourceIp||''}`);
  const rows=await sql`SELECT count(*) FILTER(WHERE subject_hash=${subjectHash})::int AS subject_count,count(*) FILTER(WHERE subject_hash=${ipHash})::int AS ip_count FROM public_rate_limit_events WHERE event_type=${eventType} AND created_at>now()-(${windowMinutes}||' minutes')::interval`;
  if(Number(rows[0]?.subject_count||0)>=subjectLimit||Number(rows[0]?.ip_count||0)>=ipLimit)return false;
  await sql`INSERT INTO public_rate_limit_events(event_type,source_ip,subject_hash) VALUES (${eventType},${ctx.sourceIp},${subjectHash}),(${eventType},${ctx.sourceIp},${ipHash})`;return true;
}

export async function handlePublicExtendedPOST(path:string,request:Request):Promise<Response|null>{
  try{
    if(path==='career-resume-presign'){
      const b=await input(request);if(!b.openingId||!b.fileName||!b.contentType||!b.sizeBytes)return badRequest('Missing résumé upload metadata');if(!allowedResumeTypes.has(String(b.contentType)))return badRequest('Résumé must be PDF, DOC or DOCX');if(Number(b.sizeBytes)<=0||Number(b.sizeBytes)>maxResumeBytes)return badRequest('Résumé exceeds the 20 MB upload limit');
      const opening=await sql`SELECT id::text,active,closes_at FROM career_openings WHERE id=${b.openingId} LIMIT 1`;if(!opening.length||!opening[0].active||(opening[0].closes_at&&new Date(opening[0].closes_at)<=new Date()))return new Response(JSON.stringify({error:'This role is not accepting applications'}),{status:410,headers:{'Content-Type':'application/json'}});
      const subject=b.email?`${b.openingId}:${String(b.email).toLowerCase()}`:`${b.openingId}:cv-only`;if(!(await rateLimit(request,'career_resume_presign',subject,b.email?3:1000,20,60)))return new Response(JSON.stringify({error:'Too many upload attempts. Please try again later.'}),{status:429,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
      if(b.email){const recent=await sql`SELECT count(*)::int AS count FROM career_applications WHERE opening_id=${b.openingId} AND lower(email)=lower(${b.email}) AND created_at>=now()-interval '24 hours'`;if(Number(recent[0]?.count||0)>=2)return new Response(JSON.stringify({error:'An application was already submitted recently for this role'}),{status:429,headers:{'Content-Type':'application/json'}});}
      const storageKey=`careers/${b.openingId}/${Date.now()}-${randomBytes(10).toString('hex')}-${clean(String(b.fileName))}`;const signed=await issueSignedToken({pathname:storageKey,operations:['put'],allowedContentTypes:[String(b.contentType)],maximumSizeInBytes:Number(b.sizeBytes),validUntil:Date.now()+60*60*1000,token:token()});const {presignedUrl}=await presignUrl(signed,{operation:'put',pathname:storageKey,access:'private',validUntil:Date.now()+15*60*1000,allowedContentTypes:[String(b.contentType)],maximumSizeInBytes:Number(b.sizeBytes),addRandomSuffix:false,allowOverwrite:false});return ok({storageKey,presignedUrl,uploadMethod:'PUT'},{headers:{'Cache-Control':'no-store'}});
    }

    if(path==='career-apply'&&(request.headers.get('content-type')||'').includes('application/json')){
      const b=await input(request);if(b.website)return badRequest('Unable to submit application');if(!b.openingId||!b.resumeStorageKey)return badRequest('Opening and résumé are required');const opening=await sql`SELECT id::text,title,active,closes_at FROM career_openings WHERE id=${b.openingId} LIMIT 1`;if(!opening.length||!opening[0].active||(opening[0].closes_at&&new Date(opening[0].closes_at)<=new Date()))return new Response(JSON.stringify({error:'This role is not accepting applications'}),{status:410,headers:{'Content-Type':'application/json'}});if(!String(b.resumeStorageKey).startsWith(`careers/${b.openingId}/`))return badRequest('Invalid résumé upload reference');const applicationSubject=b.email||b.resumeStorageKey;if(!(await rateLimit(request,'career_apply',`${b.openingId}:${applicationSubject}`,3,50,24*60)))return new Response(JSON.stringify({error:'Too many recent application attempts. Please try again later.'}),{status:429,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});if(b.email){const recent=await sql`SELECT count(*)::int AS count FROM career_applications WHERE opening_id=${b.openingId} AND lower(email)=lower(${b.email}) AND created_at>=now()-interval '24 hours'`;if(Number(recent[0]?.count||0)>=2)return new Response(JSON.stringify({error:'An application was already submitted recently for this role'}),{status:429,headers:{'Content-Type':'application/json'}});}
      const [application]=await sql`INSERT INTO career_applications(opening_id,full_name,email,phone,current_location,linkedin_url,portfolio_url,cover_note,resume_storage_key,consent_privacy,status) VALUES (${b.openingId},${b.fullName||null},${b.email?String(b.email).toLowerCase():null},${b.phone||null},${b.currentLocation||null},${b.linkedinUrl||null},${b.portfolioUrl||null},${b.coverNote||null},${b.resumeStorageKey},${!!b.consentPrivacy},'received') RETURNING id::text`;const admins=await sql`SELECT id::text FROM users WHERE role='admin' AND active=true`;for(const admin of admins as any[])await sql`INSERT INTO notifications(user_id,type,title,body,url) VALUES (${admin.id},'career_application','New career application',${`${b.fullName||b.email||'CV-only applicant'} applied for ${opening[0].title}.`},'/portal/content')`;await audit(request,{action:'career.application_received',entityType:'career_application',entityId:application.id});return created({applicationId:application.id});
    }
    return null;
  }catch(error){console.error('Extended public POST failed',path,error);return serverError(error);}
}
