import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import HomePage from '../app/page.js';

describe('web application shell', () => {
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
