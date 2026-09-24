import { handleAdminExtendedGET } from '@/lib/adminExtended';
export const runtime='nodejs';
export async function GET(request:Request){return (await handleAdminExtendedGET('inquiry-detail',request))!;}
