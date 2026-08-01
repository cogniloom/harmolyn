import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ProductTour, TOUR_DISMISSED_KEY } from './ProductTour';

describe('ProductTour', () => {
  beforeEach(() => localStorage.clear());

  it('advances through every step and dismisses on the last', () => {
    const onClose = vi.fn();
    render(<ProductTour onClose={onClose} />);

    // Starts on the welcome step.
    expect(screen.getByRole('heading', { name: /Welcome to Harmolyn/i })).toBeInTheDocument();
    expect(screen.getByText('1 / 6')).toBeInTheDocument();

    // Click NEXT through the middle steps; the final button reads differently.
    fireEvent.click(screen.getByRole('button', { name: /^NEXT$/i })); // 2
    expect(screen.getByRole('heading', { name: /Spaces are communities/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^NEXT$/i })); // 3
    fireEvent.click(screen.getByRole('button', { name: /^NEXT$/i })); // 4
    fireEvent.click(screen.getByRole('button', { name: /^NEXT$/i })); // 5
    fireEvent.click(screen.getByRole('button', { name: /^NEXT$/i })); // 6 (last)

    expect(screen.getByText('6 / 6')).toBeInTheDocument();
    const finish = screen.getByRole('button', { name: /START USING HARMOLYN/i });
    expect(finish).toBeInTheDocument();

    fireEvent.click(finish);
    expect(onClose).toHaveBeenCalledOnce();
    // Completing the tour writes the one-time dismissal flag.
    expect(localStorage.getItem(TOUR_DISMISSED_KEY)).toBe('true');
  });

  it('BACK returns to the previous step', () => {
    render(<ProductTour onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^NEXT$/i }));
    expect(screen.getByText('2 / 6')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^BACK$/i }));
    expect(screen.getByText('1 / 6')).toBeInTheDocument();
  });

  it('SKIP dismisses immediately and persists the flag', () => {
    const onClose = vi.fn();
    render(<ProductTour onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /^SKIP$/i }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(localStorage.getItem(TOUR_DISMISSED_KEY)).toBe('true');
  });
});
