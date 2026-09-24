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

  if (destination === 'components/CyberSEApp.tsx') {
    content = content
      .replace('React.useEffect(load,[]);', 'React.useEffect(()=>{void load()},[]);')
      .replace('React.useEffect(load,[kind]);', 'React.useEffect(()=>{void load()},[kind]);');
  }

  if (destination === 'app/api/portal/[...path]/route.ts') {
    const getNeedle = 'export async function GET(request:NextRequest,ctx:Params){try{';
    const postNeedle = 'export async function POST(request:NextRequest,ctx:Params){try{';
    if (!content.includes(getNeedle) || !content.includes(postNeedle)) {
      throw new Error('Recovered portal route shape changed; compatibility hooks could not be installed safely');
    }
    content = `import { handleExtendedGET, handleExtendedPOST } from '@/lib/portalExtended';\nimport { handleExtendedDetailsGET, handleExtendedDetailsPOST } from '@/lib/portalExtendedDetails';\n${content}`
      .replace(getNeedle, `${getNeedle}const __path=await p(ctx);const __extended=await handleExtendedGET(__path,request);if(__extended)return __extended;const __details=await handleExtendedDetailsGET(__path,request);if(__details)return __details;`)
      .replace(postNeedle, `${postNeedle}const __path=await p(ctx);const __extended=await handleExtendedPOST(__path,request);if(__extended)return __extended;const __details=await handleExtendedDetailsPOST(__path,request);if(__details)return __details;`);
  }

  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content);
  console.log(`Recovered ${destination}`);
}
