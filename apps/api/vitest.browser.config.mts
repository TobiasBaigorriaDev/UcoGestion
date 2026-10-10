import { defineConfig } from 'vitest/config';
import api from './vitest.config.mts';

// This real browser gate runs after the web build and browser installation.
export default defineConfig({ ...api, test: { ...api.test, include: ['test/catalog-category-browser.e2e.ts'] } });
