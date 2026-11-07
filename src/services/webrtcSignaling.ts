import {
  collection,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  onSnapshot,
  serverTimestamp,
  type Unsubscribe,
} from 'firebase/firestore';
import { auth, db, handleFirestoreError, OperationType } from '../firebase';

export const TARGET_VIDEO_WIDTH = 640;
export const TARGET_VIDEO_HEIGHT = 360;
export const TARGET_VIDEO_FPS = 24;
export const MAX_VIDEO_BITRATE_BPS = 500_000;

export interface VideoSessionDoc {
  sessionId: string;
  initiatorId: string;
  answererId: string;
  status: 'waiting' | 'negotiating' | 'connected' | 'ended';
  initiatorReady: boolean;
  answererReady: boolean;
  offerType: string;
  offerSdp: string;
  answerType: string;
  answerSdp: string;
  offerRevision: number;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface IceServerConfigResponse {
  iceServers: RTCIceServer[];
  turnConfigured: boolean;
  turnProvider: 'cloudflare_calls' | 'static_turn' | 'none';
}

export interface WebRtcDiagnosticsState {
  sessionId: string;
  role: 'initiator' | 'answerer' | 'none';
  signalingState: string;
  iceConnectionState: string;
  peerConnectionState: string;
  localVideoTrackState: string;
  localAudioTrackState: string;
  remoteVideoTrackState: string;
  remoteAudioTrackState: string;
  selectedCandidateType: string;
  outgoingResolution: string;
  outgoingBitrateKbps: number;
  turnConfigured: boolean;
  turnProvider: string;
  offerRevision: number;
  lastError: string | null;
}

export const INITIAL_DIAGNOSTICS_STATE: WebRtcDiagnosticsState = {
  sessionId: 'none',
  role: 'none',
  signalingState: 'closed',
  iceConnectionState: 'new',
  peerConnectionState: 'new',
  localVideoTrackState: 'inactive',
  localAudioTrackState: 'inactive',
  remoteVideoTrackState: 'waiting',
  remoteAudioTrackState: 'waiting',
  selectedCandidateType: 'none',
  outgoingResolution: '0x0',
  outgoingBitrateKbps: 0,
  turnConfigured: false,
  turnProvider: 'none',
  offerRevision: 0,
  lastError: null,
};

const DEFAULT_STUN_SERVERS: RTCIceServer[] = [
  {
    urls: [
      'stun:stun.cloudflare.com:3478',
      'stun:stun.l.google.com:19302',
    ],
  },
];

let cachedIceConfig: {
  data: IceServerConfigResponse;
  expiresAt: number;
} | null = null;
let inFlightIcePromise: Promise<IceServerConfigResponse> | null = null;

/**
 * Fetches ICE servers (public STUN + optional short-lived TURN credentials)
 * from the backend endpoint `/api/webrtc/ice-servers` using the user's Firebase ID token.
 * Caches the result for 5 minutes so match startup has 0ms ICE config latency.
 */
export async function fetchIceServerConfiguration(): Promise<IceServerConfigResponse> {
  if (cachedIceConfig && Date.now() < cachedIceConfig.expiresAt) {
    return cachedIceConfig.data;
  }
  if (inFlightIcePromise) {
    return inFlightIcePromise;
  }

  inFlightIcePromise = (async (): Promise<IceServerConfigResponse> => {
    try {
      const fbUser = auth.currentUser;
      const token = fbUser ? await fbUser.getIdToken() : '';
      const res = await fetch('/api/webrtc/ice-servers', {
        method: 'GET',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
          const config: IceServerConfigResponse = {
            iceServers: data.iceServers,
            turnConfigured: Boolean(data.turnConfigured),
            turnProvider: data.turnProvider || 'none',
          };
          cachedIceConfig = {
            data: config,
            expiresAt: Date.now() + 5 * 60 * 1000,
          };
          return config;
        }
      }
    } catch {
      // Fall back to default public STUN servers
    }
    const fallback: IceServerConfigResponse = {
      iceServers: DEFAULT_STUN_SERVERS,
      turnConfigured: false,
      turnProvider: 'none',
    };
    cachedIceConfig = {
      data: fallback,
      expiresAt: Date.now() + 2 * 60 * 1000,
    };
    return fallback;
  })();

  try {
    return await inFlightIcePromise;
  } finally {
    inFlightIcePromise = null;
  }
}

/**
 * Pre-warms the ICE server configuration cache while the user enters the queue.
 */
export function prefetchIceServers(): void {
  fetchIceServerConfiguration().catch(() => {});
}

/**
 * Applies a ~500 kbps maximum video bitrate cap and degradation preference ('balanced')
 * to the outgoing RTCRtpSender so 360p streams stay smooth even on constrained mobile networks.
 */
export async function apply360pBitrateConstraints(pc: RTCPeerConnection): Promise<void> {
  const senders = pc.getSenders();
  for (const sender of senders) {
    if (sender.track && sender.track.kind === 'video') {
      try {
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}];
        }
        params.encodings[0].maxBitrate = MAX_VIDEO_BITRATE_BPS;
        params.encodings[0].maxFramerate = TARGET_VIDEO_FPS;
        (params as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference =
          'balanced';
        await sender.setParameters(params);
      } catch {
        // Browser may not support all RTCRtpSendParameters fields
      }
    }
  }
}

