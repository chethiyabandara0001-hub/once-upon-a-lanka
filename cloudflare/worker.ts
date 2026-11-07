/**
 * ONCE UPON A TIME (OUAT) — CLOUDFLARE WORKER ENTRYPOINT
 *
 * Architecture:
 * 1. Worker-First Routing:
 *    - /ws: WebSocket upgrade for Durable Object matchmaking
 *    - /api/*: Cloudflare Worker REST API endpoints (Health, Auth, Interests, Discovery, Membership)
 * 2. Static Assets Routing:
 *    - Serves compiled React Vite SPA from `dist/`
 *    - SPA Client-Side Routing: /login, /signup, /dashboard, /discover, /membership, etc.
 *      fallback to /index.html with status 200 via `not_found_handling = "single-page-application"`
 * 3. Preserves D1, Durable Objects, R2, and PayHere / Turnstile configurations
 */

import crypto from 'node:crypto';
import { MatchmakerDurableObject } from './matchmaker-do';

export { MatchmakerDurableObject };

export interface Env {
  ASSETS: {
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

// -----------------------------------------------------------------------------
// Seeded Data for Cloudflare Edge Runtime
// -----------------------------------------------------------------------------
const SEEDED_INTERESTS = [
  { id: 'int_architecture', slug: 'tropical-modernism-bawa', label_en: 'Tropical Modernism & Architecture', label_si: 'නිවර්තන ගෘහ නිර්මාණ ශිල්පය', label_ta: 'வெப்பமண்டல கட்டிடக்கலை', category: 'Arts & Culture' },
  { id: 'int_tea', slug: 'ceylon-tea-culture-cafes', label_en: 'Ceylon Tea & Hill Country Cafés', label_si: 'තේ සංස්කෘතිය සහ කැෆේ', label_ta: 'தேயிலை கலாச்சாரம் & கஃபேக்கள்', category: 'Lifestyle' },
  { id: 'int_surf', slug: 'southern-coast-surf-sunsets', label_en: 'Southern Coast & Surf Sunsets', label_si: 'දකුණු වෙරළ සහ රළ පැදීම', label_ta: 'தென் கடற்கரை & அலைச்சறுக்கு', category: 'Outdoors & Travel' },
  { id: 'int_wildlife', slug: 'yala-wilpattu-safari', label_en: 'National Parks & Wildlife Trails', label_si: 'වනජීවී චාරිකා', label_ta: 'වනவிலங்கு & சஃபாரி', category: 'Outdoors & Travel' },
  { id: 'int_cinema', slug: 'sinhala-tamil-arthouse-cinema', label_en: 'Cinema & Independent Screenings', label_si: 'සිනමාව සහ චිත්‍රපට', label_ta: 'சினிமா & திரையிடல்கள்', category: 'Arts & Culture' },
  { id: 'int_jazz', slug: 'live-acoustic-jazz-colombo', label_en: 'Live Acoustic & Jazz Evenings', label_si: 'සජීවී සංගීතය', label_ta: 'நேரடி இசை', category: 'Music & Nightlife' },
  { id: 'int_cuisine', slug: 'contemporary-sri-lankan-dining', label_en: 'Contemporary Island Gastronomy', label_si: 'දේශීය ආහාර සංස්කෘතිය', label_ta: 'பாரம்பரிய உணவு', category: 'Food & Drink' },
  { id: 'int_literature', slug: 'ceylon-literature-poetry', label_en: 'Literature, Poetry & Independent Bookshops', label_si: 'සාහිත්‍යය සහ කවි', label_ta: 'இலக்கியம் & கவிதை', category: 'Arts & Culture' },
  { id: 'int_hiking', slug: 'knuckles-ella-trails', label_en: 'Central Highlands & Peak Treks', label_si: 'කඳු නැගීම සහ ඇවිදීම', label_ta: 'மலையேற்றம்', category: 'Outdoors & Travel' },
  { id: 'int_philosophy', slug: 'late-night-conversations', label_en: 'Late-Night Conversations', label_si: 'ගැඹුරු සංවාද', label_ta: 'ஆழமான உரையாடல்கள்', category: 'Lifestyle' },
  { id: 'int_art', slug: 'colombo-galleries', label_en: 'Galleries & Contemporary Art', label_si: 'චිත්‍ර කලාව', label_ta: 'நவீன கலை', category: 'Arts' },
  { id: 'int_cricket', slug: 'island-cricket-evenings', label_en: 'Test Cricket & Evenings', label_si: 'ක්‍රිකට්', label_ta: 'கிரிக்கெட்', category: 'Sports' },
];

interface EdgeUser {
  id: string;
  email: string;
  displayName: string;
  role: 'member' | 'moderator' | 'admin';
  membership: {
    status: 'free' | 'active' | 'expired';
    expiresAt: string | null;
    plan: string | null;
  };
  profile: {
    avatarUrl: string;
    bio: string;
    region: string;
    showRegion: boolean;
    datingIntention: string;
    spokenLanguages: string[];
    discoverable: boolean;
    allowRandomVideo: boolean;
    allowRandomText: boolean;
  };
  interests: Array<{ id: string; label_en: string; label_si: string; label_ta: string }>;
}

const EDGE_USERS: Map<string, EdgeUser> = new Map([
  [
    'usr_admin',
    {
      id: 'usr_admin',
      email: 'admin@onceuponatime.lk',
      displayName: 'System Admin',
      role: 'admin',
      membership: { status: 'active', expiresAt: '2030-01-01T00:00:00Z', plan: 'administrator' },
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
      interests: SEEDED_INTERESTS.slice(0, 4),
    },
  ],
  [
    'usr_amaya',
    {
      id: 'usr_amaya',
      email: 'amaya@onceuponatime.lk',
      displayName: 'Amaya',
      role: 'member',
      membership: { status: 'active', expiresAt: '2027-12-31T00:00:00Z', plan: 'dev_test_30d' },
      profile: {
        avatarUrl: '/src/assets/images/editorial_portrait_amaya_1793978349712.jpg',
        bio: 'Documentary archivist & tea enthusiast. Weekends spent browsing antique bookshops in Galle Fort.',
        region: 'Colombo 07',
        showRegion: true,
        datingIntention: 'meaningful_dating',
        spokenLanguages: ['English', 'Sinhala'],
        discoverable: true,
        allowRandomVideo: true,
        allowRandomText: true,
      },
      interests: [SEEDED_INTERESTS[0], SEEDED_INTERESTS[1], SEEDED_INTERESTS[7]],
    },
  ],
  [
    'usr_kavan',
    {
      id: 'usr_kavan',
      email: 'kavan@onceuponatime.lk',
      displayName: 'Kavan',
      role: 'member',
      membership: { status: 'active', expiresAt: '2027-12-31T00:00:00Z', plan: 'dev_test_30d' },
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
      interests: [SEEDED_INTERESTS[0], SEEDED_INTERESTS[5], SEEDED_INTERESTS[9]],
    },
  ],
  [
    'usr_dilini',
    {
      id: 'usr_dilini',
      email: 'dilini@onceuponatime.lk',
      displayName: 'Dilini',
      role: 'member',
      membership: { status: 'active', expiresAt: '2027-12-31T00:00:00Z', plan: 'dev_test_30d' },
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
      interests: [SEEDED_INTERESTS[1], SEEDED_INTERESTS[8], SEEDED_INTERESTS[7]],
    },
  ],
  [
    'usr_ehan',
    {
      id: 'usr_ehan',
      email: 'ehan@onceuponatime.lk',
      displayName: 'Ehan',
      role: 'member',
      membership: { status: 'active', expiresAt: '2027-12-31T00:00:00Z', plan: 'dev_test_30d' },
      profile: {
        avatarUrl: '/src/assets/images/editorial_portrait_ehan_1793978351420.jpg',
        bio: 'Sound designer & record collector. Chasing monsoon recordings and old Ceylon vinyls.',
        region: 'Jaffna',
        showRegion: true,
        datingIntention: 'new_conversations',
        spokenLanguages: ['Tamil', 'English'],
        discoverable: true,
        allowRandomVideo: true,
        allowRandomText: true,
      },
      interests: [SEEDED_INTERESTS[5], SEEDED_INTERESTS[4], SEEDED_INTERESTS[9]],
    },
  ],
]);

// Ephemeral Session Token Map (Token -> UserId)
const EDGE_SESSIONS: Map<string, string> = new Map([
  ['dev_token_admin', 'usr_admin'],
  ['dev_token_amaya', 'usr_amaya'],
  ['dev_token_kavan', 'usr_kavan'],
  ['dev_token_dilini', 'usr_dilini'],
  ['dev_token_ehan', 'usr_ehan'],
]);

// Ephemeral Likes / Matches / Blocks Storage
const EDGE_PASSES: Set<string> = new Set();
const EDGE_BLOCKS: Array<{ id: string; blockerId: string; blockedUserId: string; blockedDisplayName: string; createdAt: string }> = [];
const EDGE_REPORTS: Array<{ id: string; reporterId: string; reportedUserId: string; reason: string; details: string; createdAt: string }> = [];
const EDGE_PAYMENTS: Array<{ id: string; order_id: string; amount_lkr: number; status: string; gateway: string; signature_verified: boolean; created_at: string }> = [];

// -----------------------------------------------------------------------------
// Helper Methods
// -----------------------------------------------------------------------------
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function getBearerToken(request: Request): string | null {
  const auth = request.headers.get('Authorization') || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function getAuthUser(request: Request): EdgeUser | null {
  const token = getBearerToken(request);
  if (!token) return null;
  const userId = EDGE_SESSIONS.get(token);
  if (!userId) return null;
  return EDGE_USERS.get(userId) || null;
}

// -----------------------------------------------------------------------------
// Cloudflare Worker REST API Dispatcher (/api/*)
// -----------------------------------------------------------------------------
async function handleApiRequest(request: Request, env: Env, url: URL): Promise<Response> {
  const method = request.method.toUpperCase();
  const path = url.pathname;

  // 1. Health & Environment Status
  if (path === '/api/health' && method === 'GET') {
    const paymentsConfigured = Boolean(
      env.PAYHERE_MERCHANT_ID &&
        env.PAYHERE_MERCHANT_ID !== '121XXXX' &&
        env.PAYHERE_MERCHANT_SECRET &&
        !env.PAYHERE_MERCHANT_SECRET.includes('REPLACE')
    );
    const turnAvailable = Boolean(env.TURN_KEY_ID && env.TURN_API_TOKEN);
    const stunServers = (env.STUN_SERVERS || 'stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302')
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

  // 2. Interests List
  if (path === '/api/interests' && method === 'GET') {
    return json({
      interests: SEEDED_INTERESTS.map((i) => ({
        id: i.id,
        slug: i.slug,
        category: i.category,
        labelEn: i.label_en,
        labelSi: i.label_si,
        labelTa: i.label_ta,
      })),
    });
  }

  // 3. Current Authenticated User Check
  if (path === '/api/auth/me' && method === 'GET') {
    const user = getAuthUser(request);
    if (!user) {
      return json({ error: 'Unauthorized' }, 401);
    }
    return json({ user });
  }

  // 4. Login
  if (path === '/api/auth/login' && method === 'POST') {
    try {
      const body = (await request.json().catch(() => ({}))) as { email?: string; password?: string };
      const email = body.email?.toLowerCase().trim();
      const password = body.password || '';

      if (!email || !password) {
        return json({ error: 'Email and password are required.' }, 400);
      }

      // Check seeded and registered users
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

      const token = `ouat_token_${crypto.randomUUID()}`;
      EDGE_SESSIONS.set(token, foundUser.id);
      return json({ token, user: foundUser });
    } catch {
      return json({ error: 'Failed to process login request.' }, 400);
    }
  }

  // 5. Registration
  if (path === '/api/auth/register' && method === 'POST') {
    try {
      const body = (await request.json().catch(() => ({}))) as {
        email?: string;
        password?: string;
        displayName?: string;
        dateOfBirth?: string;
        termsAccepted?: boolean;
      };

      const email = body.email?.toLowerCase().trim();
      if (!email || !body.password) {
        return json({ error: 'Email and password are required.' }, 400);
      }

      if (!body.termsAccepted) {
        return json({ error: 'You must confirm you are at least 18 years of age.' }, 400);
      }

      // Age assurance
      if (body.dateOfBirth) {
        const birthDate = new Date(body.dateOfBirth);
        const ageDifMs = Date.now() - birthDate.getTime();
        const ageDate = new Date(ageDifMs);
        const age = Math.abs(ageDate.getUTCFullYear() - 1970);
        if (age < 18) {
          return json({ error: 'You must be at least 18 years old to join Once Upon a Time.' }, 403);
        }
      }

      const id = `usr_${crypto.randomUUID().slice(0, 10)}`;
      const newUser: EdgeUser = {
        id,
        email,
        displayName: body.displayName?.trim() || email.split('@')[0],
        role: 'member',
        membership: { status: 'active', expiresAt: '2027-12-31T00:00:00Z', plan: 'dev_test_30d' },
        profile: {
          avatarUrl: '/src/assets/images/editorial_portrait_amaya_1793978349712.jpg',
          bio: 'New member discovering stories on Once Upon a Time.',
          region: 'Colombo',
          showRegion: true,
          datingIntention: 'meaningful_dating',
          spokenLanguages: ['English'],
          discoverable: true,
          allowRandomVideo: true,
          allowRandomText: true,
        },
        interests: SEEDED_INTERESTS.slice(0, 3),
      };

      EDGE_USERS.set(id, newUser);
      const token = `ouat_token_${crypto.randomUUID()}`;
      EDGE_SESSIONS.set(token, id);
      return json({ token, user: newUser });
    } catch {
      return json({ error: 'Failed to complete registration.' }, 400);
    }
  }

  // 6. Logout
  if (path === '/api/auth/logout' && method === 'POST') {
    const token = getBearerToken(request);
    if (token) {
      EDGE_SESSIONS.delete(token);
    }
    return json({ success: true });
  }

  // 7. Discover Profiles
  if (path === '/api/discover' && method === 'GET') {
    const current = getAuthUser(request);
    const profiles = Array.from(EDGE_USERS.values())
      .filter((u) => u.id !== current?.id && u.profile.discoverable && !EDGE_PASSES.has(`${current?.id || ''}:${u.id}`))
      .map((u) => ({
        userId: u.id,
        displayName: u.displayName,
        age: 26,
        region: u.profile.region,
        bio: u.profile.bio,
        avatarUrl: u.profile.avatarUrl,
        datingIntention: u.profile.datingIntention,
        spokenLanguages: u.profile.spokenLanguages,
        interests: u.interests,
      }));

    return json({ profiles });
  }

  // 8. Discover Action (Like / Pass)
  if (path === '/api/discover/action' && method === 'POST') {
    const current = getAuthUser(request);
    const body = (await request.json().catch(() => ({}))) as { targetUserId?: string; action?: 'like' | 'pass' };
    if (current && body.targetUserId) {
      EDGE_PASSES.add(`${current.id}:${body.targetUserId}`);
    }
    return json({ matched: false, conversationId: null, partnerProfile: null });
  }

  // 9. Reset Passes
  if (path === '/api/discover/reset-passes' && method === 'POST') {
    const current = getAuthUser(request);
    if (current) {
      for (const key of Array.from(EDGE_PASSES)) {
        if (key.startsWith(`${current.id}:`)) {
          EDGE_PASSES.delete(key);
        }
      }
    }
    return json({ success: true });
  }

  // 10. Matches
  if (path === '/api/matches' && method === 'GET') {
    return json({ matches: [] });
  }

  // 11. Payments History & Configuration
  if (path === '/api/payments/history' && method === 'GET') {
    const paymentsConfigured = Boolean(
      env.PAYHERE_MERCHANT_ID &&
        env.PAYHERE_MERCHANT_ID !== '121XXXX' &&
        env.PAYHERE_MERCHANT_SECRET &&
        !env.PAYHERE_MERCHANT_SECRET.includes('REPLACE')
    );

    return json({
      payments: EDGE_PAYMENTS,
      paymentsConfigured,
      devMode: true,
    });
  }

  // 12. Development Test Membership Activation
  if (path === '/api/payments/dev-test-activate' && method === 'POST') {
    const current = getAuthUser(request);
    if (!current) {
      return json({ error: 'Authentication required' }, 401);
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
    current.membership = {
      status: 'active',
      expiresAt,
      plan: 'dev_test_30d',
    };

    const orderId = `DEV-TEST-${Date.now()}`;
    EDGE_PAYMENTS.unshift({
      id: `pay_${Date.now()}`,
      order_id: orderId,
      amount_lkr: 0,
      status: 'completed',
      gateway: 'dev_test',
      signature_verified: true,
      created_at: now.toISOString(),
    });

    return json({
      success: true,
      message: 'Free Development Test Membership activated for 30 days.',
      membership: current.membership,
    });
  }

  // 13. Create Membership Order (Guarded)
  if (path === '/api/payments/create-order' && method === 'POST') {
    return json(
      {
        error: 'Payments coming soon. PayHere merchant credentials are not configured in this development environment.',
      },
      503
    );
  }

  // 14. Trust & Safety Reports
  if (path === '/api/safety/report' && method === 'POST') {
    const current = getAuthUser(request);
    const body = (await request.json().catch(() => ({}))) as { reportedUserId?: string; reason?: string; details?: string };
    EDGE_REPORTS.unshift({
      id: `rep_${Date.now()}`,
      reporterId: current?.id || 'anonymous',
      reportedUserId: body.reportedUserId || 'unknown',
      reason: body.reason || 'other',
      details: body.details || '',
      createdAt: new Date().toISOString(),
    });
    return json({ success: true, message: 'Safety report submitted to moderators.' });
  }

  // 15. User Blocks
  if (path === '/api/safety/block' && method === 'POST') {
    const current = getAuthUser(request);
    const body = (await request.json().catch(() => ({}))) as { targetUserId?: string; reason?: string };
    if (current && body.targetUserId) {
      const targetUser = EDGE_USERS.get(body.targetUserId);
      EDGE_BLOCKS.unshift({
        id: `blk_${Date.now()}`,
        blockerId: current.id,
        blockedUserId: body.targetUserId,
        blockedDisplayName: targetUser?.displayName || 'User',
        createdAt: new Date().toISOString(),
      });
    }
    return json({ success: true, message: 'User blocked.' });
  }

  if (path === '/api/safety/blocks' && method === 'GET') {
    const current = getAuthUser(request);
    const userBlocks = EDGE_BLOCKS.filter((b) => b.blockerId === current?.id);
    return json({ blocks: userBlocks });
  }

  // 16. Profile Updates
  if (path === '/api/profile' && method === 'POST') {
    const current = getAuthUser(request);
    if (!current) return json({ error: 'Authentication required' }, 401);
    const body = (await request.json().catch(() => ({}))) as Partial<EdgeUser['profile'] & { displayName?: string }>;
    if (body.displayName) current.displayName = body.displayName;
    if (body.bio !== undefined) current.profile.bio = body.bio;
    if (body.region !== undefined) current.profile.region = body.region;
    if (body.showRegion !== undefined) current.profile.showRegion = body.showRegion;
    if (body.datingIntention !== undefined) current.profile.datingIntention = body.datingIntention;
    if (body.avatarUrl !== undefined) current.profile.avatarUrl = body.avatarUrl;
    return json({ user: current });
  }

  return json({ error: 'Endpoint not found' }, 404);
}

// -----------------------------------------------------------------------------
// Main Worker Fetch Handler
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
    if (url.pathname.startsWith('/api/')) {
      return handleApiRequest(request, env, url);
    }

    // 3. Cloudflare Workers Static Assets
    // Serves the compiled React Vite frontend from `dist/`.
    // SPA routes (/, /login, /signup, /dashboard, /discover, /membership, etc.)
    // return `index.html` via `not_found_handling = "single-page-application"`.
    if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      return env.ASSETS.fetch(request);
    }

    // Fallback if env.ASSETS binding is not linked
    return new Response(
      `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Once Upon a Time</title>
  <style>
    body { background: #101417; color: #f5f6f2; font-family: sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; text-align: center; padding: 24px; }
    .card { background: #17221c; padding: 32px; border-radius: 20px; border: 1px solid #28372e; max-width: 500px; }
    h1 { color: #c5fa5a; font-size: 24px; margin-bottom: 8px; }
    p { color: #a4b3a8; font-size: 14px; line-height: 1.6; }
    code { background: rgba(255,255,255,0.1); padding: 3px 8px; border-radius: 6px; font-size: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Once Upon a Time · Static Assets Notice</h1>
    <p>The worker is running, but the static assets binding (<code>[assets]</code>) was not resolved. Ensure you run <code>npm run build</code> and deploy using <code>npx wrangler deploy</code> with <code>[assets] directory = "./dist"</code> configured in <code>wrangler.toml</code>.</p>
  </div>
</body>
</html>`,
      { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  },
};
