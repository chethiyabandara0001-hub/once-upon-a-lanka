/**
 * ONCE UPON A TIME (OUAT) — CLOUDFLARE DURABLE OBJECT MATCHMAKING ENGINE
 *
 * Production Guarantees:
 * 1. Cloudflare WebSocket Upgrade (`WebSocketPair` + HTTP 101 response)
 * 2. Full Cloudflare Durable Object WebSocket Hibernation API support:
 *    - `state.acceptWebSocket(serverSocket)` + `webSocketMessage` / `webSocketClose` / `webSocketError`
 *    - `ws.serializeAttachment()` / `ws.deserializeAttachment()` + `state.getWebSockets()`
 *    - Reconstructs `connections`, `waitingQueue`, and `activeSessions` automatically after hibernation
 *    - Graceful fallback to standard `serverSocket.accept()` in non-Cloudflare test runtimes
 * 3. Safe Heartbeat (`ping` -> `pong`) compatible with Cloudflare Durable Objects
 * 4. Connection-scoped state (`connectionId` + per-tab `clientId`):
 *    - Same-tab reconnections replace only that tab's stale socket
 *    - Disconnecting one user never closes the matched partner's signaling WebSocket
 * 5. Strict payload validation & sanitized lifecycle logging (never logs tokens or private messages)
 */

import crypto from 'node:crypto';
import {
  verifyStatelessToken,
  EDGE_BLOCKS,
  type AuthEnv,
} from './edge-auth';

export interface ParticipantAttachment {
  connectionId: string;
  clientId: string;
  userId: string;
  ephemeralPeerId: string;
  displayName: string;
  region?: string;
  mode: 'video' | 'text';
  interests: string[];
  blockedUserIds: string[];
  joinedAt: number;
  status: 'idle' | 'waiting' | 'matched';
  sessionId: string | null;
  partnerConnectionId: string | null;
  initiator: boolean;
}

export interface QueueParticipant extends ParticipantAttachment {
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

interface HibernatableWebSocket extends WebSocket {
  accept?: () => void;
  serializeAttachment?: (attachment: ParticipantAttachment) => void;
  deserializeAttachment?: () => ParticipantAttachment | null;
}

interface DurableObjectStateLike {
  id?: unknown;
  acceptWebSocket?: (ws: WebSocket, tags?: string[]) => void;
  getWebSockets?: (tag?: string) => WebSocket[];
  setWebSocketAutoResponse?: (pair: unknown) => void;
}

const ALLOWED_MESSAGE_TYPES = new Set([
  'ping',
  'queue:join',
  'queue:leave',
  'stranger:skip',
  'stranger:end',
  'webrtc:sdp',
  'webrtc:ice',
  'webrtc:ready',
  'stranger:message',
  'stranger:typing',
  'stranger:media-state',
]);

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
  private connections: Map<string, QueueParticipant> = new Map();
  private socketToConnectionId: WeakMap<WebSocket, string> = new WeakMap();
  private tabKeyToConnectionId: Map<string, string> = new Map();
  private waitingQueue: Map<string, QueueParticipant> = new Map();
  private connectionToSessionId: Map<string, string> = new Map();
  private activeSessions: Map<string, ActiveStrangerSession> = new Map();
  private readonly doState: DurableObjectStateLike | null;
  private readonly env: AuthEnv;

  constructor(state: unknown, env?: AuthEnv) {
    this.doState = (state as DurableObjectStateLike) || null;
    this.env = env || {};

    // Configure Cloudflare WebSocket Hibernation auto-response if supported by runtime
    try {
      const AutoResponsePair = (
        globalThis as unknown as {
          WebSocketRequestResponsePair?: new (req: string, res: string) => unknown;
        }
      ).WebSocketRequestResponsePair;
      if (
        this.doState &&
        typeof this.doState.setWebSocketAutoResponse === 'function' &&
        AutoResponsePair
      ) {
        this.doState.setWebSocketAutoResponse(
          new AutoResponsePair('{"type":"ping"}', '{"type":"pong"}')
        );
      }
    } catch {
      // Ignore if WebSocketRequestResponsePair is not available in test environment
    }
  }

