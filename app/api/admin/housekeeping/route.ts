import { handleAdminExtendedPOST } from '@/lib/adminExtended';
export const runtime='nodejs';
export async function POST(request:Request){return (await handleAdminExtendedPOST('housekeeping',request))!;}
