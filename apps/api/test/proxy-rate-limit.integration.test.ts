import { readFile } from 'node:fs/promises';
import { GenericContainer, Wait } from 'testcontainers';
import { expect, it } from 'vitest';

it('enforces the production proxy rate limit over real HTTP and recovers after the burst', async () => {
  const source = await readFile(new URL('../../../ops/reverse-proxy/rate-limit.conf', import.meta.url), 'utf8');
  const locationStart = source.indexOf('location /api/');
  expect(locationStart).toBeGreaterThan(0);
  // The production snippet places the zone in http and the location in server.
  // Preserve both directives verbatim, including the actual rate and burst.
  const config = `events {} http {
    ${source.slice(0, locationStart)}
    upstream uconext_api { server 127.0.0.1:8081; }
    server { listen 8081; location / { return 200 'upstream'; } }
    server { listen 80; ${source.slice(locationStart)} location / { return 200 'public'; } }
  }`;
  const proxy = await new GenericContainer('nginx:1.28-alpine')
    .withCopyContentToContainer([{ content: config, target: '/etc/nginx/nginx.conf' }])
    .withExposedPorts(80).withWaitStrategy(Wait.forHttp('/', 80)).start();
  try {
    const origin = `http://${proxy.getHost()}:${proxy.getMappedPort(80)}`;
    expect((await fetch(`${origin}/api/v1/probe`)).status).toBe(200);
    const responses = await Promise.all(Array.from({ length: 200 }, async () => {
      const response = await fetch(`${origin}/api/v1/probe`);
      const body = await response.text();
      return { status: response.status, body };
    }));
    expect(responses.filter(response => response.status === 200).length).toBeGreaterThan(0);
    expect(responses.filter(response => response.status === 503).length).toBeGreaterThan(0);
    expect(responses.every(response => response.status === 200 || response.status === 503)).toBe(true);
    expect(responses.filter(response => response.status === 503).every(response => !response.body.includes('upstream'))).toBe(true);
    expect((await fetch(origin)).status).toBe(200);
    await expect.poll(async () => (await fetch(`${origin}/api/v1/probe`)).status,
      { timeout: 5000, interval: 250 }).toBe(200);
  } finally { await proxy.stop(); }
});
