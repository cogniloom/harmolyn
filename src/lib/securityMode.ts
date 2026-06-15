/**
 * Maps a negotiated xorein security mode to its UI badge presentation.
 *
 * The protocol negotiates one of `seal | tree | clear | unspecified`
 * (see src/protocol/capabilities.ts). "crowd" is a forward-compat case: it is
 * part of the product spec (large-scale channel E2EE) but the protocol does not
 * negotiate it yet, so it will not appear from real data until the engine adds
 * it. Colors mirror the language users are taught in SecurityOnboarding.
 */
export type SecurityModeKey = 'seal' | 'tree' | 'crowd' | 'clear' | 'unspecified';

export interface SecurityModeBadge {
  key: SecurityModeKey;
  /** Short header label, e.g. "SEAL // 1:1 E2EE". */
  label: string;
  /** Tailwind text-color class for the badge. */
  className: string;
  /** Human-readable explanation for tooltips/details. */
  description: string;
  /**
   * True when the conversation is NOT end-to-end encrypted (the "clear" mode).
   * Surfaces let the UI treat it as an alarm state rather than a normal badge —
   * Harmolyn never offers "clear" as an acceptable mode to the user.
   */
  insecure?: boolean;
}

const BADGES: Record<SecurityModeKey, SecurityModeBadge> = {
  seal: {
    key: 'seal',
    label: 'SEAL // 1:1 E2EE',
    className: 'text-accent-success',
    description: 'Sealed 1:1 end-to-end encryption (X3DH + Double Ratchet).',
  },
  tree: {
    key: 'tree',
    label: 'TREE // GROUP E2EE',
    className: 'text-primary',
    description: 'Small-group end-to-end encryption (MLS).',
  },
  crowd: {
    key: 'crowd',
    label: 'CROWD // CHANNEL E2EE',
    className: 'text-accent-warning',
    description: 'Large-scale channel end-to-end encryption with epoch rotation.',
  },
  clear: {
    key: 'clear',
    label: 'UNENCRYPTED // DO NOT TRUST',
    className: 'text-accent-danger',
    insecure: true,
    description: 'This conversation is NOT end-to-end encrypted — its contents are readable by the infrastructure that carries them. Harmolyn never negotiates this mode; do not share anything sensitive and move to an encrypted space.',
  },
  unspecified: {
    key: 'unspecified',
    label: 'NOT NEGOTIATED',
    className: 'text-white/40',
    description: 'No security mode has been negotiated for this conversation yet.',
  },
};

/** Resolves a (possibly absent or unknown) mode string to its badge. */
export function resolveSecurityMode(mode: string | null | undefined): SecurityModeBadge {
  switch ((mode ?? '').trim().toLowerCase()) {
    case 'seal':
      return BADGES.seal;
    case 'tree':
      return BADGES.tree;
    case 'crowd':
    case 'channel':
      return BADGES.crowd;
    case 'clear':
      return BADGES.clear;
    default:
      return BADGES.unspecified;
  }
}
