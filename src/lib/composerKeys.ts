/** IME confirmation (including Safari's legacy 229 event) is not a send command. */
export function isComposingKey(event: { isComposing?: boolean; keyCode?: number }): boolean {
  return event.isComposing === true || event.keyCode === 229;
}
