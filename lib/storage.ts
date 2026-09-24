import { createHash, randomUUID } from 'crypto';
import { sql } from '@/lib/db';

const allowed = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'text/plain',
  'text/csv',
  'application/zip',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
]);
const maxBytes = 20 * 1024 * 1024;
let initialized = false;

async function ensureFileTable() {
  if (initialized) return;
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS self_hosted_file_blobs (
      id uuid PRIMARY KEY,
      storage_key text NOT NULL UNIQUE,
      prefix text NOT NULL,
      file_name text NOT NULL,
      content_type text NOT NULL,
      size_bytes bigint NOT NULL,
      checksum_sha256 text NOT NULL,
      data bytea NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS self_hosted_file_blobs_prefix_created_idx
      ON self_hosted_file_blobs(prefix, created_at DESC);
  `);
  initialized = true;
}

export async function storePrivateFile(file: File, prefix = 'documents') {
  if (!allowed.has(file.type)) throw new Error('File type is not allowed');
  if (file.size <= 0 || file.size > maxBytes) throw new Error('File exceeds the 20 MB upload limit');

  const bytes = Buffer.from(await file.arrayBuffer());
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const id = randomUUID();
  const key = `${prefix}/${id}-${safe}`;

  await ensureFileTable();
  await sql`
    INSERT INTO self_hosted_file_blobs
      (id, storage_key, prefix, file_name, content_type, size_bytes, checksum_sha256, data)
    VALUES
      (${id}, ${key}, ${prefix}, ${file.name}, ${file.type}, ${file.size}, ${checksum}, ${bytes})
  `;

  return {
    key,
    url: `/api/files/${encodeURIComponent(key)}`,
    checksum,
    fileName: file.name,
    contentType: file.type,
    size: file.size
  };
}

export async function getPrivateFile(storageKey: string) {
  await ensureFileTable();
  const rows = await sql`
    SELECT storage_key, prefix, file_name, content_type, size_bytes, checksum_sha256, data
    FROM self_hosted_file_blobs
    WHERE storage_key = ${storageKey}
    LIMIT 1
  `;
  return rows[0] ?? null;
}
