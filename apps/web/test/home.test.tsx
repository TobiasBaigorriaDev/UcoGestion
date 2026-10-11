import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import HomePage from '../app/page.js';

afterEach(cleanup);

describe('web application shell', () => {
  it('provides a working entry to login and resolves every local section link', () => {
    const { container } = render(<HomePage />);
    expect(screen.getAllByRole('link', { name: /iniciar sesión/i }).length).toBeGreaterThan(0);
    for (const link of container.querySelectorAll('a[href^="#"]')) {
      expect(container.querySelector(link.getAttribute('href') ?? '')).not.toBeNull();
    }
    expect(screen.getByRole('link', { name: /iniciar sesión/i }).getAttribute('href')).toBe('/login');
  });
  it('renders an accessible shell that adapts from mobile to desktop', () => {
    render(<HomePage />);

    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'Gestión comercial clara, desde cualquier pantalla.',
      }),
    ).toBeDefined();
    expect(
      screen.getByRole('navigation', { name: 'Navegación principal' }),
    ).toBeDefined();
    expect(screen.getByRole('main').className).toContain('shell');
  });
});
