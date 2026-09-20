import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { BarcodeScannerModal } from '../../components/BarcodeScannerModal';
import { render } from '../utils';


describe('BarcodeScannerModal', () => {
  it('accepts a manually-entered barcode when camera detection is unavailable', () => {
    const onDetected = vi.fn();
    render(<BarcodeScannerModal onDetected={onDetected} onClose={vi.fn()} />);

    fireEvent.change(screen.getByRole('textbox', { name: 'Barcode' }), {
      target: { value: ' 0123456789012 ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Use code' }));

    expect(onDetected).toHaveBeenCalledWith('0123456789012');
    expect(screen.getByText(/Automatic barcode detection is not available/)).toBeDefined();
  });
});
