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
} from 'lucide-react';
import type { AuthenticatedUser } from '../types';
import { apiRequest } from '../api';
import { EditorialImage } from './EditorialImage';

interface RandomChatStudioProps {
  user: AuthenticatedUser;
}

interface EphemeralMessage {
  id: string;
  sender: 'me' | 'stranger' | 'system';
  text: string;
  timestamp: string;
}

interface LocalPartnerProfile {
  ephemeralPeerId: string;
  userId: string;
  displayName: string;
  age: number;
  region: string;
  avatarUrl: string;
  sharedInterests: string[];
  greeting: string;
  replies: string[];
}

const LOCAL_STUDIO_PARTNERS: LocalPartnerProfile[] = [
  {
    ephemeralPeerId: 'peer_kavan',
    userId: 'usr_kavan',
    displayName: 'Kavan',
    age: 28,
    region: 'Colombo 03',
    avatarUrl: '/src/assets/images/editorial_portrait_kavan_1793978350314.jpg',
    sharedInterests: ['Tropical Architecture', 'Live Acoustic & Jazz', '35mm Film Photography'],
    greeting:
      'Hey! Good evening from Colombo. Just finished a studio sketch session—how is your week going?',
    replies: [
      'That sounds great! Have you checked out any of the new cafés down in Galle Fort recently?',
      'Agreed—nothing beats driving down the southern coast at dusk with good music.',
      'I would love to hear more about that. What do you usually like doing on weekends?',
    ],
  },
  {
    ephemeralPeerId: 'peer_dilini',
    userId: 'usr_dilini',
    displayName: 'Dilini',
    age: 25,
    region: 'Kandy',
    avatarUrl: '/src/assets/images/editorial_portrait_dilini_1793978350862.jpg',
    sharedInterests: ['Ceylon Tea & Cafés', 'Hill Country Trails', 'Literature & Poetry'],
    greeting:
      'Hello from Kandy! Having a warm cup of Ceylon tea after an evening rain shower. How are you?',
    replies: [
      'The hill country weather has been so peaceful lately. Do you enjoy hiking or quiet bookshops?',
      'That is lovely to hear! What book or film has stayed with you recently?',
      'Definitely! Let us keep chatting—it is rare to find thoughtful conversations like this.',
    ],
  },
  {
    ephemeralPeerId: 'peer_ehan',
    userId: 'usr_ehan',
    displayName: 'Ehan',
    age: 27,
    region: 'Jaffna & Mirissa',
    avatarUrl: '/src/assets/images/editorial_portrait_ehan_1793978352895.jpg',
    sharedInterests: ['Live Acoustic & Jazz', 'Independent Cinema', 'Late-Night Conversations'],
    greeting:
      'Evening! Editing a short coastal sound recording right now. What kind of music are you into?',
    replies: [
      'Awesome taste—live acoustic sessions by the beach are hard to beat.',
      'I completely agree. Have you traveled up north or down to Mirissa recently?',
      'Haha, true! Always great meeting someone on the same wavelength.',
    ],
  },
  {
    ephemeralPeerId: 'peer_amaya',
    userId: 'usr_amaya',
    displayName: 'Amaya',
    age: 26,
    region: 'Galle & Colombo 07',
    avatarUrl: '/src/assets/images/editorial_portrait_amaya_1793978349458.jpg',
    sharedInterests: ['Ceylon Tea & Cafés', 'Independent Cinema', 'Literature & Poetry'],
    greeting:
      'Hi there! Just got back from an evening walk along the ramparts. How is your evening going?',
    replies: [
      'Same here! A quiet evening conversation over tea is always the best way to unwind.',
      'I love that! Have you watched any good independent films lately?',
      'That sounds wonderful—glad we connected tonight!',
    ],
  },
];

const TARGET_VIDEO_WIDTH = 640;
const TARGET_VIDEO_HEIGHT = 360;
const TARGET_VIDEO_FPS = 24;

