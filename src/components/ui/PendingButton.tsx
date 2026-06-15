import React from 'react';
import { Spinner } from '@/components/ui/Spinner';

type PendingButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  /** While true the button is disabled and shows a spinner + pendingLabel. */
  pending?: boolean;
  /** Text shown next to the spinner while pending (falls back to children). */
  pendingLabel?: React.ReactNode;
  spinnerSize?: number;
};

/**
 * A button that, while `pending`, auto-disables and swaps its content for a
 * spinner + label — so an in-flight action is never ambiguous. Styling is fully
 * controlled by the caller's `className` (keeps each call site's look).
 */
export const PendingButton: React.FC<PendingButtonProps> = ({
  pending = false,
  pendingLabel,
  spinnerSize = 16,
  disabled,
  children,
  className = '',
  ...rest
}) => (
  <button
    {...rest}
    disabled={disabled || pending}
    aria-busy={pending || undefined}
    className={className}
  >
    {pending ? (
      <>
        <Spinner size={spinnerSize} />
        {pendingLabel ?? children}
      </>
    ) : (
      children
    )}
  </button>
);
