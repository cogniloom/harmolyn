import { SiteFooter } from "../components/SiteFooter";
import { SiteHeader } from "../components/SiteHeader";
import { siteConfig } from "../config";

const faqs = [
  {
    question: "Can the network read my DMs?",
    answer:
      "Not in Seal mode. The network can still see unavoidable routing metadata, including who communicates and when.",
  },
  {
    question: "Why does search say “Partial”?",
    answer:
      "Strict end-to-end encryption prevents plaintext infrastructure-side indexing. Partial means your device searched only the history it can currently access.",
  },
  {
    question: "Can I run my own Xorein Node?",
    answer:
      "Yes. Xorein Nodes can provide discovery, storage, relay, and NAT traversal while Harmolyn remains the client.",
  },
  {
    question: "What does Clear mode mean?",
    answer:
      "Clear conversations are readable by infrastructure. They are always explicitly labeled and are never the default for private Spaces.",
  },
];

export function AboutPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteHeader />
      <main className="mx-auto max-w-3xl px-6 py-16">
        <h1 className="text-4xl sm:text-5xl">About Harmolyn</h1>
        <p className="mt-5 text-lg text-muted-foreground">
          Harmolyn is the browser and native desktop client for the Xorein
          network. Its browser-compatible libp2p engine makes each running
          client a peer: it retains encrypted state, verifies author proofs,
          and can route through known peers. Dedicated Xorein Nodes improve
          first contact, storage, relay, TURN, and NAT traversal, but they are
          not trusted with plaintext, private identity keys, or user authority.
        </p>

        <section className="mt-12 rounded-2xl border border-border bg-card p-6">
          <span className="label-mono text-primary">release status</span>
          <h2 className="mt-3 text-2xl">Version 1.0.0-rc.1 is not a finished security claim.</h2>
          <p className="mt-3 text-muted-foreground">
            The peer path, encrypted offline inboxes and attachments, recovery
            custody, voice/video protection, node switching, and fail-closed
            release pipeline are implemented. Independent review, signed
            platform evidence, and long-running real-WAN hostile-network tests
            remain gates before v1.0.
          </p>
          <a
            href="/#compare"
            className="mt-5 inline-flex items-center text-sm font-semibold text-primary underline-offset-4 hover:underline"
          >
            Compare Harmolyn&apos;s trust model with other communication products →
          </a>
        </section>

        <section className="mt-12">
          <h2 className="text-2xl">What end-to-end encryption can and cannot do</h2>
          <p className="mt-3 text-muted-foreground">
            End-to-end encryption protects message bodies, attachments, and
            supported media. It does not remove:
          </p>
          <ul className="mt-4 list-disc space-y-1 pl-6 text-muted-foreground">
            <li>Unavoidable routing metadata</li>
            <li>Endpoint-compromise risk on your device</li>
            <li>
              Usability trade-offs such as limited full-text search when your
              device does not hold all encrypted history
            </li>
          </ul>
          <p className="mt-4 text-muted-foreground">
            Harmolyn surfaces those boundaries with explicit labels instead of
            burying them in documentation.
          </p>
        </section>

        <section className="mt-12">
          <h2 className="text-2xl">FAQ</h2>
          <dl className="mt-6 space-y-6">
            {faqs.map((item) => (
              <div
                key={item.question}
                className="rounded-xl border border-border bg-card p-5"
              >
                <dt className="font-semibold">{item.question}</dt>
                <dd className="mt-2 text-sm text-muted-foreground">{item.answer}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="mt-12 rounded-xl border border-border bg-card p-6">
          <h2 className="text-xl">Verification</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Harmolyn releases ship with checksums, signatures, and
            reproducible-build evidence. Verify artifacts before running them
            when supply-chain assurance matters.
          </p>
          <div className="mt-4 flex flex-wrap gap-3 text-sm">
            <a
              href={siteConfig.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center justify-center rounded-full bg-primary px-4 py-2 font-medium text-primary-foreground hover:opacity-90"
            >
              GitHub repository
            </a>
            <a
              href={siteConfig.xoreinUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center justify-center rounded-full border border-border bg-background px-4 py-2 font-medium text-foreground hover:bg-accent"
            >
              Xorein network
            </a>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
