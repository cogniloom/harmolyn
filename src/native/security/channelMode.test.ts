import { describe, expect, it } from 'vitest';
import {
  TREE_MAX_MEMBERS,
  TREE_REENTRY_MEMBERS,
  recordedChannelSecurityMode,
  selectChannelSecurityMode,
} from './channelMode.js';

describe('automatic channel security mode selection', () => {
  it('keeps Tree through its hard 50-member limit', () => {
    expect(selectChannelSecurityMode(TREE_MAX_MEMBERS, 'tree')).toBe('tree');
  });

  it('moves to Crowd at member 51', () => {
    expect(selectChannelSecurityMode(TREE_MAX_MEMBERS + 1, 'tree')).toBe('crowd');
  });

  it('uses hysteresis so 50/51 churn does not flap the mode', () => {
    expect(selectChannelSecurityMode(TREE_MAX_MEMBERS, 'crowd')).toBe('crowd');
    expect(selectChannelSecurityMode(TREE_REENTRY_MEMBERS + 1, 'crowd')).toBe('crowd');
    expect(selectChannelSecurityMode(TREE_REENTRY_MEMBERS, 'crowd')).toBe('tree');
  });

  it('treats pre-v1 mode-less records as Crowd', () => {
    expect(recordedChannelSecurityMode(undefined)).toBe('crowd');
    expect(recordedChannelSecurityMode('tree')).toBe('tree');
  });
});
