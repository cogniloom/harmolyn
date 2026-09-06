import React, { useEffect, useRef, useState } from 'react';
import { WelcomeIntro } from './WelcomeIntro';
import { RegisterScreen } from './RegisterScreen';
import { KeyRevealStep } from './KeyRevealStep';
import { IdentityPicker } from './IdentityPicker';
import { RestoreStep } from './RestoreStep';
import { SecurityOnboarding } from '@/components/onboarding/SecurityOnboarding';
import { trapDialogFocus } from '@/lib/stabilization/interaction';

export type AuthStep = 'welcome' | 'create' | 'reveal' | 'picker' | 'restore';

interface AuthFlowProps {
  /** Which step to open on. */
  initialStep: AuthStep;
  /** Close the whole flow (returns the user to the app as a guest or signed-in). */
  onClose: () => void;
}

const AuthFocusBoundary: React.FC<{ surfaceKey: string; children: React.ReactNode }> = ({ surfaceKey, children }) => {
  const ref = useRef<HTMLDivElement>(null);

  // Full-screen auth screens visually cover the app but, without focus isolation,
  // Tab can still reach controls underneath them. Re-arm the trap on every step so
  // the first useful control on the newly-mounted surface receives focus.
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    return trapDialogFocus(root);
  }, [surfaceKey]);

  return <div ref={ref} className="contents">{children}</div>;
};

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

  let surface: React.ReactNode;
  let surfaceKey: string;

  if (showPrimer) {
    surfaceKey = 'primer';
    surface = <SecurityOnboarding onClose={() => setShowPrimer(false)} />;
  } else {
    surfaceKey = step;
    switch (step) {
      case 'create':
        surface = (
          <RegisterScreen
            onCreated={(info) => { setReveal(info); setStep('reveal'); }}
            onSwitchToLogin={() => setStep('picker')}
            onClose={onClose}
          />
        );
        break;
      case 'reveal':
        surface = (
          <KeyRevealStep
            peerId={reveal?.peerId ?? ''}
            displayName={reveal?.displayName ?? ''}
            onDone={onClose}
          />
        );
        break;
      case 'picker':
        surface = (
          <IdentityPicker
            onRestore={() => setStep('restore')}
            onCreate={() => setStep('create')}
            onClose={onClose}
          />
        );
        break;
      case 'restore':
        surface = (
          <RestoreStep
            onRestored={onClose}
            onBack={() => setStep('picker')}
            onCreate={() => setStep('create')}
            onClose={onClose}
          />
        );
        break;
      case 'welcome':
      default:
        surface = (
          <WelcomeIntro
            onCreate={() => setStep('create')}
            onRestore={() => setStep('picker')}
            onGuest={onClose}
            onLearnMore={() => setShowPrimer(true)}
          />
        );
        break;
    }
  }

  return <AuthFocusBoundary surfaceKey={surfaceKey}>{surface}</AuthFocusBoundary>;
};