/**
 * Prefers VP8 with H.264 fallback on video transceivers where setCodecPreferences is supported.
 */
export function preferVp8WithH264Fallback(pc: RTCPeerConnection): void {
  try {
    if (typeof RTCRtpSender.getCapabilities !== 'function') return;
    const capabilities = RTCRtpSender.getCapabilities('video');
    if (!capabilities || !capabilities.codecs) return;

    const vp8Codecs = capabilities.codecs.filter(
      (c) => c.mimeType.toLowerCase() === 'video/vp8'
    );
    const h264Codecs = capabilities.codecs.filter(
      (c) => c.mimeType.toLowerCase() === 'video/h264'
    );
    const otherCodecs = capabilities.codecs.filter(
      (c) =>
        c.mimeType.toLowerCase() !== 'video/vp8' &&
        c.mimeType.toLowerCase() !== 'video/h264'
    );

    const ordered = [...vp8Codecs, ...h264Codecs, ...otherCodecs];
    if (ordered.length === 0) return;

    for (const transceiver of pc.getTransceivers()) {
      if (
        transceiver.sender.track?.kind === 'video' &&
        typeof transceiver.setCodecPreferences === 'function'
      ) {
        transceiver.setCodecPreferences(ordered);
      }
    }
  } catch {
    // Ignore if browser rejects codec preference ordering
  }
}

/**
 * Requests user-initiated 360p (640x360 @ 24fps) camera + microphone stream.
 */
export async function request360pMediaStream(
  facingMode: 'user' | 'environment' = 'user'
): Promise<{
  stream: MediaStream | null;
  cameraError: string | null;
  micError: string | null;
}> {
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    return {
      stream: null,
      cameraError: 'Camera API is not supported in this browser.',
      micError: null,
    };
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: TARGET_VIDEO_WIDTH, max: TARGET_VIDEO_WIDTH },
        height: { ideal: TARGET_VIDEO_HEIGHT, max: TARGET_VIDEO_HEIGHT },
        frameRate: { ideal: TARGET_VIDEO_FPS, max: TARGET_VIDEO_FPS },
        facingMode: { ideal: facingMode },
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    return { stream, cameraError: null, micError: null };
  } catch (err) {
    const domErr = err as DOMException;
    const name = domErr?.name || '';
    const msg = domErr?.message || 'Unable to access camera or microphone.';

    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      return {
        stream: null,
        cameraError:
          'Camera and microphone permission was denied. Please allow access in your browser address bar to start video.',
        micError: 'Microphone permission denied.',
      };
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return {
        stream: null,
        cameraError: 'No camera or microphone hardware was detected on this device.',
        micError: 'No microphone found.',
      };
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return {
        stream: null,
        cameraError:
          'Your camera or microphone is currently in use by another application.',
        micError: null,
      };
    }
    return {
      stream: null,
      cameraError: `Media access failed: ${msg}`,
      micError: null,
    };
  }
}

