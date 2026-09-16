import CyberSEApp from '@/components/CyberSEApp';
export default async function CatchAll({params}:{params:Promise<{slug?:string[]}>}){
  const {slug=[]}=await params;
  return <CyberSEApp initialPath={'/'+slug.join('/')} />;
}
