import React, { Suspense, lazy, useEffect, useLayoutEffect } from 'react';
import { MotionConfig } from 'framer-motion';
import { ContextMenuProvider } from '@/components/GlobalContextMenu';
import { XoreinAppProviders } from '@/lib/xoreinClientProvider';
import { ToastProvider, useToast } from '@/lib/toastBus';
import { runAutomaticUpdate } from '@/lib/appUpdater';
import { installVisualViewport } from '@/lib/stabilization/viewport';

const Layout = lazy(() => import('@/components/Layout').then(module => ({ default: module.Layout })));

const AutomaticUpdate: React.FC = () => {
  const toast = useToast();
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      void runAutomaticUpdate().then(result => {
        if (active && result?.status === 'ready') toast.success(`Signed update ${result.version} is downloaded. Install it from Settings → About when convenient.`, 'Update ready');
      }).catch(() => { /* The signed updater's Settings surface remains the explicit retry path. */ });
    }, 15_000);
    return () => { active = false; window.clearTimeout(timer); };
  }, [toast]);
  return null;
};

const App = () => {
  useLayoutEffect(() => installVisualViewport(window), []);
  return (
    <MotionConfig reducedMotion="user">
      <XoreinAppProviders>
        <ToastProvider>
          <AutomaticUpdate />
          <ContextMenuProvider>
            <Suspense fallback={<div className="app-viewport flex items-center justify-center bg-bg-0" role="status" aria-label="Loading Harmolyn"><div className="animate-spin w-8 h-8 border-4 border-primary border-t-transparent rounded-full" /><span className="sr-only">Loading Harmolyn…</span></div>}>
              <Layout />
            </Suspense>
          </ContextMenuProvider>
        </ToastProvider>
      </XoreinAppProviders>
    </MotionConfig>
  );
};
export default App;
