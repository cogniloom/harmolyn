import logo from "../assets/harmolyn-logo.svg";
import screenshotCrowd from "../assets/screenshot-crowd.jpg";
import screenshotSeal from "../assets/screenshot-seal.jpg";
import { ComparisonSection } from "../components/ComparisonSection";
import { CurrentStateSection } from "../components/CurrentStateSection";
import { SiteFooter } from "../components/SiteFooter";
import { SiteHeader } from "../components/SiteHeader";
import { siteConfig } from "../config";

const features = [
  {
    title: "Peers remain useful",
    body: "Known peers can route signed, destination-sealed requests and continue direct communication when dedicated Nodes disappear.",
    emoji: "🕸️",
  },
  {
    title: "Protection follows the room",
    body: "Seal protects DMs. Private Spaces automatically use Tree or Crowd without weakening payload encryption as they grow.",
    emoji: "🔐",
  },
  {
    title: "Nodes accelerate, never rule",
    body: "Xorein Nodes provide discovery, relay, TURN, mailboxes, and opaque storage—but signatures and hashes decide what clients accept.",
    emoji: "🌐",
  },
  {
    title: "Offline delivery is encrypted",
    body: "Recipient-sealed inbox packets and encrypted attachment fragments can be replicated and repaired across available holders.",
    emoji: "📬",
  },
  {
    title: "Coverage is explicit",
    body: "History and search report Full, Partial, or Empty. A healthy local runtime is not presented as a live peer path.",
    emoji: "🔎",
  },
  {
    title: "Recovery without a vault",
    body: "Chosen contacts can hold recipient-sealed custody backups. Storage providers cannot read them or test the recovery password.",
    emoji: "🗝️",
  },
];

const modes = [
  { name: "Seal", detail: "DMs: hybrid X3DH plus a Double Ratchet." },
  { name: "Tree", detail: "Private Spaces through 50 members; signed tree-oriented epochs." },
  {
    name: "Crowd",
    detail: "Private Spaces from member 51; returns to Tree at 40 or fewer.",
  },
  { name: "Clear", detail: "Infrastructure-readable by explicit policy; never selected by room size." },
];

function LogoChip({ size = 96 }: { size?: number }) {
  return (
    <span
      className="inline-flex items-center justify-center rounded-full bg-card soft-shadow"
      style={{ width: size, height: size }}
    >
      <img
        src={logo}
        alt="Harmolyn"
        width={Math.round(size * 0.72)}
        height={Math.round(size * 0.72)}
      />
    </span>
  );
}

