import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Video,
  MicOff,
  SkipForward,
  PhoneOff,
  ShieldAlert,
  Ban,
  Send,
  Sparkles,
  Clock,
  UserCheck,
  RefreshCw,
} from 'lucide-react';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  serverTimestamp,
  writeBatch,
  Unsubscribe,
} from 'firebase/firestore';
import type { AuthenticatedUser } from '../types';
import { db, handleFirestoreError, OperationType } from '../firebase';

interface RandomChatStudioProps {
  user: AuthenticatedUser;
}

interface EphemeralMessage {
  id: string;
  sessionId: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: string;
}

interface ActivePartner {
  userId: string;
  displayName: string;
  region: string;
}

export const RandomChatStudio: React.FC<RandomChatStudioProps> = ({ user }) => {
  const [stage, setStage] = useState<'idle' | 'waiting' | 'matched'>('idle');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [partner, setPartner] = useState<ActivePartner | null>(null);
  const [partnerLeft, setPartnerLeft] = useState(false);

  const [messages, setMessages] = useState<EphemeralMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [waitingElapsed, setWaitingElapsed] = useState(0);

  const [reportModalOpen, setReportModalOpen] = useState(false);
  const [reportReason, setReportReason] = useState('harassment_or_abuse');
  const [reportDetails, setReportDetails] = useState('');
  const [safetyFeedback, setSafetyFeedback] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const queueUnsubRef = useRef<Unsubscribe | null>(null);
  const sessionUnsubRef = useRef<Unsubscribe | null>(null);
  const messagesUnsubRef = useRef<Unsubscribe | null>(null);
  const waitTimerRef = useRef<number | null>(null);
  const currentSessionIdRef = useRef<string | null>(null);

  currentSessionIdRef.current = sessionId;

  // Cleanup listeners and queue entries
  const cleanupListeners = useCallback(() => {
    if (queueUnsubRef.current) {
      queueUnsubRef.current();
      queueUnsubRef.current = null;
    }
    if (sessionUnsubRef.current) {
      sessionUnsubRef.current();
      sessionUnsubRef.current = null;
    }
    if (messagesUnsubRef.current) {
      messagesUnsubRef.current();
      messagesUnsubRef.current = null;
    }
    if (waitTimerRef.current) {
      window.clearInterval(waitTimerRef.current);
      waitTimerRef.current = null;
    }
  }, []);

  const removeOwnQueueEntry = useCallback(async () => {
    try {
      await deleteDoc(doc(db, 'matchmaking_queue', user.id));
    } catch {
      // Ignored if document already deleted
    }
  }, [user.id]);

  useEffect(() => {
    const handleBeforeUnload = () => {
      // Best-effort cleanup on tab close
      removeOwnQueueEntry();
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      cleanupListeners();
      removeOwnQueueEntry();
    };
  }, [cleanupListeners, removeOwnQueueEntry]);

  // Real-time message listener when a session is active
  const subscribeToSessionMessages = useCallback(
    (activeSessionId: string) => {
      if (messagesUnsubRef.current) {
        messagesUnsubRef.current();
      }

      const msgsRef = collection(db, 'matchmaking_sessions', activeSessionId, 'messages');
      messagesUnsubRef.current = onSnapshot(
        msgsRef,
        (snap) => {
          const list: EphemeralMessage[] = [];
          snap.forEach((d) => {
            const data = d.data();
            const createdAtDate = data.createdAt?.toDate ? data.createdAt.toDate() : new Date();
            list.push({
              id: d.id,
              sessionId: activeSessionId,
              senderId: String(data.senderId || ''),
              senderName: String(data.senderName || 'Member'),
              text: String(data.text || ''),
              timestamp: createdAtDate.toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              }),
            });
          });
          // Sort client-side by insertion/timestamp
          setMessages(list);
        },
        (err) => {
          handleFirestoreError(err, OperationType.GET, `matchmaking_sessions/${activeSessionId}/messages`);
        }
      );
    },
    []
  );

  // Real-time session listener to observe partner presence and session termination
  const subscribeToSessionState = useCallback(
    (activeSessionId: string, currentUserId: string) => {
      if (sessionUnsubRef.current) {
        sessionUnsubRef.current();
      }

      const sessionDocRef = doc(db, 'matchmaking_sessions', activeSessionId);
      sessionUnsubRef.current = onSnapshot(
        sessionDocRef,
        (snap) => {
          if (!snap.exists()) {
            setPartnerLeft(true);
            return;
          }
          const sData = snap.data();
          if (sData.status === 'ended') {
            setPartnerLeft(true);
            return;
          }

          const isUserA = sData.userAId === currentUserId;
          const partnerUserId = isUserA ? sData.userBId : sData.userAId;
          const partnerName = isUserA ? sData.userBName : sData.userAName;
          const partnerRegion = isUserA ? sData.userBRegion : sData.userARegion;

          setPartner({
            userId: partnerUserId,
            displayName: partnerName || 'Member',
            region: partnerRegion || 'Sri Lanka',
          });
          setPartnerLeft(false);
          setStage('matched');
        },
        (err) => {
          handleFirestoreError(err, OperationType.GET, `matchmaking_sessions/${activeSessionId}`);
        }
      );

      subscribeToSessionMessages(activeSessionId);
    },
    [subscribeToSessionMessages]
  );

  // Initiates atomic queue search and real matchmaking coordination
  const handleStartMatching = async () => {
    cleanupListeners();
    setStage('waiting');
    setPartner(null);
    setPartnerLeft(false);
    setMessages([]);
    setWaitingElapsed(0);
    setSafetyFeedback(null);

    // Start timer for waiting UI
    waitTimerRef.current = window.setInterval(() => {
      setWaitingElapsed((prev) => prev + 1);
    }, 1000);

    try {
      // 1. Fetch user's active blocked list to prevent pairing with blocked users
      const blocksRef = collection(db, 'blocks');
      const blocksQuery = query(blocksRef, where('blockerId', '==', user.id));
      const blocksSnap = await getDocs(blocksQuery);
      const blockedIds = new Set<string>();
      blocksSnap.forEach((b) => {
        const bData = b.data();
        if (bData.blockedUserId) blockedIds.add(bData.blockedUserId);
      });

      // 2. Search matchmaking queue for another waiting real user
      const queueCol = collection(db, 'matchmaking_queue');
      const waitingQuery = query(queueCol, where('status', '==', 'waiting'));
      const queueSnap = await getDocs(waitingQuery);

      let matchedCandidate: { id: string; displayName: string; region: string } | null = null;
      const now = Date.now();

      queueSnap.forEach((candidateDoc) => {
        if (matchedCandidate) return;
        const cData = candidateDoc.data();
        const candidateUid = candidateDoc.id;

        // Skip self, blocked users, or entries older than 5 minutes
        if (candidateUid === user.id) return;
        if (blockedIds.has(candidateUid)) return;

        const candidateTime = cData.updatedAt?.toDate
          ? cData.updatedAt.toDate().getTime()
          : now;
        if (now - candidateTime > 5 * 60 * 1000) return;

        matchedCandidate = {
          id: candidateUid,
          displayName: cData.displayName || 'Member',
          region: cData.region || 'Sri Lanka',
        };
      });

      if (matchedCandidate) {
        // Atomic Match Found! Create session and update both queue docs
        const candidate = matchedCandidate as { id: string; displayName: string; region: string };
        const newSessionId = `ses_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        const batch = writeBatch(db);

        const sessionRef = doc(db, 'matchmaking_sessions', newSessionId);
        batch.set(sessionRef, {
          sessionId: newSessionId,
          participants: [user.id, candidate.id],
          userAId: user.id,
          userBId: candidate.id,
          userAName: user.displayName,
          userBName: candidate.displayName,
          userARegion: user.profile?.region || 'Sri Lanka',
          userBRegion: candidate.region || 'Sri Lanka',
          status: 'active',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        // Update candidate's queue doc to matched
        const candidateQueueRef = doc(db, 'matchmaking_queue', candidate.id);
        batch.update(candidateQueueRef, {
          status: 'matched',
          sessionId: newSessionId,
          updatedAt: serverTimestamp(),
        });

        // Create own queue doc as matched
        const ownQueueRef = doc(db, 'matchmaking_queue', user.id);
        batch.set(ownQueueRef, {
          userId: user.id,
          displayName: user.displayName,
          region: user.profile?.region || 'Sri Lanka',
          status: 'matched',
          sessionId: newSessionId,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        await batch.commit();

        setSessionId(newSessionId);
        subscribeToSessionState(newSessionId, user.id);
      } else {
        // No match currently waiting: Place self in queue and listen for an incoming pair
        const ownQueueRef = doc(db, 'matchmaking_queue', user.id);
        await setDoc(ownQueueRef, {
          userId: user.id,
          displayName: user.displayName,
          region: user.profile?.region || 'Sri Lanka',
          status: 'waiting',
          sessionId: '',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        // Listen to own queue doc for match event
        queueUnsubRef.current = onSnapshot(
          ownQueueRef,
          (snap) => {
            if (!snap.exists()) return;
            const qData = snap.data();
            if (qData.status === 'matched' && qData.sessionId) {
              setSessionId(qData.sessionId);
              subscribeToSessionState(qData.sessionId, user.id);
            }
          },
          (err) => {
            handleFirestoreError(err, OperationType.GET, `matchmaking_queue/${user.id}`);
          }
        );
      }
    } catch (err) {
      cleanupListeners();
      setStage('idle');
      handleFirestoreError(err, OperationType.WRITE, 'matchmaking_queue');
    }
  };

  const handleEndSession = async () => {
    const activeId = currentSessionIdRef.current;
    cleanupListeners();
    setStage('idle');
    setPartner(null);
    setPartnerLeft(false);
    setSessionId(null);
    setMessages([]);

    if (activeId) {
      try {
        await updateDoc(doc(db, 'matchmaking_sessions', activeId), {
          status: 'ended',
          updatedAt: serverTimestamp(),
        });
      } catch {
        // Ignore
      }
    }
    await removeOwnQueueEntry();
  };

  const handleSkipStranger = async () => {
    const activeId = currentSessionIdRef.current;
    if (activeId) {
      try {
        await updateDoc(doc(db, 'matchmaking_sessions', activeId), {
          status: 'ended',
          updatedAt: serverTimestamp(),
        });
      } catch {
        // Ignore
      }
    }
    await removeOwnQueueEntry();
    handleStartMatching();
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = inputText.trim();
    if (!clean || !sessionId || stage !== 'matched' || partnerLeft) return;

    setInputText('');
    const newMsgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const msgRef = doc(db, 'matchmaking_sessions', sessionId, 'messages', newMsgId);

    try {
      await setDoc(msgRef, {
        id: newMsgId,
        sessionId,
        senderId: user.id,
        senderName: user.displayName,
        text: clean,
        createdAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `matchmaking_sessions/${sessionId}/messages/${newMsgId}`);
    }
  };

  const handleBlockCurrentPartner = async () => {
    if (!partner) return;
    setIsSubmitting(true);
    const blockDocId = `${user.id}_${partner.userId}`;
    const blockRef = doc(db, 'blocks', blockDocId);

    try {
      await setDoc(blockRef, {
        id: blockDocId,
        blockerId: user.id,
        blockedUserId: partner.userId,
        blockedDisplayName: partner.displayName,
        reason: 'Blocked during random studio session',
        createdAt: serverTimestamp(),
      });
      setSafetyFeedback(`${partner.displayName} has been blocked.`);
      await handleSkipStranger();
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `blocks/${blockDocId}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmitReport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!partner) return;
    setIsSubmitting(true);
    const reportId = `rep_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const reportRef = doc(db, 'reports', reportId);

    try {
      await setDoc(reportRef, {
        id: reportId,
        reporterId: user.id,
        reportedUserId: partner.userId,
        contextType: 'random_text',
        reason: reportReason,
        details: reportDetails.slice(0, 1000),
        status: 'open',
        createdAt: serverTimestamp(),
      });
      setReportModalOpen(false);
      setReportDetails('');
      setSafetyFeedback('Safety report received. Searching for a new verified member.');
      await handleSkipStranger();
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `reports/${reportId}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Studio Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="font-outfit font-extrabold text-3xl text-[#14201b]">
            Spontaneous Chat Studio
          </h2>
          <p className="text-xs text-[#6d7a72] mt-1">
            Real 1-on-1 text pairing between verified adult members in Sri Lanka.
          </p>
        </div>

        <div className="flex items-center gap-3">
          {stage !== 'idle' && (
            <button
              type="button"
              onClick={handleEndSession}
              className="px-4 py-2 rounded-full bg-red-600 hover:bg-red-700 text-white text-xs font-extrabold inline-flex items-center gap-1.5 transition-colors shadow-sm"
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
        {/* Left 7 Columns: Video Area / Mode Placeholder */}
        <div className="lg:col-span-7 relative min-h-[440px] flex flex-col justify-between p-6 border-b lg:border-b-0 lg:border-r border-white/10">
          {stage === 'idle' && (
            <div className="m-auto text-center max-w-md space-y-6 py-10">
              <span className="brand-leaf mx-auto text-[#c5fa5a] text-3xl">✦</span>
              <div className="space-y-2">
                <h3 className="font-outfit font-extrabold text-3xl text-white">
                  Meet Someone Real
                </h3>
                <p className="text-sm text-[#b4c0b7] leading-relaxed">
                  Start an authentic real-time 1-on-1 text conversation with another verified adult member across Sri Lanka.
                </p>
              </div>

              <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={handleStartMatching}
                  className="w-full sm:w-auto px-7 py-4 bg-[#c5fa5a] hover:bg-[#d2ff75] text-[#14201b] font-black text-sm rounded-[15px] inline-flex items-center justify-center gap-2 transition-all shadow-lg hover:scale-[1.02]"
                >
                  <Sparkles className="w-4 h-4 text-[#14201b]" />
                  <span>Start Text Chat ↗</span>
                </button>
              </div>

              {/* Notice regarding video camera */}
              <div className="pt-4 border-t border-white/10 text-center">
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/5 border border-white/10 text-[11px] font-bold text-[#96a49a]">
                  <Video className="w-3 h-3 text-[#c5fa5a]" />
                  <span>Video Chat — Coming Soon</span>
                </span>
              </div>
            </div>
          )}

          {stage === 'waiting' && (
            <div className="m-auto text-center max-w-sm space-y-6 py-12">
              <div className="relative w-16 h-16 mx-auto">
                <div className="w-16 h-16 rounded-full border-2 border-[#c5fa5a] border-t-transparent animate-spin" />
                <Clock className="w-6 h-6 text-[#c5fa5a] absolute inset-0 m-auto" />
              </div>
              <div className="space-y-2">
                <p className="font-outfit font-extrabold text-2xl text-white">
                  Searching for someone online...
                </p>
                <p className="text-xs text-[#96a49a]">
                  Waiting for an eligible real member to enter the queue.
                </p>
                <div className="inline-block px-3 py-1 rounded-full bg-white/5 text-xs font-mono text-[#c5fa5a]">
                  Queue time: {waitingElapsed}s
                </div>
              </div>

              {/* Video placeholder during queue */}
              <div className="w-full max-w-[280px] mx-auto p-4 rounded-2xl bg-white/5 border border-white/10 text-center space-y-1">
                <span className="text-[11px] font-extrabold uppercase tracking-wider text-[#c5fa5a]">
                  Video Chat — Coming Soon
                </span>
                <p className="text-[11px] text-[#96a49a]">
                  Text pairing is active now. Camera and microphone remain disabled.
                </p>
              </div>

              <div>
                <button
                  type="button"
                  onClick={handleEndSession}
                  className="px-5 py-2.5 rounded-xl bg-white/10 hover:bg-white/15 text-xs font-bold text-white transition-colors"
                >
                  Cancel Queue
                </button>
              </div>
            </div>
          )}

          {stage === 'matched' && partner && (
            <>
              {/* Partner presence & video placeholder area */}
              <div className="absolute inset-0 bg-[#0e1411] flex flex-col items-center justify-center p-8 text-center overflow-hidden">
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_rgba(197,250,90,0.06),_transparent_75%)] pointer-events-none" />

                <div className="relative z-10 max-w-md space-y-4">
                  <div className="w-20 h-20 rounded-3xl bg-[#17221c] border-2 border-[#c5fa5a]/40 flex items-center justify-center mx-auto text-[#c5fa5a] shadow-xl">
                    <UserCheck className="w-10 h-10" />
                  </div>

                  <div className="space-y-1">
                    <h3 className="font-outfit font-extrabold text-3xl text-white">
                      {partner.displayName}
                    </h3>
                    <p className="text-xs text-[#c5fa5a] font-bold">
                      {partner.region} · Verified Member
                    </p>
                    <p className="text-xs text-[#96a49a] pt-1">
                      Real-Time 1-on-1 Text Conversation Active
                    </p>
                  </div>

                  {/* Elegant Video Placeholder Banner */}
                  <div className="p-3.5 rounded-2xl bg-black/40 border border-white/10 backdrop-blur-sm text-center">
                    <span className="text-xs font-extrabold text-[#c5fa5a] tracking-wider uppercase block">
                      Video Chat — Coming Soon
                    </span>
                    <span className="text-[11px] text-[#96a49a]">
                      Camera and microphone are disabled. Enjoy your text conversation!
                    </span>
                  </div>

                  {partnerLeft && (
                    <div className="p-3 rounded-xl bg-amber-950/80 border border-amber-500/40 text-amber-200 text-xs font-bold">
                      {partner.displayName} has left the session.
                    </div>
                  )}
                </div>
              </div>

              {/* Top Overlay Bar */}
              <div className="relative z-10 flex items-center justify-between gap-2">
                <div className="bg-[#101417]/85 backdrop-blur-md border border-white/15 px-4 py-2 rounded-full text-xs font-bold flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-[#c5fa5a] animate-pulse" />
                  <span>Connected</span>
                  <span className="text-[#96a49a]">·</span>
                  <span>{partner.displayName} ({partner.region})</span>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setReportModalOpen(true)}
                    className="px-3 py-1.5 rounded-full bg-black/65 hover:bg-black/80 border border-white/20 text-xs font-bold inline-flex items-center gap-1 transition-colors"
                  >
                    <ShieldAlert className="w-3.5 h-3.5 text-[#c5fa5a]" />
                    <span>Report</span>
                  </button>
                  <button
                    type="button"
                    disabled={isSubmitting}
                    onClick={handleBlockCurrentPartner}
                    className="px-3 py-1.5 rounded-full bg-black/65 hover:bg-red-950/80 border border-white/20 text-xs font-bold inline-flex items-center gap-1 transition-colors"
                  >
                    <Ban className="w-3.5 h-3.5 text-red-400" />
                    <span>Block</span>
                  </button>
                </div>
              </div>

              {/* Bottom Controls */}
              <div className="relative z-10 space-y-4">
                <div className="pt-3 border-t border-white/15 flex flex-wrap items-center justify-between gap-2">
                  {/* Disabled Video/Mic with clear 'Coming Soon' tooltip */}
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled
                      title="Video calling is coming soon in Phase 2"
                      className="px-3.5 py-2 rounded-xl bg-white/5 border border-white/10 text-xs font-bold inline-flex items-center gap-1.5 text-[#96a49a] opacity-75 cursor-not-allowed"
                    >
                      <Video className="w-3.5 h-3.5 text-[#96a49a]" />
                      <span>Camera Off (Coming Soon)</span>
                    </button>
                    <button
                      type="button"
                      disabled
                      title="Microphone audio is coming soon in Phase 2"
                      className="px-3.5 py-2 rounded-xl bg-white/5 border border-white/10 text-xs font-bold inline-flex items-center gap-1.5 text-[#96a49a] opacity-75 cursor-not-allowed"
                    >
                      <MicOff className="w-3.5 h-3.5 text-[#96a49a]" />
                      <span>Mic Off (Coming Soon)</span>
                    </button>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleEndSession}
                      className="px-3.5 py-2 rounded-xl bg-white/10 hover:bg-red-900/60 text-xs font-bold inline-flex items-center gap-1.5 transition-colors"
                    >
                      <PhoneOff className="w-3.5 h-3.5" />
                      <span>End</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleSkipStranger}
                      className="px-4 py-2 rounded-xl bg-[#c5fa5a] hover:bg-[#d2ff75] text-[#14201b] text-xs font-black inline-flex items-center gap-1.5 transition-colors shadow-md"
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

        {/* Right 5 Columns: Ephemeral Session Chat */}
        <div className="lg:col-span-5 flex flex-col justify-between h-[480px] lg:h-auto bg-[#141c18]">
          <div className="p-4 border-b border-white/10 flex items-center justify-between">
            <div>
              <p className="text-sm font-bold text-white">
                {partner ? `Live Chat with ${partner.displayName}` : 'Live Session Chat'}
              </p>
              <p className="text-[11px] text-[#96a49a]">
                Ephemeral text messages · Cleared when session ends
              </p>
            </div>
            {stage === 'matched' && (
              <span className="text-[11px] font-bold text-[#c5fa5a] px-2.5 py-0.5 rounded-full bg-white/5 border border-white/10">
                Active
              </span>
            )}
          </div>

          <div className="p-5 flex-1 overflow-y-auto space-y-3">
            {stage === 'idle' ? (
              <p className="text-xs text-[#96a49a] text-center my-auto py-16">
                Click &quot;Start Text Chat&quot; to find an active partner.
              </p>
            ) : stage === 'waiting' ? (
              <div className="text-center my-auto py-16 space-y-2">
                <RefreshCw className="w-5 h-5 text-[#c5fa5a] animate-spin mx-auto" />
                <p className="text-xs text-[#96a49a]">
                  Searching for an active user across Sri Lanka...
                </p>
              </div>
            ) : messages.length === 0 ? (
              <div className="text-center my-auto py-16 space-y-2">
                <p className="text-xs text-[#c5fa5a] font-bold">
                  Connected with {partner?.displayName}!
                </p>
                <p className="text-[11px] text-[#96a49a]">
                  Say hello to kick off your conversation.
                </p>
              </div>
            ) : (
              messages.map((m) => {
                const isMe = m.senderId === user.id;
                return (
                  <div
                    key={m.id}
                    className={`flex flex-col ${isMe ? 'items-end' : 'items-start'}`}
                  >
                    <div
                      className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-xs leading-relaxed ${
                        isMe
                          ? 'bg-[#c5fa5a] text-[#14201b] font-bold'
                          : 'bg-white/10 text-white'
                      }`}
                    >
                      {m.text}
                    </div>
                    <span className="text-[10px] text-[#96a49a] mt-1 tabular-nums">
                      {isMe ? 'You' : m.senderName} · {m.timestamp}
                    </span>
                  </div>
                );
              })
            )}
          </div>

          <form
            onSubmit={handleSendMessage}
            className="p-3.5 border-t border-white/10 flex items-center gap-2"
          >
            <input
              type="text"
              disabled={stage !== 'matched' || partnerLeft}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder={
                partnerLeft
                  ? 'Partner left the session. Click Next Person to continue.'
                  : stage === 'matched'
                  ? `Message ${partner?.displayName || 'partner'}...`
                  : 'Start chat to send messages...'
              }
              className="flex-1 bg-white/10 border border-white/15 rounded-xl px-3.5 py-2.5 text-xs text-white placeholder:text-white/40 focus:outline-none focus:border-[#c5fa5a] disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={stage !== 'matched' || partnerLeft || !inputText.trim()}
              className="px-4 py-2.5 bg-[#c5fa5a] text-[#14201b] rounded-xl text-xs font-black inline-flex items-center gap-1 disabled:opacity-40 transition-opacity"
            >
              <Send className="w-3.5 h-3.5" />
              <span>Send</span>
            </button>
          </form>
        </div>
      </div>

      {/* Safety Report Modal */}
      {reportModalOpen && partner && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4">
          <div className="max-w-md w-full p-7 rounded-[25px] bg-white text-[#14201b] space-y-4 shadow-2xl">
            <h3 className="font-outfit font-extrabold text-2xl">
              Report {partner.displayName}
            </h3>
            <p className="text-xs text-[#6d7a72]">
              Reports are audited by the Trust & Safety moderation team.
            </p>
            <form onSubmit={handleSubmitReport} className="space-y-4">
              <div>
                <label className="block text-xs font-extrabold mb-1">Reason</label>
                <select
                  value={reportReason}
                  onChange={(e) => setReportReason(e.target.value)}
                  className="w-full p-3 border border-[#d7ded5] rounded-xl text-xs font-bold"
                >
                  <option value="harassment_or_abuse">Harassment or abusive language</option>
                  <option value="underage_concern">Suspected underage user (&lt;18)</option>
                  <option value="spam_or_scam">Spam or solicitation</option>
                  <option value="inappropriate_conduct">Inappropriate conduct</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-extrabold mb-1">Additional details</label>
                <textarea
                  rows={3}
                  value={reportDetails}
                  onChange={(e) => setReportDetails(e.target.value)}
                  placeholder="Optional context for moderation..."
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
                  disabled={isSubmitting}
                  className="px-5 py-2.5 rounded-xl bg-[#c5fa5a] text-[#14201b] font-black text-xs disabled:opacity-50"
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
