import { handleAdminExtendedGET } from '@/lib/adminExtended';
export const runtime='nodejs';
export async function GET(request:Request){return (await handleAdminExtendedGET('career-resume-file',request))!;}
