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
  upsertPeer,
} from '../state/store.js';
import { publishNativeSnapshot } from '../state/snapshot.js';
import { getPeerSync } from '../sync/registry.js';
import { deriveVoicePeerKey, voiceSecurityMode } from './keys.js';
import { createEncryptTransform, createDecryptTransform, type PeerKey } from './mediashield.js';
import {
  fetchTurnCredentials, VOICE_OPS,
  type VoicePresenceRequest, type VoicePresenceResponse,
  type VoiceOfferRequest, type VoiceOfferResponse,
} from './signaling.js';
import { VoiceActivityMonitor } from './activity.js';
import { PROTOCOLS } from '../families/families.js';

// ── Insertable Streams capability probe ───────────────────────────────────────

type InsertableCap = 'scriptTransform' | 'encodedStreams' | 'none';

function insertableStreamsCapability(): InsertableCap {
  if (typeof RTCRtpSender === 'undefined') return 'none';
  if ('transform' in RTCRtpSender.prototype) return 'scriptTransform';
  if ('createEncodedStreams' in RTCRtpSender.prototype) return 'encodedStreams';
  return 'none';
}

function attachSenderTransform(sender: RTCRtpSender, pk: PeerKey, cap: Exclude<InsertableCap, 'none'>): void {
  try {
    if (cap === 'scriptTransform') {
      const worker = new Worker(new URL('./mediashield-worker.ts', import.meta.url), { type: 'module' });
      const xf = new RTCRtpScriptTransform(worker, { op: 'encrypt', peerId: pk.peerId, keyBytes: Array.from(pk.key) });
      (sender as RTCRtpSender & { transform: RTCRtpScriptTransform }).transform = xf;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { readable, writable } = (sender as any).createEncodedStreams();
      const ts = new TransformStream({ transform: createEncryptTransform(pk) });
      readable.pipeThrough(ts).pipeTo(writable);
    }
  } catch { /* SFrame is defense-in-depth; DTLS already protects mesh media */ }
}

