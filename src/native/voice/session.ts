// VoiceSession — a peer-to-peer WebRTC MESH for one voice channel.
//
// There is NO SFU (node.xorein.com is relay/blob support only). Each participant
// holds one RTCPeerConnection per other participant. Signaling is request/response
// over libp2p (see signaling.ts + PeerSync.requestPeer/requestScope). Media is E2E
// encrypted by WebRTC DTLS; SFrame is layered on top for server (Crowd) channels
// when the browser supports Insertable Streams.
//
// JOIN IS LOCAL-FIRST: the instant the mic is captured we publish ourselves into
// voice_sessions so the UI shows "in channel" + the participant list + speaking
// ring — mesh connectivity then happens best-effort and never blocks/undoes the
// join (the old SFU design threw out of join() when the non-existent SFU didn't
// answer, which is why clicking a voice channel only ever prompted for the mic).
import type { Libp2p } from 'libp2p';
import {
  getState,
  joinVoice as storeJoinVoice,
  leaveVoice as storeLeaveVoice,
  setVoiceParticipant,
  setVoiceConnectionState,
  setVoiceSecurityMode,
  setVoiceTurnUnavailable,
  upsertPeer,
} from '../state/store.js';
import { publishNativeSnapshot } from '../state/snapshot.js';
import { getPeerSync } from '../sync/registry.js';
import { deriveVoicePeerKey, voiceSecurityMode } from './keys.js';
import { createEncryptTransform, createDecryptTransform, MAX_SENDER_SLOTS, type PeerKey } from './mediashield.js';
import {
  fetchTurnCredentials, VOICE_OPS,
  type VoicePresenceRequest, type VoicePresenceResponse,
  type VoiceOfferRequest, type VoiceOfferResponse, type VoiceIceRequest,
} from './signaling.js';
import { VoiceActivityMonitor } from './activity.js';
import { IceCandidateBuffer, ReconnectScheduler, hasTurnServer, sfuConnectTargets } from './reliability.js';
import { PROTOCOLS } from '../families/families.js';
import { resolveFeatureFlag } from '../../config/featureFlags.js';

// ── Insertable Streams capability probe ───────────────────────────────────────

type InsertableCap = 'scriptTransform' | 'encodedStreams' | 'none';

// Grace window after ICE 'disconnected' before we escalate to recovery — most
// disconnects are transient network blips that self-heal well within this.
const DISCONNECT_GRACE_MS = 3000;
// Voice joins can cross on the wire: the first presence request may arrive just
// before the other browser has finished publishing its local voice session. A
// short bounded retry window closes that race without turning presence into a
// polling loop or making the support node authoritative for call membership.
const VOICE_PRESENCE_RETRY_DELAYS_MS = [120, 240, 480] as const;

function insertableStreamsCapability(): InsertableCap {
  if (typeof RTCRtpSender === 'undefined') return 'none';
  if ('transform' in RTCRtpSender.prototype) return 'scriptTransform';
  if ('createEncodedStreams' in RTCRtpSender.prototype) return 'encodedStreams';
  return 'none';
}

// Returns true only if the SFrame transform was actually installed. A false return
// means media falls back to DTLS-only, so the caller must NOT keep claiming Crowd
// protection (badge honesty — never overclaim encryption the pipeline didn't apply).
//
// `counterSlot` MUST be unique per concurrently-active ENCRYPTING sender that
// shares `pk`'s key (see mediashield.ts SLOT_BITS doc) — it only matters for the
// scriptTransform/Worker path: the worker builds its own in-worker PeerKey from
// cloned key bytes rather than sharing this process's live one. The
// encodedStreams fallback path reuses `pk` itself (a live, in-process object), so
// its frameCounter is already correctly shared across every sender that uses it.
function attachSenderTransform(sender: RTCRtpSender, pk: PeerKey, cap: Exclude<InsertableCap, 'none'>, counterSlot: number): boolean {
  try {
    if (cap === 'scriptTransform') {
      const worker = new Worker(new URL('./mediashield-worker.ts', import.meta.url), { type: 'module' });
      const xf = new RTCRtpScriptTransform(worker, { op: 'encrypt', peerId: pk.peerId, keyBytes: Array.from(pk.key), counterSlot });
      (sender as RTCRtpSender & { transform: RTCRtpScriptTransform }).transform = xf;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { readable, writable } = (sender as any).createEncodedStreams();
      const ts = new TransformStream({ transform: createEncryptTransform(pk) });
      readable.pipeThrough(ts).pipeTo(writable);
    }
    return true;
  } catch { return false; }
}

function attachReceiverTransform(receiver: RTCRtpReceiver, pk: PeerKey, cap: Exclude<InsertableCap, 'none'>): boolean {
  try {
    if (cap === 'scriptTransform') {
      const worker = new Worker(new URL('./mediashield-worker.ts', import.meta.url), { type: 'module' });
      const xf = new RTCRtpScriptTransform(worker, { op: 'decrypt', peerId: pk.peerId, keyBytes: Array.from(pk.key) });
      (receiver as RTCRtpReceiver & { transform: RTCRtpScriptTransform }).transform = xf;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { readable, writable } = (receiver as any).createEncodedStreams();
      const ts = new TransformStream({ transform: createDecryptTransform(pk) });
      readable.pipeThrough(ts).pipeTo(writable);
    }
    return true;
  } catch { return false; }
}

// ── AV preference helpers ─────────────────────────────────────────────────────

const AV_PREFS_KEY = 'harmolyn:settings:audio-video';

type VoiceBitrate = 'low' | 'medium' | 'high' | 'studio';
type VideoBitrate = 'low' | 'medium' | 'high' | 'ultra';
type VideoQuality = '360p' | '480p' | '720p' | '1080p' | '1440p' | '2160p';

interface AvPrefs {
  micDevice?: string;
  cameraDevice?: string;
  noiseSuppression?: boolean;
  echoCancellation?: boolean;
  autoGainControl?: boolean;
  /** "Music mode": forces stereo + full-band Opus and disables EC/NS/AGC. */
  highFidelityAudio?: boolean;
  /** Trade robustness for latency: 10ms Opus packets + minimal jitter buffer. */
  ultraLowLatency?: boolean;
  /** Capture volume 0..100 — applied via a WebAudio gain stage. */
  micVolume?: number;
  voiceBitrate?: VoiceBitrate;
  videoBitrate?: VideoBitrate;
  videoQuality?: VideoQuality;
  videoFrameRate?: number;
}

const VIDEO_RES: Record<string, { width: number; height: number }> = {
  '360p': { width: 640, height: 360 },
  '480p': { width: 854, height: 480 },
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '1440p': { width: 2560, height: 1440 },
  '2160p': { width: 3840, height: 2160 },
};

// Target media bitrates (bits/sec). This is a P2P mesh — bandwidth is the user's
// call — so the ceilings are generous. Studio Opus tops out at 510 kbps stereo.
const VOICE_BPS: Record<VoiceBitrate, number> = {
  low: 48_000, medium: 128_000, high: 256_000, studio: 510_000,
};
const VIDEO_BPS: Record<VideoBitrate, number> = {
  low: 1_000_000, medium: 4_000_000, high: 12_000_000, ultra: 40_000_000,
};

// Modern → legacy. AV1 = best compression; VP9 the safe high-quality middle;
// H.264 the universal hardware floor; VP8 the last-resort fallback.
const VIDEO_CODEC_ORDER = ['video/av1', 'video/vp9', 'video/h264', 'video/vp8'];

function readAvPrefs(): AvPrefs {
  try {
    const raw = localStorage.getItem(AV_PREFS_KEY);
    return raw ? (JSON.parse(raw) as AvPrefs) : {};
  } catch {
    return {};
  }
}