export const RandomChatStudio: React.FC<RandomChatStudioProps> = ({ user }) => {
  const [mode, setMode] = useState<'video' | 'text'>('video');
  const [stage, setStage] = useState<'idle' | 'waiting' | 'matched'>('idle');
  const [partnerIndex, setPartnerIndex] = useState(0);
  const [partner, setPartner] = useState<LocalPartnerProfile | null>(null);
  const [partnerTyping, setPartnerTyping] = useState(false);

  const [cameraOn, setCameraOn] = useState(true);
  const [micOn, setMicOn] = useState(true);

  const [messages, setMessages] = useState<EphemeralMessage[]>([]);
  const [inputText, setInputText] = useState('');

  const [reportModalOpen, setReportModalOpen] = useState(false);
  const [reportReason, setReportReason] = useState('harassment_or_abuse');
  const [reportDetails, setReportDetails] = useState('');
  const [safetyFeedback, setSafetyFeedback] = useState<string | null>(null);

  const localStreamRef = useRef<MediaStream | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const replyCounterRef = useRef<number>(0);
  const matchTimerRef = useRef<number | null>(null);
  const replyTimerRef = useRef<number | null>(null);

  const clearTimers = () => {
    if (matchTimerRef.current) {
      window.clearTimeout(matchTimerRef.current);
      matchTimerRef.current = null;
    }
    if (replyTimerRef.current) {
      window.clearTimeout(replyTimerRef.current);
      replyTimerRef.current = null;
    }
  };

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

  const setLocalVideoElement = useCallback(
    (el: HTMLVideoElement | null) => {
      localVideoRef.current = el;
      if (el && localStreamRef.current) {
        attachStreamToLocalVideo();
      }
    },
    [attachStreamToLocalVideo]
  );

  const stopLocalMedia = useCallback(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }
  }, []);

  const ensureLocalMedia = useCallback(
    async (selectedMode: 'video' | 'text') => {
      if (selectedMode !== 'video') return null;

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

      if (
        !navigator.mediaDevices ||
        typeof navigator.mediaDevices.getUserMedia !== 'function'
      ) {
        return null;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
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

        stream.getVideoTracks().forEach((t) => {
          t.enabled = cameraOn;
        });
        stream.getAudioTracks().forEach((t) => {
          t.enabled = micOn;
        });

        localStreamRef.current = stream;
        attachStreamToLocalVideo();
        return stream;
      } catch {
        return null;
      }
    },
    [attachStreamToLocalVideo, cameraOn, micOn]
  );

  useEffect(() => {
    if (stage === 'matched' || stage === 'waiting') {
      attachStreamToLocalVideo();
    }
  }, [stage, mode, attachStreamToLocalVideo]);

  useEffect(() => {
    return () => {
      clearTimers();
      stopLocalMedia();
    };
  }, [stopLocalMedia]);

  const pairWithNextPartner = useCallback(
    (selectedMode: 'video' | 'text', nextIndex: number) => {
      clearTimers();
      const candidates = LOCAL_STUDIO_PARTNERS.filter((p) => p.userId !== user.id);
      const chosen =
        candidates[nextIndex % candidates.length] || LOCAL_STUDIO_PARTNERS[0];

      setStage('waiting');
      setPartner(null);
      setPartnerTyping(false);

      matchTimerRef.current = window.setTimeout(() => {
        replyCounterRef.current = 0;
        setPartner(chosen);
        setStage('matched');
        const nowStr = new Date().toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        });
        setMessages([
          {
            id: `sys_${Date.now()}`,
            sender: 'system',
            text: `Matched with ${chosen.displayName} (${chosen.region}) in ${selectedMode} mode.`,
            timestamp: nowStr,
          },
          {
            id: `greet_${Date.now() + 1}`,
            sender: 'stranger',
            text: chosen.greeting,
            timestamp: nowStr,
          },
        ]);
      }, 650);
    },
    [user.id]
  );

  const handleJoinQueue = async (selectedMode: 'video' | 'text') => {
    setMode(selectedMode);
    setSafetyFeedback(null);
    if (selectedMode === 'video') {
      await ensureLocalMedia('video');
    } else {
      stopLocalMedia();
    }
    pairWithNextPartner(selectedMode, partnerIndex);
  };

  const handleSkipStranger = () => {
    const nextIdx = partnerIndex + 1;
    setPartnerIndex(nextIdx);
    pairWithNextPartner(mode, nextIdx);
  };

  const handleEndSession = () => {
    clearTimers();
    stopLocalMedia();
    setStage('idle');
    setPartner(null);
    setPartnerTyping(false);
    setMessages([]);
  };

  const toggleCamera = () => {
    const next = !cameraOn;
    setCameraOn(next);
    if (localStreamRef.current) {
      localStreamRef.current.getVideoTracks().forEach((t) => {
        t.enabled = next;
      });
    }
  };

  const toggleMic = () => {
    const next = !micOn;
    setMicOn(next);
    if (localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach((t) => {
        t.enabled = next;
      });
    }
  };

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = inputText.trim();
    if (!clean || stage !== 'matched' || !partner) return;

    const nowStr = new Date().toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });

    setMessages((prev) => [
      ...prev,
      {
        id: `me_${Date.now()}`,
        sender: 'me',
        text: clean,
        timestamp: nowStr,
      },
    ]);
    setInputText('');

    setPartnerTyping(true);
    if (replyTimerRef.current) {
      window.clearTimeout(replyTimerRef.current);
    }
    const currentPartner = partner;
    replyTimerRef.current = window.setTimeout(() => {
      setPartnerTyping(false);
      const replyText =
        currentPartner.replies[replyCounterRef.current % currentPartner.replies.length];
      replyCounterRef.current += 1;
      setMessages((prev) => [
        ...prev,
        {
          id: `str_${Date.now()}`,
          sender: 'stranger',
          text: replyText,
          timestamp: new Date().toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          }),
        },
      ]);
    }, 900);
  };

  const handleBlockCurrentPartner = async () => {
    if (!partner) return;
    await apiRequest('/safety/block', {
      method: 'POST',
      body: JSON.stringify({
        targetUserId: partner.userId,
        reason: 'Blocked during random studio session',
      }),
    });
    setSafetyFeedback(`${partner.displayName} has been blocked.`);
    handleSkipStranger();
  };

  const handleSubmitReport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!partner) return;
    await apiRequest('/safety/report', {
      method: 'POST',
      body: JSON.stringify({
        reportedUserId: partner.userId,
        contextType: mode === 'video' ? 'random_video' : 'random_text',
        reason: reportReason,
        details: reportDetails,
      }),
    });
    setReportModalOpen(false);
    setReportDetails('');
    setSafetyFeedback('Safety report submitted. Connecting you to someone new.');
    handleSkipStranger();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="font-outfit font-extrabold text-3xl text-[#14201b]">
            Spontaneous Video & Text Studio
          </h2>
        </div>

        <div className="flex items-center gap-3">
          {stage !== 'idle' && (
            <button
              type="button"
              onClick={handleEndSession}
              className="px-4 py-2 rounded-full bg-red-600 text-white text-xs font-extrabold inline-flex items-center gap-1.5"
            >
              <PhoneOff className="w-3.5 h-3.5" />
              <span>Leave Studio</span>
            </button>
          )}
        </div>
      </div>

      {safetyFeedback && (
        <div className="p-4 rounded-2xl bg-[#dff4b3] border border-[#c5fa5a] text-[#14201b] text-xs font-bold flex items-center justify-between">
          <span>{safetyFeedback}</span>
          <button
            type="button"
            onClick={() => setSafetyFeedback(null)}
            className="text-xs font-extrabold underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* MAIN STUDIO GRID */}
      <div className="grid grid-cols-1 lg:grid-cols-12 rounded-[26px] overflow-hidden bg-[#101417] text-white border border-[#222d26] shadow-2xl min-h-[540px]">
        {/* Left 7 Cols: Video / Mode Stage */}
        <div className="lg:col-span-7 relative min-h-[440px] flex flex-col justify-between p-6 border-b lg:border-b-0 lg:border-r border-white/10">
          {stage === 'idle' && (
            <div className="m-auto text-center max-w-md space-y-6 py-10">
              <span className="brand-leaf mx-auto">✦</span>
              <div className="space-y-2">
                <h3 className="font-outfit font-extrabold text-3xl text-white">
                  How would you like to meet?
                </h3>
                <p className="text-sm text-[#b4c0b7] leading-relaxed">
                  Choose live camera + audio conversation or start with a relaxed text-only
                  chat. You can skip, mute, or leave at any moment.
                </p>
              </div>

              <div className="flex flex-wrap items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={() => handleJoinQueue('video')}
                  className="px-6 py-4 bg-[#c5fa5a] hover:bg-[#d2ff75] text-[#14201b] font-black text-sm rounded-[15px] inline-flex items-center gap-2 transition-colors"
                >
                  <Video className="w-4 h-4" />
                  <span>Start video chat ↗</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleJoinQueue('text')}
                  className="px-6 py-4 bg-white/10 hover:bg-white/15 border border-white/30 text-white font-extrabold text-sm rounded-[15px] transition-colors"
                >
                  <span>▤ Start text chat</span>
                </button>
              </div>
            </div>
          )}

          {stage === 'waiting' && (
            <div className="m-auto text-center max-w-sm space-y-5 py-10">
              <div className="w-14 h-14 rounded-full border-2 border-[#c5fa5a] border-t-transparent animate-spin mx-auto" />
              <div className="space-y-1.5">
                <p className="font-outfit font-extrabold text-2xl text-white">
                  Finding your next conversation...
                </p>
                <p className="text-xs text-[#96a49a]">
                  Matching by shared Sri Lankan interests ({mode.toUpperCase()} MODE)
                </p>
              </div>
              {mode === 'video' && (
                <div className="w-40 h-28 mx-auto rounded-2xl overflow-hidden border border-white/20 bg-black relative">
                  <video
                    ref={setLocalVideoElement}
                    autoPlay
                    playsInline
                    muted
                    className="w-full h-full object-cover"
                  />
                  <span className="absolute bottom-1.5 left-2 text-[10px] font-bold text-[#c5fa5a] bg-black/60 px-2 py-0.5 rounded">
                    Your Camera Preview
                  </span>
                </div>
              )}
              <button
                type="button"
                onClick={handleEndSession}
                className="px-5 py-2.5 rounded-xl bg-white/10 hover:bg-white/15 text-xs font-bold text-white"
              >
                Cancel Queue
              </button>
            </div>
          )}

          {stage === 'matched' && partner && (
            <>
              {mode === 'video' ? (
                <div className="absolute inset-0 bg-black">
                  <EditorialImage
                    src={partner.avatarUrl}
                    alt={partner.displayName}
                    aspectClassName="w-full h-full"
                    className="w-full h-full object-cover"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-[#101417] via-transparent to-[#101417]/50 pointer-events-none" />
                </div>
              ) : (
                <div className="absolute inset-0 bg-[#17221c] flex flex-col items-center justify-center p-8 text-center">
                  <span className="brand-leaf mb-3">✦</span>
                  <p className="font-outfit font-extrabold text-3xl text-white">
                    Connected with {partner.displayName}
                  </p>
                  <p className="text-xs text-[#b4c0b7] mt-1">
                    Text-Only Conversation Mode · {partner.region}
                  </p>
                </div>
              )}

              {/* Top Overlay Bar */}
              <div className="relative z-10 flex items-center justify-between gap-2">
                <div className="bg-[#101417]/80 backdrop-blur-md border border-white/15 px-4 py-2 rounded-full text-xs font-bold">
                  <span className="text-[#c5fa5a]">● Connected</span> · {partner.displayName},{' '}
                  {partner.age} ({partner.region})
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setReportModalOpen(true)}
                    className="px-3 py-1.5 rounded-full bg-black/65 hover:bg-black/80 border border-white/20 text-xs font-bold inline-flex items-center gap-1"
                  >
                    <ShieldAlert className="w-3.5 h-3.5 text-[#c5fa5a]" />
                    <span>Report</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleBlockCurrentPartner}
                    className="px-3 py-1.5 rounded-full bg-black/65 hover:bg-red-950/80 border border-white/20 text-xs font-bold inline-flex items-center gap-1"
                  >
                    <Ban className="w-3.5 h-3.5 text-red-400" />
                    <span>Block</span>
                  </button>
                </div>
              </div>

              {/* Bottom Controls + Local Self-Preview */}
              <div className="relative z-10 space-y-4">
                <div className="flex items-end justify-between gap-4">
                  <div className="bg-black/60 backdrop-blur-md p-3.5 rounded-2xl border border-white/10">
                    <p className="font-outfit font-extrabold text-xl text-white">
                      {partner.displayName}, {partner.age}
                    </p>
                    {partner.sharedInterests.length > 0 && (
                      <p className="text-xs text-[#c5fa5a] font-bold mt-0.5">
                        Shared: {partner.sharedInterests.join(' · ')}
                      </p>
                    )}
                  </div>

                  {mode === 'video' && (
                    <div className="w-36 h-24 rounded-2xl overflow-hidden border-2 border-white/25 bg-[#17221c] relative shrink-0 shadow-lg">
                      <video
                        ref={setLocalVideoElement}
                        autoPlay
                        playsInline
                        muted
                        className={`w-full h-full object-cover ${cameraOn ? '' : 'hidden'}`}
                      />
                      {!cameraOn && (
                        <div className="w-full h-full flex items-center justify-center text-[11px] font-bold text-[#96a49a]">
                          Camera Off
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div className="pt-3 border-t border-white/15 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    {mode === 'video' && (
                      <>
                        <button
                          type="button"
                          onClick={toggleCamera}
                          className="px-3.5 py-2 rounded-xl bg-white/10 hover:bg-white/15 border border-white/20 text-xs font-bold inline-flex items-center gap-1.5"
                        >
                          {cameraOn ? (
                            <Video className="w-3.5 h-3.5 text-[#c5fa5a]" />
                          ) : (
                            <VideoOff className="w-3.5 h-3.5 text-red-400" />
                          )}
                          <span>{cameraOn ? 'Camera On' : 'Camera Off'}</span>
                        </button>
                        <button
                          type="button"
                          onClick={toggleMic}
                          className="px-3.5 py-2 rounded-xl bg-white/10 hover:bg-white/15 border border-white/20 text-xs font-bold inline-flex items-center gap-1.5"
                        >
                          {micOn ? (
                            <Mic className="w-3.5 h-3.5 text-[#c5fa5a]" />
                          ) : (
                            <MicOff className="w-3.5 h-3.5 text-red-400" />
                          )}
                          <span>{micOn ? 'Mic On' : 'Muted'}</span>
                        </button>
                      </>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleEndSession}
                      className="px-3.5 py-2 rounded-xl bg-white/10 hover:bg-red-900/60 text-xs font-bold inline-flex items-center gap-1.5"
                    >
                      <PhoneOff className="w-3.5 h-3.5" />
                      <span>End</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleSkipStranger}
                      className="px-4 py-2 rounded-xl bg-[#c5fa5a] hover:bg-[#d2ff75] text-[#14201b] text-xs font-black inline-flex items-center gap-1.5"
                    >
                      <SkipForward className="w-3.5 h-3.5" />
                      <span>Next Person ↗</span>
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Right 5 Cols: Ephemeral Session Chat */}
        <div className="lg:col-span-5 flex flex-col justify-between h-[480px] lg:h-auto bg-[#141c18]">
          <div className="p-4 border-b border-white/10 flex items-center justify-between">
            <div>
              <p className="text-sm font-bold text-white">
                {partner ? `Chat with ${partner.displayName}` : 'Live Session Chat'}
              </p>
              <p className="text-[11px] text-[#96a49a]">
                Ephemeral messages · Cleared when session ends
              </p>
            </div>
            {partnerTyping && (
              <span className="text-xs font-bold text-[#c5fa5a]">typing...</span>
            )}
          </div>

          <div className="p-5 flex-1 overflow-y-auto space-y-3">
            {messages.length === 0 ? (
              <p className="text-xs text-[#96a49a] text-center my-auto py-16">
                Start a video or text session to chat with someone new.
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
                  {m.sender === 'system' ? (
                    <span className="text-[11px] text-[#c5fa5a] bg-white/5 px-3 py-1 rounded-full font-bold">
                      {m.text}
                    </span>
                  ) : (
                    <>
                      <div
                        className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-xs leading-relaxed ${
                          m.sender === 'me'
                            ? 'bg-[#c5fa5a] text-[#14201b] font-bold'
                            : 'bg-white/10 text-white'
                        }`}
                      >
                        {m.text}
                      </div>
                      <span className="text-[10px] text-[#96a49a] mt-1 tabular-nums">
                        {m.sender === 'me' ? 'You' : partner?.displayName || 'Partner'} ·{' '}
                        {m.timestamp}
                      </span>
                    </>
                  )}
                </div>
              ))
            )}
          </div>

          <form
            onSubmit={handleSendMessage}
            className="p-3.5 border-t border-white/10 flex items-center gap-2"
          >
            <input
              type="text"
              disabled={stage !== 'matched'}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder={
                stage === 'matched'
                  ? `Message ${partner?.displayName || 'partner'}...`
                  : 'Connect first to send messages...'
              }
              className="flex-1 bg-white/10 border border-white/15 rounded-xl px-3.5 py-2.5 text-xs text-white placeholder:text-white/40 focus:outline-none focus:border-[#c5fa5a] disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={stage !== 'matched'}
              className="px-4 py-2.5 bg-[#c5fa5a] text-[#14201b] rounded-xl text-xs font-black inline-flex items-center gap-1 disabled:opacity-40"
            >
              <Send className="w-3.5 h-3.5" />
              <span>Send</span>
            </button>
          </form>
        </div>
      </div>

      {/* Report Modal */}
      {reportModalOpen && partner && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4">
          <div className="max-w-md w-full p-7 rounded-[25px] bg-white text-[#14201b] space-y-4">
            <h3 className="font-outfit font-extrabold text-2xl">
              Report {partner.displayName}
            </h3>
            <form onSubmit={handleSubmitReport} className="space-y-4">
              <div>
                <label className="block text-xs font-extrabold mb-1">Reason</label>
                <select
                  value={reportReason}
                  onChange={(e) => setReportReason(e.target.value)}
                  className="w-full p-3 border border-[#d7ded5] rounded-xl text-xs font-bold"
                >
                  <option value="harassment_or_abuse">Harassment or abusive language</option>
                  <option value="inappropriate_video">Inappropriate camera conduct</option>
                  <option value="underage_concern">Suspected underage user</option>
                  <option value="spam_or_scam">Spam or solicitation</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-extrabold mb-1">Additional details</label>
                <textarea
                  rows={3}
                  value={reportDetails}
                  onChange={(e) => setReportDetails(e.target.value)}
                  placeholder="Optional context for our Trust & Safety team..."
                  className="w-full p-3 border border-[#d7ded5] rounded-xl text-xs"
                />
              </div>
              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setReportModalOpen(false)}
                  className="px-4 py-2 text-xs font-bold text-[#6d7a72]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2.5 rounded-xl bg-[#c5fa5a] text-[#14201b] font-black text-xs"
                >
                  Submit Report & Skip
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
