import { opaqueDeliveryTestServer } from './opaque-delivery-server.mjs';
import { readFile } from 'node:fs/promises';
import { URL, fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';

// Serve the unchanged production worker and its public shell in the test origin.
export default {
  resolve: { alias: { react: fileURLToPath(new URL('../../node_modules/react', import.meta.url)),
    'react-dom': fileURLToPath(new URL('../../node_modules/react-dom', import.meta.url)) } },
  plugins: [react(), { name: 'offline-public-assets', configureServer(server) {
    opaqueDeliveryTestServer(server);
    server.middlewares.use(async (request, response, next) => {
      const paths = { '/offline-delivery-worker-v1.js': ['offline-delivery-worker-v1.js','text/javascript'], '/sw.js': ['sw.js', 'text/javascript'],
        '/offline-shell-v1.html': ['offline-shell-v1.html', 'text/html'],
        '/offline-icon-v1.svg': ['offline-icon-v1.svg', 'image/svg+xml'] };
      const asset = paths[request.url?.split('?')[0]];
      if (!asset) return next();
      try {
        response.setHeader('Content-Type', asset[1]);
        response.setHeader('Cache-Control', 'no-cache');
        response.end(await readFile(new URL(`../../public/${asset[0]}`, import.meta.url)));
      } catch (error) { next(error); }
    });
  } }],
};
