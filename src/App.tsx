import React, { Suspense, lazy } from 'react';
import { ContextMenuProvider } from "@/components/GlobalContextMenu";
import { XoreinAppProviders } from "@/lib/xoreinClientProvider";
import { ToastProvider } from "@/lib/toastBus";

const Layout = lazy(() => import("@/components/Layout").then(m => ({ default: m.Layout })));

const App = () => (
  <XoreinAppProviders>
    <ToastProvider>
      <ContextMenuProvider>
        <Suspense fallback={<div className="flex h-screen items-center justify-center bg-bg-0"><div className="animate-spin w-8 h-8 border-4 border-primary border-t-transparent rounded-full" /></div>}>
          <Layout />
        </Suspense>
      </ContextMenuProvider>
    </ToastProvider>
  </XoreinAppProviders>
);

export default App;
