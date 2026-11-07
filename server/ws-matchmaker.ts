import http from 'node:http';
import crypto from 'node:crypto';
import type { Duplex } from 'node:stream';
import { db } from './db';
import { hashSessionToken } from './security';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface RtcSocketClient {
  id: string;
  clientId: string;
  userId: string;
  ephemeralPeerId: string;
  displayName: string;
  region: string;
  interests: string[];
  socket: Duplex;
  send: (payload: Record<string, unknown>) => void;
  close: () => void;
}

interface QueuedEntry {
  client: RtcSocketClient;
  mode: 'video' | 'text';
  joinedAt: number;
}

interface ActiveSession {
  sessionId: string;
  mode: 'video' | 'text';
  startedAt: number;
  userA: RtcSocketClient;
  userB: RtcSocketClient;
}

const ALLOWED_CLIENT_TYPES = new Set([
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

class RealtimeMatchmakingCoordinator {
  private clientsById = new Map<string, RtcSocketClient>();
  private tabKeyToClientId = new Map<string, string>();
  private waitingQueue = new Map<string, QueuedEntry>();
  private clientToSessionId = new Map<string, string>();
  private activeSessions = new Map<string, ActiveSession>();

  public attachToServer(server: http.Server): void {
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (url.pathname !== '/ws') {
        return; // Let Vite or other upgrade handlers process if needed
      }

      const token = url.searchParams.get('token') || '';
      const rawClientId = (url.searchParams.get('clientId') || '').trim();
      const tokenHash = token ? hashSessionToken(token) : '';
      const now = new Date();
      const session = db.state.user_sessions.find(
        (s) => s.token_hash === tokenHash && new Date(s.expires_at) > now
      );

      if (!session) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      const user = db.state.users.find(
        (u) => u.id === session.user_id && u.account_status === 'active'
      );
      if (!user) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }

      const key = req.headers['sec-websocket-key'];
      if (!key || typeof key !== 'string') {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
      }

      const acceptKey = crypto
        .createHash('sha1')
        .update(key + WS_GUID)
        .digest('base64');

      const responseHeaders = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-Websocket-Accept: ${acceptKey}`,
        '\r\n',
      ];
      socket.write(responseHeaders.join('\r\n'));

      if (head && head.length > 0) {
        socket.unshift(head);
      }

      const profile = db.state.profiles.find((p) => p.user_id === user.id);
      const interestIds = db.state.user_interests
        .filter((ui) => ui.user_id === user.id)
        .map((ui) => ui.interest_id);
      const interestNames = db.state.interests
        .filter((i) => interestIds.includes(i.id))
        .map((i) => i.label_en);

      const connectionId = `ws_${crypto.randomUUID().slice(0, 10)}`;
      const clientId = rawClientId ? rawClientId.slice(0, 48) : connectionId;

      const client: RtcSocketClient = {
        id: connectionId,
        clientId,
        userId: user.id,
        ephemeralPeerId: `peer_${crypto.randomUUID().slice(0, 8)}`,
        displayName: user.display_name.split(' ')[0] || user.display_name,
        region: profile?.show_region ? profile.region : '',
        interests: interestNames,
        socket,
        send: (payload) => this.sendJsonFrame(socket, payload),
        close: () => {
          try {
            socket.end();
          } catch {
            // Ignore
          }
        },
      };

      // Close stale socket only if reconnecting from the exact same browser tab
      const tabKey = `${user.id}:${clientId}`;
      const priorConnId = this.tabKeyToClientId.get(tabKey);
      if (priorConnId && priorConnId !== client.id) {
        const existingClient = this.clientsById.get(priorConnId);
        if (existingClient) {
          this.leaveConnection(priorConnId, 'disconnect');
          this.clientsById.delete(priorConnId);
          existingClient.close();
        }
      }

      this.clientsById.set(client.id, client);
      this.tabKeyToClientId.set(tabKey, client.id);

      client.send({
        type: 'connection:established',
        connectionId: client.id,
        ephemeralPeerId: client.ephemeralPeerId,
        stats: this.getPublicOperationalStats(),
      });

      this.setupFrameReader(client);
    });
  }

  public getPublicOperationalStats() {
    return {
      connectedSockets: this.clientsById.size,
      waitingInQueue: this.waitingQueue.size,
      activeStrangerSessions: this.activeSessions.size,
    };
  }

  public notifyDirectMessage(recipientUserId: string, payload: Record<string, unknown>): void {
    for (const client of this.clientsById.values()) {
      if (client.userId === recipientUserId) {
        client.send({
          type: 'dm:received',
          ...payload,
        });
      }
    }
  }

  public forceDisconnectUser(userId: string): void {
    for (const [connId, client] of this.clientsById.entries()) {
      if (client.userId === userId) {
        this.leaveConnection(connId, 'disconnect');
        client.send({ type: 'account:moderated' });
        client.close();
        this.clientsById.delete(connId);
      }
    }
  }

  private handleClientMessage(client: RtcSocketClient, msg: Record<string, unknown>): void {
    const type = String(msg.type || '').trim();
    if (!ALLOWED_CLIENT_TYPES.has(type)) {
      client.send({
        type: 'error:invalid-payload',
        message: `Unsupported message type: ${type || 'empty'}`,
      });
      return;
    }

    if (type === 'ping') {
      client.send({
        type: 'pong',
        timestamp: Date.now(),
      });
      return;
    }

    if (type === 'queue:join') {
      const mode: 'video' | 'text' = msg.mode === 'text' ? 'text' : 'video';
      this.enqueueAndMatch(client, mode);
      return;
    }

    if (type === 'queue:leave') {
      this.leaveConnection(client.id, 'end');
      client.send({ type: 'queue:left' });
      return;
    }

    if (type === 'stranger:skip') {
      const mode: 'video' | 'text' = msg.mode === 'text' ? 'text' : 'video';
      this.leaveConnection(client.id, 'skip');
      this.enqueueAndMatch(client, mode);
      return;
    }

    if (type === 'stranger:end') {
      this.leaveConnection(client.id, 'end');
      client.send({ type: 'stranger:ended' });
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
      const sessionId = String(msg.sessionId || '');
      const activeSessionId = this.clientToSessionId.get(client.id);
      if (!activeSessionId || activeSessionId !== sessionId) return;

      const session = this.activeSessions.get(activeSessionId);
      if (!session) return;

      const partner = session.userA.id === client.id ? session.userB : session.userA;

      partner.send({
        type,
        sessionId: session.sessionId,
        fromPeerId: client.ephemeralPeerId,
        data: msg.data,
        timestamp: new Date().toISOString(),
      });
    }
  }

  private enqueueAndMatch(client: RtcSocketClient, mode: 'video' | 'text'): void {
    this.leaveConnection(client.id, 'skip');

    let bestCandidate: QueuedEntry | null = null;
    let bestScore = -1;

    for (const candidate of this.waitingQueue.values()) {
      if (candidate.client.id === client.id) continue;
      if (candidate.mode !== mode) continue;

      if (
        candidate.client.userId !== client.userId &&
        db.isBlockedBetween(client.userId, candidate.client.userId)
      ) {
        continue;
      }

      const overlap = candidate.client.interests.filter((i) =>
        client.interests.includes(i)
      ).length;
      const distinctBonus = candidate.client.userId !== client.userId ? 1000 : 0;
      const score = distinctBonus + overlap;

      if (score > bestScore) {
        bestScore = score;
        bestCandidate = candidate;
      }
    }

    if (!bestCandidate) {
      this.waitingQueue.set(client.id, {
        client,
        mode,
        joinedAt: Date.now(),
      });
      client.send({
        type: 'queue:waiting',
        mode,
        joinedAt: Date.now(),
        waitingCount: this.waitingQueue.size,
      });
      return;
    }

    this.waitingQueue.delete(bestCandidate.client.id);

    const sessionId = `ouat_live_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const session: ActiveSession = {
      sessionId,
      mode,
      startedAt: Date.now(),
      userA: bestCandidate.client,
      userB: client,
    };

    this.activeSessions.set(sessionId, session);
    this.clientToSessionId.set(bestCandidate.client.id, sessionId);
    this.clientToSessionId.set(client.id, sessionId);

    const sharedInterests = bestCandidate.client.interests.filter((i) =>
      client.interests.includes(i)
    );

    bestCandidate.client.send({
      type: 'match:found',
      sessionId,
      mode,
      initiator: true,
      partner: {
        ephemeralPeerId: client.ephemeralPeerId,
        displayName: client.displayName,
        region: client.region || null,
        sharedInterests,
      },
    });

    client.send({
      type: 'match:found',
      sessionId,
      mode,
      initiator: false,
      partner: {
        ephemeralPeerId: bestCandidate.client.ephemeralPeerId,
        displayName: bestCandidate.client.displayName,
        region: bestCandidate.client.region || null,
        sharedInterests,
      },
    });
  }

  public leaveConnection(connectionId: string, reason: 'skip' | 'end' | 'disconnect'): void {
    this.waitingQueue.delete(connectionId);

    const sessionId = this.clientToSessionId.get(connectionId);
    if (!sessionId) return;

    const session = this.activeSessions.get(sessionId);
    this.activeSessions.delete(sessionId);
    this.clientToSessionId.delete(connectionId);

    if (session) {
      const partner = session.userA.id === connectionId ? session.userB : session.userA;
      this.clientToSessionId.delete(partner.id);
      partner.send({
        type: 'stranger:disconnected',
        sessionId: session.sessionId,
        reason,
      });
    }
  }

  public leaveAll(userId: string, reason: 'skip' | 'end' | 'disconnect'): void {
    for (const [connId, client] of this.clientsById.entries()) {
      if (client.userId === userId) {
        this.leaveConnection(connId, reason);
      }
    }
  }

  public resolvePeerToUserId(sessionId: string, reporterUserId: string): string | null {
    const session = this.activeSessions.get(sessionId);
    if (!session) return null;
    if (session.userA.userId === reporterUserId) return session.userB.userId;
    if (session.userB.userId === reporterUserId) return session.userA.userId;
    return null;
  }

  private setupFrameReader(client: RtcSocketClient): void {
    let buffer = Buffer.alloc(0);

    client.socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      while (buffer.length >= 2) {
        const firstByte = buffer[0];
        const secondByte = buffer[1];
        const opcode = firstByte & 0x0f;
        const isMasked = (secondByte & 0x80) === 0x80;
        let payloadLength = secondByte & 0x7f;
        let offset = 2;

        if (payloadLength === 126) {
          if (buffer.length < 4) return;
          payloadLength = buffer.readUInt16BE(2);
          offset = 4;
        } else if (payloadLength === 127) {
          if (buffer.length < 10) return;
          payloadLength = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }

        const maskLength = isMasked ? 4 : 0;
        const totalFrameLength = offset + maskLength + payloadLength;
        if (buffer.length < totalFrameLength) return;

        let payload = buffer.subarray(offset + maskLength, totalFrameLength);
        if (isMasked) {
          const mask = buffer.subarray(offset, offset + 4);
          const unmasked = Buffer.alloc(payloadLength);
          for (let i = 0; i < payloadLength; i++) {
            unmasked[i] = payload[i] ^ mask[i % 4];
          }
          payload = unmasked;
        }

        buffer = buffer.subarray(totalFrameLength);

        if (opcode === 0x08) {
          this.leaveConnection(client.id, 'disconnect');
          this.clientsById.delete(client.id);
          const tabKey = `${client.userId}:${client.clientId}`;
          if (this.tabKeyToClientId.get(tabKey) === client.id) {
            this.tabKeyToClientId.delete(tabKey);
          }
          client.close();
          return;
        }

        if (opcode === 0x09) {
          // Ping -> Pong
          this.sendRawFrame(client.socket, 0x0a, payload);
          continue;
        }

        if (opcode === 0x01) {
          try {
            const text = payload.toString('utf8');
            const parsed = JSON.parse(text) as Record<string, unknown>;
            this.handleClientMessage(client, parsed);
          } catch {
            // Ignore malformed JSON frame
          }
        }
      }
    });

    const handleDisconnect = () => {
      this.leaveConnection(client.id, 'disconnect');
      this.clientsById.delete(client.id);
      const tabKey = `${client.userId}:${client.clientId}`;
      if (this.tabKeyToClientId.get(tabKey) === client.id) {
        this.tabKeyToClientId.delete(tabKey);
      }
    };

    client.socket.on('close', handleDisconnect);
    client.socket.on('error', handleDisconnect);
    client.socket.on('end', handleDisconnect);
  }

  private sendJsonFrame(socket: Duplex, payload: Record<string, unknown>): void {
    try {
      const data = Buffer.from(JSON.stringify(payload), 'utf8');
      this.sendRawFrame(socket, 0x01, data);
    } catch {
      // Ignore closed socket errors
    }
  }

  private sendRawFrame(socket: Duplex, opcode: number, data: Buffer): void {
    if (socket.destroyed || !socket.writable) return;
    const length = data.length;
    let header: Buffer;

    if (length < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode;
      header[1] = length;
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }

    socket.write(Buffer.concat([header, data]));
  }
}

export const matchmaker = new RealtimeMatchmakingCoordinator();
