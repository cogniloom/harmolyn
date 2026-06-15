import { createContext, useContext } from 'react';
import type { XoreinRuntimeSnapshot } from '@/types';

export const XoreinRuntimeContext = createContext<XoreinRuntimeSnapshot | null>(null);

export type XoreinBootstrapStatus = 'idle' | 'connecting' | 'waiting' | 'retrying' | 'ready' | 'failed';

export interface XoreinBootstrapState {
  status: XoreinBootstrapStatus;
  message: string;
  detail?: string;
}

export const XoreinBootstrapContext = createContext<XoreinBootstrapState>({
  status: 'idle',
  message: '',
});

export function useRuntimeSnapshot(): XoreinRuntimeSnapshot | null {
  return useContext(XoreinRuntimeContext);
}

export function useRuntimeBootstrapState(): XoreinBootstrapState {
  return useContext(XoreinBootstrapContext);
}
