/**
 * ONCE UPON A TIME (OUAT) — CLOUDFLARE DURABLE OBJECT MATCHMAKING ENGINE
 *
 * Guarantees:
 * 1. Real Cloudflare WebSocket Upgrade (`WebSocketPair` + HTTP 101 response)
 * 2. Cryptographic session token verification (`verifyStatelessToken`); never trusts client IDs
 * 3. Atomic single-threaded queue coordination (Durable Object execution model)
 * 4. Zero duplicate session assignment & clean reconnection handling
 * 5. Mutual block filtering: blocked pairs are never matched together
 * 6. Ephemeral peer tokens: internal user IDs are never exposed to strangers
 * 7. Authenticated WebRTC SDP Offer/Answer + ICE Candidate + Chat/Typing/Media relay
 */

import crypto from 'node:crypto';
import {
  verifyStatelessToken,
  EDGE_BLOCKS,
  type AuthEnv,
} from './edge-auth';

export interface QueueParticipant {
  connectionId: string;
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

interface CloudflareWebSocketPair {
  0: WebSocket;
  1: WebSocket;
}

function createWebSocketUpgradeResponse(clientSocket: WebSocket): Response {
  try {
    return new Response(null, {
      status: 101,
      webSocket: clientSocket,
    } as ResponseInit & { webSocket: WebSocket });
  } catch {
    // Fallback for Node.js test runner where undici Response restricts status 101
    const res = new Response(null, { status: 200 });
    Object.defineProperty(res, 'status', { value: 101 });
    Object.defineProperty(res, 'webSocket', { value: clientSocket });
    return res;
  }
}

export class MatchmakerDurableObject {
  private clientsByUser: Map<string, QueueParticipant> = new Map();
  private waitingQueue: Map<string, QueueParticipant> = new Map();
  private userToSessionId: Map<string, string> = new Map();
  private activeSessions: Map<string, ActiveStrangerSession> = new Map();
  private readonly env: AuthEnv;

  constructor(
    private readonly state: unknown,
    env?: AuthEnv
  ) {
    this.env = env || {};
  }

