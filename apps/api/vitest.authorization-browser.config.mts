import { defineConfig } from 'vitest/config';
import api from './vitest.config.mts';
export default defineConfig({ ...api, test: { ...api.test, include: ['test/organization-switch-browser.e2e.ts'] } });
