import { siteConfig } from "../config";

type Status = "yes" | "partial" | "no";

type Criterion = {
  key: "e2ee" | "pq" | "peer" | "source" | "authority" | "business";
  label: string;
  shortLabel: string;
};

type Product = {
  name: string;
  note: string;
  harmolyn?: boolean;
  statuses: Record<Criterion["key"], Status>;
  details: Record<Criterion["key"], string>;
};

const criteria: Criterion[] = [
  { key: "e2ee", label: "Private E2EE", shortLabel: "E2EE" },
  { key: "pq", label: "PQ protocol", shortLabel: "Post-quantum" },
  { key: "peer", label: "Peer path", shortLabel: "Peer path" },
  { key: "source", label: "Public stack", shortLabel: "Public stack" },
  { key: "authority", label: "No global ban", shortLabel: "No global ban" },
  { key: "business", label: "No paid/ads tier", shortLabel: "No paid/ads" },
];

const products: Product[] = [
  {
    name: "Harmolyn",
    note: "Peer-owned client + network",
    harmolyn: true,
    statuses: {
      e2ee: "yes",
      pq: "yes",
      peer: "yes",
      source: "yes",
      authority: "yes",
      business: "yes",
    },
    details: {
      e2ee: "Seal DMs and private Spaces are E2EE; Clear is explicit and labeled.",
      pq: "X25519 + ML-KEM-768 key establishment and Ed25519 + ML-DSA-65 identity proofs.",
      peer: "Known peers can communicate and route bounded requests without a dedicated node.",
      source: "The client and Xorein network are published under AGPL-3.0-or-later.",
      authority: "Identities belong to users. Space owners moderate locally; no platform can ban an identity everywhere.",
      business: "No ads, behavioral profile, mandatory subscription, or paid feature tier.",
    },
  },
  {
    name: "Signal",
    note: "Private nonprofit messenger",
    statuses: {
      e2ee: "yes",
      pq: "partial",
      peer: "no",
      source: "partial",
      authority: "no",
      business: "yes",
    },
    details: {
      e2ee: "Messages and calls are E2EE by default.",
      pq: "PQXDH is deployed; the Triple Ratchet was still described as a staged rollout.",
      peer: "Accounts and delivery depend on the Signal service.",
      source: "Signal publishes application and server source, with a private anti-spam component.",
      authority: "Signal remains the account and service operator.",
      business: "Donation-funded nonprofit with no ads or required payment.",
    },
  },
  {
    name: "Threema",
    note: "Paid privacy messenger",
    statuses: {
      e2ee: "yes",
      pq: "no",
      peer: "no",
      source: "partial",
      authority: "no",
      business: "no",
    },
    details: {
      e2ee: "Messages, calls, groups, profiles, and membership data are E2EE.",
      pq: "No deployed post-quantum chat protocol is documented in the reviewed material.",
      peer: "Consumer delivery uses Threema switching infrastructure.",
      source: "Client source is public; the complete service stack is not.",
      authority: "Threema operates the consumer identity and delivery service.",
      business: "Commercial paid app and business subscriptions.",
    },
  },
  {
    name: "Matrix",
    note: "Federated protocol ecosystem",
    statuses: {
      e2ee: "partial",
      pq: "no",
      peer: "no",
      source: "yes",
      authority: "partial",
      business: "partial",
    },
    details: {
      e2ee: "New rooms default to E2EE, but rooms and client support can vary.",
      pq: "The Matrix Foundation lists post-quantum encryption as future work.",
      peer: "Current clients use homeservers; peer-to-peer Matrix remains future work.",
      source: "Open protocol with open clients and server implementations.",
      authority: "No universal operator, but each homeserver controls its users and federation policy.",
      business: "The protocol is open; client and hosting business models vary.",
    },
  },
  {
    name: "WhatsApp",
    note: "Meta-operated messenger",
    statuses: {
      e2ee: "yes",
      pq: "no",
      peer: "no",
      source: "no",
      authority: "no",
      business: "no",
    },
    details: {
      e2ee: "Personal messages and calls are E2EE by default.",
      pq: "Meta documents a broader PQ migration, not a deployed WhatsApp PQ chat protocol.",
      peer: "Identity and delivery depend on WhatsApp infrastructure.",
      source: "The complete client and service stack is proprietary.",
      authority: "Meta operates accounts, policy enforcement, and service access.",
      business: "WhatsApp has Status ads, promoted channels, and channel subscriptions.",
    },
  },
  {
    name: "Telegram",
    note: "Cloud messenger",
    statuses: {
      e2ee: "partial",
      pq: "no",
      peer: "no",
      source: "partial",
      authority: "no",
      business: "no",
    },
    details: {
      e2ee: "Only device-specific Secret Chats provide message E2EE; Cloud Chats do not.",
      pq: "No deployed post-quantum chat protocol is documented.",
      peer: "Cloud Chats and identity depend on Telegram infrastructure.",
      source: "Clients are public and verifiable; server source is not published.",
      authority: "Telegram operates accounts, cloud history, and platform enforcement.",
      business: "Premium, Stars, paid posts, sponsored messages, and ads fund the platform.",
    },
  },
  {
    name: "Discord",
    note: "Community platform",
    statuses: {
      e2ee: "partial",
      pq: "no",
      peer: "no",
      source: "no",
      authority: "no",
      business: "no",
    },
    details: {
      e2ee: "Voice/video is E2EE by default; text messages are not E2EE.",
      pq: "No deployed post-quantum messaging protocol is documented.",
      peer: "Accounts, text, moderation, and discovery depend on Discord.",
      source: "The complete platform stack is proprietary.",
      authority: "Discord enforces platform-wide account and server rules.",
      business: "Nitro, Shop purchases, and rewarded advertising fund the platform.",
    },
  },
  {
    name: "Slack",
    note: "Enterprise SaaS",
    statuses: {
      e2ee: "no",
      pq: "no",
      peer: "no",
      source: "no",
      authority: "no",
      business: "no",
    },
    details: {
      e2ee: "Slack documents encryption in transit and at rest, not participant-only E2EE.",
      pq: "No deployed post-quantum messaging protocol is documented.",
      peer: "Workspaces, history, and delivery depend on Slack infrastructure.",
      source: "The complete platform stack is proprietary.",
      authority: "Workspace owners and Slack control access and retention.",
      business: "Commercial SaaS with paid feature and governance tiers.",
    },
  },
  {
    name: "Teams",
    note: "Microsoft 365 collaboration",
    statuses: {
      e2ee: "partial",
      pq: "no",
      peer: "no",
      source: "no",
      authority: "no",
      business: "no",
    },
    details: {
      e2ee: "Chats use service encryption; E2EE is limited to supported calls and meetings.",
      pq: "No deployed post-quantum Teams messaging protocol is documented.",
      peer: "Tenants, identity, meetings, and history depend on Microsoft 365.",
      source: "The complete platform stack is proprietary.",
      authority: "Tenant administrators and Microsoft control service access.",
      business: "Commercial Microsoft 365 licensing and paid tiers.",
    },
  },
];

