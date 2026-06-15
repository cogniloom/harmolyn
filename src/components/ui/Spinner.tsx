import React from 'react';
import { Loader2 } from 'lucide-react';

/** Consistent in-flight spinner. Use everywhere instead of bespoke animate-spin divs. */
export const Spinner: React.FC<{ size?: number; className?: string }> = ({ size = 16, className = '' }) => (
  <Loader2 size={size} className={`animate-spin ${className}`} aria-hidden="true" />
);
