import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Video,
  VideoOff,
  Mic,
  MicOff,
  SkipForward,
  PhoneOff,
  ShieldAlert,
  Ban,
  Send,
  Radio,
  Lock,
  Activity,
  RefreshCw,
  Volume2,
} from 'lucide-react';
import type { AuthenticatedUser } from '../types';
import { apiRequest, buildWebSocketUrl } from '../api';

interface RandomChatStudioProps {
  user: AuthenticatedUser;
  onNavigateMembership: () => void;
}

interface EphemeralMessage {
  id: string;
  sender: 'me' | 'stranger' | 'system';
  text: string;
  timestamp: string;
}

interface MatchedPartnerMeta {
  ephemeralPeerId: string;
  displayName: string;
  region: string | null;
  sharedInterests: string[];
}

interface IceServersApiResponse {
  iceServers: RTCIceServer[];
  turnConfigured: boolean;
  turnProvider: 'cloudflare_calls' | 'static_turn' | 'none';
  mediaConstraints?: {
    width: number;
    height: number;
    frameRate: number;
    maxVideoBitrateBps: number;
  };
}

interface WebRtcDiagnostics {
  role: 'idle' | 'initiator (offerer)' | 'responder (answerer)';
  signalingState: string;
  iceConnectionState: string;
  connectionState: string;
  iceGatheringState: string;
  localTracksSummary: string;
  remoteTracksSummary: string;
  remoteVideoReady: boolean;
  sdpStatus: string;
  iceSent: number;
  iceReceived: number;
  iceQueued: number;
  iceApplied: number;
  turnConfigured: boolean;
  maxBitrateKbps: number;
  lastError: string | null;
  events: string[];
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
];

const TARGET_VIDEO_WIDTH = 640;
const TARGET_VIDEO_HEIGHT = 360;
const TARGET_VIDEO_FPS = 24;
const MAX_VIDEO_BITRATE_BPS = 500_000; // 500 Kbps

/**
 * Sanitizes error messages so session tokens or private SDP keys/fingerprints
 * are never exposed in logs or UI diagnostics.
 */
function sanitizeWebRtcErrorMessage(raw: unknown): string {
  const message =
    raw instanceof Error
      ? `${raw.name}: ${raw.message}`
      : typeof raw === 'string'
      ? raw
      : JSON.stringify(raw || 'Unknown WebRTC error');

  return message
    .replace(/token=[^&\s]+/gi, 'token=[REDACTED]')
    .replace(/ouat_v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_TOKEN]')
    .replace(/a=(ice-pwd|ice-ufrag|fingerprint):[^\r\n]+/gi, 'a=$1:[REDACTED]');
}

/**
 * Adds a 500 Kbps bandwidth limit line (b=AS:500) to the video media section of an SDP
 * as a universal fallback alongside RTCRtpSender.setParameters(maxBitrate = 500_000).
 */
function enforceSdpVideoBitrateKbps(sdp: string, maxKbps = 500): string {
  if (!sdp || !sdp.includes('m=video')) return sdp;
  const lines = sdp.split(/\r?\n/);
  const out: string[] = [];
  let inVideoSection = false;
  let bandwidthInserted = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('m=video')) {
      inVideoSection = true;
      bandwidthInserted = false;
      out.push(line);
      continue;
    }
    if (line.startsWith('m=') && !line.startsWith('m=video')) {
      inVideoSection = false;
    }
    if (inVideoSection && (line.startsWith('b=AS:') || line.startsWith('b=TIAS:'))) {
      continue;
    }
    out.push(line);
    if (
      inVideoSection &&
      !bandwidthInserted &&
      (line.startsWith('c=IN') || line.startsWith('a=mid:'))
    ) {
      out.push(`b=AS:${maxKbps}`);
      out.push(`b=TIAS:${maxKbps * 1000}`);
      bandwidthInserted = true;
    }
  }
  return out.join('\r\n');
}

const INITIAL_DIAGNOSTICS: WebRtcDiagnostics = {
  role: 'idle',
  signalingState: 'closed',
  iceConnectionState: 'idle',
  connectionState: 'idle',
  iceGatheringState: 'new',
  localTracksSummary: 'none',
  remoteTracksSummary: 'none',
  remoteVideoReady: false,
  sdpStatus: 'idle',
  iceSent: 0,
  iceReceived: 0,
  iceQueued: 0,
  iceApplied: 0,
  turnConfigured: false,
  maxBitrateKbps: 500,
  lastError: null,
  events: [],
};