const proofPoints = [
  {
    icon: "shield",
    title: "Private by default",
    body: "Seal DMs and private Spaces are E2EE.",
  },
  {
    icon: "lock",
    title: "Post-quantum now",
    body: "ML-KEM-768 + ML-DSA-65, hybrid with classical crypto.",
  },
  {
    icon: "network",
    title: "Peers keep it alive",
    body: "Known peers can route after a relay disappears.",
  },
  {
    icon: "identity",
    title: "No global ban switch",
    body: "Space owners moderate; no company owns every account.",
  },
  {
    icon: "code",
    title: "Public source",
    body: "AGPL client and Xorein network code.",
  },
  {
    icon: "eye",
    title: "No attention business",
    body: "No ads, paid tier, or behavioral profile.",
  },
] as const;

const sources = [
  { label: "Harmolyn source", href: siteConfig.sourceUrl },
  { label: "Signal PQ rollout", href: "https://signal.org/blog/spqr/" },
  { label: "Signal government request", href: "https://signal.org/bigbrother/district-of-columbia/" },
  { label: "Signal funding", href: "https://support.signal.org/hc/en-us/articles/360031949872-Donor-FAQs" },
  { label: "Threema transparency", href: "https://threema.com/en/transparency-report" },
  { label: "Telegram FAQ", href: "https://telegram.org/faq#q-how-secure-is-telegram" },
  { label: "Telegram data policy", href: "https://telegram.org/privacy#8-3-law-enforcement-authorities" },
  { label: "Discord E2EE scope", href: "https://discord.com/blog/every-voice-and-video-call-on-discord-is-now-end-to-end-encrypted" },
  { label: "Discord enforcement", href: "https://discord.com/safety-transparency" },
  { label: "Discord advertising", href: "https://support.discord.com/hc/en-us/articles/22225719947543-Discord-Quests-FAQ" },
  { label: "Slack security", href: "https://slack.com/trust/security" },
  { label: "Slack legal requests", href: "https://slack.com/trust/data-request/transparency-report" },
  { label: "Teams E2EE scope", href: "https://learn.microsoft.com/en-us/microsoftteams/teams-end-to-end-encryption" },
  { label: "Microsoft requests", href: "https://www.microsoft.com/en-us/corporate-responsibility/law-enforcement-requests-report" },
  { label: "Matrix architecture", href: "https://matrix.org/foundation/about/" },
  { label: "Matrix 2025 roadmap", href: "https://matrix.org/foundation/reports/2025%20Public%20Annual%20Report.pdf" },
  { label: "WhatsApp E2EE", href: "https://engineering.fb.com/2023/04/13/security/whatsapp-key-transparency/" },
  { label: "WhatsApp advertising", href: "https://about.fb.com/news/2025/06/helping-you-find-more-channels-businesses-on-whatsapp/" },
  { label: "Measured app blocking", href: "https://explorer.ooni.org/fa/social-media" },
  { label: "Discord blocked in Türkiye", href: "https://explorer.ooni.org/findings/267640924000" },
  { label: "Signal proxy support", href: "https://support.signal.org/hc/en-us/articles/360056052052-Proxy-Support" },
];

