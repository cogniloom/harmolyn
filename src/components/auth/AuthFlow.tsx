import React, { useState } from 'react';
import { WelcomeIntro } from './WelcomeIntro';
import { RegisterScreen } from './RegisterScreen';
import { KeyRevealStep } from './KeyRevealStep';
import { IdentityPicker } from './IdentityPicker';
import { RestoreStep } from './RestoreStep';
import { SecurityOnboarding } from '@/components/onboarding/SecurityOnboarding';

export type AuthStep = 'welcome' | 'create' | 'reveal' | 'picker' | 'restore';

interface AuthFlowProps {
  /** Which step to open on. */
  initialStep: AuthStep;
  /** Close the whole flow (returns the user to the app as a guest or signed-in). */
  onClose: () => void;
}

/**
 * Single coordinator overlay for the auth flow. Owns a small step machine over the
 * reusable leaf screens (welcome → create → key reveal, or picker → restore) and
 * the optional security primer. Each leaf is a self-contained full-screen overlay
 * (z-200); the primer (z-110) is rendered in place of the active step so it isn't
 * hidden behind it.
 */
export const AuthFlow: React.FC<AuthFlowProps> = ({ initialStep, onClose }) => {
  const [step, setStep] = useState<AuthStep>(initialStep);
  const [reveal, setReveal] = useState<{ peerId: string; displayName: string } | null>(null);
  const [showPrimer, setShowPrimer] = useState(false);

  if (showPrimer) {
    return <SecurityOnboarding onClose={() => setShowPrimer(false)} />;
  }

  switch (step) {
    case 'create':
      return (
        <RegisterScreen
          onCreated={(info) => { setReveal(info); setStep('reveal'); }}
          onSwitchToLogin={() => setStep('picker')}
          onClose={onClose}
        />
      );
    case 'reveal':
      return (
        <KeyRevealStep
          peerId={reveal?.peerId ?? ''}
          displayName={reveal?.displayName ?? ''}
          onDone={onClose}
        />
      );
    case 'picker':
      return (
        <IdentityPicker
          onRestore={() => setStep('restore')}
          onCreate={() => setStep('create')}
          onClose={onClose}
        />
      );
    case 'restore':
      return (
        <RestoreStep
          onRestored={onClose}
          onBack={() => setStep('picker')}
          onCreate={() => setStep('create')}
          onClose={onClose}
        />
      );
    case 'welcome':
    default:
      return (
        <WelcomeIntro
          onCreate={() => setStep('create')}
          onRestore={() => setStep('picker')}
          onGuest={onClose}
          onLearnMore={() => setShowPrimer(true)}
        />
      );
  }
};
