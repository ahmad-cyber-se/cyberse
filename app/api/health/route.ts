import { sql } from '@/lib/db';
import { NextResponse } from 'next/server';
export const runtime='nodejs';
export async function GET(){try{const [r]=await sql`SELECT now() AS db_time,(SELECT count(*) FROM srs_sections)::int AS srs_sections,(SELECT count(*) FROM organization_memberships WHERE active AND role='platform_admin')::int AS active_admins`;return NextResponse.json({status:'ok',database:'ok',...r});}catch(e){console.error(e);return NextResponse.json({status:'degraded',database:'error'},{status:503});}}
