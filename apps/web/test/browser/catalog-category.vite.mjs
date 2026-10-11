import process from 'node:process';
import workspace from './offline-update.vite.mjs';

export default {
  ...workspace,
  optimizeDeps: { entries: ['apps/web/test/browser/catalog-category.html'] },
  server: { proxy: { '/api/v1': { target: process.env.CATALOG_TEST_API_URL } } },
};
