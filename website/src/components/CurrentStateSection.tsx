const implemented = [
  "Browser and native clients with a built-in libp2p peer engine",
  "Seal DMs plus automatically selected Tree and Crowd protection for private Spaces",
  "Signed invites, membership epochs, history, encrypted attachments, and offline inbox replication",
  "End-to-end encrypted voice and video with short-lived TURN credentials from Xorein Nodes",
  "Recipient-sealed account recovery held by user-chosen recovery contacts",
  "Node switching, signed-update verification, and release automation that fails closed",
];

const evidenceGates = [
  "Independent cryptographic and protocol review of the custom Tree/Crowd design",
  "Signed macOS and Windows artifact plus updater install and rollback evidence",
  "Long-running, real-WAN tests across multiple hosts, restrictive NATs, churn, and partitions",
  "Live hostile-provider and recovery drills beyond deterministic simulations and local browser tests",
];

export function CurrentStateSection() {
  return (
    <section className="mx-auto mt-32 max-w-6xl px-4" aria-labelledby="today-heading">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div className="max-w-2xl">
          <span className="label-mono text-primary">harmolyn today</span>
          <h2 id="today-heading" className="mt-3 text-4xl sm:text-5xl">
            Implemented in the client. Honest about the evidence.
          </h2>
        </div>
        <p className="max-w-sm text-muted-foreground">
          Version 1.0.0-rc.1 is a release candidate. Passing tests and a complete
          architecture are not presented as an independent audit.
        </p>
      </div>

      <div className="mt-12 overflow-hidden rounded-[2.5rem] border border-border bg-card soft-shadow">
        <div className="grid lg:grid-cols-2">
          <div className="p-8 sm:p-10">
            <span className="label-mono text-primary">implemented now</span>
            <ul className="mt-6 space-y-4">
              {implemented.map((item) => (
                <li key={item} className="flex gap-3 text-sm leading-relaxed">
                  <span
                    aria-hidden
                    className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary"
                  />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="border-t border-border bg-background/70 p-8 sm:p-10 lg:border-l lg:border-t-0">
            <span className="label-mono text-muted-foreground">still earning v1.0</span>
            <ul className="mt-6 space-y-4">
              {evidenceGates.map((item) => (
                <li key={item} className="flex gap-3 text-sm leading-relaxed text-muted-foreground">
                  <span
                    aria-hidden
                    className="mt-1.5 h-2 w-2 shrink-0 rounded-full border border-foreground/35"
                  />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
