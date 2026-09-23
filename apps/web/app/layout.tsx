import type { Metadata } from 'next';
import { Plus_Jakarta_Sans } from 'next/font/google';
import { connection } from 'next/server';

import './globals.css';

const plusJakartaSans = Plus_Jakarta_Sans({
  display: 'swap',
  subsets: ['latin'],
  variable: '--font-plus-jakarta',
});

export const metadata: Metadata = {
  title: 'UcoNext',
  description: 'Gestión comercial para PyMEs.',
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // The per-request CSP nonce cannot be attached to prerendered scripts.
  await connection();
  return (
    <html lang="es" className={plusJakartaSans.variable}>
      <body>{children}</body>
    </html>
  );
}
