import { useEffect } from "react";

import { AboutPage } from "./pages/AboutPage";
import { HomePage } from "./pages/HomePage";

const pageMetadata: Record<string, { title: string; description: string }> = {
  "/": {
    title: "Harmolyn — Peer-owned communication on Xorein",
    description:
      "Harmolyn is the browser and desktop client for Xorein: peer-owned encrypted state, untrusted infrastructure, explicit security modes, and honest release evidence.",
  },
  "/about": {
    title: "About Harmolyn — How the client and Xorein fit together",
    description:
      "How Harmolyn's built-in peer engine, Xorein Nodes, end-to-end encryption, recovery, and release-candidate evidence fit together.",
  },
};

function NotFoundPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl text-foreground">404</h1>
        <h2 className="mt-4 text-xl text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you&apos;re looking for doesn&apos;t exist or has been moved.
        </p>
        <a
          href="/"
          className="mt-6 inline-flex items-center justify-center rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition-transform hover:scale-[1.02]"
        >
          Go home
        </a>
      </div>
    </main>
  );
}

export function App() {
  const path = window.location.pathname.replace(/\/$/, "") || "/";
  const metadata = pageMetadata[path] ?? {
    title: "Page not found — Harmolyn",
    description: "The requested Harmolyn page could not be found.",
  };

  useEffect(() => {
    document.title = metadata.title;
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute("content", metadata.description);
  }, [metadata.description, metadata.title]);

  if (path === "/") return <HomePage />;
  if (path === "/about") return <AboutPage />;
  return <NotFoundPage />;
}