export const RandomChatStudio: React.FC<RandomChatStudioProps> = ({
  user,
  onNavigateMembership,
}) => {
  const [mode, setMode] = useState<'video' | 'text'>('video');
  const [wsConnected, setWsConnected] = useState(false);
  const [wsStatus, setWsStatus] = useState<'connecting' | 'connected' | 'error'>('connecting');
  const [wsError, setWsError] = useState<string | null>(null);
  const [wsAttempt, setWsAttempt] = useState(0);
  const [stage, setStage] = useState<'idle' | 'waiting' | 'matched'>('idle');
  const [partner, setPartner] = useState<MatchedPartnerMeta | null>(null);
  const [partnerMedia, setPartnerMedia] = useState<{ cameraOn: boolean; micOn: boolean }>({
    cameraOn: true,
    micOn: true,
  });
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [partnerTyping, setPartnerTyping] = useState(false);

  const [cameraOn, setCameraOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [mediaPermissionState, setMediaPermissionState] = useState<
    'prompt' | 'granted' | 'unavailable'
  >('prompt');
  const [queueSeconds, setQueueSeconds] = useState(0);

  const [messages, setMessages] = useState<EphemeralMessage[]>([]);
  const [inputText, setInputText] = useState('');

  const [reportModalOpen, setReportModalOpen] = useState(false);
  const [reportReason, setReportReason] = useState('harassment_or_abuse');
  const [reportDetails, setReportDetails] = useState('');
  const [safetyFeedback, setSafetyFeedback] = useState<string | null>(null);
  const [webrtcError, setWebrtcError] = useState<string | null>(null);
  const [iceState, setIceState] = useState<string>('idle');
  const [showDiagnostics, setShowDiagnostics] = useState<boolean>(true);
  const [remoteAudioBlocked, setRemoteAudioBlocked] = useState<boolean>(false);
  const [diagnostics, setDiagnostics] = useState<WebRtcDiagnostics>(INITIAL_DIAGNOSTICS);

  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const isInitiatorRef = useRef<boolean>(false);
  const modeRef = useRef<'video' | 'text'>('video');
  const typingTimeoutRef = useRef<number | null>(null);
  const iceTimeoutRef = useRef<number | null>(null);

  // Ordered WebRTC signaling & Pending ICE Candidate Queue refs
  const signalingChainRef = useRef<Promise<void>>(Promise.resolve());
  const pendingIceCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const remoteDescriptionSetRef = useRef<boolean>(false);
  const cachedIceConfigRef = useRef<{
    iceServers: RTCIceServer[];
    turnConfigured: boolean;
  } | null>(null);

  const hasActiveMembership = user.membership.status === 'active';

  const appendDiagnosticEvent = useCallback((label: string, isError = false) => {
    const clean = sanitizeWebRtcErrorMessage(label);
    const time = new Date().toLocaleTimeString([], {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    if (isError) {
      console.error(`[OUAT WebRTC] ${clean}`);
    } else {
      console.info(`[OUAT WebRTC] ${clean}`);
    }
    setDiagnostics((prev) => ({
      ...prev,
      lastError: isError ? clean : prev.lastError,
      events: [...prev.events.slice(-14), `${time} · ${clean}`],
    }));
  }, []);

  const syncTrackDiagnostics = useCallback(() => {
    const localStream = localStreamRef.current;
    let localSummary = 'none';
    if (localStream) {
      const tracks = localStream.getTracks();
      if (tracks.length > 0) {
        localSummary = tracks
          .map((t) => {
            if (t.kind === 'video') {
              const s = t.getSettings ? t.getSettings() : {};
              const dim = s.width && s.height ? `${s.width}x${s.height}` : '640x360';
              const fps = s.frameRate ? `@${Math.round(s.frameRate)}fps` : '@24fps';
              return `video(${dim}${fps}, ${t.enabled ? 'on' : 'muted'})`;
            }
            return `${t.kind}(${t.enabled ? 'on' : 'muted'})`;
          })
          .join(', ');
      }
    }

    const remoteStream = remoteStreamRef.current;
    let remoteSummary = 'none';
    let hasRemoteVideo = false;
    if (remoteStream) {
      const rTracks = remoteStream.getTracks();
      if (rTracks.length > 0) {
        hasRemoteVideo = rTracks.some((t) => t.kind === 'video' && t.readyState === 'live');
        remoteSummary = rTracks
          .map((t) => `${t.kind}(${t.readyState}${t.muted ? ',muted' : ',live'})`)
          .join(', ');
      }
    }

    setDiagnostics((prev) => ({
      ...prev,
      localTracksSummary: localSummary,
      remoteTracksSummary: remoteSummary,
      remoteVideoReady: hasRemoteVideo,
    }));
  }, []);

  const attachStreamToRemoteVideo = useCallback(() => {
    const videoEl = remoteVideoRef.current;
    const stream = remoteStreamRef.current;
    if (!videoEl || !stream) return;

    if (videoEl.srcObject !== stream) {
      videoEl.srcObject = stream;
    }
    videoEl.autoplay = true;
    videoEl.playsInline = true;

    const playPromise = videoEl.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise
        .then(() => {
          setRemoteAudioBlocked(false);
          syncTrackDiagnostics();
        })
        .catch((err: Error) => {
          // If browser blocks unmuted autoplay, play muted immediately so video is visible
          // and show a 1-click "Unmute Audio" button.
          if (err.name === 'NotAllowedError') {
            videoEl.muted = true;
            setRemoteAudioBlocked(true);
            videoEl.play().catch((innerErr) => {
              appendDiagnosticEvent(
                `Remote video playback blocked: ${sanitizeWebRtcErrorMessage(innerErr)}`,
                true
              );
            });
          } else if (err.name !== 'AbortError') {
            appendDiagnosticEvent(
              `Remote video play() notice: ${sanitizeWebRtcErrorMessage(err)}`,
               false
            );
          }
        });
    }
  }, [appendDiagnosticEvent, syncTrackDiagnostics]);

  const attachStreamToLocalVideo = useCallback(() => {
    const videoEl = localVideoRef.current;
    const stream = localStreamRef.current;
    if (!videoEl || !stream) return;

    if (videoEl.srcObject !== stream) {
      videoEl.srcObject = stream;
    }
    videoEl.muted = true;
    videoEl.autoplay = true;
    videoEl.playsInline = true;
    videoEl.play().catch(() => {
      // Local preview is muted; ignore benign AbortError on re-mount
    });
  }, []);

  // Callback refs ensure <video> elements receive srcObject immediately upon DOM mount
  const setRemoteVideoElement = useCallback(
    (el: HTMLVideoElement | null) => {
      remoteVideoRef.current = el;
      if (el && remoteStreamRef.current) {
        attachStreamToRemoteVideo();
      }
    },
    [attachStreamToRemoteVideo]
  );

  const setLocalVideoElement = useCallback(
    (el: HTMLVideoElement | null) => {
      localVideoRef.current = el;
      if (el && localStreamRef.current) {
        attachStreamToLocalVideo();
      }
    },
    [attachStreamToLocalVideo]
  );

  useEffect(() => {
    if (stage === 'matched' || stage === 'waiting') {
      attachStreamToLocalVideo();
      attachStreamToRemoteVideo();
    }
  }, [stage, mode, attachStreamToLocalVideo, attachStreamToRemoteVideo]);

  const clearIceNegotiationTimer = () => {
    if (iceTimeoutRef.current) {
      window.clearTimeout(iceTimeoutRef.current);
      iceTimeoutRef.current = null;
    }
  };

  const cleanupPeerConnection = useCallback(() => {
    clearIceNegotiationTimer();
    setWebrtcError(null);
    setIceState('idle');
    setRemoteAudioBlocked(false);
    pendingIceCandidatesRef.current = [];
    remoteDescriptionSetRef.current = false;

    if (pcRef.current) {
      try {
        pcRef.current.onicecandidate = null;
        pcRef.current.ontrack = null;
        pcRef.current.oniceconnectionstatechange = null;
        pcRef.current.onconnectionstatechange = null;
        pcRef.current.onsignalingstatechange = null;
        pcRef.current.onicegatheringstatechange = null;
        pcRef.current.close();
      } catch (err) {
        console.warn('[OUAT WebRTC] Error closing RTCPeerConnection:', sanitizeWebRtcErrorMessage(err));
      }
      pcRef.current = null;
    }

    remoteStreamRef.current = null;
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }

    setDiagnostics((prev) => ({
      ...INITIAL_DIAGNOSTICS,
      turnConfigured: prev.turnConfigured,
      localTracksSummary: prev.localTracksSummary,
    }));
  }, []);

  const stopLocalMedia = useCallback(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }
    syncTrackDiagnostics();
  }, [syncTrackDiagnostics]);

  /**
   * Captures 640x360 @ 24 FPS video + echo-cancelled audio via getUserMedia.
   */
  const ensureLocalMedia = useCallback(async (): Promise<MediaStream | null> => {
    if (modeRef.current !== 'video') return null;

    if (localStreamRef.current) {
      const activeTracks = localStreamRef.current
        .getTracks()
        .filter((t) => t.readyState === 'live');
      if (activeTracks.length > 0) {
        attachStreamToLocalVideo();
        syncTrackDiagnostics();
        return localStreamRef.current;
      }
      localStreamRef.current = null;
    }

    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      const msg =
        'Camera/microphone capture (navigator.mediaDevices.getUserMedia) is unavailable in this browser context. Ensure you are using HTTPS.';
      setMediaPermissionState('unavailable');
      appendDiagnosticEvent(msg, true);
      setWebrtcError(msg);
      return null;
    }

    try {
      let stream: MediaStream;
      try {
        // Requirement 5 & 6: Capture 640x360 at 24 FPS + audio
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: TARGET_VIDEO_WIDTH, max: TARGET_VIDEO_WIDTH },
            height: { ideal: TARGET_VIDEO_HEIGHT, max: TARGET_VIDEO_HEIGHT },
            frameRate: { ideal: TARGET_VIDEO_FPS, max: TARGET_VIDEO_FPS },
            facingMode: 'user',
          },
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      } catch (constraintErr) {
        appendDiagnosticEvent(
          `Strict 640x360@24fps constraint fallback: ${sanitizeWebRtcErrorMessage(constraintErr)}`,
          false
        );
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: TARGET_VIDEO_WIDTH },
            height: { ideal: TARGET_VIDEO_HEIGHT },
            frameRate: { ideal: TARGET_VIDEO_FPS },
            facingMode: 'user',
          },
          audio: true,
        });
      }

      // Apply 640x360 @ 24fps constraints on captured video track
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack && typeof videoTrack.applyConstraints === 'function') {
        await videoTrack
          .applyConstraints({
            width: { ideal: TARGET_VIDEO_WIDTH, max: TARGET_VIDEO_WIDTH },
            height: { ideal: TARGET_VIDEO_HEIGHT, max: TARGET_VIDEO_HEIGHT },
            frameRate: { ideal: TARGET_VIDEO_FPS, max: TARGET_VIDEO_FPS },
          })
          .catch(() => {
            // Keep stream even if hardware driver locks native resolution
          });
      }

      // Respect current cameraOn / micOn toggles
      stream.getVideoTracks().forEach((t) => {
        t.enabled = cameraOn;
      });
      stream.getAudioTracks().forEach((t) => {
        t.enabled = micOn;
      });

      localStreamRef.current = stream;
      setMediaPermissionState('granted');
      attachStreamToLocalVideo();
      syncTrackDiagnostics();
      appendDiagnosticEvent(
        `Captured local media: ${stream.getVideoTracks().length} video (640x360@24fps), ${
          stream.getAudioTracks().length
        } audio track(s)`
      );
      return stream;
    } catch (err) {
      setMediaPermissionState('unavailable');
      const cleanErr = sanitizeWebRtcErrorMessage(err);
      appendDiagnosticEvent(`getUserMedia failed: ${cleanErr}`, true);
      setWebrtcError(
        `Could not access your camera or microphone (${cleanErr}). Please grant camera & microphone permissions in your browser address bar and retry.`
      );
      return null;
    }
  }, [
    attachStreamToLocalVideo,
    appendDiagnosticEvent,
    cameraOn,
    micOn,
    syncTrackDiagnostics,
  ]);

  /**
   * Fetches STUN + optional TURN credentials from /api/webrtc/ice-servers.
   */
  const fetchIceConfiguration = useCallback(async (): Promise<{
    iceServers: RTCIceServer[];
    turnConfigured: boolean;
  }> => {
    if (cachedIceConfigRef.current) {
      return cachedIceConfigRef.current;
    }
    try {
      const data = await apiRequest<IceServersApiResponse>('/webrtc/ice-servers');
      if (data && Array.isArray(data.iceServers) && data.iceServers.length > 0) {
        const config = {
          iceServers: data.iceServers,
          turnConfigured: Boolean(data.turnConfigured),
        };
        cachedIceConfigRef.current = config;
        setDiagnostics((prev) => ({
          ...prev,
          turnConfigured: config.turnConfigured,
        }));
        return config;
      }
    } catch (err) {
      appendDiagnosticEvent(
        `ICE config endpoint fallback to default STUN: ${sanitizeWebRtcErrorMessage(err)}`,
        false
      );
    }
    return {
      iceServers: DEFAULT_ICE_SERVERS,
      turnConfigured: false,
    };
  }, [appendDiagnosticEvent]);

  /**
   * Caps outgoing video RTCRtpSender bitrate to 500 Kbps and framerate to 24 FPS.
   */
  const applyVideoSenderBitrateLimit = useCallback(
    async (pc: RTCPeerConnection) => {
      const senders = pc.getSenders ? pc.getSenders() : [];
      for (const sender of senders) {
        if (sender.track && sender.track.kind === 'video' && typeof sender.getParameters === 'function') {
          try {
            const params = sender.getParameters() || ({} as RTCRtpSendParameters);
            if (!params.encodings || params.encodings.length === 0) {
              params.encodings = [{}];
            }
            params.encodings[0].maxBitrate = MAX_VIDEO_BITRATE_BPS; // 500 Kbps
            params.encodings[0].maxFramerate = TARGET_VIDEO_FPS; // 24 FPS
            await sender.setParameters(params);
            appendDiagnosticEvent('Applied 500 Kbps / 24 FPS cap on outgoing video RTCRtpSender');
          } catch (err) {
            appendDiagnosticEvent(
              `RTCRtpSender bitrate parameter note: ${sanitizeWebRtcErrorMessage(err)}`,
              false
            );
          }
        }
      }
    },
    [appendDiagnosticEvent]
  );

  /**
   * Drains and applies all queued ICE candidates ONLY after setRemoteDescription has succeeded.
   */
  const flushPendingIceCandidates = useCallback(
    async (pc: RTCPeerConnection) => {
      if (!remoteDescriptionSetRef.current || !pc.remoteDescription) {
        return;
      }
      const pending = pendingIceCandidatesRef.current.splice(
        0,
        pendingIceCandidatesRef.current.length
      );
      if (pending.length === 0) return;

      appendDiagnosticEvent(`Flushing ${pending.length} queued ICE candidate(s) after setRemoteDescription`);
      for (const candidateInit of pending) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidateInit));
          setDiagnostics((prev) => ({
            ...prev,
            iceQueued: pendingIceCandidatesRef.current.length,
            iceApplied: prev.iceApplied + 1,
          }));
        } catch (err) {
          appendDiagnosticEvent(
            `Failed to apply queued ICE candidate: ${sanitizeWebRtcErrorMessage(err)}`,
            true
          );
        }
      }
    },
    [appendDiagnosticEvent]
  );

  /**
   * Initializes RTCPeerConnection, attaches local video+audio tracks BEFORE SDP negotiation,
   * sets up remote stream attachment, and sends the SDP offer if initiator === true.
   */
  const initializeWebRtcForSession = useCallback(
    async (sessionId: string, initiator: boolean): Promise<RTCPeerConnection | null> => {
      cleanupPeerConnection();
      isInitiatorRef.current = initiator;

      const roleLabel = initiator ? 'initiator (offerer)' : 'responder (answerer)';
      setDiagnostics((prev) => ({
        ...INITIAL_DIAGNOSTICS,
        role: roleLabel,
        signalingState: 'new',
        iceConnectionState: 'new',
        connectionState: 'new',
        sdpStatus: initiator ? 'preparing-offer' : 'waiting-for-offer',
      }));
      appendDiagnosticEvent(`Initializing WebRTC session as ${roleLabel}`);

      // 1. Fetch STUN + optional TURN configuration & capture local 640x360@24fps media
      const [iceConfig, localStream] = await Promise.all([
        fetchIceConfiguration(),
        ensureLocalMedia(),
      ]);

      // Abort if user skipped/left while awaiting media permission
      if (sessionIdRef.current !== sessionId) {
        return null;
      }

      const pc = new RTCPeerConnection({
        iceServers: iceConfig.iceServers,
        iceCandidatePoolSize: 4,
      });
      pcRef.current = pc;

      // Prepare remote MediaStream container immediately
      const remoteStream = new MediaStream();
      remoteStreamRef.current = remoteStream;

      // 2. Add local video and audio tracks BEFORE SDP offer/answer creation
      if (localStream) {
        const videoTracks = localStream.getVideoTracks();
        const audioTracks = localStream.getAudioTracks();

        for (const track of videoTracks) {
          pc.addTrack(track, localStream);
        }
        for (const track of audioTracks) {
          pc.addTrack(track, localStream);
        }

        if (videoTracks.length === 0 && typeof pc.addTransceiver === 'function') {
          pc.addTransceiver('video', { direction: 'recvonly' });
        }
        if (audioTracks.length === 0 && typeof pc.addTransceiver === 'function') {
          pc.addTransceiver('audio', { direction: 'recvonly' });
        }
      } else if (typeof pc.addTransceiver === 'function') {
        // Still allow receiving partner's video & audio even if local camera is unavailable
        pc.addTransceiver('video', { direction: 'recvonly' });
        pc.addTransceiver('audio', { direction: 'recvonly' });
      }

      syncTrackDiagnostics();
      await applyVideoSenderBitrateLimit(pc);

      // 3. Attach WebRTC state & diagnostic listeners
      pc.onsignalingstatechange = () => {
        setDiagnostics((prev) => ({
          ...prev,
          signalingState: pc.signalingState || 'unknown',
        }));
        appendDiagnosticEvent(`signalingState -> ${pc.signalingState}`);
      };

      pc.onicegatheringstatechange = () => {
        setDiagnostics((prev) => ({
          ...prev,
          iceGatheringState: pc.iceGatheringState || 'unknown',
        }));
      };

      pc.onicecandidate = (event) => {
        if (event.candidate && wsRef.current?.readyState === WebSocket.OPEN) {
          const candidateJson =
            typeof event.candidate.toJSON === 'function'
              ? event.candidate.toJSON()
              : {
                  candidate: event.candidate.candidate,
                  sdpMid: event.candidate.sdpMid,
                  sdpMLineIndex: event.candidate.sdpMLineIndex,
                  usernameFragment: event.candidate.usernameFragment,
                };

          wsRef.current.send(
            JSON.stringify({
              type: 'webrtc:ice',
              sessionId,
              data: candidateJson,
            })
          );
          setDiagnostics((prev) => ({
            ...prev,
            iceSent: prev.iceSent + 1,
          }));
        }
      };

      // Requirement 7: Attach remote tracks to remoteVideoRef.srcObject reliably
      pc.ontrack = (event) => {
        appendDiagnosticEvent(
          `ontrack received: kind=${event.track.kind}, streams=${event.streams?.length || 0}`
        );

        let targetStream = remoteStreamRef.current;
        if (event.streams && event.streams[0]) {
          targetStream = event.streams[0];
          remoteStreamRef.current = targetStream;
        } else {
          if (!targetStream) {
            targetStream = new MediaStream();
            remoteStreamRef.current = targetStream;
          }
          if (!targetStream.getTracks().some((t) => t.id === event.track.id)) {
            targetStream.addTrack(event.track);
          }
        }

        event.track.onunmute = () => {
          syncTrackDiagnostics();
          attachStreamToRemoteVideo();
        };

        event.track.onended = () => {
          syncTrackDiagnostics();
        };

        syncTrackDiagnostics();
        attachStreamToRemoteVideo();
      };

      const startIceWatchdog = () => {
        clearIceNegotiationTimer();
        iceTimeoutRef.current = window.setTimeout(() => {
          if (
            pcRef.current === pc &&
            pc.iceConnectionState !== 'connected' &&
            pc.iceConnectionState !== 'completed'
          ) {
            const noTurnMsg = iceConfig.turnConfigured
              ? 'ICE negotiation timed out waiting for peer connectivity. Click "Retry Video" to restart ICE.'
              : 'ICE connection timed out — direct UDP hole-punching was blocked by a symmetric NAT or firewall, and no TURN relay server is configured. Configure TURN_KEY_ID / TURN_API_TOKEN for relay traversal, or use live text chat below.';
            setWebrtcError(noTurnMsg);
            appendDiagnosticEvent(noTurnMsg, true);
          }
        }, 15000);
      };

      pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        setIceState(state);
        setDiagnostics((prev) => ({
          ...prev,
          iceConnectionState: state,
        }));
        appendDiagnosticEvent(`iceConnectionState -> ${state}`);

        if (state === 'checking') {
          startIceWatchdog();
        } else if (state === 'connected' || state === 'completed') {
          clearIceNegotiationTimer();
          setWebrtcError(null);
          syncTrackDiagnostics();
          attachStreamToRemoteVideo();
        } else if (state === 'failed') {
          clearIceNegotiationTimer();
          const failMsg = iceConfig.turnConfigured
            ? 'Peer-to-peer ICE negotiation failed even with TURN configured. Click "Retry Video" to attempt an ICE restart.'
            : 'ICE connection failed: Direct peer-to-peer media was blocked by a firewall/symmetric NAT and no TURN relay server is configured. Live text chat remains active.';
          setWebrtcError(failMsg);
          appendDiagnosticEvent(failMsg, true);
        } else if (state === 'disconnected') {
          setWebrtcError(
            'Peer media stream temporarily disconnected. Attempting automatic recovery...'
          );
        }
      };

      pc.onconnectionstatechange = () => {
        const cState = pc.connectionState || 'unknown';
        setDiagnostics((prev) => ({
          ...prev,
          connectionState: cState,
        }));
        appendDiagnosticEvent(`connectionState -> ${cState}`);

        if (cState === 'connected') {
          clearIceNegotiationTimer();
          setWebrtcError(null);
          syncTrackDiagnostics();
          attachStreamToRemoteVideo();
        } else if (cState === 'failed') {
          clearIceNegotiationTimer();
          const failMsg = iceConfig.turnConfigured
            ? 'WebRTC peer connection failed. Click "Retry Video" to renegotiate.'
            : 'WebRTC peer connection failed (no TURN relay available for this network path).';
          setWebrtcError(failMsg);
          appendDiagnosticEvent(failMsg, true);
        }
      };

      // 4. If Initiator: create SDP offer, apply 500 Kbps limit, setLocalDescription, and send
      if (initiator) {
        try {
          const offer = await pc.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: true,
          });
          const cappedOffer: RTCSessionDescriptionInit = {
            type: offer.type,
            sdp: enforceSdpVideoBitrateKbps(offer.sdp || '', 500),
          };
          await pc.setLocalDescription(cappedOffer);
          await applyVideoSenderBitrateLimit(pc);

          if (wsRef.current?.readyState === WebSocket.OPEN && pc.localDescription) {
            wsRef.current.send(
              JSON.stringify({
                type: 'webrtc:sdp',
                sessionId,
                data: {
                  type: pc.localDescription.type,
                  sdp: pc.localDescription.sdp,
                },
              })
            );
            setDiagnostics((prev) => ({
              ...prev,
              signalingState: pc.signalingState,
              sdpStatus: 'offer-sent',
            }));
            appendDiagnosticEvent('SDP Offer created, setLocalDescription complete, and sent to peer');
            startIceWatchdog();
          }
        } catch (err) {
          const clean = sanitizeWebRtcErrorMessage(err);
          appendDiagnosticEvent(`Offer creation failed: ${clean}`, true);
          setWebrtcError(`Failed to create WebRTC SDP offer: ${clean}`);
        }
      } else {
        // Responder notifies Initiator that its RTCPeerConnection + local tracks are ready
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(
            JSON.stringify({
              type: 'webrtc:ready',
              sessionId,
            })
          );
          appendDiagnosticEvent('Responder RTCPeerConnection ready; sent webrtc:ready signal');
        }
      }

      return pc;
    },
    [
      appendDiagnosticEvent,
      applyVideoSenderBitrateLimit,
      attachStreamToRemoteVideo,
      cleanupPeerConnection,
      ensureLocalMedia,
      fetchIceConfiguration,
      syncTrackDiagnostics,
    ]
  );

  /**
   * Processes incoming SDP Offer or Answer ONLY after RTCPeerConnection initialization completes.
   */
  const handleIncomingSdp = useCallback(
    async (sessionId: string, rawData: unknown) => {
      if (sessionIdRef.current !== sessionId) return;

      let pc = pcRef.current;
      if (!pc) {
        appendDiagnosticEvent('RTCPeerConnection was not initialized before SDP arrived; initializing now');
        pc = await initializeWebRtcForSession(sessionId, false);
      }
      if (!pc) return;

      const sdpData = rawData as { type?: RTCSdpType; sdp?: string } | null;
      if (!sdpData || !sdpData.type || !sdpData.sdp) {
        appendDiagnosticEvent('Ignored malformed incoming SDP payload', true);
        return;
      }

      try {
        if (sdpData.type === 'offer') {
          appendDiagnosticEvent('Received remote SDP Offer; applying setRemoteDescription');
          await pc.setRemoteDescription(
            new RTCSessionDescription({
              type: 'offer',
              sdp: sdpData.sdp,
            })
          );
          remoteDescriptionSetRef.current = true;
          setDiagnostics((prev) => ({
            ...prev,
            signalingState: pc!.signalingState,
            sdpStatus: 'offer-received-remote-set',
          }));

          // Requirement 3: Apply queued ICE candidates now that setRemoteDescription succeeded
          await flushPendingIceCandidates(pc);

          // Requirement 4: Create Answer, apply 500 Kbps limit, setLocalDescription, and send
          const answer = await pc.createAnswer();
          const cappedAnswer: RTCSessionDescriptionInit = {
            type: answer.type,
            sdp: enforceSdpVideoBitrateKbps(answer.sdp || '', 500),
          };
          await pc.setLocalDescription(cappedAnswer);
          await applyVideoSenderBitrateLimit(pc);

          if (wsRef.current?.readyState === WebSocket.OPEN && pc.localDescription) {
            wsRef.current.send(
              JSON.stringify({
                type: 'webrtc:sdp',
                sessionId,
                data: {
                  type: pc.localDescription.type,
                  sdp: pc.localDescription.sdp,
                },
              })
            );
            setDiagnostics((prev) => ({
              ...prev,
              signalingState: pc!.signalingState,
              sdpStatus: 'answer-sent (negotiated)',
            }));
            appendDiagnosticEvent('SDP Answer created, setLocalDescription complete, and sent to initiator');
          }
        } else if (sdpData.type === 'answer') {
          if (pc.signalingState !== 'have-local-offer') {
            appendDiagnosticEvent(
              `Skipped duplicate SDP Answer in signalingState=${pc.signalingState}`,
              false
            );
            return;
          }
          appendDiagnosticEvent('Received remote SDP Answer; applying setRemoteDescription');
          await pc.setRemoteDescription(
            new RTCSessionDescription({
              type: 'answer',
              sdp: sdpData.sdp,
            })
          );
          remoteDescriptionSetRef.current = true;
          setDiagnostics((prev) => ({
            ...prev,
            signalingState: pc!.signalingState,
            sdpStatus: 'answer-received (negotiated)',
          }));

          // Requirement 3: Flush queued ICE candidates now that setRemoteDescription succeeded
          await flushPendingIceCandidates(pc);
        }
      } catch (err) {
        const clean = sanitizeWebRtcErrorMessage(err);
        appendDiagnosticEvent(`SDP ${sdpData.type} processing error: ${clean}`, true);
        setWebrtcError(`WebRTC SDP negotiation error: ${clean}`);
      }
    },
    [
      appendDiagnosticEvent,
      applyVideoSenderBitrateLimit,
      flushPendingIceCandidates,
      initializeWebRtcForSession,
    ]
  );

  /**
   * Queues ICE candidates until setRemoteDescription succeeds, or applies them immediately if ready.
   */
  const handleIncomingIceCandidate = useCallback(
    async (sessionId: string, rawCandidate: unknown) => {
      if (sessionIdRef.current !== sessionId || !rawCandidate) return;
      const candidateInit = rawCandidate as RTCIceCandidateInit;
      if (!candidateInit.candidate) return;

      setDiagnostics((prev) => ({
        ...prev,
        iceReceived: prev.iceReceived + 1,
      }));

      const pc = pcRef.current;
      // Requirement 2 & 3: Queue candidate if RTCPeerConnection or remoteDescription is not ready yet
      if (!pc || !remoteDescriptionSetRef.current || !pc.remoteDescription) {
        pendingIceCandidatesRef.current.push(candidateInit);
        setDiagnostics((prev) => ({
          ...prev,
          iceQueued: pendingIceCandidatesRef.current.length,
        }));
        appendDiagnosticEvent(
          `Queued incoming ICE candidate (queue size: ${pendingIceCandidatesRef.current.length})`
        );
        return;
      }

      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidateInit));
        setDiagnostics((prev) => ({
          ...prev,
          iceApplied: prev.iceApplied + 1,
        }));
      } catch (err) {
        appendDiagnosticEvent(
          `addIceCandidate error: ${sanitizeWebRtcErrorMessage(err)}`,
          true
        );
      }
    },
    [appendDiagnosticEvent]
  );

  /**
   * Enqueues signaling operations sequentially so `initializeWebRtcForSession`
   * always completes before incoming `webrtc:sdp` or `webrtc:ice` handlers execute.
   */
  const enqueueSignalingTask = useCallback(
    (task: () => Promise<void>) => {
      signalingChainRef.current = signalingChainRef.current
        .then(task)
        .catch((err) => {
          appendDiagnosticEvent(
            `Signaling task error: ${sanitizeWebRtcErrorMessage(err)}`,
            true
          );
        });
    },
    [appendDiagnosticEvent]
  );

  /**
   * Triggers an ICE Restart offer if connection failed or timed out.
   */
  const handleRetryVideoNegotiation = useCallback(() => {
    const sid = sessionIdRef.current;
    const pc = pcRef.current;
    if (!sid || !pc || wsRef.current?.readyState !== WebSocket.OPEN) return;

    setWebrtcError(null);
    enqueueSignalingTask(async () => {
      try {
        appendDiagnosticEvent('Triggering WebRTC ICE Restart offer...');
        const offer = await pc.createOffer({
          iceRestart: true,
          offerToReceiveAudio: true,
          offerToReceiveVideo: true,
        });
        const cappedOffer: RTCSessionDescriptionInit = {
          type: offer.type,
          sdp: enforceSdpVideoBitrateKbps(offer.sdp || '', 500),
        };
        await pc.setLocalDescription(cappedOffer);
        wsRef.current?.send(
          JSON.stringify({
            type: 'webrtc:sdp',
            sessionId: sid,
            data: {
              type: pc.localDescription?.type,
              sdp: pc.localDescription?.sdp,
            },
          })
        );
        setDiagnostics((prev) => ({
          ...prev,
          sdpStatus: 'ice-restart-offer-sent',
        }));
      } catch (err) {
        appendDiagnosticEvent(
          `ICE restart failed: ${sanitizeWebRtcErrorMessage(err)}`,
          true
        );
      }
    });
  }, [appendDiagnosticEvent, enqueueSignalingTask]);

  useEffect(() => {
    let unmounted = false;
    setWsConnected(false);
    setWsStatus('connecting');
    setWsError(null);

    let ws: WebSocket;
    try {
      ws = new WebSocket(buildWebSocketUrl());
    } catch (err) {
      setWsStatus('error');
      setWsError(
        `Could not initialize WebSocket connection: ${sanitizeWebRtcErrorMessage(err)}`
      );
      return;
    }

    wsRef.current = ws;
    let opened = false;

    const connectTimeout = window.setTimeout(() => {
      if (!unmounted && ws.readyState !== WebSocket.OPEN) {
        setWsConnected(false);
        setWsStatus('error');
        setWsError(
          'Real-time signaling connection timed out. Please click "Reconnect Signaling" below.'
        );
        try {
          ws.close();
        } catch {
          // Ignore close error
        }
      }
    }, 8000);

    ws.onopen = () => {
      if (unmounted) return;
      opened = true;
      window.clearTimeout(connectTimeout);
      setWsConnected(true);
      setWsStatus('connected');
      setWsError(null);
      appendDiagnosticEvent('WebSocket signaling connected (/ws)');
    };

    ws.onerror = () => {
      if (unmounted) return;
      window.clearTimeout(connectTimeout);
      setWsConnected(false);
      setWsStatus('error');
      setWsError(
        'WebSocket handshake failed (/ws). Ensure your session is valid and the Matchmaker Durable Object is deployed, or click "Reconnect Signaling".'
      );
    };

    ws.onclose = (event) => {
      if (unmounted) return;
      window.clearTimeout(connectTimeout);
      setWsConnected(false);
      setStage('idle');
      cleanupPeerConnection();
      if (!opened || event.code !== 1000) {
        setWsStatus('error');
        setWsError(
          event.reason
            ? `Signaling connection closed: ${event.reason}`
            : 'Real-time signaling connection closed unexpectedly. Click "Reconnect Signaling" to resume.'
        );
      }
    };

    ws.onmessage = (event) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(event.data) as Record<string, unknown>;
      } catch (err) {
        appendDiagnosticEvent(
          `Invalid WebSocket JSON frame: ${sanitizeWebRtcErrorMessage(err)}`,
          true
        );
        return;
      }

      const type = String(msg.type || '');

      if (type === 'connection:established') {
        setWsConnected(true);
        setWsStatus('connected');
        setWsError(null);
        return;
      }

      if (type === 'queue:waiting') {
        setStage('waiting');
        setPartner(null);
        setActiveSessionId(null);
        sessionIdRef.current = null;
        setQueueSeconds(0);
        appendDiagnosticEvent(`Joined matchmaking queue (${String(msg.mode || modeRef.current)})`);
        return;
      }

      if (type === 'match:found') {
        const sid = String(msg.sessionId || '');
        const matchMode: 'video' | 'text' = msg.mode === 'text' ? 'text' : 'video';
        const initiator = Boolean(msg.initiator);
        const partnerMeta = msg.partner as MatchedPartnerMeta;

        sessionIdRef.current = sid;
        modeRef.current = matchMode;
        setMode(matchMode);
        setActiveSessionId(sid);
        setPartner(partnerMeta);
        setPartnerMedia({ cameraOn: true, micOn: true });
        setStage('matched');
        setMessages([
          {
            id: `sys_${Date.now()}`,
            sender: 'system',
            text: `Matched with ${partnerMeta.displayName}${
              partnerMeta.region ? ` (${partnerMeta.region})` : ''
            }. Say hello!`,
            timestamp: new Date().toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            }),
          },
        ]);

        appendDiagnosticEvent(
          `match:found received (sessionId=${sid}, mode=${matchMode}, initiator=${initiator})`
        );

        if (matchMode === 'video') {
          enqueueSignalingTask(async () => {
            await initializeWebRtcForSession(sid, initiator);
          });
        }
        return;
      }

      if (type === 'webrtc:ready') {
        const sid = String(msg.sessionId || sessionIdRef.current || '');
        enqueueSignalingTask(async () => {
          const pc = pcRef.current;
          // If we are the initiator and the responder just finished initializing its PC
          // while our offer hasn't been answered yet, re-send our localDescription offer
          if (
            pc &&
            isInitiatorRef.current &&
            sessionIdRef.current === sid &&
            pc.localDescription &&
            pc.localDescription.type === 'offer' &&
            !remoteDescriptionSetRef.current &&
            ws.readyState === WebSocket.OPEN
          ) {
            ws.send(
              JSON.stringify({
                type: 'webrtc:sdp',
                sessionId: sid,
                data: {
                  type: pc.localDescription.type,
                  sdp: pc.localDescription.sdp,
                },
              })
            );
            appendDiagnosticEvent('Re-sent SDP Offer upon receiving responder webrtc:ready');
          }
        });
        return;
      }

      if (type === 'webrtc:sdp') {
        const sid = String(msg.sessionId || sessionIdRef.current || '');
        enqueueSignalingTask(async () => {
          await handleIncomingSdp(sid, msg.data);
        });
        return;
      }

      if (type === 'webrtc:ice') {
        const sid = String(msg.sessionId || sessionIdRef.current || '');
        enqueueSignalingTask(async () => {
          await handleIncomingIceCandidate(sid, msg.data);
        });
        return;
      }

      if (type === 'stranger:message') {
        const dataObj = (msg.data || {}) as { text?: string };
        const text = String(dataObj.text || '');
        if (text) {
          setPartnerTyping(false);
          setMessages((prev) => [
            ...prev,
            {
              id: `str_${Date.now()}_${Math.random()}`,
              sender: 'stranger',
              text,
              timestamp: new Date().toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              }),
            },
          ]);
        }
        return;
      }

      if (type === 'stranger:typing') {
        setPartnerTyping(true);
        if (typingTimeoutRef.current) {
          window.clearTimeout(typingTimeoutRef.current);
        }
        typingTimeoutRef.current = window.setTimeout(() => {
          setPartnerTyping(false);
        }, 2000);
        return;
      }

      if (type === 'stranger:media-state' && msg.data) {
        const mediaObj = msg.data as { cameraOn?: boolean; micOn?: boolean };
        setPartnerMedia({
          cameraOn: mediaObj.cameraOn !== false,
          micOn: mediaObj.micOn !== false,
        });
        return;
      }

      if (type === 'stranger:disconnected') {
        appendDiagnosticEvent('Partner disconnected; cleaning up RTCPeerConnection');
        cleanupPeerConnection();
        setMessages((prev) => [
          ...prev,
          {
            id: `sys_disc_${Date.now()}`,
            sender: 'system',
            text: 'Stranger disconnected. Click "Start video chat" or "Next" to meet someone new.',
            timestamp: new Date().toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            }),
          },
        ]);
        setStage('idle');
        setPartner(null);
        setActiveSessionId(null);
        sessionIdRef.current = null;
      }
    };

    return () => {
      unmounted = true;
      window.clearTimeout(connectTimeout);
      cleanupPeerConnection();
      stopLocalMedia();
      ws.close(1000, 'Component unmounted');
    };
  }, [
    wsAttempt,
    appendDiagnosticEvent,
    cleanupPeerConnection,
    enqueueSignalingTask,
    handleIncomingIceCandidate,
    handleIncomingSdp,
    initializeWebRtcForSession,
    stopLocalMedia,
  ]);

  useEffect(() => {
    if (stage !== 'waiting') return;
    const interval = window.setInterval(() => {
      setQueueSeconds((s) => s + 1);
    }, 1000);
    return () => window.clearInterval(interval);
  }, [stage]);

  const handleReconnectSignaling = () => {
    setWsAttempt((prev) => prev + 1);
  };

  const handleJoinQueue = async (selectedMode: 'video' | 'text') => {
    setSafetyFeedback(null);
    setWebrtcError(null);

    if (wsRef.current?.readyState !== WebSocket.OPEN) {
      setWsStatus('error');
      setWsError(
        'Cannot join matchmaking queue because the WebSocket signaling connection is not open. Click "Reconnect Signaling" first.'
      );
      return;
    }

    modeRef.current = selectedMode;
    setMode(selectedMode);

    if (selectedMode === 'video') {
      // Pre-warm ICE config and capture local 640x360@24fps video + audio before entering queue
      await Promise.all([fetchIceConfiguration(), ensureLocalMedia()]);
    } else {
      stopLocalMedia();
    }

    wsRef.current.send(JSON.stringify({ type: 'queue:join', mode: selectedMode }));
  };

  const handleSkipPartner = () => {
    cleanupPeerConnection();
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'stranger:skip', mode: modeRef.current }));
    }
  };

  const handleEndSession = () => {
    cleanupPeerConnection();
    stopLocalMedia();
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'stranger:end' }));
    }
    setStage('idle');
    setPartner(null);
    setActiveSessionId(null);
    sessionIdRef.current = null;
  };

  const toggleCamera = () => {
    const nextState = !cameraOn;
    setCameraOn(nextState);
    if (localStreamRef.current) {
      localStreamRef.current.getVideoTracks().forEach((t) => {
        t.enabled = nextState;
      });
      syncTrackDiagnostics();
    }
    if (activeSessionId && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: 'stranger:media-state',
          sessionId: activeSessionId,
          data: { cameraOn: nextState, micOn },
        })
      );
    }
  };

  const toggleMic = () => {
    const nextState = !micOn;
    setMicOn(nextState);
    if (localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach((t) => {
        t.enabled = nextState;
      });
      syncTrackDiagnostics();
    }
    if (activeSessionId && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: 'stranger:media-state',
          sessionId: activeSessionId,
          data: { cameraOn, micOn: nextState },
        })
      );
    }
  };

  const handleUnmuteRemoteVideo = () => {
    if (remoteVideoRef.current) {
      remoteVideoRef.current.muted = false;
      remoteVideoRef.current.play().catch((err) => {
        appendDiagnosticEvent(
          `Manual unmute play() error: ${sanitizeWebRtcErrorMessage(err)}`,
          true
        );
      });
      setRemoteAudioBlocked(false);
    }
  };

  const handleSendEphemeralMessage = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = inputText.trim();
    if (!clean || !activeSessionId || wsRef.current?.readyState !== WebSocket.OPEN) return;

    wsRef.current.send(
      JSON.stringify({
        type: 'stranger:message',
        sessionId: activeSessionId,
        data: { text: clean },
      })
    );

    setMessages((prev) => [
      ...prev,
      {
        id: `me_${Date.now()}`,
        sender: 'me',
        text: clean,
        timestamp: new Date().toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        }),
      },
    ]);
    setInputText('');
  };

  const handleBlockStranger = async () => {
    if (!activeSessionId) return;
    try {
      await apiRequest('/safety/block', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: activeSessionId,
          reason: 'Blocked during random chat session',
        }),
      });
      setSafetyFeedback('User blocked and disconnected immediately.');
      handleEndSession();
    } catch (err) {
      setSafetyFeedback((err as Error).message);
    }
  };

  const handleSubmitReport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeSessionId) return;
    try {
      await apiRequest('/safety/report', {
        method: 'POST',
        body: JSON.stringify({
          contextSessionId: activeSessionId,
          contextType: mode === 'video' ? 'random_video' : 'random_text',
          reason: reportReason,
          details: reportDetails,
        }),
      });
      setReportModalOpen(false);
      setReportDetails('');
      setSafetyFeedback('Safety report submitted to Trust & Safety moderators.');
      handleEndSession();
    } catch (err) {
      setSafetyFeedback((err as Error).message);
    }
  };

  if (!hasActiveMembership) {
    return (
      <div className="p-10 rounded-[26px] bg-[#17221c] text-white max-w-2xl mx-auto text-center space-y-5 shadow-xl">
        <Lock className="w-8 h-8 text-[#c5fa5a] mx-auto" />
        <h2 className="font-outfit font-extrabold text-3xl">
          Activate your Rs. 500 Membership to enter the Live Studio
        </h2>
        <p className="text-sm text-[#b4c0b7] max-w-md mx-auto leading-relaxed">
          One simple membership gives you 30 days of unlimited random video chat, random text chat,
          and private messaging.
        </p>
        <button
          type="button"
          onClick={onNavigateMembership}
          className="px-7 py-4 bg-[#c5fa5a] hover:bg-[#d2ff75] text-[#14201b] font-black text-sm rounded-[15px]"
        >
          Get membership — Rs. 500 ↗
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <p className="text-xs font-black text-[#557d27] uppercase tracking-wider">
            LIVE WEBRTC & DURABLE OBJECT QUEUE · 640×360 @ 24FPS (≤500 KBPS)
          </p>
          <h1 className="font-outfit font-extrabold text-3xl md:text-4xl text-[#14201b] mt-1">
            Random Video & Text Chat
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setShowDiagnostics((v) => !v)}
            className="flex items-center gap-1.5 text-[11px] font-bold text-[#14201b] bg-[#f5f6f2] hover:bg-[#e9ede4] px-3 py-1.5 rounded-full border border-[#d6dfd3]"
          >
            <Activity className="w-3.5 h-3.5 text-[#557d27]" />
            <span>{showDiagnostics ? 'Hide Diagnostics' : 'WebRTC Diagnostics'}</span>
          </button>

          <div className="flex items-center gap-1.5 text-[11px] font-bold text-[#557d27] bg-[#f5f6f2] px-3 py-1.5 rounded-full border border-[#d6dfd3]">
            <span>
              {diagnostics.turnConfigured ? '📡 STUN + TURN Relay' : '📡 Free STUN Mode'}
            </span>
            {!diagnostics.turnConfigured && (
              <span className="text-[#849187]">(TURN optional)</span>
            )}
          </div>

          <div
            className={`flex items-center gap-2 text-xs font-bold px-4 py-2 rounded-full border ${
              wsStatus === 'connected'
                ? 'bg-white text-[#14201b] border-[#e7ebe5]'
                : wsStatus === 'error'
                ? 'bg-red-50 text-red-900 border-red-200'
                : 'bg-white text-[#14201b] border-[#e7ebe5]'
            }`}
          >
            <Radio
              className={`w-3.5 h-3.5 ${
                wsStatus === 'connected'
                  ? 'text-[#557d27]'
                  : wsStatus === 'error'
                  ? 'text-red-600'
                  : 'text-amber-600'
              }`}
            />
            <span>
              {wsStatus === 'connected'
                ? 'Signaling Ready'
                : wsStatus === 'error'
                ? 'Signaling Disconnected'
                : 'Connecting...'}
            </span>
            {wsStatus === 'error' && (
              <button
                type="button"
                onClick={handleReconnectSignaling}
                className="ml-1 px-2.5 py-0.5 rounded-full bg-red-600 text-white text-[11px] font-extrabold hover:bg-red-700"
              >
                Reconnect
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Requirement 8: Visible Diagnostics Panel for signalingState, iceConnectionState, connectionState, tracks, SDP/ICE */}
      {showDiagnostics && (
        <div
          data-testid="webrtc-diagnostics-panel"
          className="p-4 rounded-2xl bg-[#14201b] text-[#e7ebe5] border border-[#28382f] text-xs space-y-3 shadow-md"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-2.5">
            <div className="flex items-center gap-2 font-extrabold text-[#c5fa5a]">
              <Activity className="w-4 h-4" />
              <span>LIVE WEBRTC TELEMETRY & SIGNALING DIAGNOSTICS</span>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <span className="px-2.5 py-0.5 rounded-full bg-white/10 font-bold">
                Role: <strong className="text-[#c5fa5a]">{diagnostics.role}</strong>
              </span>
              <span className="px-2.5 py-0.5 rounded-full bg-white/10 font-bold">
                Profile: <strong className="text-white">640×360 @ 24fps · ≤500 Kbps</strong>
              </span>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
            <div className="p-2.5 rounded-xl bg-white/5 border border-white/10">
              <p className="text-[10px] uppercase tracking-wider text-[#96a49a]">signalingState</p>
              <p className="font-mono font-bold text-white mt-0.5">{diagnostics.signalingState}</p>
            </div>
            <div className="p-2.5 rounded-xl bg-white/5 border border-white/10">
              <p className="text-[10px] uppercase tracking-wider text-[#96a49a]">
                iceConnectionState
              </p>
              <p
                className={`font-mono font-bold mt-0.5 ${
                  diagnostics.iceConnectionState === 'connected' ||
                  diagnostics.iceConnectionState === 'completed'
                    ? 'text-[#c5fa5a]'
                    : diagnostics.iceConnectionState === 'failed'
                    ? 'text-red-400'
                    : 'text-amber-300'
                }`}
              >
                {diagnostics.iceConnectionState}
              </p>
            </div>
            <div className="p-2.5 rounded-xl bg-white/5 border border-white/10">
              <p className="text-[10px] uppercase tracking-wider text-[#96a49a]">connectionState</p>
              <p
                className={`font-mono font-bold mt-0.5 ${
                  diagnostics.connectionState === 'connected'
                    ? 'text-[#c5fa5a]'
                    : diagnostics.connectionState === 'failed'
                    ? 'text-red-400'
                    : 'text-white'
                }`}
              >
                {diagnostics.connectionState}
              </p>
            </div>
            <div className="p-2.5 rounded-xl bg-white/5 border border-white/10">
              <p className="text-[10px] uppercase tracking-wider text-[#96a49a]">SDP Exchange</p>
              <p className="font-mono font-bold text-[#c5fa5a] mt-0.5 truncate">
                {diagnostics.sdpStatus}
              </p>
            </div>
            <div className="p-2.5 rounded-xl bg-white/5 border border-white/10">
              <p className="text-[10px] uppercase tracking-wider text-[#96a49a]">
                ICE (Sent/Recv/Q/App)
              </p>
              <p className="font-mono font-bold text-white mt-0.5">
                {diagnostics.iceSent} / {diagnostics.iceReceived} / {diagnostics.iceQueued} /{' '}
                {diagnostics.iceApplied}
              </p>
            </div>
            <div className="p-2.5 rounded-xl bg-white/5 border border-white/10">
              <p className="text-[10px] uppercase tracking-wider text-[#96a49a]">Tracks (L / R)</p>
              <p className="font-mono font-bold text-white mt-0.5 truncate" title={`Local: ${diagnostics.localTracksSummary} | Remote: ${diagnostics.remoteTracksSummary}`}>
                L: {diagnostics.localTracksSummary !== 'none' ? 'Ready' : 'None'} · R:{' '}
                {diagnostics.remoteTracksSummary !== 'none' ? 'Active' : 'Waiting'}
              </p>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-[11px] text-[#b4c0b7] pt-1">
            <div>
              <span className="font-bold text-white">Local Tracks:</span>{' '}
              <span className="font-mono">{diagnostics.localTracksSummary}</span>
              <span className="mx-2 text-white/30">|</span>
              <span className="font-bold text-white">Remote Tracks:</span>{' '}
              <span className="font-mono">{diagnostics.remoteTracksSummary}</span>
            </div>
            {diagnostics.events.length > 0 && (
              <div className="font-mono text-[10px] text-[#c5fa5a] truncate max-w-md">
                Latest: {diagnostics.events[diagnostics.events.length - 1]}
              </div>
            )}
          </div>
        </div>
      )}

      {wsError && (
        <div className="p-4 rounded-2xl bg-red-950 text-red-100 border border-red-500/40 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <ShieldAlert className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <div>
              <p className="font-extrabold text-red-200">WebSocket Signaling Connection Error</p>
              <p className="text-red-200/90 mt-0.5">{wsError}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleReconnectSignaling}
            className="px-4 py-2 rounded-xl bg-[#c5fa5a] text-[#14201b] font-black text-xs shrink-0 hover:bg-[#d2ff75]"
          >
            Reconnect Signaling ↗
          </button>
        </div>
      )}

      {safetyFeedback && (
        <div className="p-3.5 rounded-2xl bg-[#dff4b3] text-[#14201b] text-xs font-extrabold">
          {safetyFeedback}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 rounded-[26px] overflow-hidden bg-[#101417] text-white shadow-xl border border-[#222d26]">
        {/* Left 7 Cols: Video / Queue Stage */}
        <div className="lg:col-span-7 relative min-h-[450px] flex flex-col justify-between border-b lg:border-b-0 lg:border-r border-white/10">
          {stage === 'idle' && (
            <div className="m-auto p-8 text-center max-w-md space-y-6">
              <span className="brand-leaf mx-auto">✦</span>
              <h2 className="font-outfit font-extrabold text-3xl text-white">
                Start a spontaneous conversation.
              </h2>
              <p className="text-sm text-[#bac3be] leading-relaxed">
                Get paired atomically with another adult in Sri Lanka. Video streams at 640×360 @
                24 FPS (capped at 500 Kbps) for smooth, low-latency connections.
              </p>

              <div className="flex flex-wrap items-center justify-center gap-3">
                <button
                  type="button"
                  disabled={!wsConnected}
                  onClick={() => handleJoinQueue('video')}
                  className="px-6 py-4 bg-[#c5fa5a] hover:bg-[#d2ff75] disabled:opacity-50 text-[#132014] font-black text-sm rounded-[15px]"
                >
                  ◉ &nbsp; Start video chat ↗
                </button>
                <button
                  type="button"
                  disabled={!wsConnected}
                  onClick={() => handleJoinQueue('text')}
                  className="px-6 py-4 bg-white/10 hover:bg-white/15 disabled:opacity-50 border border-white/30 text-white font-extrabold text-sm rounded-[15px]"
                >
                  ▤ &nbsp; Start text chat
                </button>
              </div>
            </div>
          )}

          {stage === 'waiting' && (
            <div className="m-auto p-8 text-center max-w-md space-y-4">
              <p className="font-outfit font-extrabold text-3xl text-[#c5fa5a]">
                Finding someone new ({mode})...
              </p>
              <p className="text-xs text-[#bac3be] tabular-nums">
                Waiting in queue: {queueSeconds}s
              </p>

              {mode === 'video' && (
                <div className="w-48 h-28 mx-auto rounded-2xl overflow-hidden border border-white/20 bg-[#17221c] flex items-center justify-center">
                  {mediaPermissionState === 'granted' && cameraOn ? (
                    <video
                      ref={setLocalVideoElement}
                      autoPlay
                      muted
                      playsInline
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <span className="text-[11px] font-bold text-[#bac3be] px-2">
                      {mediaPermissionState === 'unavailable'
                        ? 'Camera permission needed'
                        : 'Camera preview'}
                    </span>
                  )}
                </div>
              )}

              {queueSeconds >= 6 && (
                <p className="text-xs text-[#dff4b3] bg-white/10 p-3 rounded-xl">
                  Tip: Open a second browser window logged into another account to test live
                  peer-to-peer WebRTC video & audio immediately.
                </p>
              )}
              <button
                type="button"
                onClick={handleEndSession}
                className="px-5 py-2.5 rounded-full border border-white/25 text-xs font-bold text-white hover:bg-white/10"
              >
                Leave Queue
              </button>
            </div>
          )}

          {stage === 'matched' && (
            <>
              {mode === 'video' ? (
                <div className="relative flex-1 bg-black flex items-center justify-center min-h-[380px]">
                  <video
                    ref={setRemoteVideoElement}
                    autoPlay
                    playsInline
                    className="w-full h-full object-cover"
                  />

                  {!diagnostics.remoteVideoReady && !webrtcError && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#101417]/80 pointer-events-none p-6 text-center space-y-2">
                      <p className="text-sm font-extrabold text-[#c5fa5a]">
                        Connecting video stream with {partner?.displayName}...
                      </p>
                      <p className="text-xs text-[#bac3be] font-mono">
                        SDP: {diagnostics.sdpStatus} · ICE: {diagnostics.iceConnectionState}
                      </p>
                    </div>
                  )}

                  {remoteAudioBlocked && (
                    <button
                      type="button"
                      onClick={handleUnmuteRemoteVideo}
                      className="absolute bottom-20 left-4 z-30 px-4 py-2.5 rounded-xl bg-[#c5fa5a] text-[#14201b] font-black text-xs shadow-lg inline-flex items-center gap-2 hover:bg-[#d2ff75]"
                    >
                      <Volume2 className="w-4 h-4" />
                      <span>Tap to Unmute Partner Audio</span>
                    </button>
                  )}

                  {/* Requirement 12: Clear error state when ICE fails or no relay is available */}
                  {webrtcError && (
                    <div className="absolute inset-x-4 top-16 z-20 p-4 rounded-2xl bg-amber-950/95 border border-amber-500/40 text-amber-100 text-xs shadow-2xl backdrop-blur-md space-y-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 font-black text-amber-300">
                          <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0" />
                          <span>WebRTC Media Connection Error</span>
                        </div>
                        <button
                          type="button"
                          onClick={handleRetryVideoNegotiation}
                          className="px-3 py-1.5 rounded-lg bg-[#c5fa5a] text-[#14201b] font-black text-[11px] inline-flex items-center gap-1 hover:bg-[#d2ff75]"
                        >
                          <RefreshCw className="w-3 h-3" />
                          <span>Retry Video</span>
                        </button>
                      </div>
                      <p className="leading-relaxed">{webrtcError}</p>
                    </div>
                  )}

                  <div className="absolute top-4 left-4 bg-[#101417]/85 px-4 py-2 rounded-full border border-white/15 text-xs font-bold flex flex-wrap items-center gap-2 z-10">
                    <span className="text-[#c5fa5a]">●</span>
                    <span>{partner?.displayName}</span>
                    {partner?.region && <span> · {partner.region}</span>}
                    {!partnerMedia.cameraOn && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-500/20 text-red-200">
                        Partner Camera Off
                      </span>
                    )}
                    {!partnerMedia.micOn && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-500/20 text-red-200">
                        Partner Muted
                      </span>
                    )}
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/10 text-[#c5fa5a]">
                      {iceState === 'connected' || iceState === 'completed'
                        ? 'P2P Live (640×360)'
                        : iceState === 'failed'
                        ? 'ICE Failed'
                        : `ICE: ${iceState}`}
                    </span>
                  </div>

                  <div className="absolute bottom-4 right-4 w-40 h-24 rounded-2xl overflow-hidden border-2 border-white/25 bg-[#17221c] flex items-center justify-center z-10 shadow-lg">
                    {mediaPermissionState === 'granted' && cameraOn ? (
                      <video
                        ref={setLocalVideoElement}
                        autoPlay
                        muted
                        playsInline
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <span className="text-[11px] font-bold text-[#bac3be] px-2 text-center">
                        {mediaPermissionState === 'unavailable'
                          ? 'No camera detected'
                          : 'Camera Off'}
                      </span>
                    )}
                  </div>
                </div>
              ) : (
                <div className="m-auto p-8 text-center space-y-2">
                  <span className="brand-leaf mx-auto mb-2">✦</span>
                  <p className="font-outfit font-extrabold text-3xl text-white">
                    Connected with {partner?.displayName}
                  </p>
                  <p className="text-xs text-[#bac3be]">
                    {partner?.region || 'Sri Lanka'} · Text Conversation
                  </p>
                </div>
              )}
            </>
          )}

          {stage !== 'idle' && (
            <div className="p-4 border-t border-white/10 bg-[#17221c] flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                {mode === 'video' && (
                  <>
                    <button
                      type="button"
                      onClick={toggleCamera}
                      className="px-3.5 py-2 rounded-xl bg-white/10 text-xs font-bold inline-flex items-center gap-1.5"
                    >
                      {cameraOn ? (
                        <Video className="w-3.5 h-3.5 text-[#c5fa5a]" />
                      ) : (
                        <VideoOff className="w-3.5 h-3.5 text-red-300" />
                      )}
                      <span>{cameraOn ? 'Camera' : 'Off'}</span>
                    </button>
                    <button
                      type="button"
                      onClick={toggleMic}
                      className="px-3.5 py-2 rounded-xl bg-white/10 text-xs font-bold inline-flex items-center gap-1.5"
                    >
                      {micOn ? (
                        <Mic className="w-3.5 h-3.5 text-[#c5fa5a]" />
                      ) : (
                        <MicOff className="w-3.5 h-3.5 text-red-300" />
                      )}
                      <span>{micOn ? 'Mic' : 'Muted'}</span>
                    </button>
                  </>
                )}
              </div>

              <div className="flex items-center gap-2">
                {stage === 'matched' && (
                  <>
                    <button
                      type="button"
                      onClick={() => setReportModalOpen(true)}
                      className="px-3 py-2 rounded-xl bg-white/10 text-xs font-bold inline-flex items-center gap-1"
                    >
                      <ShieldAlert className="w-3.5 h-3.5 text-[#c5fa5a]" />
                      <span>Report</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleBlockStranger}
                      className="px-3 py-2 rounded-xl bg-white/10 text-xs font-bold inline-flex items-center gap-1"
                    >
                      <Ban className="w-3.5 h-3.5 text-red-300" />
                      <span>Block</span>
                    </button>
                  </>
                )}

                <button
                  type="button"
                  onClick={handleSkipPartner}
                  className="px-4 py-2 rounded-xl bg-[#c5fa5a] text-[#14201b] font-black text-xs inline-flex items-center gap-1.5"
                >
                  <SkipForward className="w-3.5 h-3.5" />
                  <span>Next ↗</span>
                </button>

                <button
                  type="button"
                  onClick={handleEndSession}
                  className="px-3.5 py-2 rounded-xl bg-red-500/20 text-red-200 text-xs font-bold inline-flex items-center gap-1"
                >
                  <PhoneOff className="w-3.5 h-3.5" />
                  <span>Leave</span>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Right 5 Cols: Ephemeral Chat */}
        <div className="lg:col-span-5 flex flex-col justify-between h-[450px] bg-[#141c18]">
          <div className="p-4 border-b border-white/10">
            <p className="text-sm font-bold text-white">
              {partner ? `Chatting with ${partner.displayName}` : 'Stranger Chat'}
            </p>
            <p className="text-[11px] text-[#96a49a]">
              Messages disappear as soon as you skip or leave
            </p>
          </div>

          <div className="flex-1 p-4 overflow-y-auto space-y-3">
            {messages.length === 0 ? (
              <p className="text-xs text-[#96a49a] text-center pt-28">
                Start video or text chat to say hello.
              </p>
            ) : (
              messages.map((m) => (
                <div
                  key={m.id}
                  className={`flex flex-col ${
                    m.sender === 'me'
                      ? 'items-end'
                      : m.sender === 'system'
                      ? 'items-center'
                      : 'items-start'
                  }`}
                >
                  <div
                    className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-xs ${
                      m.sender === 'me'
                        ? 'bg-[#c5fa5a] text-[#14201b] font-bold'
                        : m.sender === 'system'
                        ? 'bg-white/10 text-[#c5fa5a] font-bold text-center'
                        : 'bg-white/10 text-white'
                    }`}
                  >
                    {m.text}
                  </div>
                  <span className="text-[10px] text-[#96a49a] mt-1 tabular-nums">
                    {m.timestamp}
                  </span>
                </div>
              ))
            )}
            {partnerTyping && (
              <p className="text-[11px] italic text-[#c5fa5a]">
                {partner?.displayName || 'Stranger'} is typing...
              </p>
            )}
          </div>

          <form
            onSubmit={handleSendEphemeralMessage}
            className="p-3.5 border-t border-white/10 flex items-center gap-2"
          >
            <input
              type="text"
              disabled={stage !== 'matched'}
              value={inputText}
              onChange={(e) => {
                setInputText(e.target.value);
                if (activeSessionId && wsRef.current?.readyState === WebSocket.OPEN) {
                  wsRef.current.send(
                    JSON.stringify({ type: 'stranger:typing', sessionId: activeSessionId })
                  );
                }
              }}
              placeholder={stage === 'matched' ? 'Say something...' : 'Waiting for match...'}
              className="flex-1 bg-white/10 border border-white/15 rounded-xl px-3.5 py-2.5 text-xs text-white disabled:opacity-40"
            />
            <button
              type="submit"
              disabled={stage !== 'matched'}
              className="px-4 py-2.5 bg-[#c5fa5a] text-[#14201b] font-black text-xs rounded-xl disabled:opacity-40 inline-flex items-center gap-1"
            >
              <Send className="w-3.5 h-3.5" />
              <span>Send</span>
            </button>
          </form>
        </div>
      </div>

      {reportModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4">
          <div className="bg-white text-[#14201b] max-w-md w-full p-7 rounded-[24px] space-y-4">
            <h3 className="font-outfit font-extrabold text-2xl">Report conversation</h3>
            <form onSubmit={handleSubmitReport} className="space-y-4">
              <select
                value={reportReason}
                onChange={(e) => setReportReason(e.target.value)}
                className="w-full p-3 border border-[#d7ded5] rounded-xl text-xs font-bold"
              >
                <option value="harassment_or_abuse">Harassment or abusive conduct</option>
                <option value="nudity_or_explicit_content">Explicit content</option>
                <option value="underage_concern">Suspected underage user</option>
                <option value="spam_or_scam">Spam or scam</option>
              </select>
              <textarea
                rows={3}
                value={reportDetails}
                onChange={(e) => setReportDetails(e.target.value)}
                placeholder="Additional details..."
                className="w-full p-3 border border-[#d7ded5] rounded-xl text-xs"
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setReportModalOpen(false)}
                  className="px-4 py-2 text-xs font-bold text-[#6d7a72]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2.5 bg-[#c5fa5a] text-[#14201b] text-xs font-black rounded-xl"
                >
                  Submit Report
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
