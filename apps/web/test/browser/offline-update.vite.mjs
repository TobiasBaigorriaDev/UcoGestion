import { opaqueDeliveryTestServer } from './opaque-delivery-server.mjs';
import { readFile, readdir } from 'node:fs/promises';
import { URL, fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';

// Serve the unchanged production worker and its public shell in the test origin.
export default {
  resolve: { alias: { react: fileURLToPath(new URL('../../node_modules/react', import.meta.url)),
    'react-dom': fileURLToPath(new URL('../../node_modules/react-dom', import.meta.url)) } },
  plugins: [react(), { name: 'offline-public-assets', configureServer(server) {
    opaqueDeliveryTestServer(server);
    server.middlewares.use(async (request, response, next) => {
      // Reuse Next's built fonts, reset and theme so UI captures match the real workspace.
      const path=request.url?.split('?')[0];
      if(path==='/test-receipt.html') {
        try {
          const { renderReceiptHtml } = await server.ssrLoadModule('/apps/api/src/modules/sales/receipt-renderer.ts');
          const injected = '<script>window.receiptExecuted=true</script><img src=x onerror="window.receiptExecuted=true">';
          response.setHeader('Content-Type','text/html; charset=utf-8');
          return response.end(renderReceiptHtml({label:'Comprobante no fiscal',organization:{name:injected},
            items:[{name:injected,quantity:'1.000',unit:'UNIT',lineTotal:'10.00'}],
            payments:[],currency:'ARS',subtotal:'10.00',discount:'0.00',total:'10.00'}));
        } catch(error) { return next(error); }
      }
      if(path==='/test-workspace.css' || /^\/test-workspace-fonts\/[a-zA-Z0-9_.-]+\.woff2$/.test(path ?? '')) {
        try {
          if(path==='/test-workspace.css') {
            const directory=new URL('../../.next/static/chunks/',import.meta.url);
            for(const file of await readdir(directory)) if(file.endsWith('.css')) {
              const css=await readFile(new URL(file,directory),'utf8');
              if(css.includes('font-family:Plus Jakarta Sans')) {
                response.setHeader('Content-Type','text/css');
                return response.end(css.replaceAll('../media/','/test-workspace-fonts/'));
              }
            }
            throw new Error('Build Next before capturing workspace UI');
          }
          response.setHeader('Content-Type','font/woff2');
          return response.end(await readFile(new URL(`../../.next/static/media/${path.slice('/test-workspace-fonts/'.length)}`,import.meta.url)));
        } catch(error) {return next(error);}
      }
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
