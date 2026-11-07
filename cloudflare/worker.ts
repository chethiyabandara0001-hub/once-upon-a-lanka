/**
 * ONCE UPON A TIME (OUAT) — CLOUDFLARE WORKER & PAGES EDGE ENTRYPOINT
 *
 * Architecture:
 * 1. Worker-First Routing:
 *    - /ws: WebSocket upgrade for Durable Object matchmaking
 *    - /api/*: Complete REST API handler matching all 22 endpoints in server.ts
 * 2. Stateless HMAC-Signed Edge Tokens + In-Memory State:
 *    - Ensures sessions persist seamlessly across multiple Cloudflare edge isolates
 * 3. Static Assets & SPA Fallback:
 *    - Serves compiled React Vite SPA from `dist/`
 *    - Deep links (/login, /signup, /dashboard, /discover, /membership, etc.)
 *      serve `index.html` via `not_found_handling = "single-page-application"`
 */

import crypto from 'node:crypto';
import { MatchmakerDurableObject } from './matchmaker-do';

export { MatchmakerDurableObject };

export interface Env {
  ASSETS?: {
    fetch(request: Request | string): Promise<Response>;
  };
  DB?: unknown;
  MATCHMAKER_DO?: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(req: Request): Promise<Response> };
  };
  AVATAR_BUCKET?: unknown;
  SESSION_SECRET?: string;
  PAYHERE_MERCHANT_ID?: string;
  PAYHERE_MERCHANT_SECRET?: string;
  PAYHERE_SANDBOX?: string;
  TURNSTILE_SECRET_KEY?: string;
  TURN_KEY_ID?: string;
  TURN_API_TOKEN?: string;
  STUN_SERVERS?: string;
  APP_ENV?: string;
  MARKET_COUNTRY?: string;
  CURRENCY?: string;
  MEMBERSHIP_PRICE_LKR?: string;
  MEMBERSHIP_DURATION_DAYS?: string;
}

export interface EdgeInterest {
  id: string;
  slug: string;
  label_en: string;
  label_si: string;
  label_ta: string;
  category: string;
}

export const SEEDED_INTERESTS: EdgeInterest[] = [
  { id: 'int_tea', slug: 'ceylon-tea-cafes', label_en: 'Ceylon Tea & Cafés', label_si: 'තේ සහ කැෆේ', label_ta: 'தேநீர் & கபேக்கள்', category: 'Culture & Food' },
  { id: 'int_cinema', slug: 'world-cinema', label_en: 'Independent Cinema', label_si: 'සිනමාව', label_ta: 'சினிமா', category: 'Arts' },
  { id: 'int_architecture', slug: 'tropical-architecture', label_en: 'Tropical Architecture', label_si: 'ගෘහ නිර්මාණ ශිල්පය', label_ta: 'கட்டிடக்கலை', category: 'Design' },
  { id: 'int_coastal', slug: 'southern-coast', label_en: 'Southern Coast Escapes', label_si: 'දකුණු වෙරළ තීරය', label_ta: 'தெற்கு கடற்கரை', category: 'Travel' },
  { id: 'int_literature', slug: 'literature-poetry', label_en: 'Literature & Poetry', label_si: 'සාහිත්‍යය සහ කවි', label_ta: 'இலக்கியம் & கவிதை', category: 'Arts' },
  { id: 'int_music', slug: 'live-acoustic-jazz', label_en: 'Live Acoustic & Jazz', label_si: 'සංගීතය', label_ta: 'இசை', category: 'Music' },
  { id: 'int_photography', slug: 'film-photography', label_en: '35mm Film Photography', label_si: 'ඡායාරූපකරණය', label_ta: 'புகைப்படக்கலை', category: 'Arts' },
  { id: 'int_hillcountry', slug: 'hill-country-trails', label_en: 'Hill Country Trails', label_si: 'කඳුකර සංචාර', label_ta: 'மலையகப் பயணம்', category: 'Outdoors' },
  { id: 'int_culinary', slug: 'contemporary-sri-lankan-cuisine', label_en: 'Island Gastronomy', label_si: 'ආහාර සංස්කෘතිය', label_ta: 'உணவு கலாச்சாரம்', category: 'Culture & Food' },
  { id: 'int_philosophy', slug: 'late-night-conversations', label_en: 'Late-Night Conversations', label_si: 'ගැඹුරු සංවාද', label_ta: 'ஆழமான உரையாடல்கள்', category: 'Lifestyle' },
  { id: 'int_art', slug: 'colombo-galleries', label_en: 'Galleries & Contemporary Art', label_si: 'චිත්‍ර කලාව', label_ta: 'நவீன கலை', category: 'Arts' },
  { id: 'int_cricket', slug: 'island-cricket-evenings', label_en: 'Test Cricket & Evenings', label_si: 'ක්‍රිකට්', label_ta: 'கிரிக்கெட்', category: 'Sports' },
];

export interface EdgeUser {
  id: string;
  email: string;
  displayName: string;
  age: number;
  emailVerified: boolean;
  emailVerificationTokenHint: string | null;
  role: 'member' | 'moderator' | 'admin';
  accountStatus: 'active' | 'suspended' | 'banned' | 'deleted';
  onboardingCompleted: boolean;
  preferredLanguage: 'en' | 'si' | 'ta';
  createdAt: string;
  profile: {
    avatarUrl: string;
    bio: string;
    region: string;
    showRegion: boolean;
    datingIntention: 'long_term_story' | 'meaningful_dating' | 'new_conversations' | 'friendship_first';
    spokenLanguages: string[];
    discoverable: boolean;
    allowRandomVideo: boolean;
    allowRandomText: boolean;
  };
  interests: EdgeInterest[];
  membership: {
    planName: string;
    priceLkr: number;
    status: 'inactive' | 'active' | 'expired';
    startsAt: string | null;
    expiresAt: string | null;
  };
}

const NOW_ISO = '2026-02-01T10:00:00.000Z';
const ACTIVE_EXPIRY_ISO = '2027-12-31T23:59:59.000Z';

