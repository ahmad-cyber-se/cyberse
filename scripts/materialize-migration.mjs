import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { gunzipSync } from 'node:zlib';

const recovered = [
  ['migration_payload/CyberSEApp.tsx.gz.b64', 'components/CyberSEApp.tsx'],
  ['migration_payload/portal-route.ts.gz.b64', 'app/api/portal/[...path]/route.ts'],
  ['migration_payload/globals.css.gz.b64', 'app/globals.css'],
];

for (const [source, destination] of recovered) {
  const encoded = (await readFile(source, 'utf8')).trim();
  let content = gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8');

  if (destination === 'app/api/portal/[...path]/route.ts') {
    content = content.replace(
      "if(!process.env.BLOB_READ_WRITE_TOKEN)warnings.push('Vercel Blob is not configured; file uploads remain disabled.');",
      ''
    );
  }

  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content);
  console.log(`Recovered ${destination}`);
}
