import { accessContext, assertEngagement, authorizedEngagementScope } from '@/lib/access';
import { sql } from '@/lib/db';
import { getPrivateFile } from '@/lib/storage';
import { forbidden, notFound, unauthorized } from '@/lib/http';

export const runtime = 'nodejs';

type Params = { params: Promise<{ key: string[] }> };

export async function GET(_request: Request, ctx: Params) {
  const access = await accessContext();
  if (!access) return unauthorized();

  const storageKey = (await ctx.params).key?.join('/') || '';
  if (!storageKey) return notFound();

  if (storageKey.startsWith('career-resumes/')) {
    if (!access.isPlatformAdmin) return forbidden();
    const application = await sql`
      SELECT id::text
      FROM career_applications
      WHERE resume_storage_key = ${storageKey}
      LIMIT 1
    `;
    if (!application.length) return notFound();
  } else if (storageKey.startsWith('documents/')) {
    const rows = await sql`
      SELECT engagement_id::text, confidential
      FROM documents
      WHERE storage_key = ${storageKey}
      LIMIT 1
    `;
    if (!rows.length) return notFound();

    if (!access.isPlatformAdmin) {
      const scope = await authorizedEngagementScope();
      const engagementId = String((rows[0] as any).engagement_id);
      if (!assertEngagement(scope, engagementId)) return forbidden();
      if ((rows[0] as any).confidential && !scope?.sensitiveEngagementIds.includes(engagementId)) return forbidden();
    }
  } else if (!access.isPlatformAdmin) {
    return forbidden();
  }

  const file: any = await getPrivateFile(storageKey);
  if (!file) return notFound();

  const bytes = file.data instanceof Uint8Array ? file.data : Buffer.from(file.data);
  const safeName = String(file.file_name || 'download').replace(/[\r\n"]/g, '_');

  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': String(file.content_type || 'application/octet-stream'),
      'Content-Length': String(file.size_bytes ?? bytes.byteLength),
      'Content-Disposition': `attachment; filename="${safeName}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}
