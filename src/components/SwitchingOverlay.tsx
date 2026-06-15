import React from 'react';
import { Spinner } from '@/components/ui/Spinner';

/**
 * Full-screen "we're switching accounts, hang on" curtain shown right before the
 * page reloads on an identity switch — so the reload reads as an intentional
 * transition rather than a crash/white-flash.
 */
export const SwitchingOverlay: React.FC<{ message?: string }> = ({ message = 'Switching account…' }) => (
  <div className="fixed inset-0 z-[300] bg-bg-0/95 backdrop-blur-xl flex flex-col items-center justify-center gap-4 animate-in fade-in duration-200">
    <div className="inline-flex items-center justify-center w-14 h-14 rounded-r2 bg-primary/10 border border-primary/20 shadow-glow">
      <Spinner size={28} className="text-primary" />
    </div>
    <p className="text-body text-text-secondary">{message}</p>
  </div>
);
