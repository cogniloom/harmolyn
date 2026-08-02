import logo from "../assets/harmolyn-logo.svg";
import { siteConfig } from "../config";

export function SiteHeader() {
  const path = window.location.pathname.replace(/\/$/, "") || "/";

  return (
    <header className="sticky top-0 z-40 px-4 pt-4">
      <div className="mx-auto flex max-w-6xl items-center justify-between rounded-full border border-border bg-card/90 px-3 py-2.5 pl-4 backdrop-blur soft-shadow">
        <a href="/" className="flex items-center gap-2.5" aria-label="Harmolyn home">
          <img src={logo} alt="" width={28} height={28} className="h-7 w-7" />
          <span className="text-lg font-bold tracking-tight">harmolyn</span>
        </a>
        <nav aria-label="Primary" className="flex items-center gap-1 text-sm">
          <a
            href="/#compare"
            className="hidden rounded-full px-4 py-2 text-muted-foreground transition-colors hover:text-foreground md:inline-block"
          >
            Compare
          </a>
          <a
            href="/about"
            aria-current={path === "/about" ? "page" : undefined}
            className="hidden rounded-full px-4 py-2 text-muted-foreground transition-colors hover:text-foreground aria-[current=page]:text-foreground md:inline-block"
          >
            About
          </a>
          <a
            href={siteConfig.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="hidden rounded-full px-4 py-2 text-muted-foreground transition-colors hover:text-foreground lg:inline-block"
          >
            GitHub
          </a>
          <a
            href={siteConfig.xoreinUrl}
            target="_blank"
            rel="noreferrer"
            className="hidden rounded-full px-4 py-2 text-muted-foreground transition-colors hover:text-foreground lg:inline-block"
          >
            Xorein
          </a>
          <a
            href={siteConfig.appUrl}
            className="ml-1 inline-flex items-center justify-center rounded-full bg-foreground px-4 py-2 text-sm font-semibold text-background transition-transform hover:scale-[1.02]"
          >
            Open app
          </a>
        </nav>
      </div>
    </header>
  );
}
