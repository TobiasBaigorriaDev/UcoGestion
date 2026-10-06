import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'UcoNext', short_name: 'UcoNext', description: 'Gestión comercial para PyMEs',
    start_url: '/workspace', display: 'standalone', background_color: '#ffffff',
    theme_color: '#273e38', icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
