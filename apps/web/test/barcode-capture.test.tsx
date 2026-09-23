import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BarcodeCapture } from '../src/features/catalog/components/barcode-capture.js';

describe('BarcodeCapture component', () => {
  afterEach(() => {
    cleanup();
  });
  it('renders an accessible input with label and visible focus styling', () => {
    render(<BarcodeCapture onScan={vi.fn()} />);

    const label = screen.getByLabelText('Código de barras');
    expect(label).toBeDefined();
    expect(label.tagName.toLowerCase()).toBe('input');
    expect((label as HTMLInputElement).style.outline).not.toBe('none');
    expect(screen.getByRole('button', { name: 'Capturar código' })).toBeDefined();
  });

  it('captures barcode when Enter key is pressed, trims it, and clears the input for the next scan', () => {
    const onScan = vi.fn();
    render(<BarcodeCapture onScan={onScan} />);

    const input = screen.getByLabelText('Código de barras') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '  7791234567890  ' } });
    expect(input.value).toBe('  7791234567890  ');

    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    expect(onScan).toHaveBeenCalledTimes(1);
    expect(onScan).toHaveBeenCalledWith('7791234567890');
    expect(input.value).toBe('');
  });

  it('captures barcode when submit button is clicked', () => {
    const onScan = vi.fn();
    render(<BarcodeCapture onScan={onScan} />);

    const input = screen.getByLabelText('Código de barras') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'ABC-789' } });

    const button = screen.getByRole('button', { name: 'Capturar código' });
    fireEvent.click(button);

    expect(onScan).toHaveBeenCalledWith('ABC-789');
    expect(input.value).toBe('');
  });

  it('does not trigger onScan when empty or whitespace-only is submitted', () => {
    const onScan = vi.fn();
    render(<BarcodeCapture onScan={onScan} />);

    const input = screen.getByLabelText('Código de barras') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    expect(onScan).not.toHaveBeenCalled();
  });

  it('respects disabled state', () => {
    const onScan = vi.fn();
    render(<BarcodeCapture disabled onScan={onScan} />);

    const input = screen.getByLabelText('Código de barras') as HTMLInputElement;
    const button = screen.getByRole('button', { name: 'Capturar código' }) as HTMLButtonElement;

    expect(input.disabled).toBe(true);
    expect(button.disabled).toBe(true);
  });
});