function FeatureIcon({ name }: { name: (typeof proofPoints)[number]["icon"] }) {
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    strokeWidth: 1.8,
  };

  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-6 w-6" {...common}>
      {name === "shield" && <path d="M12 3 5.5 5.7v5.6c0 4.1 2.5 7.6 6.5 9.7 4-2.1 6.5-5.6 6.5-9.7V5.7L12 3Z" />}
      {name === "lock" && <><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>}
      {name === "network" && <><circle cx="12" cy="5" r="2" /><circle cx="5" cy="18" r="2" /><circle cx="19" cy="18" r="2" /><path d="m10.8 6.8-4.5 9M13.2 6.8l4.5 9M7 18h10" /></>}
      {name === "identity" && <><circle cx="12" cy="8" r="4" /><path d="M4.5 21a7.5 7.5 0 0 1 15 0" /></>}
      {name === "code" && <><path d="m8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16" /></>}
      {name === "eye" && <><path d="M3 12s3.5-5 9-5 9 5 9 5-3.5 5-9 5-9-5-9-5Z" /><circle cx="12" cy="12" r="2" /><path d="m4 4 16 16" /></>}
    </svg>
  );
}

function StatusMark({ status, detail }: { status: Status; detail: string }) {
  const label = status === "yes" ? "Yes" : status === "partial" ? "Partial" : "No";
  const styles = status === "yes"
    ? "bg-primary text-[#071014]"
    : status === "partial"
      ? "bg-amber-400 text-[#201500]"
      : "border border-white/15 bg-white/[0.03] text-white/35";

  return (
    <span
      className={`inline-flex h-7 w-7 items-center justify-center rounded-full text-sm font-black ${styles}`}
      title={`${label}: ${detail}`}
      aria-label={`${label}. ${detail}`}
    >
      {status === "yes" ? "✓" : status === "partial" ? "~" : "—"}
    </span>
  );
}

