export function event(type: string, properties: Record<string, unknown> = {}): Event {
  const value = new Event(type, { cancelable: true });
  for (const [key, property] of Object.entries(properties)) Object.defineProperty(value, key, { value: property });
  return value;
}
export async function withGlobals(values: Record<string, unknown>, run: () => void | Promise<void>) {
  const original = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  try { await run(); } finally {
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
}

export class Track extends EventTarget { readyState = 'live'; stops = 0; constructor(public kind: string) { super(); } stop() { this.stops++; this.readyState = 'ended'; } }
export class Stream extends EventTarget {
  constructor(private tracks: Track[] = []) { super(); }
  getTracks() { return [...this.tracks]; }
  addTrack(track: Track) { if (!this.tracks.includes(track)) { this.tracks.push(track); this.dispatchEvent(new Event('addtrack')); } }
  removeTrack(track: Track) { this.tracks = this.tracks.filter(item => item !== track); this.dispatchEvent(new Event('removetrack')); }
}
export class MediaElement extends EventTarget {
  srcObject: Stream | null = null; muted = false; paused = true; readyState = 3; attempts = 0;
  result: (() => Promise<void>) | null = null;
  play(): Promise<void> { this.attempts++; if (this.result) return this.result(); this.paused = false; this.dispatchEvent(new Event('playing')); return Promise.resolve(); }
  pause() { this.paused = true; }
}

