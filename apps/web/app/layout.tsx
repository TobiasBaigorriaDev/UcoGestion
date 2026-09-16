import type { Metadata } from 'next';
import { Plus_Jakarta_Sans } from 'next/font/google';

import './globals.css';

const plusJakartaSans = Plus_Jakarta_Sans({
  display: 'swap',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'UcoNext',
  description: 'Gestión comercial para PyMEs.',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es">
      <body className={plusJakartaSans.className}>{children}</body>
    </html>
  );
}