function PeerRouteDiagram() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 540 190"
      className="h-auto w-full max-w-xl"
      fill="none"
    >
      <g stroke="currentColor" className="text-primary" strokeDasharray="5 6" strokeWidth="2">
        <path d="M38 42c98-6 126 34 218 26s111-40 238-24" />
        <path d="M38 95c93 3 122-32 217-19s127 36 239 18" />
        <path d="M38 148c96 10 134-23 222-15s121 30 234 14" />
      </g>
      <g className="text-primary" fill="currentColor" stroke="white" strokeWidth="2">
        {[38, 494].flatMap((x) => [42, 95, 148].map((y) => <circle key={`${x}-${y}`} cx={x} cy={y} r="12" />))}
        <circle cx="164" cy="30" r="12" />
        <circle cx="377" cy="33" r="12" />
        <circle cx="381" cy="150" r="12" />
      </g>
      <g fill="#071014">
        {[38, 494].flatMap((x) => [42, 95, 148].map((y) => <g key={`eyes-${x}-${y}`}><circle cx={x - 4} cy={y} r="1.5" /><circle cx={x + 4} cy={y} r="1.5" /></g>))}
      </g>
      <g>
        {[48, 95, 142].map((y) => (
          <g key={y} transform={`translate(270 ${y})`}>
            <circle r="18" fill="#ff4855" />
            <circle r="25" stroke="#ff4855" strokeDasharray="4 4" />
            <path d="m-6-6 12 12m0-12L-6 6" stroke="white" strokeLinecap="round" strokeWidth="3" />
          </g>
        ))}
      </g>
    </svg>
  );
}