export interface WebRtcControllerCallbacks {
  onRemoteStream: (stream: MediaStream | null) => void;
  onDiagnosticsUpdate: (patch: Partial<WebRtcDiagnosticsState>) => void;
  onPartnerVideoReadyChange: (partnerReady: boolean) => void;
  onCallStatusChange: (
    status: 'idle' | 'waiting_partner' | 'connecting' | 'connected' | 'failed' | 'ended'
  ) => void;
}

/**
 * Manages the full lifecycle of a single 1-on-1 WebRTC session backed by Firestore `/videoSessions/{sessionId}`.
 * Guarantees:
 * - Deterministic initiator (`initiatorId === userAId`) and answerer (`answererId === userBId`)
 * - Immediate SDP Offer creation by the initiator without waiting for an extra readiness round-trip
 * - ICE candidate buffering until `remoteDescription` is set
 * - Deduplicated ICE candidates
 * - Bitrate & resolution telemetry polling
 * - Automatic ICE restart on transient ICE failure
 * - Zero cross-session leakage or orphaned listeners
 */
export class WebRtcSessionController {
  private sessionId: string;
  private currentUserId: string;
  private initiatorId: string;
  private answererId: string;
  private localStream: MediaStream;
  private callbacks: WebRtcControllerCallbacks;

  private pc: RTCPeerConnection | null = null;
  private remoteStream: MediaStream | null = null;
  private sessionUnsub: Unsubscribe | null = null;
  private remoteCandidatesUnsub: Unsubscribe | null = null;

  private pendingRemoteCandidates: RTCIceCandidateInit[] = [];
  private processedCandidateIds = new Set<string>();
  private lastProcessedOfferRevision = 0;
  private isNegotiatingOffer = false;
  private isClosed = false;

  private statsIntervalId: number | null = null;
  private connectionTimeoutId: number | null = null;
  private lastBytesSent = 0;
  private lastStatsTimestamp = 0;
  private iceRestartAttempted = false;

  constructor(params: {
    sessionId: string;
    currentUserId: string;
    initiatorId: string;
    answererId: string;
    localStream: MediaStream;
    callbacks: WebRtcControllerCallbacks;
  }) {
    this.sessionId = params.sessionId;
    this.currentUserId = params.currentUserId;
    this.initiatorId = params.initiatorId;
    this.answererId = params.answererId;
    this.localStream = params.localStream;
    this.callbacks = params.callbacks;
  }

  private get isInitiator(): boolean {
    return this.currentUserId === this.initiatorId;
  }

