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
  RefreshCw,
  Volume2,
} from 'lucide-react';
import type { AuthenticatedUser } from '../types';
import { apiRequest, buildWebSocketUrl, getStoredToken } from '../api';

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

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
];

const TARGET_VIDEO_WIDTH = 640;
const TARGET_VIDEO_HEIGHT = 360;
const TARGET_VIDEO_FPS = 24;
const MAX_VIDEO_BITRATE_BPS = 500_000; // 500 Kbps
const HEARTBEAT_INTERVAL_MS = 20_000; // 20s safe heartbeat for Cloudflare Durable Objects
const MAX_RECONNECT_ATTEMPTS = 6;

const VALID_SERVER_MESSAGE_TYPES = new Set([
  'connection:established',
  'pong',
  'queue:waiting',
  'queue:left',
  'match:found',
  'webrtc:sdp',
  'webrtc:ice',
  'webrtc:ready',
  'stranger:message',
  'stranger:typing',
  'stranger:media-state',
  'stranger:disconnected',
  'stranger:ended',
  'error:invalid-payload',
]);

/**
 * Sanitizes error and lifecycle logs so session tokens or private SDP keys/fingerprints
 * are never exposed in logs or UI messages.
 */
function sanitizeWebRtcLog(raw: unknown): string {
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
 * alongside RTCRtpSender.setParameters(maxBitrate = 500_000).
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

export const RandomChatStudio: React.FC<RandomChatStudioProps> = ({
  user,
  onNavigateMembership,
}) => {
  const [mode, setMode] = useState<'video' | 'text'>('video');
  const [wsConnected, setWsConnected] = useState(false);
  const [wsStatus, setWsStatus] = useState<
    'connecting' | 'connected' | 'reconnecting' | 'error'
  >('connecting');
  const [wsError, setWsError] = useState<string | null>(null);
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
  const [remoteVideoReady, setRemoteVideoReady] = useState<boolean>(false);
  const [remoteAudioBlocked, setRemoteAudioBlocked] = useState<boolean>(false);

  // Refs prevent React re-renders (like camera/mic toggle) from ever closing the active WebSocket!
  const wsRef = useRef<WebSocket | null>(null);
  const connectionIdRef = useRef<string | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const isInitiatorRef = useRef<boolean>(false);
  const modeRef = useRef<'video' | 'text'>('video');
  const cameraOnRef = useRef<boolean>(true);
  const micOnRef = useRef<boolean>(true);
  const desiredStageRef = useRef<'idle' | 'waiting' | 'matched'>('idle');
  const unmountedRef = useRef<boolean>(false);
  const intentionalCloseRef = useRef<boolean>(false);
  const permanentAuthFailureRef = useRef<boolean>(false);
  const reconnectAttemptsRef = useRef<number>(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const heartbeatIntervalRef = useRef<number | null>(null);
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

  const logLifecycle = useCallback(
    (level: 'info' | 'warn' | 'error', event: string, details?: Record<string, unknown>) => {
      const safeDetails = details
        ? JSON.parse(sanitizeWebRtcLog(JSON.stringify(details)))
        : {};
      const payload = {
        component: 'RandomChatStudio',
        event,
        connectionId: connectionIdRef.current,
        sessionId: sessionIdRef.current,
        timestamp: new Date().toISOString(),
        ...safeDetails,
      };
      if (level === 'error') {
        console.error('[OUAT Signaling]', payload);
      } else if (level === 'warn') {
        console.warn('[OUAT Signaling]', payload);
      } else {
        console.info('[OUAT Signaling]', payload);
      }
    },
    []
  );

  /**
   * Requirement 11: Ensures every WebSocket/WebRTC signaling message is sent ONLY when WebSocket is OPEN.
   */
  const sendWsMessage = useCallback(
    (payload: Record<string, unknown>): boolean => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        logLifecycle('warn', 'ws_send_skipped_not_open', {
          type: String(payload.type || 'unknown'),
          readyState: ws ? ws.readyState : -1,
        });
        return false;
      }
      try {
        ws.send(JSON.stringify(payload));
        return true;
      } catch (err) {
        logLifecycle('error', 'ws_send_exception', {
          type: String(payload.type || 'unknown'),
          error: sanitizeWebRtcLog(err),
        });
        return false;
      }
    },
    [logLifecycle]
  );

  const attachStreamToRemoteVideo = useCallback(() => {
    const videoEl = remoteVideoRef.current;
    const stream = remoteStreamRef.current;
    if (!videoEl || !stream) return;

    if (videoEl.srcObject !== stream) {
      videoEl.srcObject = stream;
    }
    videoEl.autoplay = true;
    videoEl.playsInline = true;

    const hasLiveVideo = stream
      .getVideoTracks()
      .some((t) => t.readyState === 'live');
    if (hasLiveVideo) {
      setRemoteVideoReady(true);
    }

    const playPromise = videoEl.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise
        .then(() => {
          setRemoteAudioBlocked(false);
          setRemoteVideoReady(true);
        })
        .catch((err: Error) => {
          if (err.name === 'NotAllowedError') {
            videoEl.muted = true;
            setRemoteAudioBlocked(true);
            videoEl.play().catch((innerErr) => {
              logLifecycle('error', 'remote_video_muted_play_blocked', {
                error: sanitizeWebRtcLog(innerErr),
              });
            });
          } else if (err.name !== 'AbortError') {
            logLifecycle('warn', 'remote_video_play_notice', {
              error: sanitizeWebRtcLog(err),
            });
          }
        });
    }
  }, [logLifecycle]);

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
      // Local preview is muted
    });
  }, []);

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
    setRemoteVideoReady(false);
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
        logLifecycle('warn', 'pc_close_warning', { error: sanitizeWebRtcLog(err) });
      }
      pcRef.current = null;
    }

    remoteStreamRef.current = null;
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
  }, [logLifecycle]);

  const stopLocalMedia = useCallback(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }
  }, []);

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
        return localStreamRef.current;
      }
      localStreamRef.current = null;
    }

    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      const msg =
        'Camera/microphone capture (navigator.mediaDevices.getUserMedia) is unavailable in this browser context. Ensure you are using HTTPS.';
      setMediaPermissionState('unavailable');
      logLifecycle('error', 'getusermedia_unavailable', { message: msg });
      setWebrtcError(msg);
      return null;
    }

    try {
      let stream: MediaStream;
      try {
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
        logLifecycle('warn', 'getusermedia_constraint_fallback', {
          error: sanitizeWebRtcLog(constraintErr),
        });
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

      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack && typeof videoTrack.applyConstraints === 'function') {
        await videoTrack
          .applyConstraints({
            width: { ideal: TARGET_VIDEO_WIDTH, max: TARGET_VIDEO_WIDTH },
            height: { ideal: TARGET_VIDEO_HEIGHT, max: TARGET_VIDEO_HEIGHT },
            frameRate: { ideal: TARGET_VIDEO_FPS, max: TARGET_VIDEO_FPS },
          })
          .catch(() => {
            // Keep stream if camera driver locks resolution
          });
      }

      stream.getVideoTracks().forEach((t) => {
        t.enabled = cameraOnRef.current;
      });
      stream.getAudioTracks().forEach((t) => {
        t.enabled = micOnRef.current;
      });

      localStreamRef.current = stream;
      setMediaPermissionState('granted');
      attachStreamToLocalVideo();
      logLifecycle('info', 'local_media_captured', {
        videoTracks: stream.getVideoTracks().length,
        audioTracks: stream.getAudioTracks().length,
        profile: '640x360@24fps',
      });
      return stream;
    } catch (err) {
      setMediaPermissionState('unavailable');
      const cleanErr = sanitizeWebRtcLog(err);
      logLifecycle('error', 'getusermedia_failed', { error: cleanErr });
      setWebrtcError(
        `Could not access your camera or microphone (${cleanErr}). Please grant camera & microphone permissions in your browser and retry.`
      );
      return null;
    }
  }, [attachStreamToLocalVideo, logLifecycle]);

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
        return config;
      }
    } catch (err) {
      logLifecycle('warn', 'ice_config_fallback_stun', {
        error: sanitizeWebRtcLog(err),
      });
    }
    return {
      iceServers: DEFAULT_ICE_SERVERS,
      turnConfigured: false,
    };
  }, [logLifecycle]);

  /**
   * Caps outgoing video RTCRtpSender bitrate to 500 Kbps and framerate to 24 FPS.
   */
  const applyVideoSenderBitrateLimit = useCallback(
    async (pc: RTCPeerConnection) => {
      const senders = pc.getSenders ? pc.getSenders() : [];
      for (const sender of senders) {
        if (
          sender.track &&
          sender.track.kind === 'video' &&
          typeof sender.getParameters === 'function'
        ) {
          try {
            const params = sender.getParameters() || ({} as RTCRtpSendParameters);
            if (!params.encodings || params.encodings.length === 0) {
              params.encodings = [{}];
            }
            params.encodings[0].maxBitrate = MAX_VIDEO_BITRATE_BPS; // 500 Kbps
            params.encodings[0].maxFramerate = TARGET_VIDEO_FPS; // 24 FPS
            await sender.setParameters(params);
          } catch (err) {
            logLifecycle('warn', 'sender_set_parameters_notice', {
              error: sanitizeWebRtcLog(err),
            });
          }
        }
      }
    },
    [logLifecycle]
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

      logLifecycle('info', 'flushing_queued_ice_candidates', { count: pending.length });
      for (const candidateInit of pending) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidateInit));
        } catch (err) {
          logLifecycle('error', 'queued_ice_candidate_error', {
            error: sanitizeWebRtcLog(err),
          });
        }
      }
    },
    [logLifecycle]
  );

  /**
   * Initializes RTCPeerConnection, attaches local video+audio tracks BEFORE SDP negotiation,
   * sets up remote stream attachment, and sends the SDP offer if initiator === true.
   */
  const initializeWebRtcForSession = useCallback(
    async (sessionId: string, initiator: boolean): Promise<RTCPeerConnection | null> => {
      cleanupPeerConnection();
      isInitiatorRef.current = initiator;

      logLifecycle('info', 'webrtc_session_init_start', {
        sessionId,
        initiator,
      });

      const [iceConfig, localStream] = await Promise.all([
        fetchIceConfiguration(),
        ensureLocalMedia(),
      ]);

      if (sessionIdRef.current !== sessionId) {
        return null;
      }

      const pc = new RTCPeerConnection({
        iceServers: iceConfig.iceServers,
        iceCandidatePoolSize: 4,
      });
      pcRef.current = pc;

      const remoteStream = new MediaStream();
      remoteStreamRef.current = remoteStream;

      // Add both local video and audio tracks BEFORE SDP offer/answer creation
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
        pc.addTransceiver('video', { direction: 'recvonly' });
        pc.addTransceiver('audio', { direction: 'recvonly' });
      }

      await applyVideoSenderBitrateLimit(pc);

      pc.onsignalingstatechange = () => {
        logLifecycle('info', 'webrtc_signaling_state_change', {
          signalingState: pc.signalingState,
        });
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          const candidateJson =
            typeof event.candidate.toJSON === 'function'
              ? event.candidate.toJSON()
              : {
                  candidate: event.candidate.candidate,
                  sdpMid: event.candidate.sdpMid,
                  sdpMLineIndex: event.candidate.sdpMLineIndex,
                  usernameFragment: event.candidate.usernameFragment,
                };

          sendWsMessage({
            type: 'webrtc:ice',
            sessionId,
            data: candidateJson,
          });
        }
      };

      pc.ontrack = (event) => {
        logLifecycle('info', 'webrtc_ontrack_received', {
          kind: event.track.kind,
          streamsCount: event.streams?.length || 0,
        });

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
          setRemoteVideoReady(true);
          attachStreamToRemoteVideo();
        };

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
              : 'ICE connection timed out — direct UDP hole-punching was blocked by a symmetric NAT or firewall, and no TURN relay server is configured. Live text chat below remains active.';
            setWebrtcError(noTurnMsg);
            logLifecycle('error', 'webrtc_ice_timeout', {
              turnConfigured: iceConfig.turnConfigured,
              iceConnectionState: pc.iceConnectionState,
            });
          }
        }, 15000);
      };

      pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        setIceState(state);
        logLifecycle('info', 'webrtc_ice_connection_state_change', {
          iceConnectionState: state,
        });

        if (state === 'checking') {
          startIceWatchdog();
        } else if (state === 'connected' || state === 'completed') {
          clearIceNegotiationTimer();
          setWebrtcError(null);
          attachStreamToRemoteVideo();
        } else if (state === 'failed') {
          clearIceNegotiationTimer();
          const failMsg = iceConfig.turnConfigured
            ? 'Peer-to-peer ICE negotiation failed even with TURN configured. Click "Retry Video" to attempt an ICE restart.'
            : 'ICE connection failed: Direct peer-to-peer media was blocked by a firewall/symmetric NAT and no TURN relay server is configured. Live text chat remains active.';
          setWebrtcError(failMsg);
          logLifecycle('error', 'webrtc_ice_failed', {
            turnConfigured: iceConfig.turnConfigured,
          });
        } else if (state === 'disconnected') {
          setWebrtcError(
            'Peer media stream temporarily disconnected. Attempting automatic recovery...'
          );
        }
      };

      pc.onconnectionstatechange = () => {
        const cState = pc.connectionState || 'unknown';
        logLifecycle('info', 'webrtc_connection_state_change', {
          connectionState: cState,
        });

        if (cState === 'connected') {
          clearIceNegotiationTimer();
          setWebrtcError(null);
          attachStreamToRemoteVideo();
        } else if (cState === 'failed') {
          clearIceNegotiationTimer();
          const failMsg = iceConfig.turnConfigured
            ? 'WebRTC peer connection failed. Click "Retry Video" to renegotiate.'
            : 'WebRTC peer connection failed (no TURN relay available for this network path).';
          setWebrtcError(failMsg);
          logLifecycle('error', 'webrtc_connection_failed', {
            turnConfigured: iceConfig.turnConfigured,
          });
        }
      };

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

          if (pc.localDescription) {
            sendWsMessage({
              type: 'webrtc:sdp',
              sessionId,
              data: {
                type: pc.localDescription.type,
                sdp: pc.localDescription.sdp,
              },
            });
            logLifecycle('info', 'webrtc_offer_sent', { sessionId });
            startIceWatchdog();
          }
        } catch (err) {
          const clean = sanitizeWebRtcLog(err);
          logLifecycle('error', 'webrtc_offer_creation_failed', { error: clean });
          setWebrtcError(`Failed to create WebRTC SDP offer: ${clean}`);
        }
      } else {
        sendWsMessage({
          type: 'webrtc:ready',
          sessionId,
        });
        logLifecycle('info', 'webrtc_responder_ready_sent', { sessionId });
      }

      return pc;
    },
    [
      applyVideoSenderBitrateLimit,
      attachStreamToRemoteVideo,
      cleanupPeerConnection,
      ensureLocalMedia,
      fetchIceConfiguration,
      logLifecycle,
      sendWsMessage,
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
        pc = await initializeWebRtcForSession(sessionId, false);
      }
      if (!pc) return;

      const sdpData = rawData as { type?: RTCSdpType; sdp?: string } | null;
      if (!sdpData || !sdpData.type || !sdpData.sdp) {
        logLifecycle('warn', 'webrtc_sdp_invalid_payload', {});
        return;
      }

      try {
        if (sdpData.type === 'offer') {
          logLifecycle('info', 'webrtc_offer_received', { sessionId });
          await pc.setRemoteDescription(
            new RTCSessionDescription({
              type: 'offer',
              sdp: sdpData.sdp,
            })
          );
          remoteDescriptionSetRef.current = true;

          // Flush queued ICE candidates now that setRemoteDescription succeeded
          await flushPendingIceCandidates(pc);

          const answer = await pc.createAnswer();
          const cappedAnswer: RTCSessionDescriptionInit = {
            type: answer.type,
            sdp: enforceSdpVideoBitrateKbps(answer.sdp || '', 500),
          };
          await pc.setLocalDescription(cappedAnswer);
          await applyVideoSenderBitrateLimit(pc);

          if (pc.localDescription) {
            sendWsMessage({
              type: 'webrtc:sdp',
              sessionId,
              data: {
                type: pc.localDescription.type,
                sdp: pc.localDescription.sdp,
              },
            });
            logLifecycle('info', 'webrtc_answer_sent', { sessionId });
          }
        } else if (sdpData.type === 'answer') {
          if (pc.signalingState !== 'have-local-offer') {
            return;
          }
          logLifecycle('info', 'webrtc_answer_received', { sessionId });
          await pc.setRemoteDescription(
            new RTCSessionDescription({
              type: 'answer',
              sdp: sdpData.sdp,
            })
          );
          remoteDescriptionSetRef.current = true;

          // Flush queued ICE candidates now that setRemoteDescription succeeded
          await flushPendingIceCandidates(pc);
        }
      } catch (err) {
        const clean = sanitizeWebRtcLog(err);
        logLifecycle('error', 'webrtc_sdp_processing_error', {
          sdpType: sdpData.type,
          error: clean,
        });
        setWebrtcError(`WebRTC SDP negotiation error: ${clean}`);
      }
    },
    [
      applyVideoSenderBitrateLimit,
      flushPendingIceCandidates,
      initializeWebRtcForSession,
      logLifecycle,
      sendWsMessage,
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

      const pc = pcRef.current;
      if (!pc || !remoteDescriptionSetRef.current || !pc.remoteDescription) {
        pendingIceCandidatesRef.current.push(candidateInit);
        return;
      }

      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidateInit));
      } catch (err) {
        logLifecycle('error', 'webrtc_add_ice_error', {
          error: sanitizeWebRtcLog(err),
        });
      }
    },
    [logLifecycle]
  );

  const enqueueSignalingTask = useCallback(
    (task: () => Promise<void>) => {
      signalingChainRef.current = signalingChainRef.current
        .then(task)
        .catch((err) => {
          logLifecycle('error', 'signaling_chain_error', {
            error: sanitizeWebRtcLog(err),
          });
        });
    },
    [logLifecycle]
  );

  const handleRetryVideoNegotiation = useCallback(() => {
    const sid = sessionIdRef.current;
    const pc = pcRef.current;
    if (!sid || !pc) return;

    setWebrtcError(null);
    enqueueSignalingTask(async () => {
      try {
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
        if (pc.localDescription) {
          sendWsMessage({
            type: 'webrtc:sdp',
            sessionId: sid,
            data: {
              type: pc.localDescription.type,
              sdp: pc.localDescription.sdp,
            },
          });
        }
      } catch (err) {
        logLifecycle('error', 'webrtc_ice_restart_error', {
          error: sanitizeWebRtcLog(err),
        });
      }
    });
  }, [enqueueSignalingTask, logLifecycle, sendWsMessage]);

  const clearHeartbeatAndReconnectTimers = () => {
    if (heartbeatIntervalRef.current) {
      window.clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }
    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  };

  /**
   * Connects to /ws with automatic heartbeat (`ping`/`pong`), exponential backoff + jitter
   * reconnection, token validation on failure, and queue state restoration.
   */
  const connectWebSocket = useCallback(
    async (isManualRetry = false) => {
      if (unmountedRef.current) return;

      clearHeartbeatAndReconnectTimers();

      if (isManualRetry) {
        reconnectAttemptsRef.current = 0;
        permanentAuthFailureRef.current = false;
      }

      if (permanentAuthFailureRef.current) {
        return;
      }

      const token = getStoredToken();
      if (!token) {
        permanentAuthFailureRef.current = true;
        setWsConnected(false);
        setWsStatus('error');
        setWsError('Your session token is missing. Please log out and sign in again.');
        logLifecycle('error', 'ws_connect_aborted_no_token');
        return;
      }

      // Close any existing socket before opening a new one
      if (wsRef.current) {
        try {
          wsRef.current.onopen = null;
          wsRef.current.onmessage = null;
          wsRef.current.onerror = null;
          wsRef.current.onclose = null;
          wsRef.current.close(1000, 'Re-initializing connection');
        } catch {
          // Ignore
        }
        wsRef.current = null;
      }

      setWsConnected(false);
      setWsStatus(reconnectAttemptsRef.current > 0 ? 'reconnecting' : 'connecting');
      if (isManualRetry) {
        setWsError(null);
      }

      let ws: WebSocket;
      try {
        ws = new WebSocket(buildWebSocketUrl());
      } catch (err) {
        setWsStatus('error');
        setWsError(`Could not initialize WebSocket: ${sanitizeWebRtcLog(err)}`);
        return;
      }

      wsRef.current = ws;
      let opened = false;

      const connectTimeout = window.setTimeout(() => {
        if (!unmountedRef.current && ws.readyState !== WebSocket.OPEN) {
          logLifecycle('warn', 'ws_connect_timeout');
          try {
            ws.close(4000, 'Connection handshake timeout');
          } catch {
            // Ignore
          }
        }
      }, 10000);

      ws.onopen = () => {
        if (unmountedRef.current) return;
        opened = true;
        window.clearTimeout(connectTimeout);
        reconnectAttemptsRef.current = 0;
        setWsConnected(true);
        setWsStatus('connected');
        setWsError(null);
        logLifecycle('info', 'ws_open');

        // Start 20-second Cloudflare-safe heartbeat
        if (heartbeatIntervalRef.current) {
          window.clearInterval(heartbeatIntervalRef.current);
        }
        heartbeatIntervalRef.current = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            sendWsMessage({ type: 'ping', timestamp: Date.now() });
          }
        }, HEARTBEAT_INTERVAL_MS);
      };

      ws.onerror = () => {
        if (unmountedRef.current) return;
        logLifecycle('warn', 'ws_error_event', { opened });
      };

      ws.onclose = async (event) => {
        if (unmountedRef.current) return;
        window.clearTimeout(connectTimeout);
        if (heartbeatIntervalRef.current) {
          window.clearInterval(heartbeatIntervalRef.current);
          heartbeatIntervalRef.current = null;
        }

        setWsConnected(false);
        logLifecycle('warn', 'ws_close', {
          code: event.code,
          reason: event.reason || 'none',
          wasClean: event.wasClean,
          opened,
        });

        // Clean up active WebRTC call if one was in progress
        cleanupPeerConnection();
        if (desiredStageRef.current === 'matched') {
          desiredStageRef.current = 'idle';
          setStage('idle');
          setPartner(null);
          setActiveSessionId(null);
          sessionIdRef.current = null;
        }

        // Requirement 6: Do NOT reconnect after intentional logout, unmount, or permanent auth failure
        if (
          intentionalCloseRef.current ||
          unmountedRef.current ||
          event.code === 4001 ||
          event.code === 4003
        ) {
          if (event.code === 4001 || event.code === 4003) {
            permanentAuthFailureRef.current = true;
            setWsStatus('error');
            setWsError('Authentication rejected (401/403). Please log out and sign in again.');
          }
          return;
        }

        // If handshake never opened, verify whether the user's session token is still valid
        if (!opened) {
          try {
            await apiRequest('/auth/me');
          } catch (authErr) {
            const status = (authErr as { status?: number })?.status;
            if (status === 401 || status === 403) {
              permanentAuthFailureRef.current = true;
              setWsStatus('error');
              setWsError(
                'Your login session has expired or was signed out in another tab. Please sign in again.'
              );
              logLifecycle('error', 'ws_auth_invalid_stop_reconnect', { status });
              return;
            }
          }
        }

        // Requirement 5: Exponential backoff + jitter for unexpected disconnects
        if (reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
          const attempt = reconnectAttemptsRef.current;
          reconnectAttemptsRef.current = attempt + 1;
          const baseDelay = Math.min(1000 * Math.pow(2, attempt), 15000);
          const jitter = Math.floor(Math.random() * 600);
          const delayMs = baseDelay + jitter;

          setWsStatus('reconnecting');
          setWsError(
            `Signaling connection interrupted (code ${event.code}). Reconnecting automatically (attempt ${
              attempt + 1
            }/${MAX_RECONNECT_ATTEMPTS})...`
          );
          logLifecycle('info', 'ws_reconnect_scheduled', {
            attempt: attempt + 1,
            delayMs,
            closeCode: event.code,
          });

          reconnectTimerRef.current = window.setTimeout(() => {
            connectWebSocket(false);
          }, delayMs);
        } else {
          setWsStatus('error');
          setWsError(
            !opened
              ? 'Could not establish WebSocket connection to /ws. Ensure your Cloudflare Worker is deployed with `npx wrangler deploy`, then click "Retry Connection".'
              : `Signaling connection closed (code ${event.code}${
                  event.reason ? `: ${event.reason}` : ''
                }). Click "Retry Connection" to reconnect.`
          );
        }
      };

      ws.onmessage = (event) => {
        let msg: Record<string, unknown>;
        try {
          const parsed = JSON.parse(event.data);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return;
          }
          msg = parsed as Record<string, unknown>;
        } catch {
          logLifecycle('warn', 'ws_malformed_json_ignored');
          return;
        }

        const type = String(msg.type || '').trim();
        if (!VALID_SERVER_MESSAGE_TYPES.has(type)) {
          logLifecycle('warn', 'ws_unknown_message_type_ignored', { type });
          return;
        }

        if (type === 'pong') {
          return;
        }

        if (type === 'connection:established') {
          connectionIdRef.current = String(msg.connectionId || '');
          setWsConnected(true);
          setWsStatus('connected');
          setWsError(null);
          logLifecycle('info', 'ws_authenticated', {
            connectionId: connectionIdRef.current,
            ephemeralPeerId: msg.ephemeralPeerId,
          });

          // Requirement 7: Restore the user's waiting queue state automatically after a reconnect!
          if (desiredStageRef.current === 'waiting') {
            logLifecycle('info', 'ws_restore_waiting_queue', {
              mode: modeRef.current,
            });
            sendWsMessage({ type: 'queue:join', mode: modeRef.current });
          }
          return;
        }

        if (type === 'queue:waiting') {
          desiredStageRef.current = 'waiting';
          setStage('waiting');
          setPartner(null);
          setActiveSessionId(null);
          sessionIdRef.current = null;
          setQueueSeconds(0);
          logLifecycle('info', 'queue_waiting', {
            mode: msg.mode,
            waitingCount: msg.waitingCount,
          });
          return;
        }

        if (type === 'match:found') {
          const sid = String(msg.sessionId || '');
          const matchMode: 'video' | 'text' = msg.mode === 'text' ? 'text' : 'video';
          const initiator = Boolean(msg.initiator);
          const partnerMeta = (msg.partner || {}) as MatchedPartnerMeta;

          if (!sid || !partnerMeta.displayName) {
            logLifecycle('warn', 'match_found_invalid_payload');
            return;
          }

          desiredStageRef.current = 'matched';
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

          logLifecycle('info', 'match_found', {
            sessionId: sid,
            mode: matchMode,
            initiator,
            partnerPeerId: partnerMeta.ephemeralPeerId,
          });

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
            if (
              pc &&
              isInitiatorRef.current &&
              sessionIdRef.current === sid &&
              pc.localDescription &&
              pc.localDescription.type === 'offer' &&
              !remoteDescriptionSetRef.current
            ) {
              sendWsMessage({
                type: 'webrtc:sdp',
                sessionId: sid,
                data: {
                  type: pc.localDescription.type,
                  sdp: pc.localDescription.sdp,
                },
              });
              logLifecycle('info', 'webrtc_offer_resent_on_peer_ready', { sessionId: sid });
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

        // Requirement 10: Partner disconnect only ends the pair session, keeping our WebSocket open!
        if (type === 'stranger:disconnected') {
          logLifecycle('info', 'stranger_disconnected', {
            reason: msg.reason,
          });
          cleanupPeerConnection();
          desiredStageRef.current = 'idle';
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
    },
    [
      cleanupPeerConnection,
      enqueueSignalingTask,
      handleIncomingIceCandidate,
      handleIncomingSdp,
      initializeWebRtcForSession,
      logLifecycle,
      sendWsMessage,
    ]
  );

  // Mount WebSocket once for the lifetime of RandomChatStudio
  useEffect(() => {
    unmountedRef.current = false;
    intentionalCloseRef.current = false;
    connectWebSocket(false);

    return () => {
      unmountedRef.current = true;
      intentionalCloseRef.current = true;
      clearHeartbeatAndReconnectTimers();
      cleanupPeerConnection();
      stopLocalMedia();
      if (wsRef.current) {
        try {
          wsRef.current.close(1000, 'Component unmounted');
        } catch {
          // Ignore
        }
        wsRef.current = null;
      }
    };
  }, [connectWebSocket, cleanupPeerConnection, stopLocalMedia]);

  useEffect(() => {
    if (stage !== 'waiting') return;
    const interval = window.setInterval(() => {
      setQueueSeconds((s) => s + 1);
    }, 1000);
    return () => window.clearInterval(interval);
  }, [stage]);

  const handleJoinQueue = async (selectedMode: 'video' | 'text') => {
    setSafetyFeedback(null);
    setWebrtcError(null);

    if (wsRef.current?.readyState !== WebSocket.OPEN) {
      connectWebSocket(true);
      return;
    }

    modeRef.current = selectedMode;
    desiredStageRef.current = 'waiting';
    setMode(selectedMode);

    if (selectedMode === 'video') {
      await Promise.all([fetchIceConfiguration(), ensureLocalMedia()]);
    } else {
      stopLocalMedia();
    }

    sendWsMessage({ type: 'queue:join', mode: selectedMode });
  };

  const handleSkipPartner = () => {
    cleanupPeerConnection();
    desiredStageRef.current = 'waiting';
    sendWsMessage({ type: 'stranger:skip', mode: modeRef.current });
  };

  const handleEndSession = () => {
    desiredStageRef.current = 'idle';
    cleanupPeerConnection();
    stopLocalMedia();
    sendWsMessage({ type: 'stranger:end' });
    setStage('idle');
    setPartner(null);
    setActiveSessionId(null);
    sessionIdRef.current = null;
  };

  const toggleCamera = () => {
    const nextState = !cameraOn;
    cameraOnRef.current = nextState;
    setCameraOn(nextState);
    if (localStreamRef.current) {
      localStreamRef.current.getVideoTracks().forEach((t) => {
        t.enabled = nextState;
      });
    }
    if (activeSessionId) {
      sendWsMessage({
        type: 'stranger:media-state',
        sessionId: activeSessionId,
        data: { cameraOn: nextState, micOn: micOnRef.current },
      });
    }
  };

  const toggleMic = () => {
    const nextState = !micOn;
    micOnRef.current = nextState;
    setMicOn(nextState);
    if (localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach((t) => {
        t.enabled = nextState;
      });
    }
    if (activeSessionId) {
      sendWsMessage({
        type: 'stranger:media-state',
        sessionId: activeSessionId,
        data: { cameraOn: cameraOnRef.current, micOn: nextState },
      });
    }
  };

  const handleUnmuteRemoteVideo = () => {
    if (remoteVideoRef.current) {
      remoteVideoRef.current.muted = false;
      remoteVideoRef.current.play().catch((err) => {
        logLifecycle('error', 'manual_unmute_play_error', {
          error: sanitizeWebRtcLog(err),
        });
      });
      setRemoteAudioBlocked(false);
    }
  };

  const handleSendEphemeralMessage = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = inputText.trim();
    if (!clean || !activeSessionId) return;

    if (
      !sendWsMessage({
        type: 'stranger:message',
        sessionId: activeSessionId,
        data: { text: clean },
      })
    ) {
      return;
    }

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
          <h1 className="font-outfit font-extrabold text-3xl md:text-4xl text-[#14201b]">
            Random Video & Text Chat
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2">
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
                : wsStatus === 'reconnecting'
                ? 'Reconnecting...'
                : wsStatus === 'error'
                ? 'Signaling Disconnected'
                : 'Connecting...'}
            </span>
            {(wsStatus === 'error' || wsStatus === 'reconnecting') && (
              <button
                type="button"
                onClick={() => connectWebSocket(true)}
                className="ml-1 px-2.5 py-0.5 rounded-full bg-red-600 text-white text-[11px] font-extrabold hover:bg-red-700"
              >
                Retry
              </button>
            )}
          </div>
        </div>
      </div>

      {wsError && (
        <div className="p-4 rounded-2xl bg-red-950 text-red-100 border border-red-500/40 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <ShieldAlert className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <div>
              <p className="font-extrabold text-red-200">Signaling Connection Notice</p>
              <p className="text-red-200/90 mt-0.5">{wsError}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => connectWebSocket(true)}
            className="px-4 py-2 rounded-xl bg-[#c5fa5a] text-[#14201b] font-black text-xs shrink-0 hover:bg-[#d2ff75]"
          >
            Retry Connection ↗
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
                Get paired atomically with another adult in Sri Lanka. Shared interests are
                prioritized automatically.
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
                  Tip: Open a second browser tab or window to test live peer-to-peer WebRTC video &
                  audio immediately.
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

                  {!remoteVideoReady && !webrtcError && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#101417]/80 pointer-events-none p-6 text-center space-y-2">
                      <p className="text-sm font-extrabold text-[#c5fa5a]">
                        Connecting video stream with {partner?.displayName}...
                      </p>
                      <p className="text-xs text-[#bac3be]">
                        Negotiating encrypted peer-to-peer media ({iceState})
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

                  {webrtcError && (
                    <div className="absolute inset-x-4 top-16 z-20 p-4 rounded-2xl bg-amber-950/95 border border-amber-500/40 text-amber-100 text-xs shadow-2xl backdrop-blur-md space-y-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 font-black text-amber-300">
                          <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0" />
                          <span>WebRTC Media Connection Notice</span>
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
                        ? 'P2P Live'
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
                if (activeSessionId) {
                  sendWsMessage({ type: 'stranger:typing', sessionId: activeSessionId });
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
