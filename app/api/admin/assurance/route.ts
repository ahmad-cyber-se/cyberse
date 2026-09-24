export const runtime='nodejs';
export async function GET(request:Request){
  const target=new URL('/api/portal/assurance',request.url);
  return Response.redirect(target,307);
}
