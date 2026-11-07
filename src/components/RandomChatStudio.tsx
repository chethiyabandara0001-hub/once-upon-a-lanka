import React, { useEffect, useRef, useState } from 'react';
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

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' },
  ],
};

export const RandomChatStudio: React.FC<RandomChatStudioProps> = ({
  user,
  onNavigateMembership,
}) => {
  const [mode, setMode] = useState<'video' | 'text'>('video');
  const [wsConnected, setWsConnected] = useState(false);
  const [stage, setStage] = useState<'idle' | 'waiting' | 'matched'>('idle');
  const [partner, setPartner] = useState<MatchedPartnerMeta | null>(null);
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

  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const typingTimeoutRef = useRef<number | null>(null);

  const hasActiveMembership = user.membership.status === 'active';

  const cleanupPeerConnection = () => {
    setWebrtcError(null);
    setIceState('idle');
    if (pcRef.current) {
      try {
        pcRef.current.onicecandidate = null;
        pcRef.current.ontrack = null;
        pcRef.current.oniceconnectionstatechange = null;
        pcRef.current.onconnectionstatechange = null;
        pcRef.current.close();
      } catch {
        // Ignore
      }
      pcRef.current = null;
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
  };

  const stopLocalMedia = () => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }
  };

  const ensureLocalMedia = async () => {
    if (mode !== 'video') return null;
    if (localStreamRef.current) return localStreamRef.current;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
        audio: true,
      });
      localStreamRef.current = stream;
      setMediaPermissionState('granted');
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
      return stream;
    } catch {
      setMediaPermissionState('unavailable');
      return null;
    }
  };

  const initializeWebRtcForSession = async (sessionId: string, initiator: boolean) => {
    cleanupPeerConnection();
    const pc = new RTCPeerConnection(RTC_CONFIG);
    pcRef.current = pc;

    const stream = await ensureLocalMedia();
    if (stream) {
      stream.getTracks().forEach((track) => {
        pc.addTrack(track, stream);
      });
    }

    pc.onicecandidate = (event) => {
      if (event.candidate && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({
            type: 'webrtc:ice',
            sessionId,
            data: event.candidate,
          })
        );
      }
    };

    pc.ontrack = (event) => {
      if (remoteVideoRef.current && event.streams[0]) {
        remoteVideoRef.current.srcObject = event.streams[0];
      }
    };

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      setIceState(state);
      if (state === 'failed') {
        setWebrtcError(
          'Peer-to-peer video connection failed (NAT traversal blocked). Free public STUN was queried, but Cloudflare TURN relay credentials are not configured in this development environment. Live text messaging below remains active.'
        );
      } else if (state === 'disconnected') {
        setWebrtcError('WebRTC media stream was disconnected.');
      } else if (state === 'connected' || state === 'completed') {
        setWebrtcError(null);
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        setWebrtcError(
          'WebRTC connection failed. TURN relay servers are optional and not configured in free development mode.'
        );
      }
    };

    if (initiator) {
      try {
        const offer = await pc.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: true,
        });
        await pc.setLocalDescription(offer);
        wsRef.current?.send(
          JSON.stringify({
            type: 'webrtc:sdp',
            sessionId,
            data: pc.localDescription,
          })
        );
      } catch {
        // Ignore SDP error
      }
    }
  };

  useEffect(() => {
    const ws = new WebSocket(buildWebSocketUrl());
    wsRef.current = ws;

    ws.onopen = () => {
      setWsConnected(true);
    };

    ws.onclose = () => {
      setWsConnected(false);
      setStage('idle');
      cleanupPeerConnection();
    };

    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        const type = String(msg.type || '');

        if (type === 'queue:waiting') {
          setStage('waiting');
          setPartner(null);
          setActiveSessionId(null);
          sessionIdRef.current = null;
          setQueueSeconds(0);
          return;
        }

        if (type === 'match:found') {
          const sid = String(msg.sessionId);
          sessionIdRef.current = sid;
          setActiveSessionId(sid);
          setPartner(msg.partner as MatchedPartnerMeta);
          setStage('matched');
          setMessages([
            {
              id: `sys_${Date.now()}`,
              sender: 'system',
              text: `Matched with ${msg.partner.displayName}${
                msg.partner.region ? ` (${msg.partner.region})` : ''
              }. Say hello!`,
              timestamp: new Date().toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              }),
            },
          ]);

          if (msg.mode === 'video') {
            await initializeWebRtcForSession(sid, Boolean(msg.initiator));
          }
          return;
        }

        if (type === 'webrtc:sdp' && pcRef.current) {
          const desc = new RTCSessionDescription(msg.data);
          await pcRef.current.setRemoteDescription(desc);
          if (desc.type === 'offer') {
            const answer = await pcRef.current.createAnswer();
            await pcRef.current.setLocalDescription(answer);
            ws.send(
              JSON.stringify({
                type: 'webrtc:sdp',
                sessionId: sessionIdRef.current,
                data: pcRef.current.localDescription,
              })
            );
          }
          return;
        }

        if (type === 'webrtc:ice' && pcRef.current && msg.data) {
          try {
            await pcRef.current.addIceCandidate(new RTCIceCandidate(msg.data));
          } catch {
            // Ignore
          }
          return;
        }

        if (type === 'stranger:message') {
          const text = String(msg.data?.text || '');
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

        if (type === 'stranger:disconnected') {
          cleanupPeerConnection();
          setMessages((prev) => [
            ...prev,
            {
              id: `sys_disc_${Date.now()}`,
              sender: 'system',
              text: 'Stranger disconnected. Click "Next stranger" to meet someone new.',
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
      } catch {
        // Ignore
      }
    };

    return () => {
      cleanupPeerConnection();
      stopLocalMedia();
      ws.close();
    };
  }, []);

  useEffect(() => {
    if (stage !== 'waiting') return;
    const interval = window.setInterval(() => {
      setQueueSeconds((s) => s + 1);
    }, 1000);
    return () => window.clearInterval(interval);
  }, [stage]);

  const handleJoinQueue = async (selectedMode: 'video' | 'text') => {
    setSafetyFeedback(null);
    setMode(selectedMode);
    if (selectedMode === 'video') {
      await ensureLocalMedia();
    } else {
      stopLocalMedia();
    }

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'queue:join', mode: selectedMode }));
    }
  };

  const handleSkipPartner = () => {
    cleanupPeerConnection();
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'stranger:skip', mode }));
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
    }
  };

  const toggleMic = () => {
    const nextState = !micOn;
    setMicOn(nextState);
    if (localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach((t) => {
        t.enabled = nextState;
      });
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
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <p className="text-xs font-black text-[#557d27] uppercase tracking-wider">
            LIVE WEBRTC & DURABLE OBJECT QUEUE
          </p>
          <h1 className="font-outfit font-extrabold text-3xl md:text-4xl text-[#14201b] mt-1">
            Random Video & Text Chat
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 text-[11px] font-bold text-[#557d27] bg-[#f5f6f2] px-3 py-1.5 rounded-full border border-[#d6dfd3]">
            <span>📡 Free STUN Mode</span>
            <span className="text-[#849187]">(TURN optional)</span>
          </div>

          <div className="flex items-center gap-2 text-xs font-bold text-[#14201b] bg-white px-4 py-2 rounded-full border border-[#e7ebe5]">
            <Radio className={`w-3.5 h-3.5 ${wsConnected ? 'text-[#557d27]' : 'text-amber-600'}`} />
            <span>{wsConnected ? 'Signaling Ready' : 'Connecting...'}</span>
          </div>
        </div>
      </div>

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
                  onClick={() => handleJoinQueue('video')}
                  className="px-6 py-4 bg-[#c5fa5a] hover:bg-[#d2ff75] text-[#132014] font-black text-sm rounded-[15px]"
                >
                  ◉ &nbsp; Start video chat ↗
                </button>
                <button
                  type="button"
                  onClick={() => handleJoinQueue('text')}
                  className="px-6 py-4 bg-white/10 hover:bg-white/15 border border-white/30 text-white font-extrabold text-sm rounded-[15px]"
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
              {queueSeconds >= 8 && (
                <p className="text-xs text-[#dff4b3] bg-white/10 p-3 rounded-xl">
                  Tip: Open a second browser tab logged into another account to test real-time
                  peer-to-peer WebRTC & WebSocket pairing immediately.
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
                <div className="relative flex-1 bg-black flex items-center justify-center">
                  <video
                    ref={remoteVideoRef}
                    autoPlay
                    playsInline
                    className="w-full h-full object-cover"
                  />

                  {webrtcError && (
                    <div className="absolute inset-x-4 top-16 z-20 p-4 rounded-2xl bg-amber-950/90 border border-amber-500/40 text-amber-100 text-xs shadow-2xl backdrop-blur-md space-y-2">
                      <div className="flex items-center gap-2 font-black text-amber-300">
                        <ShieldAlert className="w-4 h-4 text-amber-400" />
                        <span>WebRTC Connection Notice (STUN Mode)</span>
                      </div>
                      <p className="leading-relaxed">
                        {webrtcError}
                      </p>
                      <div className="text-[11px] text-amber-300/80 pt-1">
                        In development mode, public STUN (Cloudflare/Google) is used without paid TURN relays. Peer-to-peer works over open NAT, but symmetric NAT firewalls require TURN. Text chat remains functional!
                      </div>
                    </div>
                  )}

                  <div className="absolute top-4 left-4 bg-[#101417]/80 px-4 py-2 rounded-full border border-white/15 text-xs font-bold flex items-center gap-2">
                    <span className="text-[#c5fa5a]">●</span>
                    <span>{partner?.displayName}</span>
                    {partner?.region && <span> · {partner.region}</span>}
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/10 text-[#c5fa5a]">
                      {iceState === 'connected' || iceState === 'completed'
                        ? 'P2P Live'
                        : iceState === 'failed'
                        ? 'P2P Blocked'
                        : 'P2P Negotiating'}
                    </span>
                  </div>

                  <div className="absolute bottom-4 right-4 w-36 h-24 rounded-2xl overflow-hidden border-2 border-white/25 bg-[#17221c] flex items-center justify-center">
                    {mediaPermissionState === 'granted' && cameraOn ? (
                      <video
                        ref={localVideoRef}
                        autoPlay
                        muted
                        playsInline
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <span className="text-[11px] font-bold text-[#bac3be] px-2 text-center">
                        {mediaPermissionState === 'unavailable' ? 'No camera detected' : 'Camera Off'}
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