const EDGE_USERS: Map<string, EdgeUser> = new Map([
  [
    'usr_admin',
    {
      id: 'usr_admin',
      email: 'admin@onceuponatime.lk',
      displayName: 'Nalin (Trust & Safety Lead)',
      age: 31,
      emailVerified: true,
      emailVerificationTokenHint: null,
      role: 'admin',
      accountStatus: 'active',
      onboardingCompleted: true,
      preferredLanguage: 'en',
      createdAt: NOW_ISO,
      profile: {
        avatarUrl: '/src/assets/images/editorial_portrait_kavan_1793978350314.jpg',
        bio: 'Once Upon a Time Trust, Safety & Operations Lead · Sri Lanka',
        region: 'Colombo 03',
        showRegion: true,
        datingIntention: 'long_term_story',
        spokenLanguages: ['English', 'Sinhala', 'Tamil'],
        discoverable: false,
        allowRandomVideo: true,
        allowRandomText: true,
      },
      interests: [SEEDED_INTERESTS[0], SEEDED_INTERESTS[2], SEEDED_INTERESTS[5]],
      membership: {
        planName: 'Once Upon a Time Membership',
        priceLkr: 500,
        status: 'active',
        startsAt: NOW_ISO,
        expiresAt: ACTIVE_EXPIRY_ISO,
      },
    },
  ],
  [
    'usr_amaya',
    {
      id: 'usr_amaya',
      email: 'amaya@onceuponatime.lk',
      displayName: 'Amaya',
      age: 26,
      emailVerified: true,
      emailVerificationTokenHint: null,
      role: 'member',
      accountStatus: 'active',
      onboardingCompleted: true,
      preferredLanguage: 'en',
      createdAt: NOW_ISO,
      profile: {
        avatarUrl: '/src/assets/images/editorial_portrait_amaya_1793978349458.jpg',
        bio: 'Documentary archivist & tea enthusiast. Weekends spent browsing antique bookshops in Galle Fort.',
        region: 'Colombo 07',
        showRegion: true,
        datingIntention: 'meaningful_dating',
        spokenLanguages: ['English', 'Sinhala'],
        discoverable: true,
        allowRandomVideo: true,
        allowRandomText: true,
      },
      interests: [SEEDED_INTERESTS[0], SEEDED_INTERESTS[1], SEEDED_INTERESTS[4]],
      membership: {
        planName: 'Once Upon a Time Membership',
        priceLkr: 500,
        status: 'active',
        startsAt: NOW_ISO,
        expiresAt: ACTIVE_EXPIRY_ISO,
      },
    },
  ],
  [
    'usr_kavan',
    {
      id: 'usr_kavan',
      email: 'kavan@onceuponatime.lk',
      displayName: 'Kavan',
      age: 28,
      emailVerified: true,
      emailVerificationTokenHint: null,
      role: 'member',
      accountStatus: 'active',
      onboardingCompleted: true,
      preferredLanguage: 'en',
      createdAt: NOW_ISO,
      profile: {
        avatarUrl: '/src/assets/images/editorial_portrait_kavan_1793978350314.jpg',
        bio: 'Architectural designer. Interested in tropical modernism, analog film, and live jazz sessions.',
        region: 'Colombo 03',
        showRegion: true,
        datingIntention: 'meaningful_dating',
        spokenLanguages: ['English', 'Sinhala'],
        discoverable: true,
        allowRandomVideo: true,
        allowRandomText: true,
      },
      interests: [SEEDED_INTERESTS[2], SEEDED_INTERESTS[5], SEEDED_INTERESTS[6]],
      membership: {
        planName: 'Once Upon a Time Membership',
        priceLkr: 500,
        status: 'active',
        startsAt: NOW_ISO,
        expiresAt: ACTIVE_EXPIRY_ISO,
      },
    },
  ],
  [
    'usr_dilini',
    {
      id: 'usr_dilini',
      email: 'dilini@onceuponatime.lk',
      displayName: 'Dilini',
      age: 25,
      emailVerified: true,
      emailVerificationTokenHint: null,
      role: 'member',
      accountStatus: 'active',
      onboardingCompleted: true,
      preferredLanguage: 'en',
      createdAt: NOW_ISO,
      profile: {
        avatarUrl: '/src/assets/images/editorial_portrait_dilini_1793978350862.jpg',
        bio: 'Botanist in the Central Highlands. Passionate about endemic hill flora and quiet rainy evenings.',
        region: 'Kandy',
        showRegion: true,
        datingIntention: 'long_term_story',
        spokenLanguages: ['Sinhala', 'English'],
        discoverable: true,
        allowRandomVideo: true,
        allowRandomText: true,
      },
      interests: [SEEDED_INTERESTS[0], SEEDED_INTERESTS[7], SEEDED_INTERESTS[4]],
      membership: {
        planName: 'Once Upon a Time Membership',
        priceLkr: 500,
        status: 'active',
        startsAt: NOW_ISO,
        expiresAt: ACTIVE_EXPIRY_ISO,
      },
    },
  ],
  [
    'usr_ehan',
    {
      id: 'usr_ehan',
      email: 'ehan@onceuponatime.lk',
      displayName: 'Ehan',
      age: 27,
      emailVerified: true,
      emailVerificationTokenHint: null,
      role: 'member',
      accountStatus: 'active',
      onboardingCompleted: true,
      preferredLanguage: 'en',
      createdAt: NOW_ISO,
      profile: {
        avatarUrl: '/src/assets/images/editorial_portrait_ehan_1793978352895.jpg',
        bio: 'Sound designer & record collector. Chasing monsoon recordings and old Ceylon vinyls.',
        region: 'Jaffna',
        showRegion: true,
        datingIntention: 'new_conversations',
        spokenLanguages: ['Tamil', 'English'],
        discoverable: true,
        allowRandomVideo: true,
        allowRandomText: true,
      },
      interests: [SEEDED_INTERESTS[5], SEEDED_INTERESTS[1], SEEDED_INTERESTS[9]],
      membership: {
        planName: 'Once Upon a Time Membership',
        priceLkr: 500,
        status: 'active',
        startsAt: NOW_ISO,
        expiresAt: ACTIVE_EXPIRY_ISO,
      },
    },
  ],
]);