  public async start(): Promise<void> {
    if (this.isClosed) return;

    const role = this.isInitiator ? 'initiator' : 'answerer';
    this.callbacks.onDiagnosticsUpdate({
      sessionId: this.sessionId,
      role,
      lastError: null,
    });
    this.callbacks.onCallStatusChange('connecting');

    // 1. Fetch STUN + optional TURN configuration (cached for 0ms latency)
    const iceConfig = await fetchIceServerConfiguration();
    if (this.isClosed) return;

    this.callbacks.onDiagnosticsUpdate({
      turnConfigured: iceConfig.turnConfigured,
      turnProvider: iceConfig.turnProvider,
    });

    // 2. Initialize RTCPeerConnection
    const pc = new RTCPeerConnection({
      iceServers: iceConfig.iceServers,
      iceCandidatePoolSize: 4,
    });
    this.pc = pc;

    // 3. Add local 360p video + audio tracks
    this.localStream.getTracks().forEach((track) => {
      pc.addTrack(track, this.localStream);
    });

    preferVp8WithH264Fallback(pc);
    await apply360pBitrateConstraints(pc);
    this.updateLocalTrackDiagnostics();

    // 4. Handle incoming remote media tracks immediately as soon as frames arrive
    pc.ontrack = (event) => {
      if (this.isClosed) return;
      if (!this.remoteStream) {
        this.remoteStream = new MediaStream();
      }
      const incomingStream = event.streams && event.streams[0];
      if (incomingStream) {
        incomingStream.getTracks().forEach((t) => {
          if (!this.remoteStream!.getTracks().some((existing) => existing.id === t.id)) {
            this.remoteStream!.addTrack(t);
          }
          t.onunmute = () => {
            if (this.isClosed) return;
            this.clearConnectionTimeout();
            this.callbacks.onRemoteStream(this.remoteStream);
            this.callbacks.onCallStatusChange('connected');
            this.updateRemoteTrackDiagnostics();
          };
        });
      } else if (event.track) {
        if (!this.remoteStream.getTracks().some((existing) => existing.id === event.track.id)) {
          this.remoteStream.addTrack(event.track);
        }
        event.track.onunmute = () => {
          if (this.isClosed) return;
          this.clearConnectionTimeout();
          this.callbacks.onRemoteStream(this.remoteStream);
          this.callbacks.onCallStatusChange('connected');
          this.updateRemoteTrackDiagnostics();
        };
      }
      this.clearConnectionTimeout();
      this.callbacks.onRemoteStream(this.remoteStream);
      this.callbacks.onCallStatusChange('connected');
      this.updateRemoteTrackDiagnostics();
    };

    // 5. Publish local ICE candidates to Firestore subcollection
    const myCandidateSubcol = this.isInitiator
      ? 'initiatorCandidates'
      : 'answererCandidates';

    pc.onicecandidate = async (event) => {
      if (this.isClosed || !event.candidate) return;
      const cand = event.candidate;
      if (!cand.candidate) return;

      const candId = `cand_${Date.now().toString(36)}_${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      const candRef = doc(
        db,
        'videoSessions',
        this.sessionId,
        myCandidateSubcol,
        candId
      );

      try {
        await setDoc(candRef, {
          id: candId,
          sessionId: this.sessionId,
          senderId: this.currentUserId,
          candidate: cand.candidate.slice(0, 2048),
          sdpMid: String(cand.sdpMid ?? '0').slice(0, 64),
          sdpMLineIndex: typeof cand.sdpMLineIndex === 'number' ? cand.sdpMLineIndex : 0,
          createdAt: serverTimestamp(),
        });
      } catch {
        // Ignore candidate writes if session was concurrently closed
      }
    };

    // 6. Monitor Signaling, ICE, and PeerConnection states
    pc.onsignalingstatechange = () => {
      if (this.isClosed) return;
      this.callbacks.onDiagnosticsUpdate({
        signalingState: pc.signalingState,
      });
    };

    pc.oniceconnectionstatechange = () => {
      if (this.isClosed) return;
      const iceState = pc.iceConnectionState;
      this.callbacks.onDiagnosticsUpdate({
        iceConnectionState: iceState,
      });

      if (iceState === 'connected' || iceState === 'completed') {
        this.clearConnectionTimeout();
        this.callbacks.onCallStatusChange('connected');
      } else if (iceState === 'failed') {
        if (this.isInitiator && !this.iceRestartAttempted) {
          this.iceRestartAttempted = true;
          this.triggerIceRestart().catch((err) => {
            this.callbacks.onDiagnosticsUpdate({
              lastError: `ICE Restart failed: ${(err as Error).message}`,
            });
          });
        } else {
          this.callbacks.onCallStatusChange('failed');
          this.callbacks.onDiagnosticsUpdate({
            lastError: iceConfig.turnConfigured
              ? 'Peer-to-peer and TURN relay media connection failed.'
              : 'ICE connection failed (STUN-only mode). Restrictive symmetric NAT/firewalls require TURN credentials.',
          });
        }
      }
    };

    pc.onconnectionstatechange = () => {
      if (this.isClosed) return;
      const connState = pc.connectionState;
      this.callbacks.onDiagnosticsUpdate({
        peerConnectionState: connState,
      });

      if (connState === 'connected') {
        this.clearConnectionTimeout();
        this.callbacks.onCallStatusChange('connected');
      } else if (connState === 'failed') {
        this.callbacks.onCallStatusChange('failed');
      }
    };

    // 7. Ensure `/videoSessions/{sessionId}` exists and immediately publish Initiator Offer or Answerer Readiness
    await this.ensureVideoSessionAndMarkReady();
    if (this.isClosed) return;

    if (this.isInitiator) {
      await this.createAndPublishOffer(1, false);
      if (this.isClosed) return;
    }

    // 8. Subscribe to remote ICE candidates
    const remoteCandidateSubcol = this.isInitiator
      ? 'answererCandidates'
      : 'initiatorCandidates';
    const remoteCandidatesRef = collection(
      db,
      'videoSessions',
      this.sessionId,
      remoteCandidateSubcol
    );

    this.remoteCandidatesUnsub = onSnapshot(
      remoteCandidatesRef,
      (snap) => {
        if (this.isClosed || !this.pc) return;
        snap.docChanges().forEach((change) => {
          if (change.type === 'added') {
            const cData = change.doc.data();
            const cid = change.doc.id;
            if (this.processedCandidateIds.has(cid)) return;
            this.processedCandidateIds.add(cid);

            const candidateInit: RTCIceCandidateInit = {
              candidate: String(cData.candidate || ''),
              sdpMid: String(cData.sdpMid ?? '0'),
              sdpMLineIndex:
                typeof cData.sdpMLineIndex === 'number' ? cData.sdpMLineIndex : 0,
            };

            if (this.pc && this.pc.remoteDescription && this.pc.remoteDescription.type) {
              this.pc.addIceCandidate(new RTCIceCandidate(candidateInit)).catch(() => {
                // Ignore late/stale candidate
              });
            } else {
              this.pendingRemoteCandidates.push(candidateInit);
            }
          }
        });
      },
      (err) => {
        handleFirestoreError(
          err,
          OperationType.GET,
          `videoSessions/${this.sessionId}/${remoteCandidateSubcol}`
        );
      }
    );

    // 9. Subscribe to `/videoSessions/{sessionId}` for offer/answer negotiation
    const videoSessionRef = doc(db, 'videoSessions', this.sessionId);
    this.sessionUnsub = onSnapshot(
      videoSessionRef,
      async (snap) => {
        if (this.isClosed || !this.pc || !snap.exists()) return;
        const data = snap.data() as VideoSessionDoc;

        if (data.status === 'ended') {
          this.callbacks.onCallStatusChange('ended');
          return;
        }

        const partnerReady = this.isInitiator ? data.answererReady : data.initiatorReady;
        this.callbacks.onPartnerVideoReadyChange(Boolean(partnerReady));
        this.callbacks.onDiagnosticsUpdate({
          offerRevision: data.offerRevision || 0,
        });

        // Fallback if Initiator's initial offer wasn't published yet
        if (
          this.isInitiator &&
          (!data.offerSdp || data.offerRevision === 0) &&
          !this.isNegotiatingOffer
        ) {
          await this.createAndPublishOffer(1, false);
          return;
        }

        // Answerer receives SDP Offer and immediately publishes SDP Answer
        if (
          !this.isInitiator &&
          data.offerType === 'offer' &&
          data.offerSdp &&
          data.offerRevision > this.lastProcessedOfferRevision &&
          !this.isNegotiatingOffer
        ) {
          await this.receiveOfferAndPublishAnswer(data.offerSdp, data.offerRevision);
          return;
        }

        // Initiator receives SDP Answer
        if (
          this.isInitiator &&
          data.answerType === 'answer' &&
          data.answerSdp &&
          this.pc.signalingState === 'have-local-offer'
        ) {
          try {
            await this.pc.setRemoteDescription(
              new RTCSessionDescription({
                type: 'answer',
                sdp: data.answerSdp,
              })
            );
            await this.flushPendingIceCandidates();
            await updateDoc(videoSessionRef, {
              status: 'connected',
              updatedAt: serverTimestamp(),
            });
          } catch (err) {
            this.callbacks.onDiagnosticsUpdate({
              lastError: `Failed to set remote answer: ${(err as Error).message}`,
            });
          }
        }
      },
      (err) => {
        handleFirestoreError(err, OperationType.GET, `videoSessions/${this.sessionId}`);
      }
    );

    // 10. Start telemetry polling every 2 seconds
    this.statsIntervalId = window.setInterval(() => {
      this.collectRtcStats();
    }, 2000);
  }

  private async ensureVideoSessionAndMarkReady(): Promise<void> {
    const videoSessionRef = doc(db, 'videoSessions', this.sessionId);
    const readinessPatch = this.isInitiator
      ? { initiatorReady: true, updatedAt: serverTimestamp() }
      : { answererReady: true, updatedAt: serverTimestamp() };

    // Fast path: videoSessions/{sessionId} is created atomically in the matchmaking batch,
    // so updateDoc succeeds in a single round-trip without overwriting the partner's readiness flag.
    try {
      await updateDoc(videoSessionRef, readinessPatch);
      return;
    } catch {
      // Document may not exist yet if created by a legacy session; fall back to getDoc/setDoc
    }

    let snap;
    try {
      snap = await getDoc(videoSessionRef);
    } catch (err) {
      handleFirestoreError(err, OperationType.GET, `videoSessions/${this.sessionId}`);
    }

    if (!snap || !snap.exists()) {
      try {
        await setDoc(videoSessionRef, {
          sessionId: this.sessionId,
          initiatorId: this.initiatorId,
          answererId: this.answererId,
          status: 'waiting',
          initiatorReady: this.isInitiator,
          answererReady: !this.isInitiator,
          offerType: '',
          offerSdp: '',
          answerType: '',
          answerSdp: '',
          offerRevision: 0,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        return;
      } catch {
        // Another participant created the document concurrently; proceed to updateDoc
      }
    }

    try {
      await updateDoc(videoSessionRef, readinessPatch);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `videoSessions/${this.sessionId}`);
    }
  }

  private async createAndPublishOffer(
    nextRevision: number,
    iceRestart: boolean
  ): Promise<void> {
    if (!this.pc || this.isClosed) return;
    this.isNegotiatingOffer = true;
    this.callbacks.onCallStatusChange('connecting');
    this.startConnectionTimeout();

    try {
      const offer = await this.pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true,
        iceRestart,
      });
      await this.pc.setLocalDescription(offer);

      const videoSessionRef = doc(db, 'videoSessions', this.sessionId);
      await updateDoc(videoSessionRef, {
        initiatorReady: true,
        offerType: 'offer',
        offerSdp: (offer.sdp || '').slice(0, 24000),
        answerType: '',
        answerSdp: '',
        offerRevision: nextRevision,
        status: 'negotiating',
        updatedAt: serverTimestamp(),
      });
      this.lastProcessedOfferRevision = nextRevision;
    } catch (err) {
      this.callbacks.onDiagnosticsUpdate({
        lastError: `Create offer failed: ${(err as Error).message}`,
      });
    } finally {
      this.isNegotiatingOffer = false;
    }
  }

  private async receiveOfferAndPublishAnswer(
    offerSdp: string,
    offerRevision: number
  ): Promise<void> {
    if (!this.pc || this.isClosed) return;
    this.isNegotiatingOffer = true;
    this.lastProcessedOfferRevision = offerRevision;
    this.callbacks.onCallStatusChange('connecting');
    this.startConnectionTimeout();

    try {
      await this.pc.setRemoteDescription(
        new RTCSessionDescription({
          type: 'offer',
          sdp: offerSdp,
        })
      );
      await this.flushPendingIceCandidates();

      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);

      const videoSessionRef = doc(db, 'videoSessions', this.sessionId);
      await updateDoc(videoSessionRef, {
        answererReady: true,
        answerType: 'answer',
        answerSdp: (answer.sdp || '').slice(0, 24000),
        status: 'negotiating',
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      this.callbacks.onDiagnosticsUpdate({
        lastError: `Publish answer failed: ${(err as Error).message}`,
      });
    } finally {
      this.isNegotiatingOffer = false;
    }
  }

  private async flushPendingIceCandidates(): Promise<void> {
    if (!this.pc || !this.pc.remoteDescription) return;
    const queued = [...this.pendingRemoteCandidates];
    this.pendingRemoteCandidates = [];
    for (const cand of queued) {
      try {
        await this.pc.addIceCandidate(new RTCIceCandidate(cand));
      } catch {
        // Ignore invalid/duplicate ICE candidate
      }
    }
  }

  public async triggerIceRestart(): Promise<void> {
    if (!this.pc || this.isClosed || !this.isInitiator) return;
    const nextRev = this.lastProcessedOfferRevision + 1;
    await this.createAndPublishOffer(nextRev, true);
  }

  public async replaceVideoTrack(newVideoTrack: MediaStreamTrack): Promise<void> {
    if (!this.pc || this.isClosed) return;
    const sender = this.pc
      .getSenders()
      .find((s) => s.track && s.track.kind === 'video');
    if (sender) {
      await sender.replaceTrack(newVideoTrack);
      await apply360pBitrateConstraints(this.pc);
      this.updateLocalTrackDiagnostics();
    }
  }

  public updateLocalTrackDiagnostics(): void {
    const vTrack = this.localStream.getVideoTracks()[0];
    const aTrack = this.localStream.getAudioTracks()[0];
    this.callbacks.onDiagnosticsUpdate({
      localVideoTrackState: vTrack
        ? `${vTrack.readyState} (${vTrack.enabled ? 'enabled' : 'muted'})`
        : 'none',
      localAudioTrackState: aTrack
        ? `${aTrack.readyState} (${aTrack.enabled ? 'enabled' : 'muted'})`
        : 'none',
    });
  }

  private updateRemoteTrackDiagnostics(): void {
    const vTrack = this.remoteStream?.getVideoTracks()[0];
    const aTrack = this.remoteStream?.getAudioTracks()[0];
    this.callbacks.onDiagnosticsUpdate({
      remoteVideoTrackState: vTrack ? `${vTrack.readyState}` : 'waiting',
      remoteAudioTrackState: aTrack ? `${aTrack.readyState}` : 'waiting',
    });
  }

  private startConnectionTimeout(): void {
    this.clearConnectionTimeout();
    this.connectionTimeoutId = window.setTimeout(() => {
      if (this.isClosed || !this.pc) return;
      if (
        this.pc.iceConnectionState !== 'connected' &&
        this.pc.iceConnectionState !== 'completed'
      ) {
        this.callbacks.onCallStatusChange('failed');
        this.callbacks.onDiagnosticsUpdate({
          lastError:
            'WebRTC connection timed out after 20 seconds. Check firewall or configure TURN relay.',
        });
      }
    }, 20000);
  }

  private clearConnectionTimeout(): void {
    if (this.connectionTimeoutId) {
      window.clearTimeout(this.connectionTimeoutId);
      this.connectionTimeoutId = null;
    }
  }

  private async collectRtcStats(): Promise<void> {
    if (!this.pc || this.isClosed) return;
    try {
      const stats = await this.pc.getStats();
      let width = 0;
      let height = 0;
      let bitrateKbps = 0;
      let selectedCandidateType = 'none';

      let activeCandidatePairId: string | null = null;
      const localCandidates = new Map<string, string>();

      stats.forEach((report) => {
        if (report.type === 'outbound-rtp' && report.kind === 'video') {
          if (typeof report.frameWidth === 'number') width = report.frameWidth;
          if (typeof report.frameHeight === 'number') height = report.frameHeight;
          if (typeof report.bytesSent === 'number' && typeof report.timestamp === 'number') {
            if (this.lastStatsTimestamp > 0 && report.timestamp > this.lastStatsTimestamp) {
              const bytesDelta = report.bytesSent - this.lastBytesSent;
              const timeDeltaSec = (report.timestamp - this.lastStatsTimestamp) / 1000;
              if (timeDeltaSec > 0 && bytesDelta >= 0) {
                bitrateKbps = Math.round((bytesDelta * 8) / 1000 / timeDeltaSec);
              }
            }
            this.lastBytesSent = report.bytesSent;
            this.lastStatsTimestamp = report.timestamp;
          }
        }
        if (report.type === 'transport' && report.selectedCandidatePairId) {
          activeCandidatePairId = report.selectedCandidatePairId;
        }
        if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) {
          if (!activeCandidatePairId) {
            activeCandidatePairId = report.id;
          }
        }
        if (report.type === 'local-candidate') {
          localCandidates.set(report.id, report.candidateType || 'unknown');
        }
      });

      if (activeCandidatePairId) {
        stats.forEach((report) => {
          if (report.id === activeCandidatePairId && report.localCandidateId) {
            selectedCandidateType =
              localCandidates.get(report.localCandidateId) || 'unknown';
          }
        });
      }

      if (width === 0 || height === 0) {
        const vTrack = this.localStream.getVideoTracks()[0];
        const settings = vTrack?.getSettings();
        if (settings?.width && settings?.height) {
          width = settings.width;
          height = settings.height;
        }
      }

      this.callbacks.onDiagnosticsUpdate({
        outgoingResolution: width && height ? `${width}x${height}` : '640x360',
        outgoingBitrateKbps: bitrateKbps,
        selectedCandidateType,
      });
      this.updateLocalTrackDiagnostics();
      this.updateRemoteTrackDiagnostics();
    } catch {
      // Ignore stats error
    }
  }

  public async stop(markSessionEndedInFirestore = true): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;
    this.clearConnectionTimeout();

    if (this.statsIntervalId) {
      window.clearInterval(this.statsIntervalId);
      this.statsIntervalId = null;
    }

    if (this.sessionUnsub) {
      this.sessionUnsub();
      this.sessionUnsub = null;
    }

    if (this.remoteCandidatesUnsub) {
      this.remoteCandidatesUnsub();
      this.remoteCandidatesUnsub = null;
    }

    if (this.pc) {
      try {
        this.pc.ontrack = null;
        this.pc.onicecandidate = null;
        this.pc.onsignalingstatechange = null;
        this.pc.oniceconnectionstatechange = null;
        this.pc.onconnectionstatechange = null;
        this.pc.close();
      } catch {
        // Ignore close errors
      }
      this.pc = null;
    }

    this.remoteStream = null;
    this.callbacks.onRemoteStream(null);

    if (markSessionEndedInFirestore) {
      try {
        await updateDoc(doc(db, 'videoSessions', this.sessionId), {
          status: 'ended',
          updatedAt: serverTimestamp(),
        });
      } catch {
        // Ignore if doc doesn't exist or already ended
      }
    }
  }
}
