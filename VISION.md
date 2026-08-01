# Harmolyn vision

Communication should belong to the people participating in it. Harmolyn's goal
is a network that becomes faster and more durable as useful nodes appear, while
remaining able to communicate through its peers when every dedicated node is
gone.

## Principles

### Peers are the network

Clients retain encrypted state, exchange signed reachability records, route
bounded destination-sealed packets, and help reconstruct history and attachments.
A Xorein Node is an addressable bandwidth/storage contributor, not a central
server.

### Nodes are preferred accelerators

Xorein Nodes should automatically discover peers and one another, provide first
contact, circuit relay, TURN, mailbox holding, and opaque storage, and
continuously repair replica placement. Clients prefer them for bulk traffic so
ordinary users are not needlessly consumed as infrastructure.

### Zero trust is a protocol property

No node receives authority because of its hostname or role claim. Records are
accepted because the author signature, membership epoch, destination binding,
and content hashes verify. Providers are sampled and cross-checked; locally
observed invalid sources are quarantined. Agreement cannot turn an invalid
signature into truth.

### Availability is distributed, not fictional

The network retries through known peers, queues encrypted operations locally,
replicates recipient inbox packets and encrypted fragments, and repairs copies
when routes return. It still cannot recover information that exists on no
reachable device or discover a completely unknown address from zero input. The
product should state those physical limits instead of calling a healthy peer
graph offline because one preferred node failed.

### Scale changes coordination, not protection

Small groups use a tree-oriented key-management mode; larger spaces use bounded
epoch sender keys. Transitions are automatic and signed as membership changes.
The payload cipher and hybrid author authentication are not weakened for large
rooms.

### Recovery must survive hardware loss without creating a new breach

Users may assign recovery contacts. Their password-encrypted custody backup is
additionally sealed to the intended recipient before arbitrary peers or nodes
store it. Providers cannot read it or use it as a password-verification oracle.
This is recoverability, not MFA.

### Releases are part of the trust model

Only source from the official `staging` branch may become a release. Linux,
macOS, and Windows builds must complete before promotion. Platform packages,
updater artifacts, manifests, and checksums are signed; missing credentials fail
closed. Installed data/configuration directories are never replaced by an app
update.

## v1 evidence standard

The label v1.0 requires more than passing unit tests. It requires signed native
artifacts on every supported OS, real update/install preservation tests, a
multi-host peer-feature run, restrictive-NAT TURN evidence, partition/churn
soaks, and hostile-provider tests. Deterministic simulation and local two-browser
tests are necessary foundations, but remain clearly labeled as such.
