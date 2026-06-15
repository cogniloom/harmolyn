/**
 * Short, human-scannable fingerprint of a peer id, e.g. "12D3KooWab…aB12cd".
 * Used wherever the full public key would be too long to show inline (identity
 * cards, the current-identity badge, the account switcher).
 */
export function shortFingerprint(peerId: string | undefined | null, head = 10, tail = 6): string {
  const id = (peerId ?? '').trim();
  if (!id) return '';
  if (id.length <= head + tail + 1) return id;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}
