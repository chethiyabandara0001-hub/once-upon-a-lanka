/**
 * ONCE UPON A TIME (OUAT) — CLOUDFLARE DURABLE OBJECT MATCHMAKING ENGINE
 *
 * Guarantees:
 * 1. Atomic single-threaded queue coordination (Durable Object execution model)
 * 2. Zero duplicate session assignment: a user can never be in two sessions at once
 * 3. Mutual block filtering: blocked pairs are never matched together
 * 4. Ephemeral session tokens: internal database IDs are never exposed to strangers
 * 5. Clean WebRTC SDP Offer/Answer + ICE Candidate relay & automatic disconnect cleanup
 */

export interface QueueParticipant {
  userId: string;
  ephemeralPeerId: string;
  displayName: string;
  region?: string;
  mode: 'video' | 'text';
  interests: string[];
  blockedUserIds: string[];
  joinedAt: number;
  socket: WebSocket;
}

export interface ActiveStrangerSession {
  sessionId: string;
  mode: 'video' | 'text';
  startedAt: number;
  userA: QueueParticipant;
  userB: QueueParticipant;
}

export class MatchmakerDurableObject {
  private waitingQueue: Map<string, QueueParticipant> = new Map();
  private userToSessionId: Map<string, string> = new Map();
  private activeSessions: Map<string, ActiveStrangerSession> = new Map();

  constructor(private readonly state: unknown) {}

  /**
   * Atomically removes user from any existing waiting queue or active session
   * before placing them into a new queue or cleaning up on disconnect.
   */
  public leaveAll(userId: string, reason: 'skip' | 'end' | 'disconnect' = 'disconnect'): void {
    this.waitingQueue.delete(userId);

    const existingSessionId = this.userToSessionId.get(userId);
    if (!existingSessionId) return;

    const session = this.activeSessions.get(existingSessionId);
    this.activeSessions.delete(existingSessionId);
    this.userToSessionId.delete(userId);

    if (session) {
      const partner = session.userA.userId === userId ? session.userB : session.userA;
      this.userToSessionId.delete(partner.userId);
      this.safeSend(partner.socket, {
        type: 'stranger:disconnected',
        sessionId: session.sessionId,
        reason,
      });
    }
  }

  /**
   * Atomically enqueues a participant or pairs them immediately with a compatible waiting user.
   */
  public enqueueAndMatch(participant: QueueParticipant): void {
    // Enforce invariant: user can never hold multiple simultaneous sessions
    this.leaveAll(participant.userId, 'skip');

    let matchedCandidate: QueueParticipant | null = null;
    let bestSharedInterests = -1;

    for (const candidate of this.waitingQueue.values()) {
      if (candidate.userId === participant.userId) continue;
      if (candidate.mode !== participant.mode) continue;

      // Enforce block list bidirectionally
      const blockedByParticipant = participant.blockedUserIds.includes(candidate.userId);
      const blockedByCandidate = candidate.blockedUserIds.includes(participant.userId);
      if (blockedByParticipant || blockedByCandidate) continue;

      const sharedCount = candidate.interests.filter((i) =>
        participant.interests.includes(i)
      ).length;

      if (sharedCount > bestSharedInterests) {
        bestSharedInterests = sharedCount;
        matchedCandidate = candidate;
      }
    }

    if (!matchedCandidate) {
      this.waitingQueue.set(participant.userId, participant);
      this.safeSend(participant.socket, {
        type: 'queue:waiting',
        mode: participant.mode,
        joinedAt: participant.joinedAt,
      });
      return;
    }

    // Remove candidate from queue atomically
    this.waitingQueue.delete(matchedCandidate.userId);

    const sessionId = `ouat_rt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const session: ActiveStrangerSession = {
      sessionId,
      mode: participant.mode,
      startedAt: Date.now(),
      userA: matchedCandidate,
      userB: participant,
    };

    this.activeSessions.set(sessionId, session);
    this.userToSessionId.set(matchedCandidate.userId, sessionId);
    this.userToSessionId.set(participant.userId, sessionId);

    const sharedInterests = matchedCandidate.interests.filter((i) =>
      participant.interests.includes(i)
    );

    // Notify User A (Polite caller / SDP Offer initiator for WebRTC)
    this.safeSend(matchedCandidate.socket, {
      type: 'match:found',
      sessionId,
      mode: session.mode,
      initiator: true,
      partner: {
        ephemeralPeerId: participant.ephemeralPeerId,
        displayName: participant.displayName,
        region: participant.region || null,
        sharedInterests,
      },
    });

    // Notify User B (SDP Answerer for WebRTC)
    this.safeSend(participant.socket, {
      type: 'match:found',
      sessionId,
      mode: session.mode,
      initiator: false,
      partner: {
        ephemeralPeerId: matchedCandidate.ephemeralPeerId,
        displayName: matchedCandidate.displayName,
        region: matchedCandidate.region || null,
        sharedInterests,
      },
    });
  }

  /**
   * Relays WebRTC SDP offers/answers, ICE candidates, or ephemeral text messages
   * strictly within an authenticated active session.
   */
  public relaySessionPayload(
    senderUserId: string,
    payload: {
      type: 'webrtc:sdp' | 'webrtc:ice' | 'stranger:message' | 'stranger:typing' | 'stranger:media-state';
      sessionId: string;
      data: unknown;
    }
  ): void {
    const activeSessionId = this.userToSessionId.get(senderUserId);
    if (!activeSessionId || activeSessionId !== payload.sessionId) {
      return;
    }
    const session = this.activeSessions.get(activeSessionId);
    if (!session) return;

    const partner = session.userA.userId === senderUserId ? session.userB : session.userA;
    this.safeSend(partner.socket, {
      type: payload.type,
      sessionId: session.sessionId,
      fromPeerId:
        session.userA.userId === senderUserId
          ? session.userA.ephemeralPeerId
          : session.userB.ephemeralPeerId,
      data: payload.data,
      timestamp: new Date().toISOString(),
    });
  }

  private safeSend(ws: WebSocket, message: Record<string, unknown>): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // Socket closed
    }
  }
}