function audioConstraints(prefs: AvPrefs): MediaTrackConstraints {
  // Studio/music mode disables the browser DSP (EC/NS/AGC) — those gate and
  // colour the signal, the opposite of studio grade — and captures 48 kHz stereo.
  const hifi = prefs.highFidelityAudio ?? false;
  const c: MediaTrackConstraints = {
    noiseSuppression: hifi ? false : (prefs.noiseSuppression ?? true),
    echoCancellation: hifi ? false : (prefs.echoCancellation ?? true),
    autoGainControl: hifi ? false : (prefs.autoGainControl ?? true),
    channelCount: hifi ? 2 : 1,
    sampleRate: 48_000,
  };
  if (prefs.micDevice && prefs.micDevice !== 'default') c.deviceId = { exact: prefs.micDevice };
  return c;
}

function cameraConstraints(prefs: AvPrefs): MediaTrackConstraints {
  const res = VIDEO_RES[prefs.videoQuality ?? '720p'] ?? VIDEO_RES['720p'];
  const c: MediaTrackConstraints = {
    width: { ideal: res.width },
    height: { ideal: res.height },
    frameRate: { ideal: prefs.videoFrameRate ?? 30, max: 60 },
  };
  if (prefs.cameraDevice && prefs.cameraDevice !== 'default') c.deviceId = { exact: prefs.cameraDevice };
  return c;
}

interface PeerConnectionStats { rttMs: number | null; jitterMs: number | null; lossPct: number | null }

interface MicGraph { stream: MediaStream; ctx: AudioContext; gain: GainNode }

/** Route the raw mic through a WebAudio GainNode so capture volume (0..100%) can
 *  be set live. The returned stream's track is what we send/monitor. Returns null
 *  when WebAudio is unavailable (caller falls back to the raw track). `latencyHint`
 *  keeps the added processing delay minimal (lower still in ultra-low-latency mode). */
function buildMicGain(rawStream: MediaStream, volumePct: number, latencyHint: AudioContextLatencyCategory | number): MicGraph | null {
  const AudioCtor = typeof AudioContext !== 'undefined'
    ? AudioContext
    : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtor || rawStream.getAudioTracks().length === 0) return null;
  try {
    const ctx = new AudioCtor({ latencyHint });
    const source = ctx.createMediaStreamSource(rawStream);
    const gain = ctx.createGain();
    gain.gain.value = Math.max(0, volumePct / 100);
    const dest = ctx.createMediaStreamDestination();
    source.connect(gain).connect(dest);
    return { stream: dest.stream, ctx, gain };
  } catch {
    return null;
  }
}

// ── Codec selection, Opus tuning, sender bitrate ──────────────────────────────

/** Reorder each transceiver's codec list to prefer modern, high-compression
 *  codecs. Feature-detected and non-fatal: missing codecs are simply skipped. */
function preferCodecs(pc: RTCPeerConnection): void {
  if (typeof RTCRtpReceiver === 'undefined' || !RTCRtpReceiver.getCapabilities) return;
  for (const t of pc.getTransceivers()) {
    const kind = t.sender.track?.kind ?? t.receiver.track?.kind;
    if (!kind || typeof t.setCodecPreferences !== 'function') continue;
    try {
      const caps = RTCRtpReceiver.getCapabilities(kind);
      if (!caps) continue;
      const codecs = [...caps.codecs];
      if (kind === 'video') {
        codecs.sort((a, b) => videoCodecRank(a.mimeType) - videoCodecRank(b.mimeType));
      } else {
        // Opus first; keep telephone-event / others after it.
        codecs.sort((a, b) =>
          (a.mimeType.toLowerCase() === 'audio/opus' ? 0 : 1) -
          (b.mimeType.toLowerCase() === 'audio/opus' ? 0 : 1));
      }
      t.setCodecPreferences(codecs);
    } catch { /* unsupported / invalid order — fall back to browser default */ }
  }
}

function videoCodecRank(mimeType: string): number {
  const i = VIDEO_CODEC_ORDER.indexOf(mimeType.toLowerCase());
  return i === -1 ? VIDEO_CODEC_ORDER.length : i;
}

/** Cap/raise per-sender bitrate and bias the encoder toward quality. */
async function tuneSenders(pc: RTCPeerConnection, prefs: AvPrefs): Promise<void> {
  for (const sender of pc.getSenders()) {
    const kind = sender.track?.kind;
    if (!kind) continue;
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
      const enc = params.encodings[0] as RTCRtpEncodingParameters & { networkPriority?: string };
      if (kind === 'audio') {
        enc.maxBitrate = VOICE_BPS[prefs.voiceBitrate ?? 'high'];
      } else {
        enc.maxBitrate = VIDEO_BPS[prefs.videoBitrate ?? 'high'];
        enc.networkPriority = 'high';
      }
      enc.priority = 'high';
      // degradationPreference isn't in every lib.dom yet.
      (params as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference =
        kind === 'audio' ? 'maintain-resolution' : 'balanced';
      await sender.setParameters(params);
    } catch { /* mid-negotiation or unsupported — non-fatal */ }
  }
}

/** Rewrite the Opus a=fmtp line for studio-grade audio: full-band (stereo in
 *  music mode), FEC, and a high average bitrate. Browsers expose no
 *  setParameters() for these fmtp values, so munging is the only lever today. */
function tuneAudioSdp(sdp: string, prefs: AvPrefs): string {
  if (!sdp) return sdp;
  const rtpmap = sdp.match(/a=rtpmap:(\d+)\s+opus\/48000(?:\/2)?/i);
  if (!rtpmap) return sdp;
  const pt = rtpmap[1];
  const hifi = prefs.highFidelityAudio ?? false;
  const ultra = prefs.ultraLowLatency ?? false;
  const desired = [
    `maxaveragebitrate=${VOICE_BPS[prefs.voiceBitrate ?? 'high']}`,
    'maxplaybackrate=48000',
    'useinbandfec=1',
    `stereo=${hifi ? 1 : 0}`,
    `sprop-stereo=${hifi ? 1 : 0}`,
    // DTX off in music/ultra mode keeps a continuous, artefact-free stream.
    `usedtx=${hifi || ultra ? 0 : 1}`,
  ];
  // 10ms minimum frames trim send-side latency (default Opus packets are 20ms).
  if (ultra) desired.push('minptime=10');
  const overridden = /^(maxaveragebitrate|maxplaybackrate|useinbandfec|stereo|sprop-stereo|usedtx|minptime)=/i;
  const fmtpRe = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
  let out: string;
  if (fmtpRe.test(sdp)) {
    out = sdp.replace(fmtpRe, (_m, existing: string) => {
      const kept = existing.split(';').map(s => s.trim()).filter(Boolean).filter(kv => !overridden.test(kv));
      return `a=fmtp:${pt} ${[...kept, ...desired].join(';')}`;
    });
  } else {
    out = sdp.replace(rtpmap[0], `${rtpmap[0]}\r\na=fmtp:${pt} ${desired.join(';')}`);
  }
  if (ultra) {
    // Request 10ms packetisation. Replace an existing a=ptime, else add one.
    out = /a=ptime:\d+/.test(out)
      ? out.replace(/a=ptime:\d+/g, 'a=ptime:10')
      : out.replace(fmtpRe, (m) => `${m}\r\na=ptime:10`);
  }
  return out;
}

/** All peer IDs that share the server owning this channel (excludes nothing). */
function serverMembersForChannel(channelId: string): string[] {
  for (const server of Object.values(getState().servers)) {
    if (server.channels && channelId in server.channels) return server.members ?? [];
  }
  return [];
}

/**
 * Peers permitted to signal in this voice channel, or null if it is NOT a server channel
 * (e.g. an ad-hoc/DM call) where no membership roster applies. Distinct from
 * serverMembersForChannel (which returns [] for a non-server channel) so callers can tell
 * "no roster → allow" apart from "empty roster → deny".
 */
function voiceSignalingRoster(channelId: string): string[] | null {
  for (const server of Object.values(getState().servers)) {
    if (server.channels && channelId in server.channels) return server.members ?? [];
  }
  return null;
}

