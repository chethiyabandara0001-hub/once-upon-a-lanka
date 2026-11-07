import crypto from 'node:crypto';

export interface EdgeInterest {
  id: string;
  slug: string;
  label_en: string;
  label_si: string;
  label_ta: string;
  category: string;
}

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
    datingIntention:
      | 'long_term_story'
      | 'meaningful_dating'
      | 'new_conversations'
      | 'friendship_first';
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

export interface AuthEnv {
  SESSION_SECRET?: string;
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

export const NOW_ISO = '2026-02-01T10:00:00.000Z';
export const ACTIVE_EXPIRY_ISO = '2027-12-31T23:59:59.000Z';

export const EDGE_USERS: Map<string, EdgeUser> = new Map([
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

export const EDGE_SESSIONS: Map<string, string> = new Map();
export const EDGE_REVOKED_TOKENS: Set<string> = new Set();
export const EDGE_BLOCKS: Array<{
  id: string;
  blockerId: string;
  blockedUserId: string;
  blockedDisplayName: string;
  reason: string;
  createdAt: string;
}> = [];

const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

export function getEdgeSecret(env?: AuthEnv): string {
  return env?.SESSION_SECRET || 'ouat_cloudflare_edge_hmac_secret_2026_lk';
}

export function createStatelessToken(
  user: EdgeUser,
  env?: AuthEnv,
  customTtlMs: number = SESSION_TTL_MS
): string {
  const now = Date.now();
  const payload = Buffer.from(
    JSON.stringify({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      age: user.age,
      region: user.profile.showRegion ? user.profile.region : '',
      interests: user.interests.map((i) => i.label_en),
      iat: now,
      exp: now + customTtlMs,
    }),
    'utf8'
  ).toString('base64url');

  const sig = crypto
    .createHmac('sha256', getEdgeSecret(env))
    .update(payload)
    .digest('base64url');

  const token = `ouat_v1.${payload}.${sig}`;
  EDGE_SESSIONS.set(token, user.id);
  return token;
}

export function verifyStatelessToken(token: string, env?: AuthEnv): EdgeUser | null {
  if (!token || typeof token !== 'string') return null;
  if (EDGE_REVOKED_TOKENS.has(token)) return null;

  if (!token.startsWith('ouat_v1.')) {
    const mappedId = EDGE_SESSIONS.get(token);
    if (mappedId && EDGE_USERS.has(mappedId)) {
      const u = EDGE_USERS.get(mappedId)!;
      return u.accountStatus === 'active' ? u : null;
    }
    return null;
  }

  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [, payload, sig] = parts;

  const expectedSig = crypto
    .createHmac('sha256', getEdgeSecret(env))
    .update(payload)
    .digest('base64url');

  try {
    const sigBuf = Buffer.from(sig, 'utf8');
    const expectedBuf = Buffer.from(expectedSig, 'utf8');
    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return null;
    }

    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      id: string;
      email: string;
      displayName: string;
      role: 'member' | 'moderator' | 'admin';
      age?: number;
      region?: string;
      interests?: string[];
      iat?: number;
      exp?: number;
    };

    // Enforce token expiration
    if (typeof decoded.exp === 'number' && Date.now() > decoded.exp) {
      return null;
    }

    if (EDGE_USERS.has(decoded.id)) {
      const existing = EDGE_USERS.get(decoded.id)!;
      if (existing.accountStatus !== 'active') return null;
      return existing;
    }

    // Rehydrate authenticated user across Cloudflare Worker / Durable Object isolates
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
        region: decoded.region || 'Colombo',
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
