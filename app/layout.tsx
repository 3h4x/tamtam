import type { Metadata } from 'next';
import { AppShell } from '@/components/AppShell';
import './globals.css';

export const metadata: Metadata = {
  title: 'TamTam',
  description: 'Project Management Dashboard',
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/favicons/icon-16.png', sizes: '16x16', type: 'image/png' },
      { url: '/favicons/icon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/favicons/icon-48.png', sizes: '48x48', type: 'image/png' },
      { url: '/favicons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/favicons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [
      { url: '/favicons/icon-180.png', sizes: '180x180', type: 'image/png' },
    ],
  },
  manifest: '/site.webmanifest',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
