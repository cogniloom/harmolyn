/** Fired after the user changes the preferred Xorein HTTP/bootstrap endpoint. */
export const XOREIN_NODE_ENDPOINT_CHANGED_EVENT = 'harmolyn:xorein:node-endpoint-changed';

export function notifyXoreinNodeEndpointChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(XOREIN_NODE_ENDPOINT_CHANGED_EVENT));
}
