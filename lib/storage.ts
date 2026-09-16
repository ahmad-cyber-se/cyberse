import { put } from '@vercel/blob';
import { createHash } from 'crypto';

const allowed = new Set(['application/pdf','image/png','image/jpeg','text/plain','text/csv','application/zip','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
const maxBytes = 20 * 1024 * 1024;

export async function storePrivateFile(file: File, prefix='documents') {
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error('File storage is not configured');
  if (!allowed.has(file.type)) throw new Error('File type is not allowed');
  if (file.size <= 0 || file.size > maxBytes) throw new Error('File exceeds the 20 MB upload limit');
  const bytes = Buffer.from(await file.arrayBuffer());
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const safe = file.name.replace(/[^a-zA-Z0-9._-]/g,'_');
  const key = `${prefix}/${Date.now()}-${crypto.randomUUID()}-${safe}`;
  const blob = await put(key, bytes, { access:'private', contentType:file.type, token:process.env.BLOB_READ_WRITE_TOKEN });
  return { key: blob.pathname, url: blob.url, checksum, fileName:file.name, contentType:file.type, size:file.size };
}