function selfProfile(): { display_name?: string; avatar?: string } {
  const p = getState().identity?.profile ?? {};
  return { display_name: p.display_name, avatar: p.avatar };
}

// ── Types ──────────────────────────────────────────────────────────────────────

export type TrackKind = 'audio' | 'camera' | 'screen';

export interface VoiceSessionCallbacks {
  onParticipantStream?: (peerId: string, stream: MediaStream) => void;
  onParticipantLeft?: (peerId: string) => void;
  onScreenStream?: (peerId: string, stream: MediaStream | null) => void;
  onLocalState?: () => void;
}

interface PeerConn {
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  // mid → kind for tracks WE send to this peer (sent in our offer's `kinds`).
  localKinds: Record<string, TrackKind>;
  // mid → kind for tracks THIS peer sends us (learned from their offer/answer).
  remoteKinds: Record<string, TrackKind>;
  // Trickle-ICE candidate buffer (applies early candidates once the remote SDP is set).
  iceBuffer: IceCandidateBuffer;
  // Grace timer started on 'disconnected' — cancelled if it recovers, else escalates.
  disconnectTimer: ReturnType<typeof setTimeout> | null;
}

// Cap on ICE candidates buffered for a peer that has no PeerConn yet (pre-offer),
// so a flood of trickled candidates can't grow memory unbounded before the offer.
const MAX_PREOFFER_ICE = 32;

// ── VoiceSession ─────────────────────────────────────────────────────────────

export class VoiceSession {
  readonly channelId: string;
  // The libp2p node is optional: local voice (mic capture, mute, speaking ring,
  // camera/screen capture) must work even when the relay is down. Mesh signaling
  // goes through getPeerSync() and degrades to "alone in the channel" with no node.
  private readonly node: Libp2p | null;
  private readonly localPeerId: string;
  private readonly callbacks: VoiceSessionCallbacks;

  private localStream: MediaStream | null = null;   // mic (+ camera track when on)
  private screenStream: MediaStream | null = null;   // screen-share capture
  private cameraTrack: MediaStreamTrack | null = null;
  // Mic capture always runs through a WebAudio gain stage so the capture volume
  // can be changed LIVE (mid-call) — localStream carries the gain-processed track
  // we send; the raw capture + graph are held here for live updates + teardown.
  private micRawStream: MediaStream | null = null;
  private micAudioCtx: AudioContext | null = null;
  private micGain: GainNode | null = null;
  // Per-peer connection quality, refreshed on a timer from RTCPeerConnection.getStats().
  private peerStats = new Map<string, PeerConnectionStats>();
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private cap: InsertableCap = 'none';
  private useSframe = false;
  private localKey: PeerKey | null = null;
  // Every attachSenderTransform(scriptTransform) call spawns a Worker that builds
  // its OWN in-worker PeerKey from cloned key bytes — it does not share this
  // process's live frameCounter. Each such sender (one per local track × one per
  // mesh peer connection, since Crowd's key is shared channel-wide) must get a
  // disjoint counter slot or independent senders under the same key would restart
  // their nonce counters at 0 and collide (see mediashield.ts SLOT_BITS doc).
  private nextSenderSlot = 0;
  private securityMode: 'crowd' | 'clear' = 'clear';
  private iceServers: RTCIceServer[] = [];

  private peers = new Map<string, PeerConn>();
  // Reconnect schedulers live OUTSIDE PeerConn, keyed by peerId, so a scheduled full
  // redial (which replaces the PeerConn) preserves the exponential-backoff attempt
  // count instead of resetting to zero and looping forever at the initial delay.
  private reconnectSchedulers = new Map<string, ReconnectScheduler>();
  // ICE candidates that arrived before this peer's offer (no PeerConn yet). Drained
  // into the connection's buffer once handleOffer/connectToPeer creates it — otherwise
  // a TURN/srflx candidate that races ahead of the SDP is lost, breaking restrictive NATs.
  private preOfferIce = new Map<string, RTCIceCandidateInit[]>();
  private remoteStreams = new Map<string, MediaStream>();   // audio + camera
  private remoteScreens = new Map<string, MediaStream>();    // screen share
  private remoteKeys = new Map<string, PeerKey>();
  private activity: VoiceActivityMonitor;
  // Roster subscribers (the UI sinks). Notified via notifyRoster() whenever the
  // remote stream/screen maps, local capture streams, or participants change —
  // the event-driven replacement for the sinks' old 500ms polling.
  private rosterListeners = new Set<() => void>();

  private muted = false;
  private stopped = false;

  constructor(channelId: string, node: Libp2p | null, localPeerId: string, callbacks: VoiceSessionCallbacks = {}) {
    this.channelId = channelId;
    this.node = node;
    this.localPeerId = localPeerId;
    this.callbacks = callbacks;
    this.activity = new VoiceActivityMonitor((peerId, speaking) => this.onSpeaking(peerId, speaking));
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Join the channel. Captures the mic and publishes self into voice_sessions
   * IMMEDIATELY (local-first), then connects the mesh best-effort. Never throws
   * after the local join: voice is usable even with no reachable peers.
   */
  async start(): Promise<void> {
    this.cap = insertableStreamsCapability();
    // SFrame only for server (Crowd) channels where a REAL shared key can be
    // derived. deriveVoicePeerKey fails closed (returns null) when no crowd_root
    // exists, so useSframe hinges on an actual key — never a placeholder. Without
    // one, media relies on DTLS (the mesh has no forwarding intermediary), which is
    // honest rather than a false "encrypted" label.
    this.localKey = voiceSecurityMode(this.channelId) === 'crowd'
      ? deriveVoicePeerKey(this.channelId, this.localPeerId)
      : null;
    this.useSframe = this.cap !== 'none' && this.localKey !== null;
    // Publish the honest media security mode: crowd only when SFrame is genuinely
    // active (a real key), else clear (DTLS-only). The badge never overclaims.
    this.securityMode = this.useSframe ? 'crowd' : 'clear';

    // 1) Capture the microphone. Failure does NOT block the join — you can join
    //    a voice channel without a working mic (you simply can't be heard).
    try {
      const prefs = readAvPrefs();
      const rawStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(prefs), video: false });
      // Always route through a gain stage so mic volume is adjustable live (the
      // processed track is what we send/monitor). Keep raw stream + ctx for teardown.
      const volume = typeof prefs.micVolume === 'number' ? prefs.micVolume : 100;
      const graph = buildMicGain(rawStream, volume, prefs.ultraLowLatency ? 0 : 'interactive');
      if (graph) {
        this.micRawStream = rawStream;
        this.micAudioCtx = graph.ctx;
        this.micGain = graph.gain;
        this.localStream = graph.stream;
      } else {
        this.localStream = rawStream;
      }
      const micTrack = this.localStream.getAudioTracks()[0];
      // Tell the encoder what it's carrying: 'music' preserves full fidelity,
      // 'speech' lets it optimise for intelligibility/latency.
      if (micTrack) micTrack.contentHint = prefs.highFidelityAudio ? 'music' : 'speech';
    } catch {
      this.localStream = null;
    }

    // 2) LOCAL-FIRST: publish ourselves so the UI immediately reflects "joined".
    storeJoinVoice(this.channelId, this.localPeerId);
    setVoiceParticipant(this.channelId, this.localPeerId, { muted: false, video: false, screen_sharing: false });
    setVoiceConnectionState(this.channelId, 'connecting');
    setVoiceSecurityMode(this.channelId, this.securityMode);
    publishNativeSnapshot();

    // 3) Speaking ring for self.
    if (this.localStream) this.activity.addStream(this.localPeerId, this.localStream);

    // 4) Best-effort mesh: discover who is already here and dial them.
    this.iceServers = await fetchTurnCredentials().catch(() => [] as RTCIceServer[]);
    // Surface an honest warning when no TURN relay is available: on restrictive or
    // symmetric NATs a STUN-only mesh may never connect, and the user deserves to
    // know rather than watch a call spin forever.
    setVoiceTurnUnavailable(this.channelId, !hasTurnServer(this.iceServers));
    void this.announceAndConnect();