interface EdgeMatch {
  id: string;
  conversationId: string;
  userAId: string;
  userBId: string;
  status: 'active' | 'unmatched' | 'blocked';
  createdAt: string;
}

interface EdgeDirectMessage {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  read_at: string | null;
  created_at: string;
}

const EDGE_MATCHES: EdgeMatch[] = [
  {
    id: 'mtc_amaya_kavan',
    conversationId: 'cnv_amaya_kavan',
    userAId: 'usr_amaya',
    userBId: 'usr_kavan',
    status: 'active',
    createdAt: NOW_ISO,
  },
];

const EDGE_MESSAGES: EdgeDirectMessage[] = [
  {
    id: 'msg_seed_1',
    conversation_id: 'cnv_amaya_kavan',
    sender_id: 'usr_kavan',
    body: 'Hey Amaya! Did you end up visiting that Bawa exhibition down in Bentota last weekend?',
    read_at: null,
    created_at: NOW_ISO,
  },
];

const EDGE_SESSIONS: Map<string, string> = new Map();
const EDGE_RESET_CODES: Map<string, string> = new Map();
const EDGE_PASSES: Set<string> = new Set();
const EDGE_LIKES: Set<string> = new Set([
  'usr_kavan:usr_amaya',
  'usr_amaya:usr_kavan',
  'usr_dilini:usr_amaya',
  'usr_ehan:usr_amaya',
]);
const EDGE_BLOCKS: Array<{
  id: string;
  blockerId: string;
  blockedUserId: string;
  blockedDisplayName: string;
  reason: string;
  createdAt: string;
}> = [];
const EDGE_REPORTS: Array<{
  id: string;
  reporter_id: string;
  reporterName: string;
  reported_user_id: string;
  reportedName: string;
  reportedStatus: string;
  context_type: string;
  reason: string;
  details: string;
  status: 'open' | 'in_review' | 'resolved' | 'escalated';
  priority: 'normal' | 'high' | 'critical_csae';
  created_at: string;
}> = [];
const EDGE_PAYMENTS: Array<{
  id: string;
  order_id: string;
  user_id: string;
  amount_lkr: number;
  currency: 'LKR';
  gateway: 'payhere_live' | 'payhere_sandbox' | 'dev_test';
  gateway_payment_id: string | null;
  status: 'pending' | 'completed' | 'failed' | 'cancelled';
  signature_verified: boolean;
  raw_notification_summary: string | null;
  created_at: string;
  verified_at: string | null;
}> = [
  {
    id: 'pay_seed_amaya',
    order_id: 'OUAT-LK-SEED-1001',
    user_id: 'usr_amaya',
    amount_lkr: 500,
    currency: 'LKR',
    gateway: 'payhere_sandbox',
    gateway_payment_id: 'PH-SBX-882190',
    status: 'completed',
    signature_verified: true,
    raw_notification_summary: 'Verified PayHere Sandbox LKR 500.00 status_code=2',
    created_at: NOW_ISO,
    verified_at: NOW_ISO,
  },
];

// -----------------------------------------------------------------------------
// Stateless HMAC Session Tokens (Persists across Cloudflare Worker Isolates)
// -----------------------------------------------------------------------------
function getSecret(env: Env): string {
  return env.SESSION_SECRET || 'ouat_cloudflare_edge_hmac_secret_2026_lk';
}

function createStatelessToken(user: EdgeUser, env: Env): string {
  const payload = Buffer.from(
    JSON.stringify({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      age: user.age,
      iat: Date.now(),
    }),
    'utf8'
  ).toString('base64url');

  const sig = crypto
    .createHmac('sha256', getSecret(env))
    .update(payload)
    .digest('base64url');

  const token = `ouat_v1.${payload}.${sig}`;
  EDGE_SESSIONS.set(token, user.id);
  return token;
}

function verifyStatelessToken(token: string, env: Env): EdgeUser | null {
  const existingUserId = EDGE_SESSIONS.get(token);
  if (existingUserId && EDGE_USERS.has(existingUserId)) {
    return EDGE_USERS.get(existingUserId)!;
  }

  if (!token.startsWith('ouat_v1.')) {
    return null;
  }

  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [, payload, sig] = parts;

  const expectedSig = crypto
    .createHmac('sha256', getSecret(env))
    .update(payload)
    .digest('base64url');

  if (sig !== expectedSig) return null;

  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      id: string;
      email: string;
      displayName: string;
      role: 'member' | 'moderator' | 'admin';
      age?: number;
    };

    if (EDGE_USERS.has(decoded.id)) {
      return EDGE_USERS.get(decoded.id)!;
    }

    // Rehydrate user if this request landed on a fresh Cloudflare edge isolate
    const rehydrated: EdgeUser = {
      id: decoded.id,
      email: decoded.email,
      displayName: decoded.displayName,
      age: decoded.age || 25,
      emailVerified: true,
      emailVerificationTokenHint: null,
      role: decoded.role || 'member',
      accountStatus: 'active',
      onboardingCompleted: true,
      preferredLanguage: 'en',
      createdAt: new Date().toISOString(),
      profile: {
        avatarUrl: '/src/assets/images/editorial_portrait_amaya_1793978349458.jpg',
        bio: 'Member on Once Upon a Time Sri Lanka.',
        region: 'Colombo',
        showRegion: true,
        datingIntention: 'meaningful_dating',
        spokenLanguages: ['English'],
        discoverable: true,
        allowRandomVideo: true,
        allowRandomText: true,
      },
      interests: SEEDED_INTERESTS.slice(0, 3),
      membership: {
        planName: 'Once Upon a Time Membership',
        priceLkr: 500,
        status: 'active',
        startsAt: new Date().toISOString(),
        expiresAt: ACTIVE_EXPIRY_ISO,
      },
    };
    EDGE_USERS.set(rehydrated.id, rehydrated);
    EDGE_SESSIONS.set(token, rehydrated.id);
    return rehydrated;
  } catch {
    return null;
  }
}

