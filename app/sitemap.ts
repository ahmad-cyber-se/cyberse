import type { MetadataRoute } from 'next';
const routes=['','/services','/about','/case-studies','/insights','/trust','/careers','/contact','/privacy','/terms'];
export default function sitemap():MetadataRoute.Sitemap{const base=process.env.NEXT_PUBLIC_APP_URL||'https://cyberse.com';return routes.map(route=>({url:base+route,lastModified:new Date(),changeFrequency:route===''?'weekly':'monthly',priority:route===''?1:.7}));}