    // 5) Sample per-peer connection quality (RTT/jitter/loss) for the UI readout.
    if (!this.statsTimer) this.statsTimer = setInterval(() => { void this.pollStats(); }, 1500);
  }

  /** Tell members we joined, learn who is already in-channel, and dial each one. */
  private async announceAndConnect(): Promise<void> {
    const peerSync = getPeerSync();
    if (!peerSync) { setVoiceConnectionState(this.channelId, 'connected'); publishNativeSnapshot(); return; }
    const members = serverMembersForChannel(this.channelId).filter(p => p && p !== this.localPeerId);
    if (members.length === 0) { setVoiceConnectionState(this.channelId, 'connected'); publishNativeSnapshot(); return; }

    const req: VoicePresenceRequest = {
      session_id: this.channelId,
      action: 'join',
      muted: this.muted,
      video: false,
      screen_sharing: false,
      ...selfProfile(),
    };
    let responses: Array<{ peerId: string; response: VoicePresenceResponse }> = [];
    for (let attempt = 0; attempt <= VOICE_PRESENCE_RETRY_DELAYS_MS.length; attempt += 1) {
      if (this.stopped) return;
      responses = await peerSync.requestScope<VoicePresenceResponse>(members, PROTOCOLS.voice, VOICE_OPS.presence, req);
      const allMembersAnsweredInChannel = responses.length >= members.length
        && responses.every(({ response }) => response.in_channel);
      if (allMembersAnsweredInChannel || attempt === VOICE_PRESENCE_RETRY_DELAYS_MS.length) break;
      await new Promise<void>((resolve) => setTimeout(resolve, VOICE_PRESENCE_RETRY_DELAYS_MS[attempt]));
    }

    const present = responses.filter(r => r.response?.in_channel);
    for (const { peerId, response } of present) {
      storeJoinVoice(this.channelId, peerId);
      setVoiceParticipant(this.channelId, peerId, {
        muted: !!response.muted, video: !!response.video, screen_sharing: !!response.screen_sharing,
      });
      // Learn the responder's profile from the handshake REPLY, mirroring how the
      // responder learns ours from the join REQUEST (handlePresence 'join'). The
      // reply already carries display_name/avatar; dropping it left the newcomer's
      // roster showing bare peer ids until the next periodic presence broadcast
      // (~25s) delivered names — the measured 15s+ newcomer-side join asymmetry.
      this.learnPeerProfile(peerId, response.display_name, response.avatar);
    }
    setVoiceConnectionState(this.channelId, 'connected');
    publishNativeSnapshot();

    // Choose the connect topology. Full mesh by default (each peer ↔ every other).
    // Under the peer-SFU flag, connect only along the coordinator star: a
    // non-coordinator dials just the elected coordinator; the coordinator dials all.
    // The elected coordinator is deterministic across peers (min peer-id), so both
    // ends agree without negotiation. SFrame keys are per-sender, so a coordinator
    // relaying frames only ever handles ciphertext.
    const presentIds = present.map(p => p.peerId);
    let dialTargets = presentIds;
    if (resolveFeatureFlag('voiceScaleSfu')) {
      const roster = [this.localPeerId, ...presentIds];
      const allowed = new Set(sfuConnectTargets(this.localPeerId, roster));
      dialTargets = presentIds.filter(p => allowed.has(p));
    }

    // The newcomer is always the offerer to already-present peers (avoids glare).
    for (const peerId of dialTargets) void this.connectToPeer(peerId);
  }

  /** Gracefully leave: notify members, tear down peer connections, release media. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    const peerSync = getPeerSync();
    const members = serverMembersForChannel(this.channelId).filter(p => p && p !== this.localPeerId);
    if (peerSync && members.length) {
      void peerSync.broadcastToScope(members, PROTOCOLS.voice, VOICE_OPS.leave, { session_id: this.channelId, action: 'leave' });
    }

    if (this.statsTimer) { clearInterval(this.statsTimer); this.statsTimer = null; }
    this.peerStats.clear();
    this.activity.stop();
    this.localStream?.getTracks().forEach(t => t.stop());
    this.screenStream?.getTracks().forEach(t => t.stop());
    // Release the mic-gain graph (raw capture + WebAudio context), if any.
    this.micRawStream?.getTracks().forEach(t => t.stop());
    if (this.micAudioCtx && this.micAudioCtx.state !== 'closed') void this.micAudioCtx.close().catch(() => {});
    this.micRawStream = null;
    this.micAudioCtx = null;
    this.micGain = null;
    this.localStream = null;
    this.screenStream = null;
    this.cameraTrack = null;

    for (const entry of this.peers.values()) {
      if (entry.disconnectTimer) { clearTimeout(entry.disconnectTimer); entry.disconnectTimer = null; }
      try { entry.pc.close(); } catch { /* already closed */ }
    }
    for (const s of this.reconnectSchedulers.values()) s.cancel();
    this.reconnectSchedulers.clear();
    this.preOfferIce.clear();
    this.peers.clear();
    for (const peerId of this.remoteStreams.keys()) this.callbacks.onParticipantLeft?.(peerId);
    this.remoteStreams.clear();
    this.remoteScreens.clear();
    this.remoteKeys.clear();

    storeLeaveVoice(this.channelId, this.localPeerId);
    publishNativeSnapshot();
    this.notifyRoster();
  }

  // ── Local controls ─────────────────────────────────────────────────────────

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.localStream?.getAudioTracks().forEach(t => { t.enabled = !muted; });
    setVoiceParticipant(this.channelId, this.localPeerId, { muted });
    publishNativeSnapshot();
    this.broadcastPresenceUpdate();
  }

  /** Set capture volume (0..100) live — applies instantly to the in-call mic. */
  setMicVolume(volumePct: number): void {
    if (this.micGain) this.micGain.gain.value = Math.max(0, volumePct / 100);
  }

  /** Latest per-peer connection quality (RTT/jitter/loss), newest poll. */
  peerStatsSnapshot(): Array<{ peerId: string } & PeerConnectionStats> {
    return Array.from(this.peerStats.entries()).map(([peerId, s]) => ({ peerId, ...s }));
  }

  /** Poll RTCPeerConnection.getStats() for each peer and cache RTT/jitter/loss. */
  private async pollStats(): Promise<void> {
    for (const [peerId, entry] of this.peers) {
      try {
        const report = await entry.pc.getStats();
        let rttMs: number | null = null;
        let jitterMs: number | null = null;
        let lossPct: number | null = null;
        report.forEach((stat) => {
          const s = stat as unknown as {
            type: string; state?: string; nominated?: boolean;
            currentRoundTripTime?: number; roundTripTime?: number;
            jitter?: number; kind?: string; fractionLost?: number;
          };
          if (s.type === 'candidate-pair' && (s.nominated || s.state === 'succeeded') && typeof s.currentRoundTripTime === 'number') {
            rttMs = Math.round(s.currentRoundTripTime * 1000);
          } else if (s.type === 'remote-inbound-rtp' && rttMs == null && typeof s.roundTripTime === 'number') {
            rttMs = Math.round(s.roundTripTime * 1000);
          }
          if (s.type === 'inbound-rtp' && typeof s.jitter === 'number') {
            jitterMs = Math.round(s.jitter * 1000);
          }
          if (typeof s.fractionLost === 'number' && lossPct == null) {
            lossPct = Math.round(s.fractionLost * 1000) / 10;
          }
        });
        this.peerStats.set(peerId, { rttMs, jitterMs, lossPct });
      } catch { /* peer torn down mid-poll — drop its sample */ }
    }
    // Forget peers that have gone away.
    for (const peerId of this.peerStats.keys()) if (!this.peers.has(peerId)) this.peerStats.delete(peerId);
  }

  /** Toggle the camera. Adds/removes a video track and renegotiates every peer. */
  async setCameraEnabled(on: boolean): Promise<void> {
    if (on && !this.cameraTrack) {
      const stream = await navigator.mediaDevices.getUserMedia({ video: cameraConstraints(readAvPrefs()), audio: false });
      const track = stream.getVideoTracks()[0];
      if (!track) return;
      track.contentHint = 'motion'; // camera = full-motion video
      this.cameraTrack = track;
      if (!this.localStream) this.localStream = new MediaStream();
      this.localStream.addTrack(track);
      track.addEventListener('ended', () => { void this.setCameraEnabled(false); });
      await this.addTrackToMesh(track, 'camera');
      setVoiceParticipant(this.channelId, this.localPeerId, { video: true });
    } else if (!on && this.cameraTrack) {
      const track = this.cameraTrack;
      this.cameraTrack = null;
      await this.removeTrackFromMesh(track);
      track.stop();
      this.localStream?.removeTrack(track);
      setVoiceParticipant(this.channelId, this.localPeerId, { video: false });
    }
    publishNativeSnapshot();
    this.callbacks.onLocalState?.();
    this.broadcastPresenceUpdate();
    this.notifyRoster();
  }

  /** Start sharing a screen/game. Opens the OS picker and renegotiates each peer. */
  async startScreenShare(opts: { withAudio?: boolean; quality?: string; surface?: 'screen' | 'window' | 'tab' } = {}): Promise<void> {
    if (this.screenStream) return;
    const md = navigator.mediaDevices as MediaDevices & { getDisplayMedia?: (c: DisplayMediaStreamOptions) => Promise<MediaStream> };
    if (!md.getDisplayMedia) throw new Error('Screen sharing is not supported in this browser.');
    const heightByQuality: Record<string, number> = { '720': 720, '1080': 1080, '1440': 1440 };
    const height = heightByQuality[opts.quality ?? '1080'] ?? 1080;
    const fps = (opts.quality === '720') ? 30 : 60;
    const surfaceHint: Record<string, string> = { screen: 'monitor', window: 'window', tab: 'browser' };
    const video: MediaTrackConstraints & { displaySurface?: string } = {
      height: { ideal: height },
      frameRate: { ideal: fps },
      ...(opts.surface ? { displaySurface: surfaceHint[opts.surface] } : {}),
    };
    const stream = await md.getDisplayMedia({
      video: video as MediaTrackConstraints,
      audio: opts.withAudio ?? true,
    });
    this.screenStream = stream;
    const videoTrack = stream.getVideoTracks()[0];
    // Screen content is usually crisp UI/text — bias the encoder for detail.
    if (videoTrack) videoTrack.contentHint = 'detail';
    // The browser "Stop sharing" button ends the track — mirror that into leave.
    videoTrack?.addEventListener('ended', () => { void this.stopScreenShare(); });
    for (const track of stream.getTracks()) {
      await this.addTrackToMesh(track, track.kind === 'video' ? 'screen' : 'audio');
    }
    setVoiceParticipant(this.channelId, this.localPeerId, { screen_sharing: true });
    publishNativeSnapshot();
    this.callbacks.onLocalState?.();
    this.broadcastPresenceUpdate();
    this.notifyRoster();
  }

  async stopScreenShare(): Promise<void> {
    if (!this.screenStream) return;
    const tracks = this.screenStream.getTracks();
    this.screenStream = null;
    for (const track of tracks) {
      await this.removeTrackFromMesh(track);
      track.stop();
    }
    setVoiceParticipant(this.channelId, this.localPeerId, { screen_sharing: false });
    publishNativeSnapshot();
    this.callbacks.onLocalState?.();
    this.broadcastPresenceUpdate();
    this.notifyRoster();
  }

  get isScreenSharing(): boolean { return this.screenStream != null; }
  get isCameraOn(): boolean { return this.cameraTrack != null; }
  /** Local screen-capture stream (for the sharer's own preview), or null. */
  get localScreenStream(): MediaStream | null { return this.screenStream; }
  get localMediaStream(): MediaStream | null { return this.localStream; }

  // ── Inbound signaling (called by the engine's voice handler) ────────────────

  /** A member announced join/leave. Returns OUR state for this channel. */
  handlePresence(req: VoicePresenceRequest, remotePeerId: string): VoicePresenceResponse {
    if (!this.maySignal(remotePeerId)) {
      // A removed member trying to rejoin: force-drop any lingering state and refuse.
      this.dropPeer(remotePeerId);
      return { ok: false, in_channel: false, muted: this.muted, video: this.isCameraOn, screen_sharing: this.isScreenSharing };
    }
    if (req.action === 'leave') {
      this.dropPeer(remotePeerId);
      storeLeaveVoice(this.channelId, remotePeerId);
      publishNativeSnapshot();
    } else if (req.action === 'join') {
      storeJoinVoice(this.channelId, remotePeerId);
      setVoiceParticipant(this.channelId, remotePeerId, {
        muted: !!req.muted, video: !!req.video, screen_sharing: !!req.screen_sharing,
      });
      this.learnPeerProfile(remotePeerId, req.display_name, req.avatar);
      publishNativeSnapshot();
      // The newcomer will dial us — we wait for their offer (no glare).
    } else if (req.action === 'query') {
      // A live state update from an in-channel peer (mute/camera/screen toggles are
      // broadcast as 'query' via broadcastPresenceUpdate). Apply it only for peers
      // already in the roster — a 'query' must never ADD a participant (join/offer
      // do that) — so remote mute/video indicators track the sender's real state.
      const inRoster = getState().voice_sessions
        .find(v => v.channel_id === this.channelId)?.participants[remotePeerId] != null;
      if (inRoster) {
        setVoiceParticipant(this.channelId, remotePeerId, {
          muted: !!req.muted, video: !!req.video, screen_sharing: !!req.screen_sharing,
        });
        this.learnPeerProfile(remotePeerId, req.display_name, req.avatar);
        publishNativeSnapshot();
      }
    }
    const self = getState().voice_sessions.find(v => v.channel_id === this.channelId)?.participants[this.localPeerId];
    return {
      ok: true,
      in_channel: !this.stopped,
      muted: this.muted,
      video: this.isCameraOn,
      screen_sharing: this.isScreenSharing,
      ...(self ? {} : {}),
      ...selfProfile(),
    };
  }

  /** A peer sent us an SDP offer (initial connect or renegotiation). */
  async handleOffer(req: VoiceOfferRequest, remotePeerId: string): Promise<VoiceOfferResponse> {
    if (this.stopped) return { ok: false, error: 'not_in_channel' };
    // SECURITY: reject an offer from a peer who is not a current member of the channel's
    // server, so a kicked member can't recreate a connection after the rekey dropped it.
    if (!this.maySignal(remotePeerId)) { this.dropPeer(remotePeerId); return { ok: false, error: 'not_a_member' }; }
    let entry = this.peers.get(remotePeerId);
    if (!entry) entry = this.createPeerConn(remotePeerId);
    entry.remoteKinds = { ...entry.remoteKinds, ...(req.kinds ?? {}) };

    const pc = entry.pc;
    const offerCollision = entry.makingOffer || pc.signalingState !== 'stable';
    if (offerCollision && !entry.polite) {
      // Impolite peer ignores a colliding offer; its own offer wins.
      return { ok: false, error: 'glare' };
    }
    try {
      // A renegotiation / ICE-restart offer begins a NEW ICE generation. Candidates for
      // that generation travel on a separate voice.ice stream and can arrive BEFORE this
      // offer; if the buffer is still "ready" from the previous negotiation they'd be
      // applied against the outgoing remote description and discarded. Close the gate so
      // they re-buffer until the new remote description lands, then flushIce re-opens it.
      if (pc.currentRemoteDescription != null) {
        entry.iceBuffer.reset();
      }
      if (offerCollision) {
        await pc.setLocalDescription({ type: 'rollback' } as RTCLocalSessionDescriptionInit).catch(() => undefined);
      }
      await pc.setRemoteDescription({ type: 'offer', sdp: req.sdp });
      this.flushIce(entry);
      const prefs = readAvPrefs();
      preferCodecs(pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription({ type: answer.type, sdp: tuneAudioSdp(answer.sdp ?? '', prefs) });
      await tuneSenders(pc, prefs);
      await this.waitForIce(pc);
      // Mark members present (mutual).
      storeJoinVoice(this.channelId, remotePeerId);
      publishNativeSnapshot();
      return { ok: true, sdp: pc.localDescription?.sdp ?? '', kinds: this.localKindsFor(entry) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'answer_failed' };
    }
  }

  // ── Mesh internals ─────────────────────────────────────────────────────────

  private createPeerConn(remotePeerId: string): PeerConn {
    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      ...(this.cap === 'encodedStreams' && this.useSframe ? { encodedInsertableStreams: true } as RTCConfiguration : {}),
    });
    const entry: PeerConn = {
      pc,
      polite: this.localPeerId.localeCompare(remotePeerId) > 0,
      makingOffer: false,
      localKinds: {},
      remoteKinds: {},
      iceBuffer: new IceCandidateBuffer(),
      disconnectTimer: null,
    };
    this.peers.set(remotePeerId, entry);

    // Adopt any ICE candidates that arrived before this connection existed (they were
    // buffered pre-offer). They queue in the iceBuffer and flush once the remote SDP lands.
    const early = this.preOfferIce.get(remotePeerId);
    if (early) {
      this.preOfferIce.delete(remotePeerId);
      for (const c of early) entry.iceBuffer.accept(c);
    }

    // Add our current local tracks (mic + camera + screen if active).
    this.localStream?.getTracks().forEach(track => this.addTrackToPc(entry, track, track.kind === 'video' ? 'camera' : 'audio'));
    this.screenStream?.getTracks().forEach(track => this.addTrackToPc(entry, track, track.kind === 'video' ? 'screen' : 'audio'));

    pc.ontrack = (e) => this.onRemoteTrack(remotePeerId, entry, e);

    // Trickle ICE: ship each candidate to the peer the instant it's gathered, so
    // connectivity can establish without waiting for the full gather to embed
    // candidates in the SDP (the old blocking waitForIce path).
    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      const peerSync = getPeerSync();
      if (!peerSync) return;
      const req: VoiceIceRequest = {
        session_id: this.channelId,
        from_peer_id: this.localPeerId,
        candidate: e.candidate.candidate,
        sdp_mid: e.candidate.sdpMid,
        sdp_mline_index: e.candidate.sdpMLineIndex,
      };
      void peerSync.sendToPeer(remotePeerId, PROTOCOLS.voice, VOICE_OPS.ice, req);
    };

    // Perfect negotiation: renegotiate on our own track add/remove, guarded so we
    // never collide with an in-flight offer (makingOffer) or a rollback state.
    pc.onnegotiationneeded = () => {
      if (entry.makingOffer || pc.signalingState !== 'stable') return;
      void this.renegotiate(remotePeerId, entry);
    };

    // ICE-level recovery: distinct from connectionState so we react to the ICE
    // agent's own failed/disconnected before DTLS gives up.
    pc.oniceconnectionstatechange = () => {
      // A redial replaces the map entry; the superseded connection's late events must
      // not drive recovery/teardown of its replacement. Ignore once we're not current.
      if (this.peers.get(remotePeerId) !== entry) return;
      const st = pc.iceConnectionState;
      if (st === 'connected' || st === 'completed') {
        // Recovered: clear any grace timer + reconnect budget.
        if (entry.disconnectTimer) { clearTimeout(entry.disconnectTimer); entry.disconnectTimer = null; }
        this.schedulerFor(remotePeerId).reset();
      } else if (st === 'failed') {
        this.recoverPeer(remotePeerId, entry);
      } else if (st === 'disconnected') {
        // Transient blips self-heal; give it a grace window before escalating.
        if (!entry.disconnectTimer) {
          entry.disconnectTimer = setTimeout(() => {
            entry.disconnectTimer = null;
            if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
              this.recoverPeer(remotePeerId, entry);
            }
          }, DISCONNECT_GRACE_MS);
        }
      }
    };

    pc.onconnectionstatechange = () => {
      // Same guard: a stale connection reaching 'closed' after a redial must not call
      // dropPeer (which would close the live replacement and discard its scheduler).
      if (this.peers.get(remotePeerId) !== entry) return;
      const st = pc.connectionState;
      if (st === 'closed') this.dropPeer(remotePeerId);
      else if (st === 'failed') this.recoverPeer(remotePeerId, entry);
    };
    return entry;
  }

  /**
   * A server membership change (join/kick/leave) rotated this channel's crowd_root. The
   * SFrame keys were derived once from the OLD root, so: re-derive our key from the new
   * root; permanently drop any connected peer no longer in `members` (a removed member's
   * open WebRTC connection must stop decrypting media immediately, not linger on the old
   * key); and redial the remaining members so a fresh connection re-attaches SFrame
   * transforms under the NEW key. No-op for non-crowd (DTLS-only) channels.
   */
  rekey(members: string[]): void {
    if (this.stopped) return;
    const wasSframe = this.useSframe;
    this.localKey = voiceSecurityMode(this.channelId) === 'crowd'
      ? deriveVoicePeerKey(this.channelId, this.localPeerId)
      : null;
    this.useSframe = this.cap !== 'none' && this.localKey !== null;
    this.remoteKeys.clear(); // re-derived per peer on the next connection from the new root
    const roster = new Set(members);
    for (const peerId of [...this.peers.keys()]) {
      if (!roster.has(peerId)) {
        this.dropPeer(peerId); // removed member: permanent teardown, no reconnect
      } else if (wasSframe || this.useSframe) {
        this.scheduleReconnect(peerId); // remaining member: redial to re-attach new-key transforms
      }
    }
  }

  /**
   * SECURITY: only current members of the channel's server may signal in a server voice
   * call. Without this, a kicked member (who still knows the channel id + a peer address)
   * could re-offer and recreate a connection after the rekey tore it down — and on a
   * browser without insertable streams (DTLS-only media) receive the call's unwrapped
   * audio/video. Ad-hoc/DM calls (no owning server) have no roster and are not gated.
   */
  private maySignal(remotePeerId: string): boolean {
    const roster = voiceSignalingRoster(this.channelId);
    return roster === null || roster.includes(remotePeerId);
  }

  /** Per-peer reconnect scheduler, created on demand and preserved across redials. */
  private schedulerFor(peerId: string): ReconnectScheduler {
    let s = this.reconnectSchedulers.get(peerId);
    if (!s) { s = new ReconnectScheduler(); this.reconnectSchedulers.set(peerId, s); }
    return s;
  }

  /** Apply a trickled ICE candidate from a peer (buffering pre-remote-description). */
  handleIce(req: VoiceIceRequest, remotePeerId: string): { ok: boolean } {
    if (this.stopped) return { ok: false };
    // SECURITY: don't buffer/apply candidates from a non-member (see maySignal).
    if (!this.maySignal(remotePeerId)) return { ok: false };
    const init: RTCIceCandidateInit = {
      candidate: req.candidate,
      sdpMid: req.sdp_mid ?? undefined,
      sdpMLineIndex: req.sdp_mline_index ?? undefined,
    };
    const entry = this.peers.get(remotePeerId);
    if (!entry) {
      // No connection yet — the candidate raced ahead of the offer. Buffer it (bounded)
      // so createPeerConn can adopt it, instead of dropping a possibly-only-viable route.
      const buf = this.preOfferIce.get(remotePeerId) ?? [];
      if (buf.length < MAX_PREOFFER_ICE) { buf.push(init); this.preOfferIce.set(remotePeerId, buf); }
      return { ok: true };
    }
    for (const c of entry.iceBuffer.accept(init)) {
      void entry.pc.addIceCandidate(c).catch(() => { /* stale/duplicate candidate */ });
    }
    return { ok: true };
  }

  /** The remote SDP is now set — apply any candidates that arrived early. */
  private flushIce(entry: PeerConn): void {
    entry.iceBuffer.markRemoteReady();
    for (const c of entry.iceBuffer.flush()) {
      void entry.pc.addIceCandidate(c).catch(() => { /* stale/duplicate candidate */ });
    }
  }

  /**
   * Recover a peer whose ICE failed/stalled: the impolite side (offerer) triggers
   * an ICE restart immediately; if that can't be issued (or keeps failing), fall
   * back to a full backed-off reconnect (tear down + redial). Never a permanent
   * drop for a recoverable state — that was the old bug (a blip killed the call).
   */
  private recoverPeer(remotePeerId: string, entry: PeerConn): void {
    if (this.stopped) return;
    // The impolite peer owns restart to avoid both sides restarting at once (glare).
    if (!entry.polite && entry.pc.signalingState === 'stable') {
      let restarted = false;
      try {
        entry.pc.restartIce();
        entry.iceBuffer.reset();
        restarted = true;
      } catch { /* restartIce unavailable — fall through to full reconnect */ }
      if (restarted) {
        // restartIce() resolves synchronously and never rejects, so the only real
        // signal that recovery worked is whether renegotiation lands a usable answer.
        // Await it; if the peer never answers (unreachable / no answer), fall back to
        // a backed-off full reconnect instead of sitting failed forever.
        void this.renegotiate(remotePeerId, entry, { iceRestart: true }).then((ok) => {
          if (ok || this.stopped) return;
          if (this.peers.get(remotePeerId) !== entry) return; // superseded by a redial
          this.scheduleReconnect(remotePeerId);
        });
        return;
      }
    }
    // Otherwise schedule a backed-off full reconnect (redial from scratch).
    this.scheduleReconnect(remotePeerId);
  }

  /**
   * Schedule a backed-off full reconnect (tear down + redial). The scheduler is keyed
   * by peerId (not the PeerConn) so the attempt count and backoff survive the redial's
   * connection replacement — no infinite retry at the base delay.
   */
  private scheduleReconnect(remotePeerId: string): void {
    this.schedulerFor(remotePeerId).schedule(() => {
      if (this.stopped || !this.peers.has(remotePeerId)) return;
      this.dropPeer(remotePeerId, { keepScheduler: true });
      void this.connectToPeer(remotePeerId);
    });
  }

  private addTrackToPc(entry: PeerConn, track: MediaStreamTrack, kind: TrackKind): void {
    const stream = kind === 'screen' && this.screenStream ? this.screenStream : (this.localStream ?? undefined);
    const sender = entry.pc.addTrack(track, ...(stream ? [stream] : []));
    const transceiver = entry.pc.getTransceivers().find(t => t.sender === sender);
    if (transceiver?.mid) entry.localKinds[transceiver.mid] = kind;
    if (this.useSframe && this.localKey) {
      // See nextSenderSlot's doc: a fresh slot per sender keeps this new Worker's
      // independent in-worker counter from colliding with every OTHER sender
      // already encrypting under the same key (other tracks, other mesh peers).
      // Falling back to DTLS (never reusing a slot) is the fail-closed choice if
      // the space is ever exhausted — see MAX_SENDER_SLOTS in mediashield.ts.
      const ok = this.nextSenderSlot < MAX_SENDER_SLOTS
        && attachSenderTransform(sender, this.localKey, this.cap as Exclude<InsertableCap, 'none'>, this.nextSenderSlot++);
      if (!ok) this.downgradeSframe();
    }
  }

  /**
   * The SFrame pipeline could not be installed on a track (probe said supported, but
   * constructing the worker/transform threw). Media is now DTLS-only, so stop claiming
   * Crowd protection and republish the honest `clear` badge — never overclaim what the
   * pipeline didn't actually apply.
   */
  private downgradeSframe(): void {
    if (!this.useSframe && this.securityMode === 'clear') return;
    this.useSframe = false;
    this.securityMode = 'clear';
    setVoiceSecurityMode(this.channelId, 'clear');
    publishNativeSnapshot();
    // Existing peer connections may still carry SFrame sender/receiver transforms attached
    // before the failure, leaving media half-encrypted: we can no longer install matching
    // transforms, so peers' encrypted frames would be undecryptable and our outgoing frames
    // inconsistent. Rebuild every live connection under the now-uniform clear mode instead of
    // only flipping the badge — a backed-off reconnect drops the stale transforms and
    // renegotiates fresh, clear PeerConns (addTrackToPc no longer attaches a transform once
    // useSframe is false), and the remote observes the renegotiation. Full cross-peer mode
    // signaling remains the documented live voice smoketest.
    for (const peerId of [...this.peers.keys()]) {
      this.scheduleReconnect(peerId);
    }
  }

  /** Add a freshly-acquired local track (camera/screen) to every peer + renegotiate. */
  private async addTrackToMesh(track: MediaStreamTrack, kind: TrackKind): Promise<void> {
    for (const [peerId, entry] of this.peers) {
      this.addTrackToPc(entry, track, kind);
      await this.renegotiate(peerId, entry);
    }
  }

  private async removeTrackFromMesh(track: MediaStreamTrack): Promise<void> {
    for (const [peerId, entry] of this.peers) {
      const sender = entry.pc.getSenders().find(s => s.track === track);
      if (sender) { try { entry.pc.removeTrack(sender); } catch { /* gone */ } }
      await this.renegotiate(peerId, entry);
    }
  }

  /** We initiate (re)negotiation with a peer: offer → their answer. */
  private async connectToPeer(remotePeerId: string): Promise<void> {
    if (this.peers.has(remotePeerId)) return;
    const entry = this.createPeerConn(remotePeerId);
    await this.renegotiate(remotePeerId, entry);
  }

  /**
   * Send an offer to a peer. Returns true when negotiation is progressing (we applied
   * the peer's answer, or hit glare so the polite peer will answer our offer), false
   * when it could not complete (peer unreachable / no usable answer / exception). The
   * boolean lets ICE-restart recovery decide whether to fall back to a full reconnect —
   * most callers ignore it (renegotiation there is best-effort).
   */
  private async renegotiate(remotePeerId: string, entry: PeerConn, opts: { iceRestart?: boolean } = {}): Promise<boolean> {
    const peerSync = getPeerSync();
    if (!peerSync) return false;
    try {
      entry.makingOffer = true;
      const prefs = readAvPrefs();
      preferCodecs(entry.pc);
      const offer = await entry.pc.createOffer(opts.iceRestart ? { iceRestart: true } : undefined);
      await entry.pc.setLocalDescription({ type: offer.type, sdp: tuneAudioSdp(offer.sdp ?? '', prefs) });
      await tuneSenders(entry.pc, prefs);
      // Trickle: send the offer with whatever candidates are ready now; the rest
      // arrive over voice.ice. waitForIce only nudges the very first host candidates
      // into the initial SDP for a faster start on already-open ports.
      await this.waitForIce(entry.pc);
      const req: VoiceOfferRequest = {
        session_id: this.channelId,
        from_peer_id: this.localPeerId,
        sdp: entry.pc.localDescription?.sdp ?? '',
        kinds: this.localKindsFor(entry),
      };
      const resp = await peerSync.requestPeer<VoiceOfferResponse>(remotePeerId, PROTOCOLS.voice, VOICE_OPS.offer, req);
      if (resp?.ok && resp.sdp) {
        entry.remoteKinds = { ...entry.remoteKinds, ...(resp.kinds ?? {}) };
        await entry.pc.setRemoteDescription({ type: 'answer', sdp: resp.sdp });
        this.flushIce(entry);
        return true;
      }
      // Glare is not a failure: the polite peer will answer our offer via its own
      // handleOffer path, so negotiation is still progressing.
      return resp?.error === 'glare';
    } catch { /* peer unreachable / negotiation failed */ return false; }
    finally { entry.makingOffer = false; }
  }

  private onRemoteTrack(remotePeerId: string, entry: PeerConn, e: RTCTrackEvent): void {
    const mid = e.transceiver.mid ?? '';
    const kind: TrackKind = entry.remoteKinds[mid] ?? (e.track.kind === 'video' ? 'camera' : 'audio');

    if (this.useSframe && !this.remoteKeys.has(remotePeerId)) {
      const rk = deriveVoicePeerKey(this.channelId, remotePeerId);
      if (rk) { this.remoteKeys.set(remotePeerId, rk); }
    }
    const rk = this.remoteKeys.get(remotePeerId);
    if (this.useSframe && rk) {
      const ok = attachReceiverTransform(e.receiver, rk, this.cap as Exclude<InsertableCap, 'none'>);
      if (!ok) this.downgradeSframe();
    }

    // Nudge the jitter buffer toward interactivity. Network propagation is the
    // floor (speed of light, ~tens of ms intercontinental) and not ours to set;
    // this only trims the controllable playout/jitter portion. Non-standard hint,
    // hence the cast + guard — unsupported browsers ignore it.
    try {
      const ultra = readAvPrefs().ultraLowLatency ?? false;
      (e.receiver as RTCRtpReceiver & { playoutDelayHint?: number }).playoutDelayHint =
        e.track.kind === 'audio' ? (ultra ? 0 : 0.02) : 0;
    } catch { /* hint unsupported — adaptive jitter buffer stays in control */ }

    if (kind === 'screen') {
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      this.remoteScreens.set(remotePeerId, stream);
      setVoiceParticipant(this.channelId, remotePeerId, { screen_sharing: true });
      this.callbacks.onScreenStream?.(remotePeerId, stream);
      e.track.addEventListener('ended', () => {
        this.remoteScreens.delete(remotePeerId);
        setVoiceParticipant(this.channelId, remotePeerId, { screen_sharing: false });
        this.callbacks.onScreenStream?.(remotePeerId, null);
        publishNativeSnapshot();
        this.notifyRoster();
      });
    } else {
      const existing = this.remoteStreams.get(remotePeerId);
      const stream = e.streams[0] ?? existing ?? new MediaStream();
      if (!stream.getTracks().includes(e.track)) stream.addTrack(e.track);
      if (stream !== existing) {
        // Renegotiated track REMOVALS (e.g. remote camera off) mutate this stream
        // in place — surface them to roster subscribers as they happen.
        stream.addEventListener('removetrack', () => this.notifyRoster());
      }
      this.remoteStreams.set(remotePeerId, stream);
      if (kind === 'camera') setVoiceParticipant(this.channelId, remotePeerId, { video: true });
      if (e.track.kind === 'audio') this.activity.addStream(remotePeerId, stream);
      this.callbacks.onParticipantStream?.(remotePeerId, stream);
    }
    storeJoinVoice(this.channelId, remotePeerId);
    publishNativeSnapshot();
    this.notifyRoster();
  }

  private dropPeer(remotePeerId: string, opts: { keepScheduler?: boolean } = {}): void {
    const entry = this.peers.get(remotePeerId);
    if (entry) {
      if (entry.disconnectTimer) { clearTimeout(entry.disconnectTimer); entry.disconnectTimer = null; }
      try { entry.pc.close(); } catch { /* gone */ }
      this.peers.delete(remotePeerId);
    }
    // A scheduled redial keeps the scheduler (it owns the in-flight reconnect + backoff
    // count); a real teardown cancels and forgets it, and drops any pre-offer ICE buffer.
    if (!opts.keepScheduler) {
      this.reconnectSchedulers.get(remotePeerId)?.cancel();
      this.reconnectSchedulers.delete(remotePeerId);
      this.preOfferIce.delete(remotePeerId);
    }
    this.activity.removeStream(remotePeerId);
    this.remoteStreams.delete(remotePeerId);
    this.remoteScreens.delete(remotePeerId);
    this.remoteKeys.delete(remotePeerId);
    this.callbacks.onParticipantLeft?.(remotePeerId);
    this.notifyRoster();
  }

  private localKindsFor(entry: PeerConn): Record<string, TrackKind> {
    // Refresh mids (they're assigned after setLocalDescription).
    for (const t of entry.pc.getTransceivers()) {
      if (!t.sender.track || !t.mid) continue;
      if (entry.localKinds[t.mid]) continue;
      entry.localKinds[t.mid] = t.sender.track === this.cameraTrack
        ? 'camera'
        : (this.screenStream?.getTracks().includes(t.sender.track) ? 'screen' : (t.sender.track.kind === 'video' ? 'camera' : 'audio'));
    }
    return entry.localKinds;
  }

  // With trickle ICE the bulk of candidates flow over voice.ice, so we no longer
  // block the offer/answer on a full gather. This is a short nudge to fold the
  // instantly-available host candidates into the initial SDP for a faster first
  // connection; everything else trickles.
  private waitForIce(pc: RTCPeerConnection, timeoutMs = 400): Promise<void> {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise<void>(resolve => {
      const done = () => { pc.removeEventListener('icegatheringstatechange', check); resolve(); };
      const check = () => { if (pc.iceGatheringState === 'complete') done(); };
      pc.addEventListener('icegatheringstatechange', check);
      setTimeout(done, timeoutMs);
    });
  }

  private onSpeaking(peerId: string, speaking: boolean): void {
    setVoiceParticipant(this.channelId, peerId, { speaking });
    publishNativeSnapshot();
  }

  private broadcastPresenceUpdate(): void {
    const peerSync = getPeerSync();
    if (!peerSync) return;
    const members = serverMembersForChannel(this.channelId).filter(p => p && p !== this.localPeerId);
    if (!members.length) return;
    const req: VoicePresenceRequest = {
      session_id: this.channelId,
      action: 'query',
      muted: this.muted,
      video: this.isCameraOn,
      screen_sharing: this.isScreenSharing,
      ...selfProfile(),
    };
    void peerSync.broadcastToScope(members, PROTOCOLS.voice, VOICE_OPS.presence, req);
  }

  private learnPeerProfile(peerId: string, displayName?: string, avatar?: string): void {
    if (!displayName && !avatar) return;
    const existing = getState().peers?.[peerId];
    upsertPeer({
      peer_id: peerId,
      role: existing?.role ?? 'peer',
      ...(displayName ? { display_name: displayName } : {}),
      ...(avatar ? { avatar } : {}),
      last_seen_at: new Date().toISOString(),
    });
  }

  // ── UI accessors + change subscription (VoiceAudioSinks / VoiceVideoSinks) ──

  get remoteStreamsMap(): ReadonlyMap<string, MediaStream> { return this.remoteStreams; }
  get remoteScreensMap(): ReadonlyMap<string, MediaStream> { return this.remoteScreens; }

  /**
   * Subscribe to roster/stream changes: remote stream attached (onRemoteTrack),
   * stream removed / peer dropped (leave, connection closed, rekey/redial),
   * local camera/screen toggles, and session stop. Returns an unsubscribe
   * function. This is the event-driven path for the UI sinks — media attaches
   * within one render of the track arriving instead of waiting for a poll tick.
   */
  onRosterChanged(cb: () => void): () => void {
    this.rosterListeners.add(cb);
    return () => { this.rosterListeners.delete(cb); };
  }

  /** Fire roster listeners. Called from WebRTC/media event handlers, so it must
   *  never throw — a broken UI listener must not take down the media path. */
  private notifyRoster(): void {
    for (const cb of Array.from(this.rosterListeners)) {
      try { cb(); } catch { /* listener error — isolated from the session */ }
    }
  }
}