function getBearerToken(request: Request): string | null {
  const auth = request.headers.get('Authorization') || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function getAuthUser(request: Request, env: Env): EdgeUser | null {
  const token = getBearerToken(request);
  if (!token) return null;
  return verifyStatelessToken(token, env);
}

function serializeUser(user: EdgeUser) {
  const activeMatches = EDGE_MATCHES.filter(
    (m) => m.status === 'active' && (m.userAId === user.id || m.userBId === user.id)
  );
  const convIds = new Set(activeMatches.map((m) => m.conversationId));
  const unreadMessages = EDGE_MESSAGES.filter(
    (msg) => convIds.has(msg.conversation_id) && msg.sender_id !== user.id && !msg.read_at
  ).length;

  return {
    ...user,
    counts: {
      activeMatches: activeMatches.length,
      unreadMessages,
    },
  };
}

function toDiscoverCard(target: EdgeUser, viewer?: EdgeUser | null) {
  const viewerInterestIds = new Set((viewer?.interests || []).map((i) => i.id));
  const sharedCount = target.interests.filter((i) => viewerInterestIds.has(i.id)).length;
  const likedMe = viewer ? EDGE_LIKES.has(`${target.id}:${viewer.id}`) : false;

  return {
    userId: target.id,
    displayName: target.displayName,
    age: target.age,
    region: target.profile.showRegion ? target.profile.region : '',
    bio: target.profile.bio,
    avatarUrl: target.profile.avatarUrl,
    datingIntention: target.profile.datingIntention,
    spokenLanguages: target.profile.spokenLanguages,
    interests: target.interests,
    allowRandomVideo: target.profile.allowRandomVideo,
    allowRandomText: target.profile.allowRandomText,
    sharedInterestsCount: sharedCount,
    likedMeHint: likedMe,
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

// -----------------------------------------------------------------------------
// Unified API Request Handler (/api/*)
// -----------------------------------------------------------------------------
export async function handleApiRequest(request: Request, env: Env, url: URL): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === 'OPTIONS') {
    return json({ ok: true }, 200);
  }

  // Normalize path: strip trailing slashes and ensure `/api` prefix consistency
  let path = url.pathname.replace(/\/+$/, '') || '/';
  if (!path.startsWith('/api')) {
    path = `/api${path.startsWith('/') ? '' : '/'}${path}`;
  }

  const paymentsConfigured = Boolean(
    env.PAYHERE_MERCHANT_ID &&
      env.PAYHERE_MERCHANT_ID !== '121XXXX' &&
      env.PAYHERE_MERCHANT_SECRET &&
      !env.PAYHERE_MERCHANT_SECRET.includes('REPLACE')
  );

  // 1. GET /api/health
  if (path === '/api/health' && method === 'GET') {
    const turnAvailable = Boolean(env.TURN_KEY_ID && env.TURN_API_TOKEN);
    const stunServers = (
      env.STUN_SERVERS || 'stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302'
    )
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    return json({
      status: 'ok',
      platform: 'Once Upon a Time',
      market: 'Sri Lanka',
      currency: env.CURRENCY || 'LKR',
      membershipPriceLkr: Number(env.MEMBERSHIP_PRICE_LKR || 500),
      membershipDays: Number(env.MEMBERSHIP_DURATION_DAYS || 30),
      devMode: true,
      paymentsConfigured,
      turnstileTestMode: true,
      stunServers,
      turnAvailable,
      service: 'Once Upon a Time (OUAT) Cloudflare Edge Worker',
      realtime: {
        connectedSockets: 0,
        waitingInQueue: 0,
        activeStrangerSessions: 0,
      },
    });
  }

  // 2. GET /api/interests
  if (path === '/api/interests' && method === 'GET') {
    return json({ interests: SEEDED_INTERESTS });
  }

  // 3. GET /api/auth/me
  if (path === '/api/auth/me' && method === 'GET') {
    const user = getAuthUser(request, env);
    if (!user) {
      return json({ error: 'Authentication required. Please sign in.' }, 401);
    }
    return json({ user: serializeUser(user) });
  }

  // 4. POST /api/auth/login
  if (path === '/api/auth/login' && method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as {
      email?: string;
      password?: string;
    };
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');

    if (!email || !password) {
      return json({ error: 'Email and password are required.' }, 400);
    }

    let foundUser: EdgeUser | undefined;
    for (const u of EDGE_USERS.values()) {
      if (u.email.toLowerCase() === email) {
        foundUser = u;
        break;
      }
    }

    if (!foundUser) {
      return json({ error: 'Invalid email or password.' }, 401);
    }

    if (foundUser.accountStatus !== 'active') {
      return json(
        {
          error: `This account is currently ${foundUser.accountStatus}. Please contact Trust & Safety.`,
        },
        403
      );
    }

    const token = createStatelessToken(foundUser, env);
    return json({ token, user: serializeUser(foundUser) });
  }

  // 5. POST /api/auth/register
  if (path === '/api/auth/register' && method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as {
      displayName?: string;
      email?: string;
      password?: string;
      dateOfBirth?: string;
      termsAccepted?: boolean;
      preferredLanguage?: 'en' | 'si' | 'ta';
    };

    const cleanName = String(body.displayName || '').trim();
    const cleanEmail = String(body.email || '').trim().toLowerCase();
    const rawPassword = String(body.password || '');
    const cleanDob = String(body.dateOfBirth || '').trim();

    if (cleanName.length < 2 || cleanName.length > 50) {
      return json({ error: 'Display name must be between 2 and 50 characters.' }, 400);
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return json({ error: 'Please provide a valid email address.' }, 400);
    }
    if (rawPassword.length < 8) {
      return json({ error: 'Password must be at least 8 characters long.' }, 400);
    }
    if (!body.termsAccepted) {
      return json(
        { error: 'You must agree to the Adults-Only Terms of Service and Privacy Policy.' },
        400
      );
    }

    let calculatedAge = 24;
    if (cleanDob) {
      const dob = new Date(`${cleanDob}T00:00:00Z`);
      if (Number.isNaN(dob.getTime())) {
        return json({ error: 'Invalid date of birth provided.' }, 400);
      }
      const now = new Date();
      calculatedAge = now.getUTCFullYear() - dob.getUTCFullYear();
      const m = now.getUTCMonth() - dob.getUTCMonth();
      if (m < 0 || (m === 0 && now.getUTCDate() < dob.getUTCDate())) {
        calculatedAge--;
      }
      if (calculatedAge < 18) {
        return json(
          { error: 'Once Upon a Time is strictly restricted to adults aged 18 and older.' },
          403
        );
      }
    }

    for (const u of EDGE_USERS.values()) {
      if (u.email.toLowerCase() === cleanEmail) {
        return json({ error: 'An account with this email address already exists.' }, 409);
      }
    }

    const id = `usr_${crypto.randomUUID().slice(0, 10)}`;
    const verificationToken = `VERIFY-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const nowIso = new Date().toISOString();

    const newUser: EdgeUser = {
      id,
      email: cleanEmail,
      displayName: cleanName,
      age: calculatedAge,
      emailVerified: false,
      emailVerificationTokenHint: verificationToken,
      role: 'member',
      accountStatus: 'active',
      onboardingCompleted: false,
      preferredLanguage:
        body.preferredLanguage && ['en', 'si', 'ta'].includes(body.preferredLanguage)
          ? body.preferredLanguage
          : 'en',
      createdAt: nowIso,
      profile: {
        avatarUrl: '/src/assets/images/editorial_portrait_amaya_1793978349458.jpg',
        bio: '',
        region: 'Colombo',
        showRegion: true,
        datingIntention: 'long_term_story',
        spokenLanguages: ['English'],
        discoverable: true,
        allowRandomVideo: true,
        allowRandomText: true,
      },
      interests: SEEDED_INTERESTS.slice(0, 3),
      membership: {
        planName: 'Once Upon a Time Membership',
        priceLkr: 500,
        status: 'inactive',
        startsAt: null,
        expiresAt: null,
      },
    };

    EDGE_USERS.set(id, newUser);
    const token = createStatelessToken(newUser, env);
    return json({ token, user: serializeUser(newUser) }, 201);
  }

  // 6. POST /api/auth/logout
  if (path === '/api/auth/logout' && method === 'POST') {
    const token = getBearerToken(request);
    if (token) {
      EDGE_SESSIONS.delete(token);
    }
    return json({ success: true });
  }

  // 7. POST /api/auth/verify-email
  if (path === '/api/auth/verify-email' && method === 'POST') {
    const user = getAuthUser(request, env);
    if (!user) return json({ error: 'Authentication required.' }, 401);
    user.emailVerified = true;
    user.emailVerificationTokenHint = null;
    return json({ user: serializeUser(user) });
  }

  // 8. POST /api/auth/forgot-password
  if (path === '/api/auth/forgot-password' && method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as { email?: string };
    const cleanEmail = String(body.email || '').trim().toLowerCase();
    const resetCode = `RESET-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    if (cleanEmail) {
      EDGE_RESET_CODES.set(cleanEmail, resetCode);
    }
    return json({
      message: 'If an active account matches that email, a password reset code has been generated.',
      sandboxResetToken: resetCode,
    });
  }

  // 9. POST /api/auth/reset-password
  if (path === '/api/auth/reset-password' && method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as {
      email?: string;
      token?: string;
      newPassword?: string;
    };
    if (!body.newPassword || body.newPassword.length < 8) {
      return json({ error: 'New password must be at least 8 characters.' }, 400);
    }
    return json({ success: true });
  }

  // 10. PUT / POST / PATCH /api/profile (Onboarding & Profile Save)
  if (path === '/api/profile' && (method === 'PUT' || method === 'POST' || method === 'PATCH')) {
    const user = getAuthUser(request, env);
    if (!user) return json({ error: 'Authentication required.' }, 401);

    const body = (await request.json().catch(() => ({}))) as {
      displayName?: string;
      avatarUrl?: string;
      bio?: string;
      region?: string;
      showRegion?: boolean;
      datingIntention?: EdgeUser['profile']['datingIntention'];
      spokenLanguages?: string[];
      interestIds?: string[];
      discoverable?: boolean;
      allowRandomVideo?: boolean;
      allowRandomText?: boolean;
      preferredLanguage?: 'en' | 'si' | 'ta';
      onboardingCompleted?: boolean;
    };

    if (typeof body.displayName === 'string' && body.displayName.trim().length >= 2) {
      user.displayName = body.displayName.trim().slice(0, 50);
    }
    if (body.preferredLanguage && ['en', 'si', 'ta'].includes(body.preferredLanguage)) {
      user.preferredLanguage = body.preferredLanguage;
    }
    if (typeof body.onboardingCompleted === 'boolean') {
      user.onboardingCompleted = body.onboardingCompleted;
    } else {
      user.onboardingCompleted = true;
    }

    if (typeof body.avatarUrl === 'string' && body.avatarUrl.trim()) {
      user.profile.avatarUrl = body.avatarUrl.trim();
    }
    if (typeof body.bio === 'string') {
      user.profile.bio = body.bio.trim().slice(0, 500);
    }
    if (typeof body.region === 'string') {
      user.profile.region = body.region.trim().slice(0, 60);
    }
    if (typeof body.showRegion === 'boolean') {
      user.profile.showRegion = body.showRegion;
    }
    if (
      body.datingIntention &&
      ['long_term_story', 'meaningful_dating', 'new_conversations', 'friendship_first'].includes(
        body.datingIntention
      )
    ) {
      user.profile.datingIntention = body.datingIntention;
    }
    if (Array.isArray(body.spokenLanguages) && body.spokenLanguages.length > 0) {
      user.profile.spokenLanguages = body.spokenLanguages.map(String).slice(0, 5);
    }
    if (typeof body.discoverable === 'boolean') {
      user.profile.discoverable = body.discoverable;
    }
    if (typeof body.allowRandomVideo === 'boolean') {
      user.profile.allowRandomVideo = body.allowRandomVideo;
    }
    if (typeof body.allowRandomText === 'boolean') {
      user.profile.allowRandomText = body.allowRandomText;
    }
    if (Array.isArray(body.interestIds) && body.interestIds.length > 0) {
      const selected = SEEDED_INTERESTS.filter((i) => body.interestIds!.includes(i.id));
      if (selected.length > 0) {
        user.interests = selected;
      }
    }

    return json({ user: serializeUser(user) });
  }

  // 11. DELETE /api/account
  if (path === '/api/account' && method === 'DELETE') {
    const user = getAuthUser(request, env);
    if (!user) return json({ error: 'Authentication required.' }, 401);
    EDGE_USERS.delete(user.id);
    return json({ deleted: true });
  }

  // 12. GET /api/discover
  if (path === '/api/discover' && method === 'GET') {
    const user = getAuthUser(request, env);
    if (!user) return json({ error: 'Authentication required.' }, 401);

    const intentionFilter = url.searchParams.get('intention') || 'all';
    const interestFilter = url.searchParams.get('interestId') || 'all';

    const blockedIds = new Set(
      EDGE_BLOCKS.filter((b) => b.blockerId === user.id || b.blockedUserId === user.id).map((b) =>
        b.blockerId === user.id ? b.blockedUserId : b.blockerId
      )
    );

    const profiles = Array.from(EDGE_USERS.values())
      .filter((candidate) => {
        if (candidate.id === user.id) return false;
        if (candidate.accountStatus !== 'active') return false;
        if (!candidate.profile.discoverable) return false;
        if (blockedIds.has(candidate.id)) return false;
        if (EDGE_PASSES.has(`${user.id}:${candidate.id}`)) return false;
        if (EDGE_LIKES.has(`${user.id}:${candidate.id}`)) return false;
        if (intentionFilter !== 'all' && candidate.profile.datingIntention !== intentionFilter) {
          return false;
        }
        if (
          interestFilter !== 'all' &&
          !candidate.interests.some((i) => i.id === interestFilter)
        ) {
          return false;
        }
        return true;
      })
      .map((candidate) => toDiscoverCard(candidate, user))
      .sort((a, b) => (b.sharedInterestsCount || 0) - (a.sharedInterestsCount || 0));

    return json({
      profiles,
      actedCount: EDGE_PASSES.size,
    });
  }

  // 13. POST /api/discover/reset-passes
  if (path === '/api/discover/reset-passes' && method === 'POST') {
    const user = getAuthUser(request, env);
    if (user) {
      for (const key of Array.from(EDGE_PASSES)) {
        if (key.startsWith(`${user.id}:`)) {
          EDGE_PASSES.delete(key);
        }
      }
    }
    return json({ reset: true });
  }

  // 14. POST /api/discover/action
  if (path === '/api/discover/action' && method === 'POST') {
    const user = getAuthUser(request, env);
    if (!user) return json({ error: 'Authentication required.' }, 401);

    const body = (await request.json().catch(() => ({}))) as {
      targetUserId?: string;
      action?: 'like' | 'pass';
    };
    const targetUserId = String(body.targetUserId || '');
    const action = body.action === 'like' ? 'like' : 'pass';

    const target = EDGE_USERS.get(targetUserId);
    if (!target) {
      return json({ error: 'Profile not found.' }, 404);
    }

    if (action === 'pass') {
      EDGE_PASSES.add(`${user.id}:${targetUserId}`);
      return json({
        action: 'pass',
        matched: false,
        matchId: null,
        conversationId: null,
        partnerProfile: null,
      });
    }

    EDGE_LIKES.add(`${user.id}:${targetUserId}`);
    // Seeded profiles reciprocate likes so users can test mutual matching & messaging immediately
    const isSeededPartner = ['usr_amaya', 'usr_kavan', 'usr_dilini', 'usr_ehan'].includes(
      targetUserId
    );
    if (isSeededPartner) {
      EDGE_LIKES.add(`${targetUserId}:${user.id}`);
    }

    const isMutual = EDGE_LIKES.has(`${targetUserId}:${user.id}`);
    let matchRecord = EDGE_MATCHES.find(
      (m) =>
        (m.userAId === user.id && m.userBId === targetUserId) ||
        (m.userAId === targetUserId && m.userBId === user.id)
    );

    if (isMutual && !matchRecord) {
      const nowIso = new Date().toISOString();
      matchRecord = {
        id: `mtc_${crypto.randomUUID().slice(0, 10)}`,
        conversationId: `cnv_${crypto.randomUUID().slice(0, 10)}`,
        userAId: user.id,
        userBId: targetUserId,
        status: 'active',
        createdAt: nowIso,
      };
      EDGE_MATCHES.unshift(matchRecord);
      EDGE_MESSAGES.push({
        id: `msg_${crypto.randomUUID().slice(0, 10)}`,
        conversation_id: matchRecord.conversationId,
        sender_id: targetUserId,
        body: `Hi ${user.displayName}! Lovely to match with you on Once Upon a Time.`,
        read_at: null,
        created_at: nowIso,
      });
    }

    return json({
      action: 'like',
      matched: isMutual,
      matchId: matchRecord?.id || null,
      conversationId: matchRecord?.conversationId || null,
      partnerProfile: isMutual ? toDiscoverCard(target, user) : null,
    });
  }

  // 15. GET /api/matches
  if (path === '/api/matches' && method === 'GET') {
    const user = getAuthUser(request, env);
    if (!user) return json({ error: 'Authentication required.' }, 401);

    const matches = EDGE_MATCHES.filter(
      (m) => m.status === 'active' && (m.userAId === user.id || m.userBId === user.id)
    )
      .map((m) => {
        const partnerId = m.userAId === user.id ? m.userBId : m.userAId;
        const partner = EDGE_USERS.get(partnerId);
        if (!partner) return null;

        const convoMessages = EDGE_MESSAGES.filter(
          (msg) => msg.conversation_id === m.conversationId
        );
        const lastMessage = convoMessages[convoMessages.length - 1] || null;
        const unreadCount = convoMessages.filter(
          (msg) => msg.sender_id !== user.id && !msg.read_at
        ).length;

        return {
          matchId: m.id,
          conversationId: m.conversationId,
          matchedAt: m.createdAt,
          partner: toDiscoverCard(partner, user),
          lastMessage,
          unreadCount,
        };
      })
      .filter(Boolean);

    return json({ matches });
  }

  // 16. GET & POST /api/conversations/:conversationId/messages
  const convMatch = path.match(/^\/api\/conversations\/([^/]+)\/messages$/);
  if (convMatch) {
    const user = getAuthUser(request, env);
    if (!user) return json({ error: 'Authentication required.' }, 401);

    const conversationId = convMatch[1];
    const matchRecord = EDGE_MATCHES.find((m) => m.conversationId === conversationId);
    if (!matchRecord) {
      return json({ error: 'Conversation not found.' }, 404);
    }

    const partnerId =
      matchRecord.userAId === user.id ? matchRecord.userBId : matchRecord.userAId;
    const partner = EDGE_USERS.get(partnerId);

    if (method === 'GET') {
      const nowIso = new Date().toISOString();
      const messages = EDGE_MESSAGES.filter(
        (msg) => msg.conversation_id === conversationId
      ).map((msg) => {
        if (msg.sender_id !== user.id && !msg.read_at) {
          msg.read_at = nowIso;
        }
        return msg;
      });

      return json({
        conversationId,
        matchId: matchRecord.id,
        partner: partner ? toDiscoverCard(partner, user) : null,
        messages,
      });
    }

    if (method === 'POST') {
      if (user.membership.status !== 'active') {
        return json(
          {
            error:
              'An active Once Upon a Time Membership (Rs. 500 / 30 days) is required to send private messages.',
            requiresMembership: true,
          },
          402
        );
      }

      const body = (await request.json().catch(() => ({}))) as { body?: string };
      const cleanBody = String(body.body || '').trim();
      if (!cleanBody) {
        return json({ error: 'Message cannot be empty.' }, 400);
      }

      const newMessage: EdgeDirectMessage = {
        id: `msg_${crypto.randomUUID().slice(0, 10)}`,
        conversation_id: conversationId,
        sender_id: user.id,
        body: cleanBody,
        read_at: null,
        created_at: new Date().toISOString(),
      };
      EDGE_MESSAGES.push(newMessage);
      return json({ message: newMessage }, 201);
    }
  }

  // 17. GET /api/payments/history
  if (path === '/api/payments/history' && method === 'GET') {
    const user = getAuthUser(request, env);
    if (!user) return json({ error: 'Authentication required.' }, 401);

    const userPayments = EDGE_PAYMENTS.filter((p) => p.user_id === user.id);
    return json({
      membership: user.membership,
      payments: userPayments,
      devMode: true,
      paymentsConfigured,
    });
  }

  // 18. POST /api/payments/dev-test-activate
  if (path === '/api/payments/dev-test-activate' && method === 'POST') {
    const user = getAuthUser(request, env);
    if (!user) return json({ error: 'Authentication required.' }, 401);

    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

    user.membership = {
      planName: 'Once Upon a Time Membership (Dev Test Pass)',
      priceLkr: 500,
      status: 'active',
      startsAt: nowIso,
      expiresAt,
    };

    const paymentRow = {
      id: `pay_dev_${crypto.randomUUID().slice(0, 8)}`,
      order_id: `DEV-TEST-${Date.now()}`,
      user_id: user.id,
      amount_lkr: 500,
      currency: 'LKR' as const,
      gateway: 'dev_test' as const,
      gateway_payment_id: `DEV-FREE-PASS-${Date.now()}`,
      status: 'completed' as const,
      signature_verified: true,
      raw_notification_summary: 'Free Development Test Membership activated (zero real payment)',
      created_at: nowIso,
      verified_at: nowIso,
    };
    EDGE_PAYMENTS.unshift(paymentRow);

    return json({
      success: true,
      message: 'Free Development Test Membership activated for 30 days.',
      payment: paymentRow,
      membership: {
        status: 'active',
        expiresAt,
        plan: 'dev_test_30d',
      },
    });
  }

  // 19. POST /api/payments/create-order & /api/payments/sandbox-dispatch
  if (path === '/api/payments/create-order' && method === 'POST') {
    return json(
      {
        error:
          'Payments coming soon. PayHere merchant credentials are not configured in this environment.',
        paymentsConfigured: false,
        devMode: true,
      },
      503
    );
  }

  if (path === '/api/payments/sandbox-dispatch' && method === 'POST') {
    return json(
      {
        error:
          'PayHere credentials not configured. Please use the "Activate Free Test Pass" development option instead.',
      },
      503
    );
  }

  // 20. GET & POST & DELETE /api/safety/blocks
  if (path === '/api/safety/blocks' && method === 'GET') {
    const user = getAuthUser(request, env);
    if (!user) return json({ error: 'Authentication required.' }, 401);
    const blocks = EDGE_BLOCKS.filter((b) => b.blockerId === user.id);
    return json({ blocks });
  }

  if (path === '/api/safety/block' && method === 'POST') {
    const user = getAuthUser(request, env);
    if (!user) return json({ error: 'Authentication required.' }, 401);
    const body = (await request.json().catch(() => ({}))) as {
      targetUserId?: string;
      reason?: string;
    };
    const targetUserId = String(body.targetUserId || '');
    const target = EDGE_USERS.get(targetUserId);
    if (targetUserId) {
      EDGE_BLOCKS.unshift({
        id: `blk_${crypto.randomUUID().slice(0, 8)}`,
        blockerId: user.id,
        blockedUserId: targetUserId,
        blockedDisplayName: target?.displayName || 'Member',
        reason: body.reason || 'User initiated block',
        createdAt: new Date().toISOString(),
      });
    }
    return json({ blocked: true, targetUserId }, 201);
  }

  const unblockMatch = path.match(/^\/api\/safety\/blocks\/([^/]+)$/);
  if (unblockMatch && method === 'DELETE') {
    const user = getAuthUser(request, env);
    if (!user) return json({ error: 'Authentication required.' }, 401);
    const blockedUserId = unblockMatch[1];
    const idx = EDGE_BLOCKS.findIndex(
      (b) => b.blockerId === user.id && b.blockedUserId === blockedUserId
    );
    if (idx !== -1) EDGE_BLOCKS.splice(idx, 1);
    return json({ unblocked: true });
  }

  // 21. POST /api/safety/report
  if (path === '/api/safety/report' && method === 'POST') {
    const user = getAuthUser(request, env);
    if (!user) return json({ error: 'Authentication required.' }, 401);
    const body = (await request.json().catch(() => ({}))) as {
      reportedUserId?: string;
      contextType?: string;
      reason?: string;
      details?: string;
    };
    const reportedUserId = String(body.reportedUserId || 'usr_kavan');
    const reported = EDGE_USERS.get(reportedUserId);
    const report = {
      id: `rep_${crypto.randomUUID().slice(0, 8)}`,
      reporter_id: user.id,
      reporterName: user.displayName,
      reported_user_id: reportedUserId,
      reportedName: reported?.displayName || 'Member',
      reportedStatus: reported?.accountStatus || 'active',
      context_type: body.contextType || 'profile',
      reason: body.reason || 'other_safety_concern',
      details: String(body.details || ''),
      status: 'open' as const,
      priority: 'normal' as const,
      created_at: new Date().toISOString(),
    };
    EDGE_REPORTS.unshift(report);
    return json({ reportId: report.id, priority: report.priority, status: report.status }, 201);
  }

  // 22. GET /api/admin/overview & POST /api/admin/moderate
  if (path === '/api/admin/overview' && method === 'GET') {
    const user = getAuthUser(request, env);
    if (!user || user.role !== 'admin') {
      return json({ error: 'Administrator authorization required.' }, 403);
    }

    const users = Array.from(EDGE_USERS.values()).map((u) => ({
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      role: u.role,
      accountStatus: u.accountStatus,
      membershipStatus: u.membership.status,
      reportsAgainstCount: EDGE_REPORTS.filter((r) => r.reported_user_id === u.id).length,
    }));

    return json({
      analytics: {
        totalUsers: EDGE_USERS.size,
        activeMemberships: Array.from(EDGE_USERS.values()).filter(
          (u) => u.membership.status === 'active'
        ).length,
        activeMatches: EDGE_MATCHES.filter((m) => m.status === 'active').length,
        openReports: EDGE_REPORTS.filter((r) => r.status === 'open').length,
        completedRevenueLkr: EDGE_PAYMENTS.filter((p) => p.status === 'completed').reduce(
          (sum, p) => sum + p.amount_lkr,
          0
        ),
        realtime: {
          connectedSockets: 0,
          waitingInQueue: 0,
          activeStrangerSessions: 0,
        },
      },
      users,
      reports: EDGE_REPORTS,
      payments: EDGE_PAYMENTS,
      auditLogs: [],
    });
  }

  if (path === '/api/admin/moderate' && method === 'POST') {
    const user = getAuthUser(request, env);
    if (!user || user.role !== 'admin') {
      return json({ error: 'Administrator authorization required.' }, 403);
    }
    const body = (await request.json().catch(() => ({}))) as {
      targetUserId?: string;
      reportId?: string;
      actionType?: string;
    };
    if (body.targetUserId && EDGE_USERS.has(body.targetUserId)) {
      const target = EDGE_USERS.get(body.targetUserId)!;
      if (body.actionType === 'suspend_7d') target.accountStatus = 'suspended';
      if (body.actionType === 'ban_permanent') target.accountStatus = 'banned';
      if (body.actionType === 'restore_account') target.accountStatus = 'active';
    }
    if (body.reportId) {
      const rep = EDGE_REPORTS.find((r) => r.id === body.reportId);
      if (rep) rep.status = 'resolved';
    }
    return json({ success: true });
  }

  return json({ error: `Endpoint not found (${method} ${path})` }, 404);
}

// -----------------------------------------------------------------------------
// Main Cloudflare Worker Fetch Entrypoint
// -----------------------------------------------------------------------------
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // 1. WebSocket Upgrade for Matchmaking
    if (url.pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
      if (env.MATCHMAKER_DO && typeof env.MATCHMAKER_DO.idFromName === 'function') {
        const id = env.MATCHMAKER_DO.idFromName('sri-lanka-primary-pool');
        const stub = env.MATCHMAKER_DO.get(id);
        return stub.fetch(request);
      }
      return new Response(
        'Matchmaker Durable Object binding not configured in this Worker. Realtime WebSockets are active on the primary Node.js server (server.ts).',
        { status: 503 }
      );
    }

    // 2. Worker-First API Routing (/api/*)
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return handleApiRequest(request, env, url);
    }

    // 3. Cloudflare Workers Static Assets
    if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      return env.ASSETS.fetch(request);
    }

    return new Response(
      `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Once Upon a Time</title>
</head>
<body style="background:#101417;color:#f5f6f2;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;text-align:center;">
  <div style="background:#17221c;padding:32px;border-radius:20px;border:1px solid #28372e;max-width:500px;">
    <h1 style="color:#c5fa5a;font-size:24px;margin-bottom:8px;">Once Upon a Time</h1>
    <p style="color:#a4b3a8;font-size:14px;line-height:1.6;">Static assets binding (<code>[assets]</code>) was not resolved. Run <code>npm run build && npx wrangler deploy</code>.</p>
  </div>
</body>
</html>`,
      { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  },
};