function attachReceiverTransform(receiver: RTCRtpReceiver, pk: PeerKey, cap: Exclude<InsertableCap, 'none'>): void {
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
  } catch { /* see attachSenderTransform */ }
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
}

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
  private iceServers: RTCIceServer[] = [];

  private peers = new Map<string, PeerConn>();
  private remoteStreams = new Map<string, MediaStream>();   // audio + camera
  private remoteScreens = new Map<string, MediaStream>();    // screen share
  private remoteKeys = new Map<string, PeerKey>();
  private activity: VoiceActivityMonitor;

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
    // SFrame only for server (Crowd) channels where a real shared key exists;
    // DM/other modes rely on DTLS (mesh has no forwarding intermediary).
    this.useSframe = this.cap !== 'none' && voiceSecurityMode(this.channelId) === 'crowd';
    if (this.useSframe) this.localKey = deriveVoicePeerKey(this.channelId, this.localPeerId);

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
    publishNativeSnapshot();

    // 3) Speaking ring for self.
    if (this.localStream) this.activity.addStream(this.localPeerId, this.localStream);

    // 4) Best-effort mesh: discover who is already here and dial them.
    this.iceServers = await fetchTurnCredentials().catch(() => [] as RTCIceServer[]);
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
    const responses = await peerSync.requestScope<VoicePresenceResponse>(members, PROTOCOLS.voice, VOICE_OPS.presence, req);

    const present = responses.filter(r => r.response?.in_channel);
    for (const { peerId, response } of present) {
      storeJoinVoice(this.channelId, peerId);
      setVoiceParticipant(this.channelId, peerId, {
        muted: !!response.muted, video: !!response.video, screen_sharing: !!response.screen_sharing,
      });
    }
    setVoiceConnectionState(this.channelId, 'connected');
    publishNativeSnapshot();

    // The newcomer is always the offerer to already-present peers (avoids glare).
    for (const { peerId } of present) void this.connectToPeer(peerId);
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

    for (const { pc } of this.peers.values()) { try { pc.close(); } catch { /* already closed */ } }
    this.peers.clear();
    for (const peerId of this.remoteStreams.keys()) this.callbacks.onParticipantLeft?.(peerId);
    this.remoteStreams.clear();
    this.remoteScreens.clear();
    this.remoteKeys.clear();

    storeLeaveVoice(this.channelId, this.localPeerId);
    publishNativeSnapshot();
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
  }

  get isScreenSharing(): boolean { return this.screenStream != null; }
  get isCameraOn(): boolean { return this.cameraTrack != null; }
  /** Local screen-capture stream (for the sharer's own preview), or null. */
  get localScreenStream(): MediaStream | null { return this.screenStream; }
  get localMediaStream(): MediaStream | null { return this.localStream; }

  // ── Inbound signaling (called by the engine's voice handler) ────────────────

  /** A member announced join/leave. Returns OUR state for this channel. */
  handlePresence(req: VoicePresenceRequest, remotePeerId: string): VoicePresenceResponse {
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
      if (offerCollision) {
        await pc.setLocalDescription({ type: 'rollback' } as RTCLocalSessionDescriptionInit).catch(() => undefined);
      }
      await pc.setRemoteDescription({ type: 'offer', sdp: req.sdp });
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
    };
    this.peers.set(remotePeerId, entry);

    // Add our current local tracks (mic + camera + screen if active).
    this.localStream?.getTracks().forEach(track => this.addTrackToPc(entry, track, track.kind === 'video' ? 'camera' : 'audio'));
    this.screenStream?.getTracks().forEach(track => this.addTrackToPc(entry, track, track.kind === 'video' ? 'screen' : 'audio'));

    pc.ontrack = (e) => this.onRemoteTrack(remotePeerId, entry, e);
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === 'failed' || st === 'closed') this.dropPeer(remotePeerId);
    };
    return entry;
  }

  private addTrackToPc(entry: PeerConn, track: MediaStreamTrack, kind: TrackKind): void {
    const stream = kind === 'screen' && this.screenStream ? this.screenStream : (this.localStream ?? undefined);
    const sender = entry.pc.addTrack(track, ...(stream ? [stream] : []));
    const transceiver = entry.pc.getTransceivers().find(t => t.sender === sender);
    if (transceiver?.mid) entry.localKinds[transceiver.mid] = kind;
    if (this.useSframe && this.localKey) attachSenderTransform(sender, this.localKey, this.cap as Exclude<InsertableCap, 'none'>);
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

  private async renegotiate(remotePeerId: string, entry: PeerConn): Promise<void> {
    const peerSync = getPeerSync();
    if (!peerSync) return;
    try {
      entry.makingOffer = true;
      const prefs = readAvPrefs();
      preferCodecs(entry.pc);
      const offer = await entry.pc.createOffer();
      await entry.pc.setLocalDescription({ type: offer.type, sdp: tuneAudioSdp(offer.sdp ?? '', prefs) });
      await tuneSenders(entry.pc, prefs);
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
      } else if (resp?.error === 'glare') {
        // The polite peer will answer our offer via its own handleOffer path.
      }
    } catch { /* peer unreachable / negotiation failed — non-fatal */ }
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
    if (this.useSframe && rk) attachReceiverTransform(e.receiver, rk, this.cap as Exclude<InsertableCap, 'none'>);

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
      });
    } else {
      const stream = e.streams[0] ?? this.remoteStreams.get(remotePeerId) ?? new MediaStream();
      if (!stream.getTracks().includes(e.track)) stream.addTrack(e.track);
      this.remoteStreams.set(remotePeerId, stream);
      if (kind === 'camera') setVoiceParticipant(this.channelId, remotePeerId, { video: true });
      if (e.track.kind === 'audio') this.activity.addStream(remotePeerId, stream);
      this.callbacks.onParticipantStream?.(remotePeerId, stream);
    }
    storeJoinVoice(this.channelId, remotePeerId);
    publishNativeSnapshot();
  }

  private dropPeer(remotePeerId: string): void {
    const entry = this.peers.get(remotePeerId);
    if (entry) { try { entry.pc.close(); } catch { /* gone */ } this.peers.delete(remotePeerId); }
    this.activity.removeStream(remotePeerId);
    this.remoteStreams.delete(remotePeerId);
    this.remoteScreens.delete(remotePeerId);
    this.remoteKeys.delete(remotePeerId);
    this.callbacks.onParticipantLeft?.(remotePeerId);
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

  private waitForIce(pc: RTCPeerConnection, timeoutMs = 2500): Promise<void> {
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

  // ── UI accessors (polled by VoiceAudioSinks / VoiceVideoSinks) ──────────────

  get remoteStreamsMap(): ReadonlyMap<string, MediaStream> { return this.remoteStreams; }
  get remoteScreensMap(): ReadonlyMap<string, MediaStream> { return this.remoteScreens; }
}