function GitHubIcon() {
  return (
    <svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.42 7.42 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

export function HomePage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteHeader />
      <main>
        <section className="relative overflow-hidden px-4 pt-12 sm:pt-20">
          <div aria-hidden className="absolute inset-0 -z-10 blob-bg" />
          <div className="mx-auto grid max-w-6xl items-center gap-12 lg:grid-cols-[1.1fr_0.9fr] lg:gap-16">
            <div>
              <span className="label-mono inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-muted-foreground">
                <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                peer-owned communication · v{siteConfig.version}
              </span>
              <h1 className="mt-6 text-5xl leading-[1.05] sm:text-6xl lg:text-7xl">
                Communication that <span className="text-primary">belongs to the people</span>{" "}
                in it.
              </h1>
              <p className="mt-6 max-w-xl text-lg text-muted-foreground">
                Harmolyn is the browser and desktop client for Xorein. Clients
                retain encrypted state and verify every accepted record; Xorein
                Nodes improve reach and durability without becoming the source
                of truth.
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                <a
                  href={siteConfig.appUrl}
                  className="inline-flex items-center gap-2 rounded-full bg-foreground px-6 py-3 text-base font-semibold text-background transition-transform hover:scale-[1.02]"
                >
                  Open web app <span aria-hidden>→</span>
                </a>
                <a
                  href={siteConfig.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-6 py-3 text-base font-semibold transition-colors hover:border-foreground/30"
                >
                  <GitHubIcon />
                  View on GitHub
                </a>
              </div>
              <dl className="mt-12 grid grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-4">
                {[
                  { key: "Hybrid", value: "PQ identities" },
                  { key: "Tree", value: "through 50" },
                  { key: "Crowd", value: "from 51" },
                  { key: "AGPL", value: "open source" },
                ].map((stat) => (
                  <div key={stat.key}>
                    <dt className="text-2xl font-bold text-foreground">{stat.key}</dt>
                    <dd className="label-mono mt-1 text-muted-foreground">{stat.value}</dd>
                  </div>
                ))}
              </dl>
            </div>

            <div className="relative mx-auto w-full max-w-md">
              <div className="relative aspect-square overflow-hidden rounded-[2.5rem] border border-border bg-card soft-shadow">
                <div
                  aria-hidden
                  className="absolute inset-0"
                  style={{
                    background:
                      "radial-gradient(55% 55% at 50% 50%, color-mix(in oklab, var(--color-primary) 22%, transparent), transparent 72%)",
                    filter: "blur(8px)",
                  }}
                />
                <div
                  aria-hidden
                  className="pointer-events-none absolute left-1/2 top-1/2 aspect-square w-[78%] -translate-x-1/2 -translate-y-1/2 rounded-full border border-dashed"
                  style={{
                    borderColor:
                      "color-mix(in oklab, var(--color-primary) 35%, transparent)",
                  }}
                />
                <div className="relative flex h-full items-center justify-center">
                  <img
                    src={logo}
                    alt="Harmolyn mascot"
                    className="h-56 w-56 drop-shadow-[0_20px_30px_rgba(0,0,0,0.15)]"
                  />
                </div>
                <span
                  aria-hidden
                  className="pointer-events-none absolute bottom-5 right-6 text-2xl font-bold tracking-tight text-foreground/[0.07]"
                  style={{ fontFamily: "Comfortaa, ui-rounded, sans-serif" }}
                >
                  harmolyn
                </span>
              </div>

              <div className="absolute -left-3 top-8 flex items-center gap-2.5 rounded-full border border-border bg-card px-3 py-2 soft-shadow">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
                </span>
                <span className="flex flex-col leading-tight">
                  <span className="label-mono text-muted-foreground">Seal</span>
                  <span className="text-sm font-semibold text-foreground">E2EE · 1:1</span>
                </span>
              </div>
              <div className="absolute -right-2 top-1/2 flex -translate-y-1/2 items-center gap-2.5 rounded-full border border-border bg-card px-3 py-2 soft-shadow sm:-right-4">
                <span className="h-2 w-2 rounded-full bg-foreground/30" />
                <span className="flex flex-col leading-tight">
                  <span className="label-mono text-muted-foreground">Crowd</span>
                  <span className="text-sm font-semibold text-foreground">epoch</span>
                </span>
              </div>
              <div className="absolute bottom-6 left-6 flex items-center gap-2.5 rounded-full border border-border bg-card px-3 py-2 soft-shadow">
                <span className="h-2 w-2 rounded-full border border-foreground/30 bg-transparent" />
                <span className="flex flex-col leading-tight">
                  <span className="label-mono text-muted-foreground">Clear</span>
                  <span className="text-sm font-semibold text-muted-foreground">labeled</span>
                </span>
              </div>
            </div>
          </div>
        </section>

        <CurrentStateSection />

        <section className="mx-auto mt-32 max-w-6xl px-4">
          <div className="flex flex-wrap items-end justify-between gap-6">
            <div className="max-w-2xl">
              <span className="label-mono text-primary">peer-owned by design</span>
              <h2 className="mt-3 text-4xl sm:text-5xl">
                The client is part of the network—not a window into one server.
              </h2>
            </div>
            <p className="max-w-sm text-muted-foreground">
              Dedicated infrastructure remains useful for bandwidth and
              availability, but it receives ciphertext and public routing
              material—not user authority.
            </p>
          </div>
          <ul className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {features.map((feature) => (
              <li
                key={feature.title}
                className="rounded-3xl border border-border bg-card p-7 transition-transform hover:-translate-y-1 soft-shadow"
              >
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-secondary text-2xl">
                  <span aria-hidden>{feature.emoji}</span>
                </div>
                <h3 className="mt-5 text-xl">{feature.title}</h3>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                  {feature.body}
                </p>
              </li>
            ))}
          </ul>
        </section>

        <section className="mx-auto mt-32 max-w-6xl px-4">
          <div className="rounded-[2.5rem] border border-border bg-card p-8 soft-shadow sm:p-12">
            <span className="label-mono text-primary">security model</span>
            <h2 className="mt-3 max-w-3xl text-4xl sm:text-5xl">
              Protection is visible per conversation.
              <br />
              <span className="text-muted-foreground">Nothing hidden.</span>
            </h2>
            <p className="mt-5 max-w-2xl text-muted-foreground">
              Private DMs and Spaces never silently fall back to plaintext.
              Membership changes advance signed epochs, and room size changes
              key coordination rather than cipher strength.
            </p>
            <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {modes.map((mode) => (
                <li
                  key={mode.name}
                  className="rounded-2xl border border-border bg-background p-5"
                >
                  <span className="label-mono inline-flex items-center gap-2 rounded-full bg-primary/15 px-3 py-1 text-primary">
                    <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                    {mode.name}
                  </span>
                  <p className="mt-3 text-sm text-muted-foreground">{mode.detail}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <ComparisonSection />

        <section className="mx-auto mt-32 max-w-6xl px-4">
          <span className="label-mono text-primary">the client</span>
          <h2 className="mt-3 max-w-3xl text-4xl sm:text-5xl">
            Familiar UI. Security always in view.
          </h2>
          <p className="mt-5 max-w-2xl text-muted-foreground">
            Spaces, channels, and DMs — the layout you already know, with the
            security badge sitting right in the header.
          </p>
          <div className="mt-12 grid gap-6 lg:grid-cols-2">
            {[
              {
                src: screenshotSeal,
                mode: "Seal",
                caption: "1:1 end-to-end encrypted DM.",
              },
              {
                src: screenshotCrowd,
                mode: "Crowd",
                caption: "Large channel with signed epoch rotation.",
              },
            ].map((screenshot) => (
              <figure
                key={screenshot.mode}
                className="overflow-hidden rounded-3xl border border-border bg-card soft-shadow"
              >
                <img
                  src={screenshot.src}
                  alt={`Harmolyn ${screenshot.mode} conversation view`}
                  width={1920}
                  height={1080}
                  loading="lazy"
                  className="aspect-[16/10] w-full object-cover"
                />
                <figcaption className="flex items-center gap-3 border-t border-border px-5 py-4 text-sm text-muted-foreground">
                  <span className="label-mono inline-flex items-center gap-1.5 rounded-full bg-primary/15 px-2.5 py-0.5 text-primary">
                    <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                    {screenshot.mode}
                  </span>
                  <span>{screenshot.caption}</span>
                </figcaption>
              </figure>
            ))}
          </div>
        </section>

        <section className="mx-auto mt-32 max-w-6xl px-4">
          <span className="label-mono text-primary">get harmolyn</span>
          <h2 className="mt-3 max-w-3xl text-4xl sm:text-5xl">
            Use the client. Inspect the evidence. Run the network.
          </h2>
          <div className="mt-12 grid gap-5 md:grid-cols-3">
            {[
              {
                href: siteConfig.appUrl,
                tag: "web",
                title: "Harmolyn Web",
                body: "Use Harmolyn straight from your browser.",
                cta: "Open web app",
              },
              {
                href: siteConfig.sourceUrl,
                tag: "source",
                title: "GitHub repository",
                body: "Read the implementation, tests, threat boundaries, and release gates.",
                cta: "cogniloom/harmolyn",
              },
              {
                href: siteConfig.xoreinUrl,
                tag: "network",
                title: "Xorein Nodes",
                body: "Run discovery, relay, TURN, mailbox, and opaque storage infrastructure.",
                cta: "Explore Xorein",
              },
            ].map((card) => (
              <a
                key={card.tag}
                href={card.href}
                className="group flex flex-col rounded-3xl border border-border bg-card p-7 transition-all hover:-translate-y-1 hover:border-primary/50 soft-shadow"
              >
                <span className="label-mono text-primary">{card.tag}</span>
                <h3 className="mt-3 text-2xl">{card.title}</h3>
                <p className="mt-3 text-sm text-muted-foreground">{card.body}</p>
                <span className="mt-6 inline-flex items-center gap-1 text-sm font-semibold text-foreground">
                  {card.cta}
                  <span className="transition-transform group-hover:translate-x-0.5">→</span>
                </span>
              </a>
            ))}
          </div>
        </section>

        <section className="mx-auto mt-32 max-w-6xl px-4">
          <div className="relative overflow-hidden rounded-[2.5rem] border border-border bg-card p-12 text-center soft-shadow sm:p-16">
            <div aria-hidden className="absolute inset-0 -z-10 blob-bg" />
            <LogoChip />
            <h2 className="mt-6 text-4xl sm:text-5xl">
              Own the <span className="text-primary">conversation</span>.
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-muted-foreground">
              Familiar communication UX, peer-owned encrypted state, and a
              release process that keeps unfinished evidence visible.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <a
                href={siteConfig.appUrl}
                className="inline-flex items-center gap-2 rounded-full bg-foreground px-6 py-3 text-base font-semibold text-background transition-transform hover:scale-[1.02]"
              >
                Open web app →
              </a>
              <a
                href={siteConfig.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 rounded-full border border-border bg-background px-6 py-3 text-base font-semibold transition-colors hover:border-foreground/30"
              >
                View source
              </a>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
