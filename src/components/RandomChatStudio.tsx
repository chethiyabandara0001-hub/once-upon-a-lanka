import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Video,
  VideoOff,
  Mic,
  MicOff,
  SkipForward,
  ShieldAlert,
  Send,
  Sparkles,
  Clock,
  UserCheck,
  RefreshCw,
  SwitchCamera,
  Activity,
  AlertTriangle,
  SlidersHorizontal,
} from 'lucide-react';
import {
  collection,
  doc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  serverTimestamp,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore';
import type { AuthenticatedUser } from '../types';
import { db, handleFirestoreError, OperationType } from '../firebase';
import {
  INITIAL_DIAGNOSTICS_STATE,
  prefetchIceServers,
  request360pMediaStream,
  WebRtcSessionController,
  type WebRtcDiagnosticsState,
} from '../services/webrtcSignaling';

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
  createdAtMs: number;
}

interface ActivePartner {
  userId: string;
  displayName: string;
  region: string;
}

interface MatchSessionParticipants {
  userAId: string;
  userBId: string;
}

type GenderPreference = 'any' | 'female' | 'male' | 'non_binary';
type RegionPreference = 'any' | 'my_region';

export const RandomChatStudio: React.FC<RandomChatStudioProps> = ({ user }) => {
  const [preferredMode, setPreferredMode] = useState<'video' | 'text'>('video');
  const [preferredGender, setPreferredGender] = useState<GenderPreference>('any');
  const [preferredRegion, setPreferredRegion] = useState<RegionPreference>('any');

  const [stage, setStage] = useState<'idle' | 'waiting' | 'matched'>('idle');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionParticipants, setSessionParticipants] =
    useState<MatchSessionParticipants | null>(null);
  const [partner, setPartner] = useState<ActivePartner | null>(null);
  const [partnerLeft, setPartnerLeft] = useState(false);

  // WebRTC & Camera/Mic States
  const [videoCallActive, setVideoCallActive] = useState(false);
  const [callStatus, setCallStatus] = useState<
    'idle' | 'waiting_partner' | 'connecting' | 'connected' | 'failed' | 'ended'
  >('idle');
  const [hasRemoteStream, setHasRemoteStream] = useState(false);
  const [partnerVideoReady, setPartnerVideoReady] = useState(false);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [micEnabled, setMicEnabled] = useState(true);
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
  const [cameraPermissionError, setCameraPermissionError] = useState<string | null>(null);
  const [micPermissionError, setMicPermissionError] = useState<string | null>(null);

  // Diagnostics Panel State (Dev/Debug Toggle)
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [diagnostics, setDiagnostics] = useState<WebRtcDiagnosticsState>(
    INITIAL_DIAGNOSTICS_STATE
  );

  // Ephemeral Chat States
  const [messages, setMessages] = useState<EphemeralMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [waitingElapsed, setWaitingElapsed] = useState(0);

  // Safety & Reporting States
  const [reportModalOpen, setReportModalOpen] = useState(false);
  const [reportReason, setReportReason] = useState('harassment_or_abuse');
  const [reportDetails, setReportDetails] = useState('');
  const [safetyFeedback, setSafetyFeedback] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Refs for DOM elements, MediaStreams, Preferences, and Subscriptions
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const rtcControllerRef = useRef<WebRtcSessionController | null>(null);

  const queueUnsubRef = useRef<Unsubscribe | null>(null);
  const sessionUnsubRef = useRef<Unsubscribe | null>(null);
  const messagesUnsubRef = useRef<Unsubscribe | null>(null);
  const waitTimerRef = useRef<number | null>(null);
  const queuePollTimerRef = useRef<number | null>(null);

  const currentSessionIdRef = useRef<string | null>(null);
  const currentPartnerIdRef = useRef<string | null>(null);
  const lastSkippedPartnerIdRef = useRef<string | null>(null);
  const lastSkippedAtRef = useRef<number>(0);
  const isTransitioningSessionRef = useRef<boolean>(false);

  const preferredModeRef = useRef<'video' | 'text'>(preferredMode);
  const preferredGenderRef = useRef<GenderPreference>(preferredGender);
  const preferredRegionRef = useRef<RegionPreference>(preferredRegion);
  const handleStartMatchingRef = useRef<
    ((selectedMode: 'video' | 'text', keepFeedback?: boolean) => Promise<void>) | null
  >(null);

  currentSessionIdRef.current = sessionId;
  currentPartnerIdRef.current = partner?.userId || null;
  preferredModeRef.current = preferredMode;
  preferredGenderRef.current = preferredGender;
  preferredRegionRef.current = preferredRegion;

  // Bind local stream to PIP video element
  const attachLocalVideo = useCallback((el: HTMLVideoElement | null) => {
    localVideoRef.current = el;
    if (el && localStreamRef.current) {
      if (el.srcObject !== localStreamRef.current) {
        el.srcObject = localStreamRef.current;
      }
      el.muted = true;
      el.playsInline = true;
      el.autoplay = true;
      el.play().catch(() => {
        // Local preview is muted
      });
    }
  }, []);

  // Bind remote stream to main stage video element
  const attachRemoteVideo = useCallback((el: HTMLVideoElement | null) => {
    remoteVideoRef.current = el;
    if (el && remoteStreamRef.current) {
      if (el.srcObject !== remoteStreamRef.current) {
        el.srcObject = remoteStreamRef.current;
      }
      el.playsInline = true;
      el.autoplay = true;
      el.play().catch(() => {
        // Autoplay handled
      });
    }
  }, []);

  // Stop all local camera & microphone hardware tracks
  const stopLocalMediaTracks = useCallback(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          // Ignore
        }
      });
      localStreamRef.current = null;
    }
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }
  }, []);

  // Close only the RTCPeerConnection & remote stream while keeping local camera stream alive for fast skip
  const closePeerConnectionKeepCamera = useCallback(
    async (markEndedInFirestore = true) => {
      if (rtcControllerRef.current) {
        const controller = rtcControllerRef.current;
        rtcControllerRef.current = null;
        await controller.stop(markEndedInFirestore);
      }
      remoteStreamRef.current = null;
      setHasRemoteStream(false);
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = null;
      }
      setCallStatus('idle');
      setPartnerVideoReady(false);
    },
    []
  );

  // Tear down active WebRTC peer connection & local hardware media tracks completely
  const teardownWebRtcCall = useCallback(
    async (markEndedInFirestore = true) => {
      await closePeerConnectionKeepCamera(markEndedInFirestore);
      stopLocalMediaTracks();
      setVideoCallActive(false);
      setDiagnostics(INITIAL_DIAGNOSTICS_STATE);
    },
    [closePeerConnectionKeepCamera, stopLocalMediaTracks]
  );

  // Cleanup Firestore listeners & timers
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
    if (queuePollTimerRef.current) {
      window.clearInterval(queuePollTimerRef.current);
      queuePollTimerRef.current = null;
    }
  }, []);

  const removeOwnQueueEntry = useCallback(async () => {
    try {
      await deleteDoc(doc(db, 'matchmaking_queue', user.id));
    } catch {
      // Ignored if document already deleted
    }
  }, [user.id]);

  // Page unload & component unmount cleanup
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (rtcControllerRef.current) {
        rtcControllerRef.current.stop(true);
      }
      stopLocalMediaTracks();
      removeOwnQueueEntry();
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      cleanupListeners();
      if (rtcControllerRef.current) {
        rtcControllerRef.current.stop(true);
      }
      stopLocalMediaTracks();
      removeOwnQueueEntry();
    };
  }, [cleanupListeners, removeOwnQueueEntry, stopLocalMediaTracks]);

  // Helper to sync local MediaStream state into the WebRTC Diagnostics panel even before a peer is matched
  const syncLocalStreamDiagnostics = useCallback(
    (stream: MediaStream | null, currentStatusLabel?: string) => {
      if (!stream) {
        setDiagnostics((prev) => ({
          ...prev,
          localVideoTrackState: 'inactive',
          localAudioTrackState: 'inactive',
          outgoingResolution: '0x0',
        }));
        return;
      }
      const vTrack = stream.getVideoTracks()[0];
      const aTrack = stream.getAudioTracks()[0];
      const settings = vTrack?.getSettings();
      const res =
        settings?.width && settings?.height
          ? `${settings.width}x${settings.height}`
          : '640x360';

      setDiagnostics((prev) => ({
        ...prev,
        sessionId: currentStatusLabel || prev.sessionId,
        localVideoTrackState: vTrack
          ? `${vTrack.readyState} (${vTrack.enabled ? 'enabled' : 'muted'})`
          : 'none',
        localAudioTrackState: aTrack
          ? `${aTrack.readyState} (${aTrack.enabled ? 'enabled' : 'muted'})`
          : 'none',
        outgoingResolution: res,
      }));
    },
    []
  );

  // Trigger automatic re-matchmaking when the remote partner skips the session
  const handleRemotePartnerSkipped = useCallback(async () => {
    if (isTransitioningSessionRef.current) return;
    isTransitioningSessionRef.current = true;

    if (currentPartnerIdRef.current) {
      lastSkippedPartnerIdRef.current = currentPartnerIdRef.current;
      lastSkippedAtRef.current = Date.now();
    }

    cleanupListeners();
    await closePeerConnectionKeepCamera(false);
    await removeOwnQueueEntry();

    setSafetyFeedback(
      'Partner skipped — automatically finding you a new match based on your chosen preferences...'
    );

    if (handleStartMatchingRef.current) {
      await handleStartMatchingRef.current(preferredModeRef.current, true);
    }
  }, [cleanupListeners, closePeerConnectionKeepCamera, removeOwnQueueEntry]);

  // Start or Accept 360p WebRTC Video Call inside an active matched session
  const startWebRtcForMatchedSession = useCallback(
    async (
      activeSessionId: string,
      userAId: string,
      userBId: string,
      selectedFacingMode: 'user' | 'environment' = facingMode
    ) => {
      setCameraPermissionError(null);
      setMicPermissionError(null);

      // Tear down any previous peer connection controller while keeping active local stream if already acquired
      if (rtcControllerRef.current) {
        await rtcControllerRef.current.stop(false);
        rtcControllerRef.current = null;
      }

      let stream = localStreamRef.current;
      const hasLiveTracks =
        stream &&
        stream.getTracks().some((t) => t.readyState === 'live');

      if (!stream || !hasLiveTracks) {
        stopLocalMediaTracks();
        const mediaResult = await request360pMediaStream(selectedFacingMode);
        if (!mediaResult.stream) {
          setCameraPermissionError(mediaResult.cameraError);
          setMicPermissionError(mediaResult.micError);
          setVideoCallActive(false);
          setCallStatus('failed');
          setDiagnostics((prev) => ({
            ...prev,
            sessionId: activeSessionId,
            lastError:
              mediaResult.cameraError ||
              mediaResult.micError ||
              'Media permission denied',
          }));
          return;
        }
        stream = mediaResult.stream;
        localStreamRef.current = stream;
      }

      stream.getVideoTracks().forEach((t) => {
        t.enabled = cameraEnabled;
      });
      stream.getAudioTracks().forEach((t) => {
        t.enabled = micEnabled;
      });

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
        localVideoRef.current.muted = true;
        localVideoRef.current.play().catch(() => {});
      }

      setVideoCallActive(true);
      syncLocalStreamDiagnostics(stream, activeSessionId);

      const controller = new WebRtcSessionController({
        sessionId: activeSessionId,
        currentUserId: user.id,
        initiatorId: userAId,
        answererId: userBId,
        localStream: stream,
        callbacks: {
          onRemoteStream: (remStream) => {
            remoteStreamRef.current = remStream;
            const hasTracks = Boolean(
              remStream && remStream.getTracks().length > 0
            );
            setHasRemoteStream(hasTracks);
            if (remoteVideoRef.current) {
              if (remoteVideoRef.current.srcObject !== remStream) {
                remoteVideoRef.current.srcObject = remStream;
              }
              if (remStream) {
                remoteVideoRef.current.play().catch(() => {});
              }
            }
          },
          onDiagnosticsUpdate: (patch) => {
            setDiagnostics((prev) => ({ ...prev, ...patch }));
          },
          onPartnerVideoReadyChange: (ready) => {
            setPartnerVideoReady(ready);
          },
          onCallStatusChange: (nextStatus) => {
            setCallStatus(nextStatus);
            if (nextStatus === 'ended') {
              handleRemotePartnerSkipped();
            }
          },
        },
      });

      rtcControllerRef.current = controller;
      await controller.start();
    },
    [
      cameraEnabled,
      micEnabled,
      facingMode,
      handleRemotePartnerSkipped,
      stopLocalMediaTracks,
      syncLocalStreamDiagnostics,
      user.id,
    ]
  );

  // Subscribe to ephemeral session messages
  const subscribeToSessionMessages = useCallback((activeSessionId: string) => {
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
            createdAtMs: createdAtDate.getTime(),
          });
        });
        list.sort((a, b) => a.createdAtMs - b.createdAtMs);
        setMessages(list);
      },
      (err) => {
        handleFirestoreError(
          err,
          OperationType.GET,
          `matchmaking_sessions/${activeSessionId}/messages`
        );
      }
    );
  }, []);

  // Subscribe to active matchmaking session document
  const subscribeToSessionState = useCallback(
    (
      activeSessionId: string,
      currentUserId: string,
      autoStartVideo: boolean
    ) => {
      if (sessionUnsubRef.current) {
        sessionUnsubRef.current();
      }
      if (queuePollTimerRef.current) {
        window.clearInterval(queuePollTimerRef.current);
        queuePollTimerRef.current = null;
      }

      let hasTriggeredInitialVideo = false;
      const sessionDocRef = doc(db, 'matchmaking_sessions', activeSessionId);

      sessionUnsubRef.current = onSnapshot(
        sessionDocRef,
        (snap) => {
          if (!snap.exists()) {
            handleRemotePartnerSkipped();
            return;
          }
          const sData = snap.data();
          if (sData.status === 'ended') {
            handleRemotePartnerSkipped();
            return;
          }

          isTransitioningSessionRef.current = false;

          const userAId = String(sData.userAId || '');
          const userBId = String(sData.userBId || '');
          setSessionParticipants({ userAId, userBId });

          const isUserA = userAId === currentUserId;
          const partnerUserId = isUserA ? userBId : userAId;
          const partnerName = isUserA ? sData.userBName : sData.userAName;
          const partnerRegion = isUserA ? sData.userBRegion : sData.userARegion;

          setPartner({
            userId: partnerUserId,
            displayName: partnerName || 'Member',
            region: partnerRegion || 'Sri Lanka',
          });
          setPartnerLeft(false);
          setStage('matched');
          setDiagnostics((prev) => ({
            ...prev,
            sessionId: activeSessionId,
            role: isUserA ? 'initiator' : 'answerer',
          }));

          if (autoStartVideo && !hasTriggeredInitialVideo && userAId && userBId) {
            hasTriggeredInitialVideo = true;
            startWebRtcForMatchedSession(activeSessionId, userAId, userBId);
          }
        },
        (err) => {
          handleFirestoreError(
            err,
            OperationType.GET,
            `matchmaking_sessions/${activeSessionId}`
          );
        }
      );

      subscribeToSessionMessages(activeSessionId);
    },
    [handleRemotePartnerSkipped, startWebRtcForMatchedSession, subscribeToSessionMessages]
  );

  // Helper to evaluate whether a waiting queue candidate matches both users' chosen preferences
  const findCompatibleCandidateFromDocs = useCallback(
    (
      queueDocs: Array<{ id: string; data: () => Record<string, unknown> }>,
      blockedIds: Set<string>,
      selectedMode: 'video' | 'text',
      requireTieBreaker: boolean
    ): { id: string; displayName: string; region: string } | null => {
      const now = Date.now();
      const myRegion = user.profile?.region || 'Sri Lanka';
      const myGender = user.gender || 'prefer_not_to_say';
      const wantGender = preferredGenderRef.current;
      const wantRegion = preferredRegionRef.current;

      const eligible: Array<{
        id: string;
        displayName: string;
        region: string;
        sameMode: boolean;
        isRecentlySkipped: boolean;
      }> = [];

      for (const candidateDoc of queueDocs) {
        const cData = candidateDoc.data();
        const candidateUid = candidateDoc.id;

        if (candidateUid === user.id) continue;
        if (blockedIds.has(candidateUid)) continue;

        const updatedAtObj = cData.updatedAt as { toDate?: () => Date } | undefined;
        const candidateTime = updatedAtObj?.toDate
          ? updatedAtObj.toDate().getTime()
          : now;
        if (now - candidateTime > 5 * 60 * 1000) continue;

        // Avoid dual-create race during background polling between two waiting peers
        if (requireTieBreaker && user.id > candidateUid && now - candidateTime < 3000) {
          continue;
        }

        // Check mutual gender preferences
        const candidateGender = String(cData.gender || '');
        const candidateWantGender = String(cData.preferredGender || 'any');
        if (wantGender !== 'any' && candidateGender && candidateGender !== wantGender) {
          continue;
        }
        if (
          candidateWantGender !== 'any' &&
          myGender &&
          myGender !== candidateWantGender
        ) {
          continue;
        }

        // Check mutual region preferences
        const candidateRegion = String(cData.region || 'Sri Lanka');
        const candidateWantRegion = String(cData.preferredRegion || 'any');
        if (wantRegion === 'my_region' && candidateRegion !== myRegion) {
          continue;
        }
        if (candidateWantRegion === 'my_region' && myRegion !== candidateRegion) {
          continue;
        }

        const isRecentlySkipped =
          candidateUid === lastSkippedPartnerIdRef.current &&
          now - lastSkippedAtRef.current < 6000;

        const candidateMode = String(cData.preferredMode || 'video');
        const sameMode = candidateMode === selectedMode;

        eligible.push({
          id: candidateUid,
          displayName: String(cData.displayName || 'Member'),
          region: candidateRegion,
          sameMode,
          isRecentlySkipped,
        });
      }

      // 1. Prefer candidates who were NOT just skipped and have the exact same mode preference
      const freshSameMode = eligible.find((c) => !c.isRecentlySkipped && c.sameMode);
      if (freshSameMode) return freshSameMode;

      // 2. Otherwise prefer any candidate who was NOT just skipped
      const freshAnyMode = eligible.find((c) => !c.isRecentlySkipped);
      if (freshAnyMode) return freshAnyMode;

      return null;
    },
    [user.gender, user.id, user.profile?.region]
  );

  // Atomically pair current user with a matched candidate and pre-create `/videoSessions/{sessionId}`
  const commitMatchBatchWithCandidate = useCallback(
    async (
      candidate: { id: string; displayName: string; region: string },
      selectedMode: 'video' | 'text'
    ) => {
      const newSessionId = `ses_${Date.now().toString(36)}_${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      const batch = writeBatch(db);
      const myRegion = user.profile?.region || 'Sri Lanka';

      // 1. Create matchmaking session (`userAId` is deterministic WebRTC Offer Initiator)
      const sessionRef = doc(db, 'matchmaking_sessions', newSessionId);
      batch.set(sessionRef, {
        sessionId: newSessionId,
        participants: [user.id, candidate.id],
        userAId: user.id,
        userBId: candidate.id,
        userAName: user.displayName,
        userBName: candidate.displayName,
        userARegion: myRegion,
        userBRegion: candidate.region || 'Sri Lanka',
        status: 'active',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      // 2. Atomically create `/videoSessions/{newSessionId}` in the same batch so neither peer ever races on setDoc()
      const videoSessionRef = doc(db, 'videoSessions', newSessionId);
      batch.set(videoSessionRef, {
        sessionId: newSessionId,
        initiatorId: user.id,
        answererId: candidate.id,
        status: 'waiting',
        initiatorReady: selectedMode === 'video',
        answererReady: false,
        offerType: '',
        offerSdp: '',
        answerType: '',
        answerSdp: '',
        offerRevision: 0,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      // 3. Update candidate's queue entry to `matched`
      const candidateQueueRef = doc(db, 'matchmaking_queue', candidate.id);
      batch.update(candidateQueueRef, {
        status: 'matched',
        sessionId: newSessionId,
        updatedAt: serverTimestamp(),
      });

      // 4. Write own queue entry as `matched`
      const ownQueueRef = doc(db, 'matchmaking_queue', user.id);
      batch.set(ownQueueRef, {
        userId: user.id,
        displayName: user.displayName,
        gender: user.gender || 'prefer_not_to_say',
        region: myRegion,
        preferredMode: selectedMode,
        preferredGender: preferredGenderRef.current,
        preferredRegion: preferredRegionRef.current,
        status: 'matched',
        sessionId: newSessionId,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      await batch.commit();

      setSessionId(newSessionId);
      subscribeToSessionState(newSessionId, user.id, selectedMode === 'video');
    },
    [subscribeToSessionState, user.displayName, user.gender, user.id, user.profile?.region]
  );

  // Join Firestore matchmaking queue in either Video+Audio or Text-Only mode using chosen preferences
  const handleStartMatching = useCallback(
    async (selectedMode: 'video' | 'text', keepFeedback = false) => {
      setPreferredMode(selectedMode);
      preferredModeRef.current = selectedMode;

      // Pre-warm STUN/TURN configuration while entering queue so WebRTC starts in 0ms
      prefetchIceServers();

      cleanupListeners();
      await closePeerConnectionKeepCamera(false);

      setPartner(null);
      setSessionParticipants(null);
      setPartnerLeft(false);
      setMessages([]);
      setWaitingElapsed(0);
      if (!keepFeedback) {
        setSafetyFeedback(null);
      }
      setCameraPermissionError(null);
      setMicPermissionError(null);

      // If user chose Video Chat, ensure 360p camera/mic is open so local preview & diagnostics stay live
      if (selectedMode === 'video') {
        const existingLive =
          localStreamRef.current &&
          localStreamRef.current.getTracks().some((t) => t.readyState === 'live');
        if (!existingLive) {
          stopLocalMediaTracks();
          const mediaRes = await request360pMediaStream(facingMode);
          if (!mediaRes.stream) {
            setCameraPermissionError(mediaRes.cameraError);
            setMicPermissionError(mediaRes.micError);
            setDiagnostics((prev) => ({
              ...prev,
              lastError:
                mediaRes.cameraError ||
                mediaRes.micError ||
                'Camera permission denied',
            }));
            isTransitioningSessionRef.current = false;
            return;
          }
          mediaRes.stream.getVideoTracks().forEach((t) => {
            t.enabled = cameraEnabled;
          });
          mediaRes.stream.getAudioTracks().forEach((t) => {
            t.enabled = micEnabled;
          });
          localStreamRef.current = mediaRes.stream;
        }
        setVideoCallActive(true);
        syncLocalStreamDiagnostics(localStreamRef.current, 'searching_queue...');
      } else {
        stopLocalMediaTracks();
        setVideoCallActive(false);
        setDiagnostics({
          ...INITIAL_DIAGNOSTICS_STATE,
          sessionId: 'searching_queue (text)...',
        });
      }

      setStage('waiting');
      isTransitioningSessionRef.current = false;

      waitTimerRef.current = window.setInterval(() => {
        setWaitingElapsed((prev) => prev + 1);
      }, 1000);

      try {
        // 1. Fetch user's blocked list so blocked users are never paired
        const blocksRef = collection(db, 'blocks');
        const blocksQuery = query(blocksRef, where('blockerId', '==', user.id));
        const blocksSnap = await getDocs(blocksQuery);
        const blockedIds = new Set<string>();
        blocksSnap.forEach((b) => {
          const bData = b.data();
          if (bData.blockedUserId) blockedIds.add(String(bData.blockedUserId));
        });

        // 2. Search matchmaking queue for another waiting real user matching preferences
        const queueCol = collection(db, 'matchmaking_queue');
        const waitingQuery = query(queueCol, where('status', '==', 'waiting'));
        const queueSnap = await getDocs(waitingQuery);

        const matchedCandidate = findCompatibleCandidateFromDocs(
          queueSnap.docs,
          blockedIds,
          selectedMode,
          false
        );

        if (matchedCandidate) {
          await commitMatchBatchWithCandidate(matchedCandidate, selectedMode);
        } else {
          const ownQueueRef = doc(db, 'matchmaking_queue', user.id);
          await setDoc(ownQueueRef, {
            userId: user.id,
            displayName: user.displayName,
            gender: user.gender || 'prefer_not_to_say',
            region: user.profile?.region || 'Sri Lanka',
            preferredMode: selectedMode,
            preferredGender: preferredGenderRef.current,
            preferredRegion: preferredRegionRef.current,
            status: 'waiting',
            sessionId: '',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });

          queueUnsubRef.current = onSnapshot(
            ownQueueRef,
            (snap) => {
              if (!snap.exists()) return;
              const qData = snap.data();
              if (qData.status === 'matched' && qData.sessionId) {
                if (queuePollTimerRef.current) {
                  window.clearInterval(queuePollTimerRef.current);
                  queuePollTimerRef.current = null;
                }
                setSessionId(qData.sessionId);
                subscribeToSessionState(
                  qData.sessionId,
                  user.id,
                  selectedMode === 'video'
                );
              }
            },
            (err) => {
              handleFirestoreError(err, OperationType.GET, `matchmaking_queue/${user.id}`);
            }
          );

          // Periodic background check while waiting so two skipped users or newly arriving compatible peers pair reliably
          queuePollTimerRef.current = window.setInterval(async () => {
            try {
              const latestSnap = await getDocs(waitingQuery);
              const candidate = findCompatibleCandidateFromDocs(
                latestSnap.docs,
                blockedIds,
                selectedMode,
                true
              );
              if (candidate) {
                if (queuePollTimerRef.current) {
                  window.clearInterval(queuePollTimerRef.current);
                  queuePollTimerRef.current = null;
                }
                await commitMatchBatchWithCandidate(candidate, selectedMode);
              }
            } catch {
              // Ignore transient poll errors if another peer just claimed the match
            }
          }, 3500);
        }
      } catch (err) {
        cleanupListeners();
        setStage('idle');
        handleFirestoreError(err, OperationType.WRITE, 'matchmaking_queue');
      }
    },
    [
      cameraEnabled,
      cleanupListeners,
      closePeerConnectionKeepCamera,
      commitMatchBatchWithCandidate,
      facingMode,
      findCompatibleCandidateFromDocs,
      micEnabled,
      stopLocalMediaTracks,
      subscribeToSessionState,
      syncLocalStreamDiagnostics,
      user.displayName,
      user.gender,
      user.id,
      user.profile?.region,
    ]
  );

  handleStartMatchingRef.current = handleStartMatching;

  // Toggle Camera Track
  const handleToggleCamera = () => {
    const next = !cameraEnabled;
    setCameraEnabled(next);
    if (localStreamRef.current) {
      localStreamRef.current.getVideoTracks().forEach((t) => {
        t.enabled = next;
      });
    }
    rtcControllerRef.current?.updateLocalTrackDiagnostics();
  };

  // Toggle Microphone Track
  const handleToggleMic = () => {
    const next = !micEnabled;
    setMicEnabled(next);
    if (localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach((t) => {
        t.enabled = next;
      });
    }
    rtcControllerRef.current?.updateLocalTrackDiagnostics();
  };

  // Switch Front/Back Camera on supported mobile devices
  const handleSwitchCameraFacing = async () => {
    const nextFacing: 'user' | 'environment' =
      facingMode === 'user' ? 'environment' : 'user';
    setFacingMode(nextFacing);

    if (!videoCallActive || !localStreamRef.current) return;

    const mediaRes = await request360pMediaStream(nextFacing);
    if (!mediaRes.stream) return;

    const newVideoTrack = mediaRes.stream.getVideoTracks()[0];
    if (!newVideoTrack) return;

    newVideoTrack.enabled = cameraEnabled;

    // Stop old video tracks and swap in new track
    const oldVideoTracks = localStreamRef.current.getVideoTracks();
    oldVideoTracks.forEach((t) => {
      localStreamRef.current?.removeTrack(t);
      t.stop();
    });
    localStreamRef.current.addTrack(newVideoTrack);

    // Stop unused audio track from the temporary stream
    mediaRes.stream.getAudioTracks().forEach((t) => t.stop());

    if (localVideoRef.current) {
      localVideoRef.current.srcObject = localStreamRef.current;
    }

    if (rtcControllerRef.current) {
      await rtcControllerRef.current.replaceVideoTrack(newVideoTrack);
    }
  };

  // Cancel waiting queue (only used when waiting in queue before matching)
  const handleCancelQueue = async () => {
    cleanupListeners();
    await teardownWebRtcCall(false);
    setStage('idle');
    setPartner(null);
    setSessionParticipants(null);
    setPartnerLeft(false);
    setSessionId(null);
    setMessages([]);
    await removeOwnQueueEntry();
  };

  // Skip current partner and immediately match both parties with someone new based on their chosen preferences
  const handleSkipStranger = async () => {
    if (isTransitioningSessionRef.current) return;
    isTransitioningSessionRef.current = true;

    const activeId = currentSessionIdRef.current;
    if (currentPartnerIdRef.current) {
      lastSkippedPartnerIdRef.current = currentPartnerIdRef.current;
      lastSkippedAtRef.current = Date.now();
    }

    cleanupListeners();
    await closePeerConnectionKeepCamera(true);

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
    await handleStartMatching(preferredModeRef.current, true);
  };

  // Send real-time text message during video/text call
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
      handleFirestoreError(
        err,
        OperationType.WRITE,
        `matchmaking_sessions/${sessionId}/messages/${newMsgId}`
      );
    }
  };

  // Submit safety report & immediately skip to next partner
  const handleSubmitReport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!partner) return;
    setIsSubmitting(true);
    const reportId = `rep_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 7)}`;
    const reportRef = doc(db, 'reports', reportId);

    try {
      await setDoc(reportRef, {
        id: reportId,
        reporterId: user.id,
        reportedUserId: partner.userId,
        contextType: videoCallActive ? 'random_video' : 'random_text',
        reason: reportReason,
        details: reportDetails.slice(0, 1000),
        status: 'open',
        createdAt: serverTimestamp(),
      });
      setReportModalOpen(false);
      setReportDetails('');
      setSafetyFeedback('Safety report submitted. Connecting you to someone new.');
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
            Spontaneous Video & Text Studio
          </h2>
          <p className="text-xs text-[#6d7a72] mt-1">
            Real 1-on-1 360p WebRTC video & live text pairing for verified adults in Sri Lanka.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => setShowDiagnostics((prev) => !prev)}
            className={`px-3.5 py-2 rounded-full text-xs font-extrabold inline-flex items-center gap-1.5 border transition-colors ${
              showDiagnostics
                ? 'bg-[#17221c] text-[#c5fa5a] border-[#17221c]'
                : 'bg-white text-[#14201b] border-[#d7ded5] hover:border-[#14201b]'
            }`}
          >
            <Activity className="w-3.5 h-3.5" />
            <span>WebRTC Diagnostics</span>
          </button>
        </div>
      </div>

      {/* Safety Feedback Toast */}
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

      {/* Camera / Microphone Permission Error Banner */}
      {(cameraPermissionError || micPermissionError) && (
        <div className="p-4 rounded-2xl bg-red-950/90 border border-red-500/40 text-red-100 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <div>
              <p className="font-extrabold text-white">Camera / Microphone Permission Required</p>
              <p className="text-red-200 mt-0.5">
                {cameraPermissionError || micPermissionError}
              </p>
            </div>
          </div>
          {stage === 'matched' && sessionId && sessionParticipants && (
            <button
              type="button"
              onClick={() =>
                startWebRtcForMatchedSession(
                  sessionId,
                  sessionParticipants.userAId,
                  sessionParticipants.userBId
                )
              }
              className="px-4 py-2 rounded-xl bg-[#c5fa5a] text-[#14201b] font-black text-xs shrink-0"
            >
              Retry Camera Access
            </button>
          )}
        </div>
      )}

      {/* Development WebRTC Diagnostics Panel */}
      {showDiagnostics && (
        <div className="p-5 rounded-[22px] bg-[#101417] text-white border border-[#28372e] shadow-lg space-y-3">
          <div className="flex items-center justify-between border-b border-white/10 pb-2.5">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-[#c5fa5a]" />
              <span className="text-xs font-black uppercase tracking-wider text-[#c5fa5a]">
                WebRTC Live Telemetry & Signaling Diagnostics (360p Cap)
              </span>
            </div>
            <span className="text-[11px] text-[#96a49a] font-mono">
              Target: 640×360 @ 24fps · Max ~500 kbps
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 text-xs">
            <div className="p-2.5 rounded-xl bg-white/5 border border-white/10">
              <span className="text-[10px] text-[#96a49a] block">Firebase Session ID</span>
              <span className="font-mono font-bold text-white truncate block">
                {diagnostics.sessionId}
              </span>
            </div>
            <div className="p-2.5 rounded-xl bg-white/5 border border-white/10">
              <span className="text-[10px] text-[#96a49a] block">Peer Role / Rev</span>
              <span className="font-mono font-bold text-[#c5fa5a]">
                {diagnostics.role.toUpperCase()} (rev {diagnostics.offerRevision})
              </span>
            </div>
            <div className="p-2.5 rounded-xl bg-white/5 border border-white/10">
              <span className="text-[10px] text-[#96a49a] block">Signaling State</span>
              <span className="font-mono font-bold text-white">
                {diagnostics.signalingState}
              </span>
            </div>
            <div className="p-2.5 rounded-xl bg-white/5 border border-white/10">
              <span className="text-[10px] text-[#96a49a] block">ICE Connection State</span>
              <span className="font-mono font-bold text-[#c5fa5a]">
                {diagnostics.iceConnectionState}
              </span>
            </div>
            <div className="p-2.5 rounded-xl bg-white/5 border border-white/10">
              <span className="text-[10px] text-[#96a49a] block">PeerConnection State</span>
              <span className="font-mono font-bold text-white">
                {diagnostics.peerConnectionState}
              </span>
            </div>
            <div className="p-2.5 rounded-xl bg-white/5 border border-white/10">
              <span className="text-[10px] text-[#96a49a] block">Local Video / Audio</span>
              <span className="font-mono font-bold text-white block truncate">
                V: {diagnostics.localVideoTrackState} | A: {diagnostics.localAudioTrackState}
              </span>
            </div>
            <div className="p-2.5 rounded-xl bg-white/5 border border-white/10">
              <span className="text-[10px] text-[#96a49a] block">Remote Video / Audio</span>
              <span className="font-mono font-bold text-white block truncate">
                V: {diagnostics.remoteVideoTrackState} | A: {diagnostics.remoteAudioTrackState}
              </span>
            </div>
            <div className="p-2.5 rounded-xl bg-white/5 border border-white/10">
              <span className="text-[10px] text-[#96a49a] block">Selected Candidate</span>
              <span className="font-mono font-bold text-[#c5fa5a]">
                {diagnostics.selectedCandidateType}
              </span>
            </div>
            <div className="p-2.5 rounded-xl bg-white/5 border border-white/10">
              <span className="text-[10px] text-[#96a49a] block">Outgoing Resolution</span>
              <span className="font-mono font-bold text-white">
                {diagnostics.outgoingResolution}
              </span>
            </div>
            <div className="p-2.5 rounded-xl bg-white/5 border border-white/10">
              <span className="text-[10px] text-[#96a49a] block">Outgoing Bitrate</span>
              <span className="font-mono font-bold text-[#c5fa5a]">
                {diagnostics.outgoingBitrateKbps} kbps
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-[11px] text-[#96a49a]">
            <span>
              TURN Relay:{' '}
              <strong className="text-white">
                {diagnostics.turnConfigured
                  ? `Active (${diagnostics.turnProvider})`
                  : 'STUN-Only Mode (Direct P2P; restrictive symmetric NATs require TURN)'}
              </strong>
            </span>
            {diagnostics.lastError && (
              <span className="text-red-400 font-bold">
                Error: {diagnostics.lastError}
              </span>
            )}
          </div>
        </div>
      )}

      {/* MAIN STUDIO GRID */}
      <div className="grid grid-cols-1 lg:grid-cols-12 rounded-[26px] overflow-hidden bg-[#101417] text-white border border-[#222d26] shadow-2xl min-h-[540px]">
        {/* Left 7 Columns: Live WebRTC Video Stage */}
        <div className="lg:col-span-7 relative min-h-[460px] flex flex-col justify-between p-6 border-b lg:border-b-0 lg:border-r border-white/10 overflow-hidden">
          {stage === 'idle' && (
            <div className="m-auto text-center max-w-md space-y-6 py-8">
              <span className="brand-leaf mx-auto text-[#c5fa5a] text-3xl">✦</span>
              <div className="space-y-2">
                <h3 className="font-outfit font-extrabold text-3xl text-white">
                  How would you like to meet?
                </h3>
                <p className="text-sm text-[#b4c0b7] leading-relaxed">
                  Choose your matching preferences and start live 360p camera + audio calling
                  or a relaxed text-only conversation.
                </p>
              </div>

              {/* Match Preferences Selector (Preserved across skips) */}
              <div className="p-4 rounded-2xl bg-white/5 border border-white/10 text-left space-y-3">
                <div className="flex items-center gap-1.5 text-xs font-extrabold text-[#c5fa5a]">
                  <SlidersHorizontal className="w-3.5 h-3.5" />
                  <span>Match Preferences (kept automatically when skipping)</span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-bold text-[#96a49a] mb-1">
                      Match With
                    </label>
                    <select
                      value={preferredGender}
                      onChange={(e) =>
                        setPreferredGender(e.target.value as GenderPreference)
                      }
                      className="w-full bg-[#17221c] border border-white/15 rounded-xl px-3 py-2 text-xs font-bold text-white focus:outline-none focus:border-[#c5fa5a]"
                    >
                      <option value="any">Everyone</option>
                      <option value="female">Women</option>
                      <option value="male">Men</option>
                      <option value="non_binary">Non-Binary</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-[11px] font-bold text-[#96a49a] mb-1">
                      Region Filter
                    </label>
                    <select
                      value={preferredRegion}
                      onChange={(e) =>
                        setPreferredRegion(e.target.value as RegionPreference)
                      }
                      className="w-full bg-[#17221c] border border-white/15 rounded-xl px-3 py-2 text-xs font-bold text-white focus:outline-none focus:border-[#c5fa5a]"
                    >
                      <option value="any">All Sri Lanka</option>
                      <option value="my_region">
                        Same Region ({user.profile?.region || 'Sri Lanka'})
                      </option>
                    </select>
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => handleStartMatching('video')}
                  className="px-6 py-4 bg-[#c5fa5a] hover:bg-[#d2ff75] text-[#14201b] font-black text-sm rounded-[15px] inline-flex items-center gap-2 transition-all shadow-lg"
                >
                  <Video className="w-4 h-4 text-[#14201b]" />
                  <span>Start 360p Video Chat ↗</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleStartMatching('text')}
                  className="px-6 py-4 bg-white/10 hover:bg-white/15 border border-white/30 text-white font-extrabold text-sm rounded-[15px] inline-flex items-center gap-2 transition-colors"
                >
                  <Sparkles className="w-4 h-4 text-[#c5fa5a]" />
                  <span>Start Text-Only Chat</span>
                </button>
              </div>
            </div>
          )}

          {stage === 'waiting' && (
            <div className="m-auto text-center max-w-sm space-y-5 py-8">
              <div className="relative w-14 h-14 mx-auto">
                <div className="w-14 h-14 rounded-full border-2 border-[#c5fa5a] border-t-transparent animate-spin" />
                <Clock className="w-5 h-5 text-[#c5fa5a] absolute inset-0 m-auto" />
              </div>
              <div className="space-y-1.5">
                <p className="font-outfit font-extrabold text-2xl text-white">
                  Searching for someone online...
                </p>
                <p className="text-xs text-[#96a49a]">
                  Matching on your preferences ({preferredMode.toUpperCase()} ·{' '}
                  {preferredGender === 'any' ? 'Everyone' : preferredGender} ·{' '}
                  {preferredRegion === 'any'
                    ? 'All Sri Lanka'
                    : user.profile?.region || 'Same Region'}
                  )
                </p>
                <div className="inline-block px-3 py-1 rounded-full bg-white/5 text-xs font-mono text-[#c5fa5a]">
                  Queue time: {waitingElapsed}s
                </div>
              </div>

              {preferredMode === 'video' && videoCallActive && (
                <div className="space-y-3">
                  <div className="w-52 h-32 mx-auto rounded-2xl overflow-hidden border-2 border-[#c5fa5a]/60 bg-[#17221c] relative shadow-xl">
                    <video
                      ref={attachLocalVideo}
                      autoPlay
                      playsInline
                      muted
                      className={`w-full h-full object-cover ${
                        cameraEnabled ? '' : 'hidden'
                      }`}
                    />
                    {!cameraEnabled && (
                      <div className="w-full h-full flex items-center justify-center text-xs font-bold text-[#96a49a]">
                        Camera Off
                      </div>
                    )}
                    <span className="absolute top-2 right-2 px-2 py-0.5 rounded-full bg-red-600/90 text-white text-[10px] font-black inline-flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-white animate-ping" />
                      <span>360p READY</span>
                    </span>
                    <span className="absolute bottom-1.5 left-2 text-[10px] font-bold text-[#c5fa5a] bg-black/70 px-2 py-0.5 rounded">
                      Your 360p Preview
                    </span>
                  </div>

                  <div className="flex items-center justify-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        handleToggleCamera();
                        syncLocalStreamDiagnostics(localStreamRef.current);
                      }}
                      className="px-3 py-1.5 rounded-xl bg-white/10 hover:bg-white/15 border border-white/20 text-xs font-bold inline-flex items-center gap-1.5"
                    >
                      {cameraEnabled ? (
                        <Video className="w-3.5 h-3.5 text-[#c5fa5a]" />
                      ) : (
                        <VideoOff className="w-3.5 h-3.5 text-red-400" />
                      )}
                      <span>{cameraEnabled ? 'Camera On' : 'Camera Off'}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        handleToggleMic();
                        syncLocalStreamDiagnostics(localStreamRef.current);
                      }}
                      className="px-3 py-1.5 rounded-xl bg-white/10 hover:bg-white/15 border border-white/20 text-xs font-bold inline-flex items-center gap-1.5"
                    >
                      {micEnabled ? (
                        <Mic className="w-3.5 h-3.5 text-[#c5fa5a]" />
                      ) : (
                        <MicOff className="w-3.5 h-3.5 text-red-400" />
                      )}
                      <span>{micEnabled ? 'Mic On' : 'Muted'}</span>
                    </button>
                  </div>
                </div>
              )}

              <div>
                <button
                  type="button"
                  onClick={handleCancelQueue}
                  className="px-5 py-2.5 rounded-xl bg-white/10 hover:bg-white/15 text-xs font-bold text-white transition-colors"
                >
                  Change Preferences
                </button>
              </div>
            </div>
          )}

          {stage === 'matched' && partner && (
            <>
              {/* REMOTE VIDEO STREAM OR STATUS STAGE */}
              <div className="absolute inset-0 bg-[#0b0f0d] flex items-center justify-center overflow-hidden">
                <video
                  ref={attachRemoteVideo}
                  autoPlay
                  playsInline
                  className={`w-full h-full object-cover transition-opacity duration-200 ${
                    videoCallActive && (callStatus === 'connected' || hasRemoteStream)
                      ? 'opacity-100'
                      : 'opacity-0 pointer-events-none'
                  }`}
                />

                {/* Overlay states when remote video is not yet rendering */}
                {(!videoCallActive || (callStatus !== 'connected' && !hasRemoteStream)) && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center p-8 text-center bg-[#0e1411]">
                    <div className="max-w-md space-y-4">
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
                      </div>

                      {!videoCallActive && !partnerLeft && (
                        <div className="space-y-3 pt-2">
                          <p className="text-xs text-[#b4c0b7]">
                            {partnerVideoReady
                              ? `${partner.displayName} has enabled video and is waiting for you to join.`
                              : 'You are in text mode. Click below to start live 360p camera & audio.'}
                          </p>
                          {sessionId && sessionParticipants && (
                            <button
                              type="button"
                              onClick={() =>
                                startWebRtcForMatchedSession(
                                  sessionId,
                                  sessionParticipants.userAId,
                                  sessionParticipants.userBId
                                )
                              }
                              className="px-5 py-3 rounded-xl bg-[#c5fa5a] hover:bg-[#d2ff75] text-[#14201b] font-black text-xs inline-flex items-center gap-2 shadow-lg"
                            >
                              <Video className="w-4 h-4" />
                              <span>
                                {partnerVideoReady ? 'Accept & Start 360p Video' : 'Start 360p Video'}
                              </span>
                            </button>
                          )}
                        </div>
                      )}

                      {videoCallActive &&
                        (callStatus === 'waiting_partner' || callStatus === 'connecting') &&
                        !hasRemoteStream &&
                        !partnerLeft && (
                          <div className="p-4 rounded-2xl bg-white/5 border border-white/10 space-y-2">
                            <div className="w-5 h-5 rounded-full border-2 border-[#c5fa5a] border-t-transparent animate-spin mx-auto" />
                            <p className="text-xs font-bold text-[#c5fa5a]">
                              Connecting 360p video with {partner.displayName}...
                            </p>
                            <p className="text-[11px] text-[#96a49a]">
                              Exchanging encrypted peer-to-peer stream via Cloud Firestore
                            </p>
                          </div>
                        )}

                      {videoCallActive && callStatus === 'failed' && !partnerLeft && (
                        <div className="p-4 rounded-2xl bg-red-950/70 border border-red-500/40 space-y-2.5">
                          <p className="text-xs font-extrabold text-red-200">
                            Video Connection Could Not Be Established
                          </p>
                          <p className="text-[11px] text-red-300">
                            {diagnostics.lastError ||
                              'NAT traversal failed. You can retry ICE negotiation or continue chatting via text.'}
                          </p>
                          {sessionId && sessionParticipants && (
                            <button
                              type="button"
                              onClick={() =>
                                startWebRtcForMatchedSession(
                                  sessionId,
                                  sessionParticipants.userAId,
                                  sessionParticipants.userBId
                                )
                              }
                              className="px-4 py-2 rounded-xl bg-[#c5fa5a] text-[#14201b] text-xs font-black"
                            >
                              Retry Video Connection
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                <div className="absolute inset-0 bg-gradient-to-t from-[#101417]/90 via-transparent to-[#101417]/60 pointer-events-none" />
              </div>

              {/* Bottom Controls + Local Picture-in-Picture Preview */}
              <div className="relative z-10 mt-auto space-y-4">
                <div className="flex items-end justify-between gap-4">
                  <div className="bg-black/60 backdrop-blur-md p-3.5 rounded-2xl border border-white/10">
                    <p className="font-outfit font-extrabold text-xl text-white">
                      {partner.displayName}
                    </p>
                    <p className="text-xs text-[#c5fa5a] font-bold mt-0.5">
                      {partner.region} ·{' '}
                      {callStatus === 'connected' || hasRemoteStream
                        ? `Live 360p (${diagnostics.outgoingResolution})`
                        : 'Text Chat Active'}
                    </p>
                  </div>

                  {/* Local Picture-in-Picture (PiP) Muted Preview */}
                  {videoCallActive && (
                    <div className="w-36 h-24 sm:w-44 sm:h-28 rounded-2xl overflow-hidden border-2 border-[#c5fa5a]/70 bg-[#17221c] relative shrink-0 shadow-2xl">
                      <video
                        ref={attachLocalVideo}
                        autoPlay
                        playsInline
                        muted
                        className={`w-full h-full object-cover ${
                          cameraEnabled ? '' : 'hidden'
                        }`}
                      />
                      {!cameraEnabled && (
                        <div className="w-full h-full flex items-center justify-center text-[11px] font-bold text-[#96a49a]">
                          Camera Paused
                        </div>
                      )}
                      <span className="absolute bottom-1.5 left-2 text-[10px] font-bold text-[#c5fa5a] bg-black/70 px-2 py-0.5 rounded">
                        You (360p)
                      </span>
                    </div>
                  )}
                </div>

                {/* Media & Session Action Bar (Report and Skip at bottom right, no End Call button) */}
                <div className="pt-3 border-t border-white/15 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    {videoCallActive ? (
                      <button
                        type="button"
                        onClick={handleSwitchCameraFacing}
                        title="Switch front/back camera on mobile devices"
                        className="px-3 py-2 rounded-xl bg-white/10 hover:bg-white/15 border border-white/20 text-xs font-bold inline-flex items-center gap-1.5 transition-colors"
                      >
                        <SwitchCamera className="w-3.5 h-3.5 text-[#c5fa5a]" />
                        <span className="hidden sm:inline">Flip</span>
                      </button>
                    ) : (
                      sessionId &&
                      sessionParticipants &&
                      !partnerLeft && (
                        <button
                          type="button"
                          onClick={() =>
                            startWebRtcForMatchedSession(
                              sessionId,
                              sessionParticipants.userAId,
                              sessionParticipants.userBId
                            )
                          }
                          className="px-4 py-2 rounded-xl bg-[#c5fa5a] hover:bg-[#d2ff75] text-[#14201b] text-xs font-black inline-flex items-center gap-1.5 transition-colors"
                        >
                          <Video className="w-3.5 h-3.5" />
                          <span>Start 360p Video</span>
                        </button>
                      )
                    )}
                  </div>

                  <div className="flex items-center gap-2 ml-auto">
                    <button
                      type="button"
                      onClick={() => setReportModalOpen(true)}
                      className="px-3.5 py-2 rounded-xl bg-black/65 hover:bg-black/80 border border-white/20 text-xs font-bold inline-flex items-center gap-1.5 transition-colors"
                    >
                      <ShieldAlert className="w-3.5 h-3.5 text-[#c5fa5a]" />
                      <span>Report</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleSkipStranger}
                      className="px-4 py-2 rounded-xl bg-[#c5fa5a] hover:bg-[#d2ff75] text-[#14201b] text-xs font-black inline-flex items-center gap-1.5 transition-colors shadow-md"
                    >
                      <SkipForward className="w-3.5 h-3.5" />
                      <span>Skip</span>
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Right 5 Columns: Real-Time Ephemeral Session Chat */}
        <div className="lg:col-span-5 flex flex-col justify-between h-[480px] lg:h-auto bg-[#141c18]">
          <div className="p-4 border-b border-white/10 flex items-center justify-between">
            <div>
              <p className="text-sm font-bold text-white">
                {partner ? `Live Chat with ${partner.displayName}` : 'Live Session Chat'}
              </p>
              <p className="text-[11px] text-[#96a49a]">
                Ephemeral text messages · Active alongside video
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
                Start a 360p video or text session to chat with someone new.
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
                  Say hello in text chat while your video session is active.
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
                  : 'Connect first to send messages...'
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
              Reports are audited by our Trust & Safety moderation team and immediately terminate the current video/text session.
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
                  <option value="inappropriate_video">Inappropriate camera conduct</option>
                  <option value="underage_concern">Suspected underage user (&lt;18)</option>
                  <option value="spam_or_scam">Spam or solicitation</option>
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
