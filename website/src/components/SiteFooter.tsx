import logo from "../assets/harmolyn-logo.svg";
import { siteConfig } from "../config";

export function SiteFooter() {
  return (
    <footer className="mt-24 px-4 pb-6">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 rounded-3xl border border-border bg-card p-8 soft-shadow sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2.5">
          <img src={logo} alt="" width={28} height={28} className="h-7 w-7" />
          <span className="text-sm text-muted-foreground">
            Harmolyn — peer-owned communication on Xorein.
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
          <a
            href="/#compare"
            className="hover:text-foreground"
          >
            Compare
          </a>
          <a
            href={siteConfig.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="hover:text-foreground"
          >
            GitHub
          </a>
          <a
            href={siteConfig.xoreinUrl}
            target="_blank"
            rel="noreferrer"
            className="hover:text-foreground"
          >
            Xorein
          </a>
          <a href={siteConfig.appUrl} className="hover:text-foreground">
            Web app
          </a>
          <span>AGPL-3.0</span>
        </div>
      </div>
    </footer>
  );
}