  /**
   * Cloudflare Durable Object HTTP & WebSocket Entrypoint
   */
  public async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Internal operational metrics endpoint for /api/health and /api/admin/overview
    if (url.pathname === '/internal/stats' && request.method === 'GET') {
      return new Response(JSON.stringify(this.getOperationalStats()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Internal peer resolution for Trust & Safety block/report during active random chat
    if (url.pathname === '/internal/resolve-peer' && request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as {
        sessionId?: string;
        reporterUserId?: string;
        endSession?: boolean;
      };
      const peerUserId = this.resolvePeerToUserId(
        String(body.sessionId || ''),
        String(body.reporterUserId || '')
      );
      if (body.endSession && body.reporterUserId) {
        this.leaveAll(body.reporterUserId, 'end');
      }
      return new Response(JSON.stringify({ peerUserId }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Validate WebSocket Upgrade header
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      return new Response(
        JSON.stringify({ error: 'Expected Upgrade: websocket header.' }),
        {
          status: 426,
          headers: {
            'Content-Type': 'application/json',
            Upgrade: 'websocket',
          },
        }
      );
    }

    // Extract & cryptographically verify session token (never trust client-supplied user IDs)
    const queryToken = url.searchParams.get('token') || '';
    const authHeader = request.headers.get('Authorization') || '';
    const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    const rawToken = queryToken || (bearerMatch ? bearerMatch[1].trim() : '');

    if (!rawToken) {
      return new Response(
        JSON.stringify({ error: 'Authentication required: missing session token.' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const verifiedUser = verifyStatelessToken(rawToken, this.env);
    if (!verifiedUser) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized: invalid or expired session token.' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (verifiedUser.accountStatus !== 'active') {
      return new Response(
        JSON.stringify({ error: 'Forbidden: account is not active.' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Create Cloudflare WebSocketPair
    const PairConstructor = (
      globalThis as unknown as { WebSocketPair?: new () => CloudflareWebSocketPair }
    ).WebSocketPair;

    if (!PairConstructor) {
      return new Response(
        JSON.stringify({ error: 'WebSocketPair runtime API unavailable.' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const pair = new PairConstructor();
    const clientSocket = pair[0];
    const serverSocket = pair[1];

    // Accept the WebSocket inside the Durable Object
    const cfServerSocket = serverSocket as WebSocket & { accept?: () => void };
    if (typeof cfServerSocket.accept === 'function') {
      cfServerSocket.accept();
    }

    const blockedUserIds = EDGE_BLOCKS.filter(
      (b) => b.blockerId === verifiedUser.id || b.blockedUserId === verifiedUser.id
    ).map((b) => (b.blockerId === verifiedUser.id ? b.blockedUserId : b.blockerId));

    const connectionId = `conn_${crypto.randomUUID().slice(0, 12)}`;
    const participant: QueueParticipant = {
      connectionId,
      userId: verifiedUser.id,
      ephemeralPeerId: `peer_${crypto.randomUUID().slice(0, 8)}`,
      displayName: verifiedUser.displayName.split(' ')[0] || verifiedUser.displayName,
      region: verifiedUser.profile.showRegion ? verifiedUser.profile.region : '',
      mode: 'video',
      interests: verifiedUser.interests.map((i) => i.label_en),
      blockedUserIds,
      joinedAt: Date.now(),
      socket: serverSocket,
    };

    // Reconnection / duplicate connection cleanup: close any previous socket for this user
    const existingParticipant = this.clientsByUser.get(verifiedUser.id);
    if (existingParticipant && existingParticipant.connectionId !== connectionId) {
      this.leaveAll(verifiedUser.id, 'disconnect');
      try {
        existingParticipant.socket.close(1000, 'Replaced by newer connection');
      } catch {
        // Ignore already-closed socket
      }
    }

    this.clientsByUser.set(verifiedUser.id, participant);

    // Attach WebSocket lifecycle listeners
    this.attachSocketListeners(participant);

    // Confirm connection established to client
    this.safeSend(serverSocket, {
      type: 'connection:established',
      ephemeralPeerId: participant.ephemeralPeerId,
      stats: this.getOperationalStats(),
    });

    return createWebSocketUpgradeResponse(clientSocket);
  }

  public getOperationalStats() {
    return {
      connectedSockets: this.clientsByUser.size,
      waitingInQueue: this.waitingQueue.size,
      activeStrangerSessions: this.activeSessions.size,
    };
  }

  public resolvePeerToUserId(sessionId: string, reporterUserId: string): string | null {
    const session = this.activeSessions.get(sessionId);
    if (!session) return null;
    if (session.userA.userId === reporterUserId) return session.userB.userId;
    if (session.userB.userId === reporterUserId) return session.userA.userId;
    return null;
  }

  private attachSocketListeners(participant: QueueParticipant): void {
    const { socket, userId, connectionId } = participant;

    socket.addEventListener('message', (event: MessageEvent) => {
      try {
        const rawData =
          typeof event.data === 'string'
            ? event.data
            : event.data instanceof ArrayBuffer
            ? new TextDecoder().decode(event.data)
            : String(event.data);
        const msg = JSON.parse(rawData) as Record<string, unknown>;
        this.handleClientMessage(participant, msg);
      } catch {
        // Ignore malformed JSON frames
      }
    });

    const handleCleanup = () => {
      // Only clean up if this connection is still the active one for this user
      const current = this.clientsByUser.get(userId);
      if (current && current.connectionId === connectionId) {
        this.leaveAll(userId, 'disconnect');
        this.clientsByUser.delete(userId);
      } else {
        // Still ensure waitingQueue doesn't hold a stale reference to this connection
        const queued = this.waitingQueue.get(userId);
        if (queued && queued.connectionId === connectionId) {
          this.waitingQueue.delete(userId);
        }
      }
    };

    socket.addEventListener('close', handleCleanup);
    socket.addEventListener('error', handleCleanup);
  }

  private handleClientMessage(
    participant: QueueParticipant,
    msg: Record<string, unknown>
  ): void {
    const type = String(msg.type || '');

    if (type === 'queue:join') {
      const mode: 'video' | 'text' = msg.mode === 'text' ? 'text' : 'video';
      participant.mode = mode;
      participant.joinedAt = Date.now();
      // Refresh block list on queue join
      participant.blockedUserIds = EDGE_BLOCKS.filter(
        (b) => b.blockerId === participant.userId || b.blockedUserId === participant.userId
      ).map((b) => (b.blockerId === participant.userId ? b.blockedUserId : b.blockerId));
      this.enqueueAndMatch(participant);
      return;
    }

    if (type === 'queue:leave') {
      this.leaveAll(participant.userId, 'end');
      this.safeSend(participant.socket, { type: 'queue:left' });
      return;
    }

    if (type === 'stranger:skip') {
      const mode: 'video' | 'text' =
        msg.mode === 'text' ? 'text' : msg.mode === 'video' ? 'video' : participant.mode;
      participant.mode = mode;
      participant.joinedAt = Date.now();
      this.leaveAll(participant.userId, 'skip');
      this.enqueueAndMatch(participant);
      return;
    }

    if (type === 'stranger:end') {
      this.leaveAll(participant.userId, 'end');
      this.safeSend(participant.socket, { type: 'stranger:ended' });
      return;
    }

    if (
      type === 'webrtc:sdp' ||
      type === 'webrtc:ice' ||
      type === 'stranger:message' ||
      type === 'stranger:typing' ||
      type === 'stranger:media-state'
    ) {
      this.relaySessionPayload(participant.userId, {
        type,
        sessionId: String(msg.sessionId || ''),
        data: msg.data,
      });
    }
  }

  /**
   * Atomically removes user from any existing waiting queue or active session
   * before placing them into a new queue or cleaning up on disconnect.
   */
  public leaveAll(
    userId: string,
    reason: 'skip' | 'end' | 'disconnect' = 'disconnect'
  ): void {
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

      // Verify candidate is still connected in clientsByUser
      const activeCandidate = this.clientsByUser.get(candidate.userId);
      if (!activeCandidate || activeCandidate.connectionId !== candidate.connectionId) {
        this.waitingQueue.delete(candidate.userId);
        continue;
      }

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
        waitingCount: this.waitingQueue.size,
      });
      return;
    }

    // Remove candidate from queue atomically
    this.waitingQueue.delete(matchedCandidate.userId);

    const sessionId = `ouat_rt_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
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

    // Notify User A (SDP Offer initiator for WebRTC)
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
   * Relays WebRTC SDP offers/answers, ICE candidates, or ephemeral text/typing/media-state messages
   * strictly within an authenticated active session between the two matched partners.
   */
  public relaySessionPayload(
    senderUserId: string,
    payload: {
      type:
        | 'webrtc:sdp'
        | 'webrtc:ice'
        | 'stranger:message'
        | 'stranger:typing'
        | 'stranger:media-state';
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

    const isUserA = session.userA.userId === senderUserId;
    const isUserB = session.userB.userId === senderUserId;
    if (!isUserA && !isUserB) return;

    const sender = isUserA ? session.userA : session.userB;
    const partner = isUserA ? session.userB : session.userA;

    this.safeSend(partner.socket, {
      type: payload.type,
      sessionId: session.sessionId,
      fromPeerId: sender.ephemeralPeerId,
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
