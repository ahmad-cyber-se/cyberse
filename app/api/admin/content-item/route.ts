import { contentItem } from '@/lib/adminContentCompat';
export const runtime='nodejs';
export async function GET(request:Request){return contentItem(request);}