  private usesHibernationApi(): boolean {
    return Boolean(
      this.doState &&
        typeof this.doState.acceptWebSocket === 'function' &&
        typeof this.doState.getWebSockets === 'function'
    );
  }

  /**
   * Persists participant metadata onto the WebSocket attachment so state survives
   * Cloudflare Durable Object hibernation.
   */
  private saveSocketAttachment(participant: QueueParticipant): void {
    const hSocket = participant.socket as HibernatableWebSocket;
    if (typeof hSocket.serializeAttachment === 'function') {
      try {
        const attachment: ParticipantAttachment = {
          connectionId: participant.connectionId,
          clientId: participant.clientId,
          userId: participant.userId,
          ephemeralPeerId: participant.ephemeralPeerId,
          displayName: participant.displayName,
          region: participant.region,
          mode: participant.mode,
          interests: participant.interests,
          blockedUserIds: participant.blockedUserIds,
          joinedAt: participant.joinedAt,
          status: participant.status,
          sessionId: participant.sessionId,
          partnerConnectionId: participant.partnerConnectionId,
          initiator: participant.initiator,
        };
        hSocket.serializeAttachment(attachment);
      } catch (err) {
        this.logEvent('attachment_error', {
          connectionId: participant.connectionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Reconstructs in-memory maps (`connections`, `waitingQueue`, `activeSessions`)
   * from hibernated WebSockets when the Durable Object wakes up.
   */
  private rehydrateFromHibernatedSockets(): void {
    if (!this.usesHibernationApi() || !this.doState?.getWebSockets) {
      return;
    }

    let sockets: WebSocket[] = [];
    try {
      sockets = this.doState.getWebSockets();
    } catch {
      return;
    }

    if (sockets.length === 0) return;

    // Fast path: if all active sockets are already in this.connections, no rehydration needed
    let needsRehydration = false;
    for (const ws of sockets) {
      if (!this.socketToConnectionId.has(ws)) {
        needsRehydration = true;
        break;
      }
    }
    if (!needsRehydration && this.connections.size === sockets.length) {
      return;
    }

    this.logEvent('hibernation_wakeup_rehydrate', { socketCount: sockets.length });

    const restoredParticipants: QueueParticipant[] = [];
    for (const ws of sockets) {
      const existingConnId = this.socketToConnectionId.get(ws);
      if (existingConnId && this.connections.has(existingConnId)) {
        restoredParticipants.push(this.connections.get(existingConnId)!);
        continue;
      }

      const hSocket = ws as HibernatableWebSocket;
      if (typeof hSocket.deserializeAttachment === 'function') {
        try {
          const meta = hSocket.deserializeAttachment();
          if (meta && meta.connectionId && meta.userId) {
            const participant: QueueParticipant = {
              ...meta,
              socket: ws,
            };
            this.connections.set(participant.connectionId, participant);
            this.socketToConnectionId.set(ws, participant.connectionId);
            this.tabKeyToConnectionId.set(
              `${participant.userId}:${participant.clientId}`,
              participant.connectionId
            );
            restoredParticipants.push(participant);
          }
        } catch {
          // Ignore corrupted attachment
        }
      }
    }

    // Rebuild waitingQueue and activeSessions from restored participant attachments
    for (const p of restoredParticipants) {
      if (p.status === 'waiting') {
        this.waitingQueue.set(p.connectionId, p);
      } else if (
        p.status === 'matched' &&
        p.sessionId &&
        p.partnerConnectionId &&
        !this.activeSessions.has(p.sessionId)
      ) {
        const partner = this.connections.get(p.partnerConnectionId);
        if (partner && partner.sessionId === p.sessionId) {
          const userA = p.initiator ? p : partner;
          const userB = p.initiator ? partner : p;
          this.activeSessions.set(p.sessionId, {
            sessionId: p.sessionId,
            mode: p.mode,
            startedAt: p.joinedAt || Date.now(),
            userA,
            userB,
          });
          this.connectionToSessionId.set(userA.connectionId, p.sessionId);
          this.connectionToSessionId.set(userB.connectionId, p.sessionId);
        } else {
          // Partner socket no longer exists after hibernation; reset to idle
          p.status = 'idle';
          p.sessionId = null;
          p.partnerConnectionId = null;
          this.saveSocketAttachment(p);
        }
      }
    }
  }

  private logEvent(event: string, meta: Record<string, unknown>): void {
    console.log(
      JSON.stringify({
        service: 'MatchmakerDurableObject',
        event,
        timestamp: new Date().toISOString(),
        ...meta,
      })
    );
  }

  /**
   * Cloudflare Durable Object HTTP & WebSocket Upgrade Entrypoint
   */
  public async fetch(request: Request): Promise<Response> {
    this.rehydrateFromHibernatedSockets();
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
        this.leaveByUserId(body.reporterUserId, 'end');
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
      this.logEvent('ws_auth_rejected', { reason: 'missing_token' });
      return new Response(
        JSON.stringify({ error: 'Authentication required: missing session token.' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const verifiedUser = verifyStatelessToken(rawToken, this.env);
    if (!verifiedUser) {
      this.logEvent('ws_auth_rejected', { reason: 'invalid_or_expired_token' });
      return new Response(
        JSON.stringify({ error: 'Unauthorized: invalid or expired session token.' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (verifiedUser.accountStatus !== 'active') {
      this.logEvent('ws_auth_rejected', {
        reason: 'account_not_active',
        userId: verifiedUser.id,
        status: verifiedUser.accountStatus,
      });
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
    const serverSocket = pair[1] as HibernatableWebSocket;

    const rawClientId = (url.searchParams.get('clientId') || '').trim();
    const connectionId = `conn_${crypto.randomUUID().slice(0, 12)}`;
    const clientId = rawClientId ? rawClientId.slice(0, 48) : connectionId;

    // Accept the WebSocket using Hibernation API when available, or standard accept() in test runtime
    if (this.usesHibernationApi() && this.doState?.acceptWebSocket) {
      this.doState.acceptWebSocket(serverSocket, [verifiedUser.id, connectionId]);
    } else {
      if (typeof serverSocket.accept === 'function') {
        serverSocket.accept();
      }
      this.attachStandardSocketListeners(serverSocket);
    }

    const blockedUserIds = EDGE_BLOCKS.filter(
      (b) => b.blockerId === verifiedUser.id || b.blockedUserId === verifiedUser.id
    ).map((b) => (b.blockerId === verifiedUser.id ? b.blockedUserId : b.blockerId));

    const participant: QueueParticipant = {
      connectionId,
      clientId,
      userId: verifiedUser.id,
      ephemeralPeerId: `peer_${crypto.randomUUID().slice(0, 8)}`,
      displayName: verifiedUser.displayName.split(' ')[0] || verifiedUser.displayName,
      region: verifiedUser.profile.showRegion ? verifiedUser.profile.region : '',
      mode: 'video',
      interests: verifiedUser.interests.map((i) => i.label_en),
      blockedUserIds,
      joinedAt: Date.now(),
      status: 'idle',
      sessionId: null,
      partnerConnectionId: null,
      initiator: false,
      socket: serverSocket,
    };

    // If the EXACT same browser tab (`userId:clientId`) reconnected, clean up only its prior stale socket
    const tabKey = `${verifiedUser.id}:${clientId}`;
    const priorConnectionId = this.tabKeyToConnectionId.get(tabKey);
    if (priorConnectionId && priorConnectionId !== connectionId) {
      const priorParticipant = this.connections.get(priorConnectionId);
      if (priorParticipant) {
        this.leaveConnection(priorConnectionId, 'disconnect');
        this.connections.delete(priorConnectionId);
        try {
          priorParticipant.socket.close(1000, 'Reconnected from same tab');
        } catch {
          // Ignore already-closed socket
        }
      }
    }

    this.connections.set(connectionId, participant);
    this.socketToConnectionId.set(serverSocket, connectionId);
    this.tabKeyToConnectionId.set(tabKey, connectionId);
    this.saveSocketAttachment(participant);

    this.logEvent('ws_connected', {
      connectionId,
      clientId,
      userId: verifiedUser.id,
      ephemeralPeerId: participant.ephemeralPeerId,
      connectedSockets: this.connections.size,
    });

    // Confirm connection established to client
    this.safeSend(serverSocket, {
      type: 'connection:established',
      connectionId,
      ephemeralPeerId: participant.ephemeralPeerId,
      stats: this.getOperationalStats(),
    });

    return createWebSocketUpgradeResponse(clientSocket);
  }

  /**
   * Cloudflare Durable Objects WebSocket Hibernation handler: incoming message
   */
  public async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer
  ): Promise<void> {
    this.rehydrateFromHibernatedSockets();
    const rawText =
      typeof message === 'string'
        ? message
        : message instanceof ArrayBuffer
        ? new TextDecoder().decode(message)
        : String(message);
    this.processSocketMessage(ws, rawText);
  }

  /**
   * Cloudflare Durable Objects WebSocket Hibernation handler: socket closed
   */
  public async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<void> {
    this.rehydrateFromHibernatedSockets();
    this.processSocketClose(ws, code, reason, wasClean);
    try {
      ws.close(code, reason);
    } catch {
      // Ignore if already closed
    }
  }

  /**
   * Cloudflare Durable Objects WebSocket Hibernation handler: socket error
   */
  public async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    this.rehydrateFromHibernatedSockets();
    const connId = this.resolveConnectionIdForSocket(ws);
    this.logEvent('ws_error', {
      connectionId: connId,
      error: error instanceof Error ? error.message : String(error),
    });
    this.processSocketClose(ws, 1011, 'WebSocket runtime error', false);
  }

  public getOperationalStats() {
    this.rehydrateFromHibernatedSockets();
    return {
      connectedSockets: this.connections.size,
      waitingInQueue: this.waitingQueue.size,
      activeStrangerSessions: this.activeSessions.size,
    };
  }

  public resolvePeerToUserId(sessionId: string, reporterUserId: string): string | null {
    this.rehydrateFromHibernatedSockets();
    const session = this.activeSessions.get(sessionId);
    if (!session) return null;
    if (session.userA.userId === reporterUserId) return session.userB.userId;
    if (session.userB.userId === reporterUserId) return session.userA.userId;
    return null;
  }

  private resolveConnectionIdForSocket(ws: WebSocket): string | null {
    const mapped = this.socketToConnectionId.get(ws);
    if (mapped) return mapped;

    const hSocket = ws as HibernatableWebSocket;
    if (typeof hSocket.deserializeAttachment === 'function') {
      try {
        const meta = hSocket.deserializeAttachment();
        if (meta && meta.connectionId) {
          return meta.connectionId;
        }
      } catch {
        // Ignore
      }
    }

    for (const [connId, participant] of this.connections.entries()) {
      if (participant.socket === ws) {
        return connId;
      }
    }
    return null;
  }

  private attachStandardSocketListeners(socket: WebSocket): void {
    socket.addEventListener('message', (event: MessageEvent) => {
      const rawText =
        typeof event.data === 'string'
          ? event.data
          : event.data instanceof ArrayBuffer
          ? new TextDecoder().decode(event.data)
          : String(event.data);
      this.processSocketMessage(socket, rawText);
    });

    socket.addEventListener('close', (event: CloseEvent) => {
      this.processSocketClose(
        socket,
        event.code || 1000,
        event.reason || '',
        Boolean(event.wasClean)
      );
    });

    socket.addEventListener('error', (err: Event) => {
      const connId = this.resolveConnectionIdForSocket(socket);
      this.logEvent('ws_error', {
        connectionId: connId,
        error: String(err),
      });
      this.processSocketClose(socket, 1011, 'Socket error', false);
    });
  }

  private processSocketMessage(ws: WebSocket, rawText: string): void {
    const connectionId = this.resolveConnectionIdForSocket(ws);
    if (!connectionId) {
      return;
    }
    const participant = this.connections.get(connectionId);
    if (!participant) {
      return;
    }

    let msg: Record<string, unknown>;
    try {
      const parsed = JSON.parse(rawText);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        this.safeSend(ws, {
          type: 'error:invalid-payload',
          message: 'Payload must be a JSON object.',
        });
        return;
      }
      msg = parsed as Record<string, unknown>;
    } catch {
      this.safeSend(ws, {
        type: 'error:invalid-payload',
        message: 'Malformed JSON message.',
      });
      return;
    }

    try {
      this.handleClientMessage(participant, msg);
    } catch (err) {
      this.logEvent('message_handler_exception', {
        connectionId: participant.connectionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private processSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean
  ): void {
    const connectionId = this.resolveConnectionIdForSocket(ws);
    if (!connectionId) return;

    const participant = this.connections.get(connectionId);
    this.logEvent('ws_closed', {
      connectionId,
      userId: participant?.userId || 'unknown',
      code,
      reason: reason || 'none',
      wasClean,
    });

    this.leaveConnection(connectionId, 'disconnect');
    this.connections.delete(connectionId);

    if (participant) {
      const tabKey = `${participant.userId}:${participant.clientId}`;
      if (this.tabKeyToConnectionId.get(tabKey) === connectionId) {
        this.tabKeyToConnectionId.delete(tabKey);
      }
    }
  }

  private handleClientMessage(
    participant: QueueParticipant,
    msg: Record<string, unknown>
  ): void {
    const type = String(msg.type || '').trim();

    if (!ALLOWED_MESSAGE_TYPES.has(type)) {
      this.safeSend(participant.socket, {
        type: 'error:invalid-payload',
        message: `Unsupported message type: ${type || 'empty'}`,
      });
      return;
    }

    // Heartbeat ping -> pong
    if (type === 'ping') {
      this.safeSend(participant.socket, {
        type: 'pong',
        timestamp: Date.now(),
      });
      return;
    }

    if (type === 'queue:join') {
      const mode: 'video' | 'text' = msg.mode === 'text' ? 'text' : 'video';
      participant.mode = mode;
      participant.joinedAt = Date.now();
      participant.blockedUserIds = EDGE_BLOCKS.filter(
        (b) => b.blockerId === participant.userId || b.blockedUserId === participant.userId
      ).map((b) => (b.blockerId === participant.userId ? b.blockedUserId : b.blockerId));

      this.logEvent('queue_join', {
        connectionId: participant.connectionId,
        userId: participant.userId,
        mode,
      });
      this.enqueueAndMatch(participant);
      return;
    }

    if (type === 'queue:leave') {
      this.leaveConnection(participant.connectionId, 'end');
      this.safeSend(participant.socket, { type: 'queue:left' });
      return;
    }

    if (type === 'stranger:skip') {
      const mode: 'video' | 'text' =
        msg.mode === 'text' ? 'text' : msg.mode === 'video' ? 'video' : participant.mode;
      participant.mode = mode;
      participant.joinedAt = Date.now();
      this.logEvent('stranger_skip', {
        connectionId: participant.connectionId,
        userId: participant.userId,
        mode,
      });
      this.leaveConnection(participant.connectionId, 'skip');
      this.enqueueAndMatch(participant);
      return;
    }

    if (type === 'stranger:end') {
      this.leaveConnection(participant.connectionId, 'end');
      this.safeSend(participant.socket, { type: 'stranger:ended' });
      return;
    }

    if (
      type === 'webrtc:sdp' ||
      type === 'webrtc:ice' ||
      type === 'webrtc:ready' ||
      type === 'stranger:message' ||
      type === 'stranger:typing' ||
      type === 'stranger:media-state'
    ) {
      const sessionId = String(msg.sessionId || participant.sessionId || '').trim();
      if (!sessionId) {
        this.safeSend(participant.socket, {
          type: 'error:invalid-payload',
          message: 'Missing sessionId for session relay.',
        });
        return;
      }

      if (type === 'webrtc:sdp') {
        const sdpObj = msg.data as { type?: string; sdp?: string } | null;
        if (!sdpObj || typeof sdpObj.type !== 'string' || typeof sdpObj.sdp !== 'string') {
          this.safeSend(participant.socket, {
            type: 'error:invalid-payload',
            message: 'Invalid webrtc:sdp payload.',
          });
          return;
        }
      }

      if (type === 'stranger:message') {
        const textObj = msg.data as { text?: string } | null;
        if (!textObj || typeof textObj.text !== 'string' || !textObj.text.trim()) {
          return;
        }
      }

      this.relaySessionPayload(participant.connectionId, {
        type,
        sessionId,
        data: msg.data,
      });
    }
  }

  /**
   * Atomically removes a specific connection from any waiting queue or active session.
   * Never closes the partner's WebSocket connection!
   */
  public leaveConnection(
    connectionId: string,
    reason: 'skip' | 'end' | 'disconnect' = 'disconnect'
  ): void {
    this.waitingQueue.delete(connectionId);

    const participant = this.connections.get(connectionId);
    if (participant) {
      participant.status = 'idle';
      participant.sessionId = null;
      participant.partnerConnectionId = null;
      participant.initiator = false;
      this.saveSocketAttachment(participant);
    }

    const existingSessionId = this.connectionToSessionId.get(connectionId);
    if (!existingSessionId) return;

    const session = this.activeSessions.get(existingSessionId);
    this.activeSessions.delete(existingSessionId);
    this.connectionToSessionId.delete(connectionId);

    if (session) {
      const partner =
        session.userA.connectionId === connectionId ? session.userB : session.userA;
      this.connectionToSessionId.delete(partner.connectionId);

      partner.status = 'idle';
      partner.sessionId = null;
      partner.partnerConnectionId = null;
      partner.initiator = false;
      this.saveSocketAttachment(partner);

      // Notify partner that the session ended without closing partner's WebSocket
      this.safeSend(partner.socket, {
        type: 'stranger:disconnected',
        sessionId: session.sessionId,
        reason,
      });
    }
  }

  public leaveByUserId(
    userId: string,
    reason: 'skip' | 'end' | 'disconnect' = 'disconnect'
  ): void {
    for (const [connId, participant] of this.connections.entries()) {
      if (participant.userId === userId) {
        this.leaveConnection(connId, reason);
      }
    }
  }

  /**
   * Atomically enqueues a participant or pairs them immediately with a waiting user.
   */
  public enqueueAndMatch(participant: QueueParticipant): void {
    this.leaveConnection(participant.connectionId, 'skip');

    let matchedCandidate: QueueParticipant | null = null;
    let bestScore = -1;

    for (const candidate of this.waitingQueue.values()) {
      if (candidate.connectionId === participant.connectionId) continue;
      if (candidate.mode !== participant.mode) continue;

      // Verify candidate connection is still open and registered
      const activeCandidate = this.connections.get(candidate.connectionId);
      if (!activeCandidate || !this.isSocketOpen(activeCandidate.socket)) {
        this.waitingQueue.delete(candidate.connectionId);
        continue;
      }

      // Enforce mutual block list when two distinct accounts are matching
      if (candidate.userId !== participant.userId) {
        const blockedByParticipant = participant.blockedUserIds.includes(candidate.userId);
        const blockedByCandidate = candidate.blockedUserIds.includes(participant.userId);
        if (blockedByParticipant || blockedByCandidate) continue;
      }

      const sharedCount = candidate.interests.filter((i) =>
        participant.interests.includes(i)
      ).length;

      // Strongly prioritize distinct user accounts (+1000 score) over same-account multi-tab testing
      const distinctAccountBonus = candidate.userId !== participant.userId ? 1000 : 0;
      const totalScore = distinctAccountBonus + sharedCount;

      if (totalScore > bestScore) {
        bestScore = totalScore;
        matchedCandidate = activeCandidate;
      }
    }

    if (!matchedCandidate) {
      participant.status = 'waiting';
      participant.sessionId = null;
      participant.partnerConnectionId = null;
      participant.initiator = false;
      this.waitingQueue.set(participant.connectionId, participant);
      this.saveSocketAttachment(participant);

      this.safeSend(participant.socket, {
        type: 'queue:waiting',
        mode: participant.mode,
        joinedAt: participant.joinedAt,
        waitingCount: this.waitingQueue.size,
      });
      return;
    }

    // Remove candidate from queue atomically
    this.waitingQueue.delete(matchedCandidate.connectionId);

    const sessionId = `ouat_rt_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const session: ActiveStrangerSession = {
      sessionId,
      mode: participant.mode,
      startedAt: Date.now(),
      userA: matchedCandidate,
      userB: participant,
    };

    matchedCandidate.status = 'matched';
    matchedCandidate.sessionId = sessionId;
    matchedCandidate.partnerConnectionId = participant.connectionId;
    matchedCandidate.initiator = true;

    participant.status = 'matched';
    participant.sessionId = sessionId;
    participant.partnerConnectionId = matchedCandidate.connectionId;
    participant.initiator = false;

    this.activeSessions.set(sessionId, session);
    this.connectionToSessionId.set(matchedCandidate.connectionId, sessionId);
    this.connectionToSessionId.set(participant.connectionId, sessionId);

    this.saveSocketAttachment(matchedCandidate);
    this.saveSocketAttachment(participant);

    const sharedInterests = matchedCandidate.interests.filter((i) =>
      participant.interests.includes(i)
    );

    this.logEvent('match_found', {
      sessionId,
      mode: session.mode,
      initiatorConnectionId: matchedCandidate.connectionId,
      responderConnectionId: participant.connectionId,
      initiatorUserId: matchedCandidate.userId,
      responderUserId: participant.userId,
    });

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
   * Relays WebRTC SDP offers/answers, ICE candidates, peer readiness, or ephemeral text/typing/media-state messages
   * strictly within an authenticated active session between the two matched partners.
   */
  public relaySessionPayload(
    senderConnectionId: string,
    payload: {
      type:
        | 'webrtc:sdp'
        | 'webrtc:ice'
        | 'webrtc:ready'
        | 'stranger:message'
        | 'stranger:typing'
        | 'stranger:media-state';
      sessionId: string;
      data: unknown;
    }
  ): void {
    const activeSessionId = this.connectionToSessionId.get(senderConnectionId);
    if (!activeSessionId || activeSessionId !== payload.sessionId) {
      return;
    }
    const session = this.activeSessions.get(activeSessionId);
    if (!session) return;

    const isUserA = session.userA.connectionId === senderConnectionId;
    const isUserB = session.userB.connectionId === senderConnectionId;
    if (!isUserA && !isUserB) return;

    const sender = isUserA ? session.userA : session.userB;
    const partner = isUserA ? session.userB : session.userA;

    if (payload.type === 'webrtc:sdp' || payload.type === 'webrtc:ready') {
      this.logEvent('webrtc_signal_relay', {
        sessionId: session.sessionId,
        type: payload.type,
        sdpType:
          payload.type === 'webrtc:sdp'
            ? (payload.data as { type?: string } | null)?.type || 'unknown'
            : undefined,
        fromConnectionId: sender.connectionId,
        toConnectionId: partner.connectionId,
      });
    }

    this.safeSend(partner.socket, {
      type: payload.type,
      sessionId: session.sessionId,
      fromPeerId: sender.ephemeralPeerId,
      data: payload.data,
      timestamp: new Date().toISOString(),
    });
  }

  private isSocketOpen(ws: WebSocket): boolean {
    // In Cloudflare workerd or browser WebSocket, readyState 1 === OPEN (or undefined on mock sockets)
    const state = (ws as { readyState?: number }).readyState;
    if (typeof state === 'number') {
      return state === 1;
    }
    return !(ws as { closed?: boolean }).closed;
  }

  private safeSend(ws: WebSocket, message: Record<string, unknown>): void {
    try {
      if (this.isSocketOpen(ws)) {
        ws.send(JSON.stringify(message));
      }
    } catch (err) {
      this.logEvent('ws_send_error', {
        connectionId: this.resolveConnectionIdForSocket(ws),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
