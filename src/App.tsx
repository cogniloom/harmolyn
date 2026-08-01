import React, { Suspense, lazy, useEffect } from 'react';
import { ContextMenuProvider } from "@/components/GlobalContextMenu";
import { XoreinAppProviders } from "@/lib/xoreinClientProvider";
import { ToastProvider } from "@/lib/toastBus";
import { runAutomaticUpdate } from '@/lib/appUpdater';

const Layout = lazy(() => import("@/components/Layout").then(m => ({ default: m.Layout })));

const AutomaticUpdate: React.FC = () => {
  useEffect(() => {
    // Let identity/bootstrap rendering finish first. The native updater is
    // default-on, signed, and a no-op in ordinary browser builds.
    const timer = window.setTimeout(() => { void runAutomaticUpdate(); }, 15_000);
    return () => window.clearTimeout(timer);
  }, []);
  return null;
};

const App = () => (
  <XoreinAppProviders>
    <ToastProvider>
      <AutomaticUpdate />
      <ContextMenuProvider>
        <Suspense fallback={<div className="flex h-screen items-center justify-center bg-bg-0"><div className="animate-spin w-8 h-8 border-4 border-primary border-t-transparent rounded-full" /></div>}>
          <Layout />
        </Suspense>
      </ContextMenuProvider>
    </ToastProvider>
  </XoreinAppProviders>
);

export default App;
