# Space encryption and software compatibility

Harmolyn changes group key coordination automatically as membership changes; it
does not reduce cipher or signature strength to make a large Space cheaper.

- Tree is enforced through 50 members.
- Member 51 causes the Space Owner to publish a fresh signed Crowd epoch.
- A Crowd Space returns to Tree only at 40 or fewer members, avoiding repeated
  mode changes around the boundary.
- Every transition uses a fresh root and a monotonic owner-signed epoch.
- Every v1 channel message requires a hybrid author proof in addition to the
  shared Tree/Crowd ciphertext.

The detailed measurements, update rules, mixed-version behavior, and worst-case
analysis are maintained with the protocol in
[`docs/CRYPTO_COMPATIBILITY.md`](https://github.com/Cogniloom/xorein/blob/main/docs/CRYPTO_COMPATIBILITY.md).

## Client update behavior

A new algorithm or lower size cap must use a new named crypto profile. Existing
ciphertext remains tagged with its original profile; it is not reinterpreted.
The Space Owner advances to a fresh epoch after checking the new capability.
Clients below the required security floor must update before they can join that
epoch. Harmolyn never falls back to plaintext or an unauthenticated profile to
keep an old client connected.

An old partition may continue temporarily under its established keys. When
partitions heal, monotonic owner revisions and epochs reject stale state. If the
same owner key signed two conflicting records at one revision, Harmolyn treats
that as equivocation and stops automatic merge rather than trusting a node or a
majority vote.

## Evidence boundary

Local benchmarks establish that a real 50-member hybrid Tree removal is about
13 ms and produces a roughly 77 KB commit on the measured machine. Crowd keeps
message crypto practical at thousands of members, but rekey distribution and
roster fanout remain O(N). The checked-in 1,000-peer simulation is not proof of
a live 1,000-client WAN deployment. That live churn/bandwidth/old-version soak
remains a release-readiness requirement.