export function ComparisonSection() {
  return (
    <section
      id="compare"
      className="mt-32 scroll-mt-24 overflow-hidden bg-[#071014] text-white"
      aria-labelledby="comparison-heading"
    >
      <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-24">
        <div className="grid items-center gap-12 lg:grid-cols-[1.05fr_0.95fr]">
          <div>
            <span className="label-mono text-primary">comparison · reviewed 2 august 2026</span>
            <h2 id="comparison-heading" className="mt-4 text-5xl leading-[1.04] sm:text-6xl">
              Remove the <span className="text-primary">choke points.</span>
            </h2>
            <p className="mt-6 max-w-2xl text-lg leading-relaxed text-white/70 sm:text-xl">
              Harmolyn is the only option here combining private E2EE, deployed
              hybrid post-quantum cryptography, a zero-vendor peer path, public
              client + network source, and no platform account authority.
            </p>
          </div>
          <PeerRouteDiagram />
        </div>

        <ul className="mt-16 grid overflow-hidden rounded-3xl border border-white/15 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          {proofPoints.map((point, index) => (
            <li
              key={point.title}
              className={`grid grid-cols-[2.75rem_1fr] gap-x-4 p-5 sm:block sm:min-h-44 sm:p-6 ${index > 0 ? "border-t border-white/15 sm:border-t-0" : ""} ${index % 2 === 1 ? "sm:border-l" : ""} ${index > 1 ? "lg:border-t-0" : ""} ${index % 3 !== 0 ? "lg:border-l" : "lg:border-l-0"} ${index > 0 ? "xl:border-l xl:border-t-0" : ""}`}
            >
              <span className="flex h-11 w-11 items-center justify-center rounded-full border border-white/20 text-primary">
                <FeatureIcon name={point.icon} />
              </span>
              <h3 className="font-sans text-base font-bold tracking-tight sm:mt-5">{point.title}</h3>
              <p className="col-start-2 mt-1 text-sm leading-relaxed text-white/60 sm:mt-3">{point.body}</p>
            </li>
          ))}
        </ul>

        <div className="mt-6 overflow-hidden rounded-3xl border border-white/15">
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[920px] border-collapse">
              <caption className="sr-only">Communication product architecture comparison</caption>
              <thead>
                <tr className="border-b border-white/15 bg-white/[0.03]">
                  <th scope="col" className="w-52 px-6 py-4 text-left label-mono text-white/45">Product</th>
                  {criteria.map((criterion) => (
                    <th key={criterion.key} scope="col" className="px-3 py-4 text-center label-mono text-white/45">
                      {criterion.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {products.map((product) => (
                  <tr
                    key={product.name}
                    className={`border-b border-white/10 last:border-b-0 ${product.harmolyn ? "bg-primary/[0.09]" : ""}`}
                  >
                    <th scope="row" className="px-6 py-3 text-left">
                      <span className={`block text-base font-bold ${product.harmolyn ? "text-primary" : "text-white"}`}>
                        {product.name}
                      </span>
                      <span className="mt-0.5 block text-xs font-normal text-white/40">{product.note}</span>
                    </th>
                    {criteria.map((criterion) => (
                      <td key={criterion.key} className="px-3 py-3 text-center">
                        <StatusMark status={product.statuses[criterion.key]} detail={product.details[criterion.key]} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="divide-y divide-white/10 md:hidden">
            {products.map((product) => (
              <article key={product.name} className={`p-5 ${product.harmolyn ? "bg-primary/[0.09]" : ""}`}>
                <div className="flex items-baseline justify-between gap-4">
                  <h3 className={`text-xl ${product.harmolyn ? "text-primary" : "text-white"}`}>{product.name}</h3>
                  <span className="text-right text-[11px] text-white/40">{product.note}</span>
                </div>
                <dl className="mt-4 grid grid-cols-3 overflow-hidden rounded-xl border border-white/10">
                  {criteria.map((criterion) => (
                    <div key={criterion.key} className="flex min-h-20 flex-col items-center justify-center gap-2 border-b border-r border-white/10 p-2 text-center [&:nth-child(3n)]:border-r-0 [&:nth-child(n+4)]:border-b-0">
                      <dt className="text-[10px] leading-tight text-white/50">{criterion.shortLabel}</dt>
                      <dd><StatusMark status={product.statuses[criterion.key]} detail={product.details[criterion.key]} /></dd>
                    </div>
                  ))}
                </dl>
              </article>
            ))}
          </div>
        </div>

        <div className="mt-6 grid overflow-hidden rounded-3xl border border-white/15 lg:grid-cols-[1.05fr_0.95fr]">
          <div className="grid sm:grid-cols-3">
            {[
              ["Stored data", "can be compelled", "Slack disclosed content for five search warrants in its 2021 report."],
              ["Platform accounts", "can be suspended", "Discord publicly reports enforcement against accounts and communities."],
              ["Known endpoints", "can be blocked", "Signal, Discord, Telegram, and WhatsApp have documented access blocks."],
            ].map(([lead, outcome, evidence], index) => (
              <div key={lead} className={`p-6 ${index > 0 ? "border-t border-white/15 sm:border-l sm:border-t-0" : ""}`}>
                <span aria-hidden className="text-2xl text-[#ff4855]">{index === 0 ? "!" : index === 1 ? "×" : "⊘"}</span>
                <p className="mt-4 text-base font-bold">{lead}<br />{outcome}.</p>
                <p className="mt-3 text-xs leading-relaxed text-white/45">{evidence}</p>
              </div>
            ))}
          </div>
          <div className="border-t border-white/15 bg-white/[0.03] p-7 lg:border-l lg:border-t-0">
            <p className="text-2xl font-bold leading-snug text-primary">
              Architecture decides whether one order, one company, or one
              blocked hostname can end the conversation.
            </p>
            <p className="mt-4 text-sm leading-relaxed text-white/55">
              Harmolyn removes the universal switch. It cannot protect a
              compromised device, make an unreachable peer reachable, or stop
              a network operator from blocking known addresses.
            </p>
          </div>
        </div>

        <div className="mt-8">
          <p className="max-w-3xl text-xs leading-relaxed text-white/45">
            ✓ means the reviewed product documents the property today; ~ means
            limited, optional, in rollout, or deployment-dependent; — means the
            complete property is not documented. Product behavior varies by
            plan, client, room, policy, and backup setting. Harmolyn remains a
            release candidate and does not claim audit parity with mature messengers.
          </p>
          <details className="group mt-5 text-sm">
            <summary className="w-fit cursor-pointer font-bold text-primary underline-offset-4 hover:underline">
              Read the evidence and sources
            </summary>
            <div className="mt-4 grid max-w-4xl gap-x-6 gap-y-2 rounded-2xl border border-white/15 bg-white/[0.03] p-5 sm:grid-cols-2 lg:grid-cols-3">
              {sources.map((source) => (
                <a
                  key={source.href}
                  href={source.href}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-white/65 underline-offset-4 hover:text-primary hover:underline"
                >
                  {source.label} ↗
                </a>
              ))}
            </div>
          </details>
        </div>
      </div>
    </section>
  );
}
