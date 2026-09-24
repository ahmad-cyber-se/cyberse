import { contentStatus } from '@/lib/adminContentCompat';
export const runtime='nodejs';
export async function POST(request:Request){return contentStatus(request);}
