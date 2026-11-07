import assert from 'node:assert/strict';
import {
  hashPassword,
  verifyPassword,
  verifyAdultAge,
  generatePayHereCheckoutHash,
  verifyPayHereWebhookSignature,
  md5Upper,
  verifyTurnstileToken,
  getServerSessionSecret,
} from './security';
import { db } from './db';
import { handleApiRequest } from '../cloudflare/worker';

async function runBackendVerificationTests(): Promise<void> {
  console.log('Running Once Upon a Time Backend Security & Invariant Suite...');

  // 1. Password hashing & timing-safe verification
  const { hash, salt } = hashPassword('ColomboTwilight2026!');
  assert.notEqual(hash, 'ColomboTwilight2026!', 'Password must never be stored in plaintext');
  assert.equal(verifyPassword('ColomboTwilight2026!', hash, salt), true, 'Valid password must verify');
  assert.equal(verifyPassword('WrongPassword123!', hash, salt), false, 'Wrong password must fail');

  // 2. Server-side 18+ age assurance
  const underageYear = new Date().getUTCFullYear() - 16;
  const underageResult = verifyAdultAge(`${underageYear}-05-10`);
  assert.equal(underageResult.eligible, false, 'Under-18 user must be rejected');

  const adultResult = verifyAdultAge('1998-07-15');
  assert.equal(adultResult.eligible, true, 'Adult 18+ user must be accepted');
  assert.ok(adultResult.age >= 18, 'Calculated age must be >= 18');

  // 3. PayHere Sri Lanka (LKR 500.00) MD5 signature & webhook verification
  const merchantId = '1210001';
  const orderId = 'OUAT-LK-TEST-99';
  const secret = 'TEST_SECRET_KEY';
  const checkoutHash = generatePayHereCheckoutHash({
    merchantId,
    orderId,
    amountLkr: 500,
    currency: 'LKR',
    merchantSecret: secret,
  });
  assert.equal(checkoutHash.length, 32, 'PayHere checkout hash must be 32-char uppercase MD5');

  const validSig = md5Upper(`${merchantId}${orderId}500.00LKR2${md5Upper(secret)}`);
  assert.equal(
    verifyPayHereWebhookSignature({
      merchantId,
      orderId,
      payhereAmount: '500.00',
      payhereCurrency: 'LKR',
      statusCode: '2',
      md5sig: validSig,
      merchantSecret: secret,
    }),
    true,
    'Authentic PayHere server-to-server webhook signature must pass'
  );

  assert.equal(
    verifyPayHereWebhookSignature({
      merchantId,
      orderId,
      payhereAmount: '500.00',
      payhereCurrency: 'LKR',
      statusCode: '2',
      md5sig: '00000000000000000000000000000000',
      merchantSecret: secret,
    }),
    false,
    'Forged PayHere signature must be rejected'
  );

  // 4. Normalized Database & Block Invariant
  assert.ok(db.state.interests.length >= 10, 'Trilingual Sri Lankan interests must be seeded');
  assert.equal(
    db.isBlockedBetween('usr_amaya', 'usr_kavan'),
    false,
    'Unblocked users should be able to interact'
  );

  // 5. Free Development Mode: Cloudflare Turnstile official test key support
  const testSecret = '1x0000000000000000000000000000000AA';
  const passRes = await verifyTurnstileToken({
    token: '1x00000000000000000000AA',
    secretKey: testSecret,
  });
  assert.equal(
    passRes.success,
    true,
    'Cloudflare official test key 1x00000000000000000000AA must always pass in dev'
  );

  const failRes = await verifyTurnstileToken({
    token: '2x00000000000000000000AA',
    secretKey: testSecret,
  });
  assert.equal(
    failRes.success,
    false,
    'Cloudflare official test key 2x00000000000000000000AA must fail verification'
  );

  // 6. Mandatory Server Session Secret Generation
  const sessionSecret = getServerSessionSecret();
  assert.ok(typeof sessionSecret === 'string' && sessionSecret.length >= 32, 'Session secret must be >= 32 chars');

  // 7. Development-only Test Membership DB Invariant
  const testUserId = 'usr_kavan';
  const initialUser = db.state.users.find((u) => u.id === testUserId);
  assert.ok(initialUser, 'User must exist');
  const now = new Date();
  const startsAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const membership = db.getActiveMembership(testUserId);
  membership.status = 'active';
  membership.plan_name = 'OUAT Development Test Pass (30 Days)';
  membership.price_lkr = 0;
  membership.starts_at = startsAt;
  membership.expires_at = expiresAt;
  membership.updated_at = startsAt;

  const testOrderId = `DEV-TEST-${Date.now()}`;
  db.state.payments.unshift({
    id: `pay_test_${Date.now()}`,
    order_id: testOrderId,
    user_id: testUserId,
    amount_lkr: 0,
    currency: 'LKR',
    gateway: 'dev_test',
    gateway_payment_id: `DEV-PASS-${Date.now()}`,
    status: 'completed',
    idempotency_key: `dev_test_idem_${Date.now()}`,
    signature_verified: true,
    raw_notification_summary: 'Development Test Membership Pass (Zero Payment)',
    created_at: startsAt,
    verified_at: startsAt,
  });

  const refreshedMembership = db.getActiveMembership(testUserId);
  assert.equal(refreshedMembership.status, 'active', 'Dev test membership must be active');
  assert.equal(refreshedMembership.price_lkr, 0, 'Dev test membership price must be 0');

  const recordedPayment = db.state.payments.find((p) => p.order_id === testOrderId);
  assert.ok(recordedPayment, 'Payment row must be found');
  assert.equal(recordedPayment?.gateway, 'dev_test', 'Gateway must be recorded as dev_test');
  assert.equal(recordedPayment?.amount_lkr, 0, 'Amount must be 0 LKR');

  // 8. Cloudflare Worker & Pages Edge API Verification (Login + PUT /api/profile + Discover + Conversations)
  const loginReq = new Request('https://once-upon-a-lanka.workers.dev/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'amaya@onceuponatime.lk', password: 'OnceUpon2026!' }),
  });
  const loginRes = await handleApiRequest(loginReq, {}, new URL(loginReq.url));
  assert.equal(loginRes.status, 200, 'Edge login must return HTTP 200');
  const loginData = (await loginRes.json()) as {
    token: string;
    user: { id: string; onboardingCompleted: boolean; counts: { activeMatches: number } };
  };
  assert.ok(loginData.token.startsWith('ouat_v1.'), 'Edge login must return stateless HMAC token');
  assert.equal(loginData.user.onboardingCompleted, true, 'Seeded user must have onboardingCompleted=true');
  assert.ok(typeof loginData.user.counts.activeMatches === 'number', 'User payload must include counts');

  const profilePutReq = new Request('https://once-upon-a-lanka.workers.dev/api/profile', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${loginData.token}`,
    },
    body: JSON.stringify({
      displayName: 'Amaya',
      bio: 'Updated bio on Cloudflare Edge',
      onboardingCompleted: true,
    }),
  });
  const profilePutRes = await handleApiRequest(profilePutReq, {}, new URL(profilePutReq.url));
  assert.equal(profilePutRes.status, 200, 'PUT /api/profile on Cloudflare Worker must return HTTP 200');

  const convoGetReq = new Request(
    'https://once-upon-a-lanka.workers.dev/api/conversations/cnv_amaya_kavan/messages',
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${loginData.token}` },
    }
  );
  const convoGetRes = await handleApiRequest(convoGetReq, {}, new URL(convoGetReq.url));
  assert.equal(convoGetRes.status, 200, 'GET /api/conversations/:id/messages must return HTTP 200');

  // 9. Cloudflare MatchmakerDurableObject WebSocket Upgrade (HTTP 101), Auth, Pairing, WebRTC Relay, Skip & Disconnect Suite
  // Polyfill Cloudflare's WebSocketPair in Node.js test runtime so MatchmakerDurableObject.fetch() runs identically to workerd
  class MockCloudflareSocket {
    public peer: MockCloudflareSocket | null = null;
    public accepted = false;
    public closed = false;
    public receivedMessages: Array<Record<string, unknown>> = [];
    private listeners: Record<string, Array<(ev: Record<string, unknown>) => void>> = {
      message: [],
      close: [],
      error: [],
    };

    accept(): void {
      this.accepted = true;
    }

    addEventListener(type: string, handler: (ev: Record<string, unknown>) => void): void {
      if (!this.listeners[type]) this.listeners[type] = [];
      this.listeners[type].push(handler);
    }

    send(data: string): void {
      if (this.closed || !this.peer || this.peer.closed) return;
      const parsed = JSON.parse(data) as Record<string, unknown>;
      this.peer.receivedMessages.push(parsed);
      for (const fn of this.peer.listeners.message || []) {
        fn({ data });
      }
    }

    close(code = 1000, reason = ''): void {
      if (this.closed) return;
      this.closed = true;
      for (const fn of this.listeners.close || []) {
        fn({ code, reason });
      }
      if (this.peer && !this.peer.closed) {
        this.peer.closed = true;
        for (const fn of this.peer.listeners.close || []) {
          fn({ code, reason });
        }
      }
    }
  }

  class MockWebSocketPair {
    0: MockCloudflareSocket;
    1: MockCloudflareSocket;
    constructor() {
      const client = new MockCloudflareSocket();
      const server = new MockCloudflareSocket();
      client.peer = server;
      server.peer = client;
      this[0] = client;
      this[1] = server;
    }
  }

  (globalThis as unknown as { WebSocketPair: typeof MockWebSocketPair }).WebSocketPair =
    MockWebSocketPair;

  const workerModule = await import('../cloudflare/worker');
  const workerDefault = workerModule.default;
  const { MatchmakerDurableObject } = workerModule;

  // Create a single shared MatchmakerDurableObject instance and bind it to env.MATCHMAKER_DO
  const sharedDoInstance = new MatchmakerDurableObject({ id: 'global-sri-lanka-pool' }, {});
  const workerEnv = {
    MATCHMAKER_DO: {
      idFromName: (name: string) => ({ name }),
      get: () => sharedDoInstance,
    },
  };

  // 9a. Reject unauthenticated or forged WebSocket upgrade requests with HTTP 401
  const invalidWsReq = new Request(
    'https://once-upon-a-lanka.workers.dev/ws?token=forged_invalid_token',
    {
      headers: { Upgrade: 'websocket' },
    }
  );
  const invalidWsRes = await workerDefault.fetch(invalidWsReq, workerEnv);
  assert.equal(invalidWsRes.status, 401, 'Invalid session token on /ws must be rejected with HTTP 401');

  // 9b. Authenticate second independent user (Kavan) to get a real session token
  const kavanLoginReq = new Request('https://once-upon-a-lanka.workers.dev/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'kavan@onceuponatime.lk', password: 'OnceUpon2026!' }),
  });
  const kavanLoginRes = await handleApiRequest(kavanLoginReq, workerEnv, new URL(kavanLoginReq.url));
  assert.equal(kavanLoginRes.status, 200, 'Second user (Kavan) login must succeed');
  const kavanLoginData = (await kavanLoginRes.json()) as { token: string; user: { id: string } };

  // 9c. Upgrade both independent authenticated users (Amaya & Kavan) to WebSockets via /ws
  const amayaWsReq = new Request(
    `https://once-upon-a-lanka.workers.dev/ws?token=${encodeURIComponent(loginData.token)}`,
    { headers: { Upgrade: 'websocket' } }
  );
  const amayaWsRes = (await workerDefault.fetch(amayaWsReq, workerEnv)) as Response & {
    webSocket?: MockCloudflareSocket;
  };
  assert.equal(amayaWsRes.status, 101, 'Amaya /ws upgrade must return HTTP 101');
  assert.ok(amayaWsRes.webSocket, 'Amaya HTTP 101 response must include upgraded client WebSocket');

  const kavanWsReq = new Request(
    `https://once-upon-a-lanka.workers.dev/ws?token=${encodeURIComponent(kavanLoginData.token)}`,
    { headers: { Upgrade: 'websocket' } }
  );
  const kavanWsRes = (await workerDefault.fetch(kavanWsReq, workerEnv)) as Response & {
    webSocket?: MockCloudflareSocket;
  };
  assert.equal(kavanWsRes.status, 101, 'Kavan /ws upgrade must return HTTP 101');
  assert.ok(kavanWsRes.webSocket, 'Kavan HTTP 101 response must include upgraded client WebSocket');

  const amayaClient = amayaWsRes.webSocket!;
  const kavanClient = kavanWsRes.webSocket!;

  assert.equal(
    amayaClient.receivedMessages[0]?.type,
    'connection:established',
    'Amaya must receive connection:established upon WebSocket upgrade'
  );
  assert.equal(
    kavanClient.receivedMessages[0]?.type,
    'connection:established',
    'Kavan must receive connection:established upon WebSocket upgrade'
  );

  // 9d. Both join the video matchmaking queue; verify atomic pairing and ephemeral peer IDs
  amayaClient.send(JSON.stringify({ type: 'queue:join', mode: 'video' }));
  assert.equal(
    amayaClient.receivedMessages.at(-1)?.type,
    'queue:waiting',
    'First user joining empty queue must receive queue:waiting'
  );

  kavanClient.send(JSON.stringify({ type: 'queue:join', mode: 'video' }));
  const amayaMatchMsg = amayaClient.receivedMessages.at(-1) as {
    type: string;
    sessionId: string;
    mode: string;
    initiator: boolean;
    partner: { ephemeralPeerId: string; displayName: string };
  };
  const kavanMatchMsg = kavanClient.receivedMessages.at(-1) as {
    type: string;
    sessionId: string;
    mode: string;
    initiator: boolean;
    partner: { ephemeralPeerId: string; displayName: string };
  };

  assert.equal(amayaMatchMsg.type, 'match:found', 'Amaya must receive match:found when Kavan joins');
  assert.equal(kavanMatchMsg.type, 'match:found', 'Kavan must receive match:found when joining');
  assert.equal(amayaMatchMsg.sessionId, kavanMatchMsg.sessionId, 'Both partners must share the same sessionId');
  assert.equal(amayaMatchMsg.initiator, true, 'Waiting user (Amaya) must be designated WebRTC initiator');
  assert.equal(kavanMatchMsg.initiator, false, 'Joining user (Kavan) must be non-initiator');
  assert.ok(
    amayaMatchMsg.partner.ephemeralPeerId.startsWith('peer_') &&
      !amayaMatchMsg.partner.ephemeralPeerId.includes('usr_'),
    'Partner ID must be an ephemeral peer_ token, never exposing internal usr_ ID'
  );

  const activeSessionId = amayaMatchMsg.sessionId;

  // 9e. Relay WebRTC SDP Offer, SDP Answer, and ICE candidates between matched partners
  const mockOffer = { type: 'offer', sdp: 'v=0\r\no=- 12345 2 IN IP4 127.0.0.1\r\n' };
  amayaClient.send(
    JSON.stringify({
      type: 'webrtc:sdp',
      sessionId: activeSessionId,
      data: mockOffer,
    })
  );
  const kavanSdpMsg = kavanClient.receivedMessages.at(-1) as {
    type: string;
    sessionId: string;
    data: { type: string; sdp: string };
  };
  assert.equal(kavanSdpMsg.type, 'webrtc:sdp', 'Kavan must receive relayed WebRTC SDP offer');
  assert.equal(kavanSdpMsg.data.type, 'offer', 'Relayed SDP must preserve offer payload');

  const mockAnswer = { type: 'answer', sdp: 'v=0\r\no=- 67890 2 IN IP4 127.0.0.1\r\n' };
  kavanClient.send(
    JSON.stringify({
      type: 'webrtc:sdp',
      sessionId: activeSessionId,
      data: mockAnswer,
    })
  );
  const amayaSdpMsg = amayaClient.receivedMessages.at(-1) as {
    type: string;
    sessionId: string;
    data: { type: string; sdp: string };
  };
  assert.equal(amayaSdpMsg.type, 'webrtc:sdp', 'Amaya must receive relayed WebRTC SDP answer');
  assert.equal(amayaSdpMsg.data.type, 'answer', 'Relayed SDP must preserve answer payload');

  const mockIce = { candidate: 'candidate:1 1 UDP 2122252543 192.0.2.1 54321 typ host', sdpMid: '0' };
  amayaClient.send(
    JSON.stringify({
      type: 'webrtc:ice',
      sessionId: activeSessionId,
      data: mockIce,
    })
  );
  const kavanIceMsg = kavanClient.receivedMessages.at(-1) as {
    type: string;
    data: { candidate: string };
  };
  assert.equal(kavanIceMsg.type, 'webrtc:ice', 'Kavan must receive relayed WebRTC ICE candidate');
  assert.equal(kavanIceMsg.data.candidate, mockIce.candidate, 'Relayed ICE candidate must match');

  // 9f. Relay ephemeral text message, typing indicator, and media state
  amayaClient.send(
    JSON.stringify({
      type: 'stranger:typing',
      sessionId: activeSessionId,
    })
  );
  assert.equal(
    kavanClient.receivedMessages.at(-1)?.type,
    'stranger:typing',
    'Kavan must receive stranger:typing indicator'
  );

  amayaClient.send(
    JSON.stringify({
      type: 'stranger:media-state',
      sessionId: activeSessionId,
      data: { cameraOn: false, micOn: true },
    })
  );
  const kavanMediaMsg = kavanClient.receivedMessages.at(-1) as {
    type: string;
    data: { cameraOn: boolean; micOn: boolean };
  };
  assert.equal(kavanMediaMsg.type, 'stranger:media-state', 'Kavan must receive stranger:media-state');
  assert.equal(kavanMediaMsg.data.cameraOn, false, 'Media state cameraOn=false must be relayed');

  amayaClient.send(
    JSON.stringify({
      type: 'stranger:message',
      sessionId: activeSessionId,
      data: { text: 'Ayubowan Kavan from Colombo!' },
    })
  );
  const kavanChatMsg = kavanClient.receivedMessages.at(-1) as {
    type: string;
    data: { text: string };
  };
  assert.equal(kavanChatMsg.type, 'stranger:message', 'Kavan must receive stranger:message');
  assert.equal(
    kavanChatMsg.data.text,
    'Ayubowan Kavan from Colombo!',
    'Relayed message text must match'
  );

  // 9g. Test stranger:skip — notifies partner with stranger:disconnected and re-queues skipping user
  amayaClient.send(JSON.stringify({ type: 'stranger:skip', mode: 'video' }));
  assert.equal(
    kavanClient.receivedMessages.at(-1)?.type,
    'stranger:disconnected',
    'Partner (Kavan) must receive stranger:disconnected when Amaya skips'
  );
  assert.equal(
    amayaClient.receivedMessages.at(-1)?.type,
    'queue:waiting',
    'Skipping user (Amaya) must automatically re-enter queue:waiting'
  );

  // 9h. Pair again, verify webrtc:ready relay, ping/pong heartbeat, payload validation, and disconnect cleanup
  kavanClient.send(JSON.stringify({ type: 'queue:join', mode: 'video' }));
  const secondMatchMsg = amayaClient.receivedMessages.at(-1) as {
    type: string;
    sessionId: string;
  };
  assert.equal(
    secondMatchMsg.type,
    'match:found',
    'Amaya and Kavan must match again when Kavan rejoins queue'
  );

  kavanClient.send(
    JSON.stringify({
      type: 'webrtc:ready',
      sessionId: secondMatchMsg.sessionId,
    })
  );
  assert.equal(
    amayaClient.receivedMessages.at(-1)?.type,
    'webrtc:ready',
    'Amaya must receive webrtc:ready signal from responder Kavan'
  );

  // Verify ping -> pong heartbeat
  kavanClient.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
  assert.equal(
    kavanClient.receivedMessages.at(-1)?.type,
    'pong',
    'Durable Object must respond to ping with pong heartbeat'
  );

  // Verify invalid message type is rejected safely without closing the socket
  kavanClient.send(JSON.stringify({ type: 'unsupported:malicious:event' }));
  assert.equal(
    kavanClient.receivedMessages.at(-1)?.type,
    'error:invalid-payload',
    'Durable Object must safely reject unknown message types with error:invalid-payload'
  );
  assert.equal(kavanClient.closed, false, 'Kavan WebSocket must remain open after invalid message');

  // Verify that when Amaya disconnects, Kavan receives stranger:disconnected AND Kavan's WebSocket stays OPEN
  amayaClient.close(1001, 'Tab closed');
  assert.equal(
    kavanClient.receivedMessages.at(-1)?.type,
    'stranger:disconnected',
    'Kavan must immediately receive stranger:disconnected when Amaya closes her WebSocket'
  );
  assert.equal(
    kavanClient.closed,
    false,
    'Kavan signaling WebSocket must remain OPEN after partner Amaya disconnects'
  );

  // Verify Kavan can immediately rejoin the queue on the same open WebSocket
  kavanClient.send(JSON.stringify({ type: 'queue:join', mode: 'video' }));
  assert.equal(
    kavanClient.receivedMessages.at(-1)?.type,
    'queue:waiting',
    'Kavan must be able to rejoin queue on existing open WebSocket after partner disconnect'
  );
  kavanClient.close(1000, 'Done');

  // 9i. Verify Cloudflare Durable Object WebSocket Hibernation State Reconstruction
  const hibernatedServerSockets: Array<
    MockCloudflareSocket & {
      attachment?: unknown;
      serializeAttachment: (data: unknown) => void;
      deserializeAttachment: () => unknown;
    }
  > = [];

  const hibernatableState = {
    id: 'hibernation-test-pool',
    acceptWebSocket: (ws: MockCloudflareSocket) => {
      ws.accepted = true;
      const hWs = ws as MockCloudflareSocket & {
        attachment?: unknown;
        serializeAttachment: (data: unknown) => void;
        deserializeAttachment: () => unknown;
      };
      hWs.serializeAttachment = (data: unknown) => {
        hWs.attachment = JSON.parse(JSON.stringify(data));
      };
      hWs.deserializeAttachment = () =>
        hWs.attachment ? JSON.parse(JSON.stringify(hWs.attachment)) : null;
      hibernatedServerSockets.push(hWs);
    },
    getWebSockets: () => hibernatedServerSockets.filter((s) => !s.closed),
  };

  // Instance #1 accepts two connections and matches them
  const doBeforeHibernation = new MatchmakerDurableObject(hibernatableState, {});
  const hibAmayaRes = (await doBeforeHibernation.fetch(
    new Request(
      `https://once-upon-a-lanka.workers.dev/ws?token=${encodeURIComponent(
        loginData.token
      )}&clientId=tab_amaya_hib`,
      { headers: { Upgrade: 'websocket' } }
    )
  )) as Response & { webSocket?: MockCloudflareSocket };
  const hibKavanRes = (await doBeforeHibernation.fetch(
    new Request(
      `https://once-upon-a-lanka.workers.dev/ws?token=${encodeURIComponent(
        kavanLoginData.token
      )}&clientId=tab_kavan_hib`,
      { headers: { Upgrade: 'websocket' } }
    )
  )) as Response & { webSocket?: MockCloudflareSocket };

  const hibAmayaServer = hibernatedServerSockets[0];
  const hibKavanServer = hibernatedServerSockets[1];
  const hibAmayaClient = hibAmayaRes.webSocket!;
  const hibKavanClient = hibKavanRes.webSocket!;

  await doBeforeHibernation.webSocketMessage(
    hibAmayaServer as unknown as WebSocket,
    JSON.stringify({ type: 'queue:join', mode: 'video' })
  );
  await doBeforeHibernation.webSocketMessage(
    hibKavanServer as unknown as WebSocket,
    JSON.stringify({ type: 'queue:join', mode: 'video' })
  );

  const hibMatchMsg = hibAmayaClient.receivedMessages.at(-1) as {
    type: string;
    sessionId: string;
  };
  assert.equal(hibMatchMsg.type, 'match:found', 'Hibernation test users must match');

  // Simulate Cloudflare evicting the Durable Object from memory and waking a brand-new instance
  const doAfterWakeup = new MatchmakerDurableObject(hibernatableState, {});
  await doAfterWakeup.webSocketMessage(
    hibAmayaServer as unknown as WebSocket,
    JSON.stringify({
      type: 'webrtc:sdp',
      sessionId: hibMatchMsg.sessionId,
      data: { type: 'offer', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n' },
    })
  );
  assert.equal(
    hibKavanClient.receivedMessages.at(-1)?.type,
    'webrtc:sdp',
    'Woken Durable Object must reconstruct active session from WebSocket attachments and relay SDP Offer'
  );

  // 10. Verify GET /api/webrtc/ice-servers (Free STUN + Optional TURN + 640x360@24fps / 500 Kbps profile)
  const iceReq = new Request('https://once-upon-a-lanka.workers.dev/api/webrtc/ice-servers', {
    method: 'GET',
    headers: { Authorization: `Bearer ${loginData.token}` },
  });
  const iceRes = await handleApiRequest(iceReq, {}, new URL(iceReq.url));
  assert.equal(iceRes.status, 200, 'GET /api/webrtc/ice-servers must return HTTP 200');
  const iceData = (await iceRes.json()) as {
    iceServers: Array<{ urls: string | string[]; username?: string }>;
    turnConfigured: boolean;
    mediaConstraints: { width: number; height: number; frameRate: number; maxVideoBitrateBps: number };
  };
  assert.ok(Array.isArray(iceData.iceServers) && iceData.iceServers.length >= 1, 'Must return STUN iceServers');
  assert.equal(iceData.turnConfigured, false, 'Default free mode has turnConfigured=false');
  assert.equal(iceData.mediaConstraints.width, 640, 'Video width constraint must be 640');
  assert.equal(iceData.mediaConstraints.height, 360, 'Video height constraint must be 360');
  assert.equal(iceData.mediaConstraints.frameRate, 24, 'Video frameRate constraint must be 24');
  assert.equal(iceData.mediaConstraints.maxVideoBitrateBps, 500_000, 'Max video bitrate must be 500 Kbps');

  // Verify static TURN credentials when configured in environment
  const iceTurnRes = await handleApiRequest(
    iceReq,
    {
      TURN_URLS: 'turn:turn.cloudflare.com:3478',
      TURN_USERNAME: 'ouat_turn_user',
      TURN_CREDENTIAL: 'ouat_turn_secret',
    } as Record<string, unknown>,
    new URL(iceReq.url)
  );
  const iceTurnData = (await iceTurnRes.json()) as {
    iceServers: Array<{ urls: string | string[]; username?: string }>;
    turnConfigured: boolean;
  };
  assert.equal(iceTurnData.turnConfigured, true, 'TURN must be enabled when credentials are set');
  assert.equal(iceTurnData.iceServers.length, 2, 'Must include both STUN and TURN server entries');

  console.log('ALL BACKEND & DURABLE OBJECT WEBSOCKET TESTS PASSED.');
}

runBackendVerificationTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
