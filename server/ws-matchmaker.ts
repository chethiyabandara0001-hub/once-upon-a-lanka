import http from 'node:http';
import crypto from 'node:crypto';
import type { Duplex } from 'node:stream';
import { db } from './db';
import { hashSessionToken } from './security';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface RtcSocketClient {
  id: string;
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

class RealtimeMatchmakingCoordinator {
  private clientsByUser = new Map<string, RtcSocketClient>();
  private waitingQueue = new Map<string, QueuedEntry>();
  private userToSessionId = new Map<string, string>();
  private activeSessions = new Map<string, ActiveSession>();

  public attachToServer(server: http.Server): void {
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (url.pathname !== '/ws') {
        return; // Let Vite or other upgrade handlers process if needed
      }

      const token = url.searchParams.get('token') || '';
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

      const client: RtcSocketClient = {
        id: `ws_${crypto.randomUUID().slice(0, 10)}`,
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

      // Close any stale socket for this user
      const existingClient = this.clientsByUser.get(user.id);
      if (existingClient && existingClient.id !== client.id) {
        this.leaveAll(user.id, 'disconnect');
        existingClient.close();
      }

      this.clientsByUser.set(user.id, client);

      client.send({
        type: 'connection:established',
        ephemeralPeerId: client.ephemeralPeerId,
        stats: this.getPublicOperationalStats(),
      });

      this.setupFrameReader(client);
    });
  }

  public getPublicOperationalStats() {
    return {
      connectedSockets: this.clientsByUser.size,
      waitingInQueue: this.waitingQueue.size,
      activeStrangerSessions: this.activeSessions.size,
    };
  }

  public notifyDirectMessage(recipientUserId: string, payload: Record<string, unknown>): void {
    const client = this.clientsByUser.get(recipientUserId);
    if (client) {
      client.send({
        type: 'dm:received',
        ...payload,
      });
    }
  }

  public forceDisconnectUser(userId: string): void {
    this.leaveAll(userId, 'disconnect');
    const client = this.clientsByUser.get(userId);
    if (client) {
      client.send({ type: 'account:moderated' });
      client.close();
      this.clientsByUser.delete(userId);
    }
  }

  private handleClientMessage(client: RtcSocketClient, msg: Record<string, unknown>): void {
    const type = String(msg.type || '');

    if (type === 'queue:join') {
      const mode: 'video' | 'text' = msg.mode === 'video' ? 'video' : 'text';
      this.enqueueAndMatch(client, mode);
      return;
    }

    if (type === 'queue:leave') {
      this.leaveAll(client.userId, 'end');
      client.send({ type: 'queue:left' });
      return;
    }

    if (type === 'stranger:skip') {
      const mode: 'video' | 'text' = msg.mode === 'video' ? 'video' : 'text';
      this.leaveAll(client.userId, 'skip');
      this.enqueueAndMatch(client, mode);
      return;
    }

    if (type === 'stranger:end') {
      this.leaveAll(client.userId, 'end');
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
      const activeSessionId = this.userToSessionId.get(client.userId);
      if (!activeSessionId || activeSessionId !== sessionId) return;

      const session = this.activeSessions.get(activeSessionId);
      if (!session) return;

      const partner =
        session.userA.userId === client.userId ? session.userB : session.userA;

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
    // Enforce atomic single-session invariant
    this.leaveAll(client.userId, 'skip');

    let bestCandidate: QueuedEntry | null = null;
    let bestOverlap = -1;

    for (const candidate of this.waitingQueue.values()) {
      if (candidate.client.userId === client.userId) continue;
      if (candidate.mode !== mode) continue;

      if (db.isBlockedBetween(client.userId, candidate.client.userId)) {
        continue;
      }

      const overlap = candidate.client.interests.filter((i) =>
        client.interests.includes(i)
      ).length;

      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestCandidate = candidate;
      }
    }

    if (!bestCandidate) {
      this.waitingQueue.set(client.userId, {
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

    this.waitingQueue.delete(bestCandidate.client.userId);

    const sessionId = `ouat_live_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const session: ActiveSession = {
      sessionId,
      mode,
      startedAt: Date.now(),
      userA: bestCandidate.client,
      userB: client,
    };

    this.activeSessions.set(sessionId, session);
    this.userToSessionId.set(bestCandidate.client.userId, sessionId);
    this.userToSessionId.set(client.userId, sessionId);

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

  public leaveAll(userId: string, reason: 'skip' | 'end' | 'disconnect'): void {
    this.waitingQueue.delete(userId);

    const sessionId = this.userToSessionId.get(userId);
    if (!sessionId) return;

    const session = this.activeSessions.get(sessionId);
    this.activeSessions.delete(sessionId);
    this.userToSessionId.delete(userId);

    if (session) {
      const partner = session.userA.userId === userId ? session.userB : session.userA;
      this.userToSessionId.delete(partner.userId);
      partner.send({
        type: 'stranger:disconnected',
        sessionId: session.sessionId,
        reason,
      });
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
          // Close frame
          this.leaveAll(client.userId, 'disconnect');
          if (this.clientsByUser.get(client.userId)?.id === client.id) {
            this.clientsByUser.delete(client.userId);
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
      this.leaveAll(client.userId, 'disconnect');
      if (this.clientsByUser.get(client.userId)?.id === client.id) {
        this.clientsByUser.delete(client.userId);
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
