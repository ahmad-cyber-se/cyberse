import type { MetadataRoute } from 'next';
export default function robots():MetadataRoute.Robots{return{rules:[{userAgent:'*',allow:'/',disallow:['/portal','/login','/register','/reset-password','/accept-invite','/api/']}],sitemap:`${process.env.NEXT_PUBLIC_APP_URL||'https://cyberse.com'}/sitemap.xml`};}
