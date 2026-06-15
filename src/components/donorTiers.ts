import { createElement, type ReactNode } from 'react';
import { Coffee, HeartHandshake, Rocket } from 'lucide-react';
import type { DonationTier } from '@/types';

export const DONATION_TIER_CONFIG: Record<DonationTier, {
  label: string;
  icon: ReactNode;
  color: string;
  glow: string;
  description: string;
}> = {
  coffee: {
    label: 'Coffee Donor',
    icon: createElement(Coffee, { size: 12 }),
    color: '#FFB020',
    glow: 'rgba(255,176,32,0.4)',
    description: 'Keeps the lights on',
  },
  supporter: {
    label: 'Supporter',
    icon: createElement(HeartHandshake, { size: 12 }),
    color: '#A855F7',
    glow: 'rgba(168,85,247,0.4)',
    description: 'Monthly supporter',
  },
  champion: {
    label: 'Champion',
    icon: createElement(Rocket, { size: 12 }),
    color: '#13DDEC',
    glow: 'rgba(19,221,236,0.4)',
    description: 'Championing the future',
  },
};
