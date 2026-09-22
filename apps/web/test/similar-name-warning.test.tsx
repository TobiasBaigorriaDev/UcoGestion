import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { SimilarNameWarning } from '../src/features/catalog/components/similar-name-warning.js';

describe('SimilarNameWarning component', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders nothing when there are no similar names', () => {
    const { container } = render(<SimilarNameWarning similarNames={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders an accessible warning with the similar item names without blocking the user', () => {
    render(
      <SimilarNameWarning
        similarNames={['Yerba Mate Taragui', 'Yerba Mate Playadito']}
      />,
    );

    const alert = screen.getByRole('status');
    expect(alert).toBeDefined();
    expect(alert.textContent).toContain('Yerba Mate Taragui');
    expect(alert.textContent).toContain('Yerba Mate Playadito');
    expect(alert.textContent).toContain('Podés continuar');
  });
});
