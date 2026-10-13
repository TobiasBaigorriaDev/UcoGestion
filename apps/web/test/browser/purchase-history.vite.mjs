import process from 'node:process';
import { readFile, readdir } from 'node:fs/promises';
import { URL, fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';

export default {
  resolve: { alias: { react: fileURLToPath(new URL('../../node_modules/react', import.meta.url)),
    'react-dom': fileURLToPath(new URL('../../node_modules/react-dom', import.meta.url)) } },
  optimizeDeps: { entries: ['apps/web/test/browser/purchase-history.html'] },
  plugins: [react(), { name: 'production-workspace-css', configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      const path = request.url?.split('?')[0];
      if (path !== '/test-workspace.css' && !/^\/test-workspace-fonts\/[a-zA-Z0-9_.-]+\.woff2$/.test(path ?? '')) return next();
      try {
        if (path === '/test-workspace.css') {
          const directory = new URL('../../.next/static/chunks/', import.meta.url);
          for (const file of await readdir(directory)) if (file.endsWith('.css')) {
            const css = await readFile(new URL(file, directory), 'utf8');
            if (css.includes('font-family:Plus Jakarta Sans')) {
              response.setHeader('Content-Type', 'text/css');
              return response.end(css.replaceAll('../media/', '/test-workspace-fonts/'));
            }
          }
          throw new Error('Build Next before capturing workspace UI');
        }
        response.setHeader('Content-Type', 'font/woff2');
        return response.end(await readFile(new URL(`../../.next/static/media/${path.slice('/test-workspace-fonts/'.length)}`, import.meta.url)));
      } catch (error) { return next(error); }
    });
  } }],
  server: { proxy: { '/api/v1': { target: process.env.PURCHASE_HISTORY_TEST_API_URL } } },
};
