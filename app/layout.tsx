import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: { default:'CyberSE by AAGOB | Build. Secure. Evolve.', template:'%s | CyberSE' },
  description:'CyberSE combines secure software engineering, cybersecurity consultancy, cyber risk management, VAPT and security architecture.',
  applicationName:'CyberSE',
  robots:{index:true,follow:true},
  openGraph:{title:'CyberSE by AAGOB',description:'Build. Secure. Evolve.',type:'website'}
};

export default function RootLayout({children}:{children:React.ReactNode}){
  return <html lang="en"><body>{children}</body></html>;
}
