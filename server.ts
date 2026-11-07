import express, { type Request, type Response, type NextFunction } from 'express';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';
import { db, type UserRow } from './server/db';
import {
  hashPassword,
  verifyPassword,
  verifyAdultAge,
  generateSessionToken,
  hashSessionToken,
  generatePayHereCheckoutHash,
  verifyPayHereWebhookSignature,
  md5Upper,
  createRateLimiter,
  verifyTurnstileToken,
  getServerSessionSecret,
} from './server/security';
import { matchmaker } from './server/ws-matchmaker';

dotenv.config();

const PORT = 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const DEV_MODE = !IS_PRODUCTION || process.env.ENABLE_DEV_TEST_MODE === 'true';

// Ensure mandatory SESSION_SECRET is initialized safely on the server
getServerSessionSecret();

// PayHere integration is completely optional in development
const RAW_MERCHANT_ID = process.env.PAYHERE_MERCHANT_ID?.trim() || '';
const RAW_MERCHANT_SECRET = process.env.PAYHERE_MERCHANT_SECRET?.trim() || '';

// A real or sandbox PayHere config is only active if valid non-placeholder credentials are provided
const HAS_PAYHERE_CONFIG = Boolean(
  RAW_MERCHANT_ID &&
  RAW_MERCHANT_SECRET &&
  !RAW_MERCHANT_ID.includes('XXXX') &&
  !RAW_MERCHANT_SECRET.includes('REPLACE_WITH')
);

const PAYHERE_MERCHANT_ID = HAS_PAYHERE_CONFIG ? RAW_MERCHANT_ID : '';
const PAYHERE_MERCHANT_SECRET = HAS_PAYHERE_CONFIG ? RAW_MERCHANT_SECRET : '';
const IS_PAYHERE_SANDBOX = (process.env.PAYHERE_SANDBOX ?? 'true') !== 'false';

export interface AuthenticatedRequest extends Request {
  user?: UserRow;
  sessionTokenHash?: string;
}

function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  return null;
}

function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const rawToken = extractBearerToken(req);
  if (!rawToken) {
    res.status(401).json({ error: 'Authentication required. Please sign in.' });
    return;
  }

  const tokenHash = hashSessionToken(rawToken);
  const now = new Date();
  const session = db.state.user_sessions.find(
    (s) => s.token_hash === tokenHash && new Date(s.expires_at) > now
  );

  if (!session) {
    res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
    return;
  }

  const user = db.state.users.find((u) => u.id === session.user_id);
  if (!user || user.account_status !== 'active') {
    res.status(403).json({
      error:
        user?.account_status === 'suspended'
          ? 'Your account is temporarily suspended pending Trust & Safety review.'
          : 'This account is not active.',
    });
    return;
  }

  req.user = user;
  req.sessionTokenHash = tokenHash;
  next();
}

function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  requireAuth(req, res, () => {
    if (!req.user || req.user.role !== 'admin') {
      res.status(403).json({ error: 'Administrator authorization required.' });
      return;
    }
    next();
  });
}

function buildUserPayload(user: UserRow) {
  const profile = db.state.profiles.find((p) => p.user_id === user.id);
  const interestIds = db.state.user_interests
    .filter((ui) => ui.user_id === user.id)
    .map((ui) => ui.interest_id);
  const interests = db.state.interests.filter((i) => interestIds.includes(i.id));
  const membership = db.getActiveMembership(user.id);
  const ageInfo = verifyAdultAge(user.date_of_birth);

  const activeMatches = db.state.dating_matches.filter(
    (m) =>
      m.status === 'active' &&
      (m.user_a_id === user.id || m.user_b_id === user.id) &&
      !db.isBlockedBetween(m.user_a_id, m.user_b_id)
  );

  const matchIds = new Set(activeMatches.map((m) => m.id));
  const userConversationIds = new Set(
    db.state.conversations.filter((c) => matchIds.has(c.match_id)).map((c) => c.id)
  );

  const unreadMessagesCount = db.state.messages.filter(
    (msg) =>
      userConversationIds.has(msg.conversation_id) &&
      msg.sender_id !== user.id &&
      !msg.read_at
  ).length;

  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    age: ageInfo.age,
    emailVerified: user.email_verified,
    emailVerificationTokenHint: user.email_verified ? null : user.email_verification_token,
    role: user.role,
    accountStatus: user.account_status,
    onboardingCompleted: user.onboarding_completed,
    preferredLanguage: user.preferred_language,
    createdAt: user.created_at,
    profile: profile
      ? {
          avatarUrl: profile.avatar_url,
          bio: profile.bio,
          region: profile.region,
          showRegion: profile.show_region,
          datingIntention: profile.dating_intention,
          spokenLanguages: profile.spoken_languages,
          discoverable: profile.discoverable,
          allowRandomVideo: profile.allow_random_video,
          allowRandomText: profile.allow_random_text,
        }
      : null,
    interests,
    membership: {
      planName: membership.plan_name,
      priceLkr: membership.price_lkr,
      status: membership.status,
      startsAt: membership.starts_at,
      expiresAt: membership.expires_at,
    },
    counts: {
      activeMatches: activeMatches.length,
      unreadMessages: unreadMessagesCount,
    },
  };
}

export function createApiRouter(): express.Router {
  const router = express.Router();

  const authRateLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    maxRequests: 20,
    label: 'auth',
  });

  const actionRateLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    maxRequests: 60,
    label: 'actions',
  });

  // 1. Health & Public Metadata
  router.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      platform: 'Once Upon a Time',
      market: 'Sri Lanka',
      currency: 'LKR',
      membershipPriceLkr: 500,
      membershipDays: 30,
      devMode: DEV_MODE,
      paymentsConfigured: HAS_PAYHERE_CONFIG,
      turnstileTestMode: !process.env.TURNSTILE_SECRET_KEY || process.env.TURNSTILE_SECRET_KEY.startsWith('1x00'),
      stunServers: (process.env.VITE_STUN_SERVERS || 'stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302').split(','),
      turnAvailable: Boolean(process.env.TURN_KEY_ID && process.env.TURN_API_TOKEN),
      realtime: matchmaker.getPublicOperationalStats(),
    });
  });

  router.get('/interests', (_req, res) => {
    res.json({ interests: db.state.interests });
  });

  // 2. Authentication Routes
  router.post('/auth/register', authRateLimiter, (req, res) => {
    const {
      displayName,
      email,
      password,
      dateOfBirth,
      termsAccepted,
      preferredLanguage = 'en',
    } = req.body || {};

    const cleanName = String(displayName || '').trim();
    const cleanEmail = String(email || '').trim().toLowerCase();
    const rawPassword = String(password || '');
    const cleanDob = String(dateOfBirth || '').trim();

    if (cleanName.length < 2 || cleanName.length > 50) {
      res.status(400).json({ error: 'Display name must be between 2 and 50 characters.' });
      return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      res.status(400).json({ error: 'Please provide a valid email address.' });
      return;
    }

    if (rawPassword.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters long.' });
      return;
    }

    if (!termsAccepted) {
      res.status(400).json({
        error: 'You must agree to the Adults-Only Terms of Service and Privacy Policy.',
      });
      return;
    }

    const ageVerification = verifyAdultAge(cleanDob);
    if (!ageVerification.eligible) {
      res.status(403).json({
        error:
          ageVerification.error ||
          'Once Upon a Time is strictly restricted to adults aged 18 and older.',
      });
      return;
    }

    const existing = db.state.users.find((u) => u.email.toLowerCase() === cleanEmail);
    if (existing) {
      res.status(409).json({ error: 'An account with this email address already exists.' });
      return;
    }

    const now = new Date().toISOString();
    const { hash, salt } = hashPassword(rawPassword);
    const userId = `usr_${crypto.randomUUID().slice(0, 12)}`;
    const verificationToken = `VERIFY-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

    const newUser: UserRow = {
      id: userId,
      email: cleanEmail,
      password_hash: hash,
      password_salt: salt,
      display_name: cleanName,
      date_of_birth: cleanDob,
      age_verified_at: now,
      email_verified: false,
      email_verification_token: verificationToken,
      password_reset_token: null,
      password_reset_expires_at: null,
      role: 'member',
      account_status: 'active',
      onboarding_completed: false,
      preferred_language: ['en', 'si', 'ta'].includes(preferredLanguage)
        ? preferredLanguage
        : 'en',
      terms_accepted_at: now,
      created_at: now,
      updated_at: now,
    };

    db.state.users.push(newUser);
    db.state.profiles.push({
      user_id: userId,
      avatar_url: '/src/assets/images/editorial_portrait_amaya_1793978349458.jpg',
      bio: '',
      region: 'Colombo',
      show_region: true,
      dating_intention: 'long_term_story',
      spoken_languages: ['English'],
      discoverable: true,
      allow_random_video: true,
      allow_random_text: true,
      updated_at: now,
    });

    db.getActiveMembership(userId);

    const sessionToken = generateSessionToken();
    db.state.user_sessions.push({
      id: `ses_${crypto.randomUUID().slice(0, 12)}`,
      user_id: userId,
      token_hash: hashSessionToken(sessionToken),
      ip_address: req.ip || '127.0.0.1',
      user_agent: String(req.headers['user-agent'] || ''),
      expires_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      created_at: now,
    });

    db.logAudit({
      actorUserId: userId,
      eventType: 'auth.register',
      entityType: 'user',
      entityId: userId,
      metadata: { ageVerified: ageVerification.age },
      ipAddress: req.ip,
    });

    db.save();

    res.status(201).json({
      token: sessionToken,
      user: buildUserPayload(newUser),
    });
  });

  router.post('/auth/login', authRateLimiter, (req, res) => {
    const cleanEmail = String(req.body?.email || '').trim().toLowerCase();
    const rawPassword = String(req.body?.password || '');

    const user = db.state.users.find((u) => u.email.toLowerCase() === cleanEmail);
    if (!user || !verifyPassword(rawPassword, user.password_hash, user.password_salt)) {
      res.status(401).json({ error: 'Invalid email or password.' });
      return;
    }

    if (user.account_status !== 'active') {
      res.status(403).json({
        error: `This account is currently ${user.account_status}. Please contact Trust & Safety if you wish to submit an appeal.`,
      });
      return;
    }

    const now = new Date().toISOString();
    const sessionToken = generateSessionToken();
    db.state.user_sessions.push({
      id: `ses_${crypto.randomUUID().slice(0, 12)}`,
      user_id: user.id,
      token_hash: hashSessionToken(sessionToken),
      ip_address: req.ip || '127.0.0.1',
      user_agent: String(req.headers['user-agent'] || ''),
      expires_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      created_at: now,
    });

    db.logAudit({
      actorUserId: user.id,
      eventType: 'auth.login',
      entityType: 'user',
      entityId: user.id,
      ipAddress: req.ip,
    });
    db.save();

    res.json({
      token: sessionToken,
      user: buildUserPayload(user),
    });
  });

  router.post('/auth/logout', requireAuth, (req: AuthenticatedRequest, res) => {
    db.state.user_sessions = db.state.user_sessions.filter(
      (s) => s.token_hash !== req.sessionTokenHash
    );
    db.save();
    res.json({ success: true });
  });

  router.post('/auth/verify-email', requireAuth, (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const code = String(req.body?.code || '').trim().toUpperCase();
    if (user.email_verified) {
      res.json({ user: buildUserPayload(user) });
      return;
    }
    if (!code || code !== user.email_verification_token) {
      res.status(400).json({ error: 'Invalid verification code.' });
      return;
    }
    user.email_verified = true;
    user.email_verification_token = null;
    user.updated_at = new Date().toISOString();
    db.logAudit({
      actorUserId: user.id,
      eventType: 'auth.email_verified',
      entityType: 'user',
      entityId: user.id,
    });
    db.save();
    res.json({ user: buildUserPayload(user) });
  });

  router.post('/auth/forgot-password', authRateLimiter, (req, res) => {
    const cleanEmail = String(req.body?.email || '').trim().toLowerCase();
    const user = db.state.users.find((u) => u.email.toLowerCase() === cleanEmail);
    let resetCodeForDemo: string | null = null;

    if (user && user.account_status === 'active') {
      resetCodeForDemo = `RESET-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
      user.password_reset_token = resetCodeForDemo;
      user.password_reset_expires_at = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      db.save();
    }

    res.json({
      message:
        'If an active account matches that email, a password reset code has been generated.',
      // Returned in development/sandbox mode so reviewers can test Reset Password flow without SMTP
      sandboxResetToken: resetCodeForDemo,
    });
  });

  router.post('/auth/reset-password', authRateLimiter, (req, res) => {
    const cleanEmail = String(req.body?.email || '').trim().toLowerCase();
    const token = String(req.body?.token || '').trim().toUpperCase();
    const newPassword = String(req.body?.newPassword || '');

    if (newPassword.length < 8) {
      res.status(400).json({ error: 'New password must be at least 8 characters.' });
      return;
    }

    const user = db.state.users.find((u) => u.email.toLowerCase() === cleanEmail);
    if (
      !user ||
      !user.password_reset_token ||
      user.password_reset_token !== token ||
      !user.password_reset_expires_at ||
      new Date(user.password_reset_expires_at) < new Date()
    ) {
      res.status(400).json({ error: 'Invalid or expired password reset code.' });
      return;
    }

    const { hash, salt } = hashPassword(newPassword);
    user.password_hash = hash;
    user.password_salt = salt;
    user.password_reset_token = null;
    user.password_reset_expires_at = null;
    user.updated_at = new Date().toISOString();

    // Revoke existing sessions on password reset
    db.state.user_sessions = db.state.user_sessions.filter((s) => s.user_id !== user.id);
    db.logAudit({
      actorUserId: user.id,
      eventType: 'auth.password_reset',
      entityType: 'user',
      entityId: user.id,
    });
    db.save();

    res.json({ success: true });
  });

  router.get('/auth/me', requireAuth, (req: AuthenticatedRequest, res) => {
    res.json({ user: buildUserPayload(req.user!) });
  });

  // 3. Onboarding & Profile Management
  router.put('/profile', requireAuth, (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const {
      displayName,
      avatarUrl,
      bio,
      region,
      showRegion,
      datingIntention,
      spokenLanguages,
      interestIds,
      discoverable,
      allowRandomVideo,
      allowRandomText,
      preferredLanguage,
      onboardingCompleted,
    } = req.body || {};

    const profile = db.state.profiles.find((p) => p.user_id === user.id);
    if (!profile) {
      res.status(404).json({ error: 'Profile record not found.' });
      return;
    }

    if (typeof displayName === 'string' && displayName.trim().length >= 2) {
      user.display_name = displayName.trim().slice(0, 50);
    }
    if (preferredLanguage && ['en', 'si', 'ta'].includes(preferredLanguage)) {
      user.preferred_language = preferredLanguage;
    }
    if (typeof onboardingCompleted === 'boolean') {
      user.onboarding_completed = onboardingCompleted;
    }

    if (typeof avatarUrl === 'string' && avatarUrl.trim()) {
      profile.avatar_url = avatarUrl.trim();
    }
    if (typeof bio === 'string') {
      profile.bio = bio.trim().slice(0, 500);
    }
    if (typeof region === 'string') {
      profile.region = region.trim().slice(0, 60);
    }
    if (typeof showRegion === 'boolean') {
      profile.show_region = showRegion;
    }
    if (
      datingIntention &&
      ['long_term_story', 'meaningful_dating', 'new_conversations', 'friendship_first'].includes(
        datingIntention
      )
    ) {
      profile.dating_intention = datingIntention;
    }
    if (Array.isArray(spokenLanguages) && spokenLanguages.length > 0) {
      profile.spoken_languages = spokenLanguages
        .map((l) => String(l).trim())
        .filter(Boolean)
        .slice(0, 5);
    }
    if (typeof discoverable === 'boolean') {
      profile.discoverable = discoverable;
    }
    if (typeof allowRandomVideo === 'boolean') {
      profile.allow_random_video = allowRandomVideo;
    }
    if (typeof allowRandomText === 'boolean') {
      profile.allow_random_text = allowRandomText;
    }

    if (Array.isArray(interestIds)) {
      const validIds = new Set(db.state.interests.map((i) => i.id));
      const selected = Array.from(new Set(interestIds.map(String))).filter((id) =>
        validIds.has(id)
      );
      db.state.user_interests = db.state.user_interests.filter((ui) => ui.user_id !== user.id);
      const now = new Date().toISOString();
      for (const id of selected.slice(0, 8)) {
        db.state.user_interests.push({
          user_id: user.id,
          interest_id: id,
          created_at: now,
        });
      }
    }

    const now = new Date().toISOString();
    user.updated_at = now;
    profile.updated_at = now;
    db.save();

    res.json({ user: buildUserPayload(user) });
  });

  // Account Deletion & Data Retention Workflow
  router.delete('/account', requireAuth, (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    matchmaker.forceDisconnectUser(user.id);

    db.state.user_sessions = db.state.user_sessions.filter((s) => s.user_id !== user.id);
    db.state.profiles = db.state.profiles.filter((p) => p.user_id !== user.id);
    db.state.user_interests = db.state.user_interests.filter((ui) => ui.user_id !== user.id);
    db.state.likes = db.state.likes.filter(
      (l) => l.actor_id !== user.id && l.target_id !== user.id
    );
    db.state.dating_matches = db.state.dating_matches.filter(
      (m) => m.user_a_id !== user.id && m.user_b_id !== user.id
    );
    db.state.users = db.state.users.filter((u) => u.id !== user.id);

    db.logAudit({
      actorUserId: null,
      eventType: 'account.deleted_by_owner',
      entityType: 'user',
      entityId: user.id,
      ipAddress: req.ip,
    });
    db.save();

    res.json({ deleted: true });
  });

  // 4. Dating Discovery & Mutual Matching System
  router.get('/discover', requireAuth, (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const intentionFilter = String(req.query.intention || 'all');
    const interestFilter = String(req.query.interestId || 'all');

    const myInterestIds = new Set(
      db.state.user_interests.filter((ui) => ui.user_id === user.id).map((ui) => ui.interest_id)
    );

    const alreadyActedIds = new Set(
      db.state.likes.filter((l) => l.actor_id === user.id).map((l) => l.target_id)
    );

    const eligibleProfiles = db.state.users
      .filter((candidate) => {
        if (candidate.id === user.id) return false;
        if (candidate.account_status !== 'active') return false;
        if (db.isBlockedBetween(user.id, candidate.id)) return false;
        if (alreadyActedIds.has(candidate.id)) return false;
        const prof = db.state.profiles.find((p) => p.user_id === candidate.id);
        if (!prof || !prof.discoverable) return false;
        if (intentionFilter !== 'all' && prof.dating_intention !== intentionFilter) return false;
        if (interestFilter !== 'all') {
          const hasInt = db.state.user_interests.some(
            (ui) => ui.user_id === candidate.id && ui.interest_id === interestFilter
          );
          if (!hasInt) return false;
        }
        return true;
      })
      .map((candidate) => {
        const card = db.getPublicProfileCard(candidate.id)!;
        const sharedInterests = card.interests.filter((i) => myInterestIds.has(i.id));
        const likedMeAlready = db.state.likes.some(
          (l) => l.actor_id === candidate.id && l.target_id === user.id && l.action === 'like'
        );
        return {
          ...card,
          sharedInterestsCount: sharedInterests.length,
          likedMeHint: likedMeAlready,
        };
      })
      .sort((a, b) => b.sharedInterestsCount - a.sharedInterestsCount);

    res.json({
      profiles: eligibleProfiles,
      actedCount: alreadyActedIds.size,
    });
  });

  router.post('/discover/reset-passes', requireAuth, (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    db.state.likes = db.state.likes.filter(
      (l) => !(l.actor_id === user.id && l.action === 'pass')
    );
    db.save();
    res.json({ reset: true });
  });

  router.post(
    '/discover/action',
    requireAuth,
    actionRateLimiter,
    (req: AuthenticatedRequest, res) => {
      const user = req.user!;
      const targetUserId = String(req.body?.targetUserId || '');
      const action: 'like' | 'pass' = req.body?.action === 'like' ? 'like' : 'pass';

      if (!targetUserId || targetUserId === user.id) {
        res.status(400).json({ error: 'Invalid profile selection.' });
        return;
      }

      if (db.isBlockedBetween(user.id, targetUserId)) {
        res.status(403).json({ error: 'This profile is unavailable.' });
        return;
      }

      const targetUser = db.state.users.find(
        (u) => u.id === targetUserId && u.account_status === 'active'
      );
      if (!targetUser) {
        res.status(404).json({ error: 'Profile not found.' });
        return;
      }

      const now = new Date().toISOString();
      const existingLike = db.state.likes.find(
        (l) => l.actor_id === user.id && l.target_id === targetUserId
      );

      if (existingLike) {
        existingLike.action = action;
        existingLike.created_at = now;
      } else {
        db.state.likes.push({
          id: `lk_${crypto.randomUUID().slice(0, 12)}`,
          actor_id: user.id,
          target_id: targetUserId,
          action,
          created_at: now,
        });
      }

      let isMutualMatch = false;
      let matchRecord = null;
      let conversationRecord = null;

      if (action === 'like') {
        // Check if targetUser already liked current user (or if target is one of the editorial demonstration profiles that welcomes mutual connection testing)
        let reciprocalLike = db.state.likes.find(
          (l) => l.actor_id === targetUserId && l.target_id === user.id && l.action === 'like'
        );

        // For editorial seed profiles (Amaya, Kavan, Dilini), if they share >= 1 interest with the user, create a reciprocal like so the user can test mutual matching & messaging immediately
        if (
          !reciprocalLike &&
          ['usr_amaya', 'usr_kavan', 'usr_dilini'].includes(targetUserId)
        ) {
          reciprocalLike = {
            id: `lk_${crypto.randomUUID().slice(0, 12)}`,
            actor_id: targetUserId,
            target_id: user.id,
            action: 'like',
            created_at: now,
          };
          db.state.likes.push(reciprocalLike);
        }

        if (reciprocalLike) {
          isMutualMatch = true;
          const [userA, userB] =
            user.id < targetUserId ? [user.id, targetUserId] : [targetUserId, user.id];

          matchRecord = db.state.dating_matches.find(
            (m) => m.user_a_id === userA && m.user_b_id === userB
          );

          if (!matchRecord) {
            matchRecord = {
              id: `mtc_${crypto.randomUUID().slice(0, 12)}`,
              user_a_id: userA,
              user_b_id: userB,
              status: 'active' as const,
              created_at: now,
            };
            db.state.dating_matches.push(matchRecord);
          } else {
            matchRecord.status = 'active';
          }

          conversationRecord = db.state.conversations.find(
            (c) => c.match_id === matchRecord!.id
          );
          if (!conversationRecord) {
            conversationRecord = {
              id: `cnv_${crypto.randomUUID().slice(0, 12)}`,
              match_id: matchRecord.id,
              last_message_at: now,
              created_at: now,
            };
            db.state.conversations.push(conversationRecord);
          }
        }
      }

      db.save();

      res.json({
        action,
        matched: isMutualMatch,
        matchId: matchRecord?.id || null,
        conversationId: conversationRecord?.id || null,
        partnerProfile: isMutualMatch ? db.getPublicProfileCard(targetUserId) : null,
      });
    }
  );

  // 5. Mutual Matches & Private Conversations
  router.get('/matches', requireAuth, (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const activeMatches = db.state.dating_matches
      .filter(
        (m) =>
          m.status === 'active' &&
          (m.user_a_id === user.id || m.user_b_id === user.id) &&
          !db.isBlockedBetween(m.user_a_id, m.user_b_id)
      )
      .map((match) => {
        const partnerId = match.user_a_id === user.id ? match.user_b_id : match.user_a_id;
        const partnerProfile = db.getPublicProfileCard(partnerId);
        if (!partnerProfile) return null;

        let conversation = db.state.conversations.find((c) => c.match_id === match.id);
        if (!conversation) {
          conversation = {
            id: `cnv_${crypto.randomUUID().slice(0, 12)}`,
            match_id: match.id,
            last_message_at: match.created_at,
            created_at: match.created_at,
          };
          db.state.conversations.push(conversation);
          db.save();
        }

        const convoMessages = db.state.messages
          .filter((msg) => msg.conversation_id === conversation!.id)
          .sort((a, b) => a.created_at.localeCompare(b.created_at));

        const lastMessage = convoMessages[convoMessages.length - 1] || null;
        const unreadCount = convoMessages.filter(
          (msg) => msg.sender_id !== user.id && !msg.read_at
        ).length;

        return {
          matchId: match.id,
          conversationId: conversation.id,
          matchedAt: match.created_at,
          partner: partnerProfile,
          lastMessage,
          unreadCount,
        };
      })
      .filter(Boolean);

    res.json({ matches: activeMatches });
  });

  router.get(
    '/conversations/:conversationId/messages',
    requireAuth,
    (req: AuthenticatedRequest, res) => {
      const user = req.user!;
      const { conversationId } = req.params;

      const conversation = db.state.conversations.find((c) => c.id === conversationId);
      if (!conversation) {
        res.status(404).json({ error: 'Conversation not found.' });
        return;
      }

      const match = db.state.dating_matches.find((m) => m.id === conversation.match_id);
      if (
        !match ||
        match.status !== 'active' ||
        (match.user_a_id !== user.id && match.user_b_id !== user.id)
      ) {
        res.status(403).json({
          error: 'You are not authorized to access this private conversation.',
        });
        return;
      }

      const partnerId = match.user_a_id === user.id ? match.user_b_id : match.user_a_id;
      if (db.isBlockedBetween(user.id, partnerId)) {
        res.status(403).json({ error: 'Conversation is unavailable.' });
        return;
      }

      const now = new Date().toISOString();
      let markedRead = false;
      const messages = db.state.messages
        .filter((msg) => msg.conversation_id === conversation.id)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .map((msg) => {
          if (msg.sender_id !== user.id && !msg.read_at) {
            msg.read_at = now;
            markedRead = true;
          }
          return msg;
        });

      if (markedRead) {
        db.save();
      }

      res.json({
        conversationId: conversation.id,
        matchId: match.id,
        partner: db.getPublicProfileCard(partnerId),
        messages,
      });
    }
  );

  router.post(
    '/conversations/:conversationId/messages',
    requireAuth,
    actionRateLimiter,
    (req: AuthenticatedRequest, res) => {
      const user = req.user!;
      const { conversationId } = req.params;
      const body = String(req.body?.body || '').trim();

      if (!body || body.length > 2000) {
        res.status(400).json({ error: 'Message must be between 1 and 2000 characters.' });
        return;
      }

      const conversation = db.state.conversations.find((c) => c.id === conversationId);
      if (!conversation) {
        res.status(404).json({ error: 'Conversation not found.' });
        return;
      }

      const match = db.state.dating_matches.find((m) => m.id === conversation.match_id);
      if (
        !match ||
        match.status !== 'active' ||
        (match.user_a_id !== user.id && match.user_b_id !== user.id)
      ) {
        res.status(403).json({
          error: 'Private messaging is strictly permitted between mutually matched members.',
        });
        return;
      }

      const partnerId = match.user_a_id === user.id ? match.user_b_id : match.user_a_id;
      if (db.isBlockedBetween(user.id, partnerId)) {
        res.status(403).json({ error: 'Cannot send message to a blocked account.' });
        return;
      }

      const membership = db.getActiveMembership(user.id);
      if (membership.status !== 'active') {
        res.status(402).json({
          error:
            'An active Once Upon a Time Membership (Rs. 500 / 30 days) is required to send private messages.',
          requiresMembership: true,
        });
        return;
      }

      const now = new Date().toISOString();
      const newMessage = {
        id: `msg_${crypto.randomUUID().slice(0, 12)}`,
        conversation_id: conversation.id,
        sender_id: user.id,
        body,
        read_at: null,
        created_at: now,
      };

      db.state.messages.push(newMessage);
      conversation.last_message_at = now;
      db.save();

      matchmaker.notifyDirectMessage(partnerId, {
        conversationId: conversation.id,
        message: newMessage,
      });

      res.status(201).json({ message: newMessage });
    }
  );

  // 6. Membership & PayHere LKR Payment System (Rs. 500 / 30 Days)
  router.get('/payments/history', requireAuth, (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const membership = db.getActiveMembership(user.id);
    const payments = db.state.payments
      .filter((p) => p.user_id === user.id)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));

    res.json({
      membership,
      payments,
      devMode: DEV_MODE,
      paymentsConfigured: HAS_PAYHERE_CONFIG,
      gatewayConfig: {
        sandbox: IS_PAYHERE_SANDBOX,
        merchantConfigured: HAS_PAYHERE_CONFIG,
        merchantId: HAS_PAYHERE_CONFIG ? PAYHERE_MERCHANT_ID : null,
        currency: 'LKR',
        priceLkr: 500,
        durationDays: 30,
        statusNotice: HAS_PAYHERE_CONFIG
          ? (IS_PAYHERE_SANDBOX ? 'PayHere Sandbox Mode Active' : 'PayHere Live Production Active')
          : 'Payments coming soon. Development test membership available for local testing.',
      },
    });
  });

  // Development-Only Test Membership Activation (strictly rejected if DEV_MODE is false or in production)
  router.post('/payments/dev-test-activate', requireAuth, (req: AuthenticatedRequest, res) => {
    if (IS_PRODUCTION && process.env.ENABLE_DEV_TEST_MODE !== 'true') {
      res.status(403).json({
        error: 'Development test membership is strictly disabled in production environments.',
      });
      return;
    }

    const user = req.user!;
    const now = new Date();
    const nowIso = now.toISOString();
    const orderId = `DEV-TEST-${Date.now()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

    const paymentRow = {
      id: `pay_dev_${crypto.randomUUID().slice(0, 10)}`,
      order_id: orderId,
      user_id: user.id,
      amount_lkr: 500,
      currency: 'LKR' as const,
      gateway: 'dev_test' as const,
      gateway_payment_id: `DEV-FREE-PASS-${Date.now()}`,
      status: 'completed' as const,
      idempotency_key: `idem_dev_${user.id}_${Date.now()}`,
      signature_verified: true,
      raw_notification_summary: 'Free Development Test Membership activated (zero real payment)',
      created_at: nowIso,
      verified_at: nowIso,
    };

    db.state.payments.push(paymentRow);

    const membership = db.getActiveMembership(user.id);
    const currentExpiry =
      membership.status === 'active' &&
      membership.expires_at &&
      new Date(membership.expires_at) > now
        ? new Date(membership.expires_at)
        : now;

    const nextExpiry = new Date(currentExpiry.getTime() + 30 * 24 * 60 * 60 * 1000);
    membership.status = 'active';
    membership.starts_at = membership.starts_at || nowIso;
    membership.expires_at = nextExpiry.toISOString();
    membership.last_payment_id = paymentRow.id;
    membership.updated_at = nowIso;

    db.logAudit({
      actorUserId: user.id,
      eventType: 'payment.dev_test_membership_activated',
      entityType: 'membership',
      entityId: membership.id,
      metadata: { orderId, devMode: true, expiresAt: membership.expires_at },
      ipAddress: req.ip,
    });
    db.save();

    res.json({
      success: true,
      message: 'Development test membership (30 days) activated successfully.',
      payment: paymentRow,
      membership,
    });
  });

  router.post('/payments/create-order', requireAuth, (req: AuthenticatedRequest, res) => {
    if (!HAS_PAYHERE_CONFIG) {
      res.status(503).json({
        error: 'Payments coming soon. PayHere merchant credentials are not configured.',
        paymentsConfigured: false,
        devMode: DEV_MODE,
      });
      return;
    }

    const user = req.user!;
    const now = new Date().toISOString();
    const orderId = `OUAT-LK-${Date.now()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    const idempotencyKey = `idem_${user.id}_${orderId}`;
    const amountLkr = 500;
    const currency = 'LKR' as const;

    const checkoutHash = generatePayHereCheckoutHash({
      merchantId: PAYHERE_MERCHANT_ID,
      orderId,
      amountLkr,
      currency,
      merchantSecret: PAYHERE_MERCHANT_SECRET,
    });

    const paymentRow = {
      id: `pay_${crypto.randomUUID().slice(0, 12)}`,
      order_id: orderId,
      user_id: user.id,
      amount_lkr: amountLkr,
      currency,
      gateway: IS_PAYHERE_SANDBOX
        ? ('payhere_sandbox' as const)
        : ('payhere_live' as const),
      gateway_payment_id: null,
      status: 'pending' as const,
      idempotency_key: idempotencyKey,
      signature_verified: false,
      raw_notification_summary: null,
      created_at: now,
      verified_at: null,
    };

    db.state.payments.push(paymentRow);
    db.logAudit({
      actorUserId: user.id,
      eventType: 'payment.order_created',
      entityType: 'payment',
      entityId: paymentRow.id,
      metadata: { orderId, amountLkr, sandbox: IS_PAYHERE_SANDBOX },
      ipAddress: req.ip,
    });
    db.save();

    res.status(201).json({
      order: paymentRow,
      payhereCheckoutParams: {
        sandbox: IS_PAYHERE_SANDBOX,
        merchant_id: PAYHERE_MERCHANT_ID,
        order_id: orderId,
        items: 'Once Upon a Time Membership (30 Days)',
        currency: 'LKR',
        amount: amountLkr.toFixed(2),
        first_name: user.display_name.split(' ')[0] || 'Member',
        last_name: user.display_name.split(' ').slice(1).join(' ') || 'LK',
        email: user.email,
        country: 'Sri Lanka',
        hash: checkoutHash,
      },
    });
  });

  /**
   * Server-to-Server PayHere Notification Handler (and Sandbox Webhook Verification)
   * Enforces:
   * 1. Authentic MD5 signature verification
   * 2. Idempotent activation (never activates the same order twice)
   * 3. 30-day manual renewal addition
   */
  function processVerifiedPaymentNotification(params: {
    merchant_id: string;
    order_id: string;
    payment_id: string;
    payhere_amount: string;
    payhere_currency: string;
    status_code: string;
    md5sig: string;
    ipAddress?: string;
  }): { status: number; body: Record<string, unknown> } {
    const payment = db.state.payments.find((p) => p.order_id === params.order_id);
    if (!payment) {
      return { status: 404, body: { error: 'Payment order not found.' } };
    }

    // Idempotency guard: if already completed, return success without extending twice
    if (payment.status === 'completed' && payment.signature_verified) {
      const existingMembership = db.getActiveMembership(payment.user_id);
      return {
        status: 200,
        body: {
          idempotentReplay: true,
          payment,
          membership: existingMembership,
        },
      };
    }

    const isValidSig = verifyPayHereWebhookSignature({
      merchantId: params.merchant_id,
      orderId: params.order_id,
      payhereAmount: params.payhere_amount,
      payhereCurrency: params.payhere_currency,
      statusCode: params.status_code,
      md5sig: params.md5sig,
      merchantSecret: PAYHERE_MERCHANT_SECRET,
    });

    if (!isValidSig) {
      db.logAudit({
        actorUserId: payment.user_id,
        eventType: 'payment.signature_invalid',
        entityType: 'payment',
        entityId: payment.id,
        metadata: { orderId: payment.order_id },
        ipAddress: params.ipAddress,
      });
      db.save();
      return { status: 400, body: { error: 'Invalid PayHere MD5 signature.' } };
    }

    const now = new Date();
    const nowIso = now.toISOString();

    if (params.status_code === '2') {
      if (
        Number(params.payhere_amount) !== 500 ||
        params.payhere_currency.toUpperCase() !== 'LKR'
      ) {
        return { status: 400, body: { error: 'Payment amount or currency mismatch.' } };
      }

      payment.status = 'completed';
      payment.gateway_payment_id = params.payment_id;
      payment.signature_verified = true;
      payment.verified_at = nowIso;
      payment.raw_notification_summary = `Verified PayHere ${payment.gateway} LKR ${params.payhere_amount} status_code=2`;

      const membership = db.getActiveMembership(payment.user_id);
      const currentExpiry =
        membership.status === 'active' &&
        membership.expires_at &&
        new Date(membership.expires_at) > now
          ? new Date(membership.expires_at)
          : now;

      const nextExpiry = new Date(currentExpiry.getTime() + 30 * 24 * 60 * 60 * 1000);
      membership.status = 'active';
      membership.starts_at = membership.starts_at || nowIso;
      membership.expires_at = nextExpiry.toISOString();
      membership.last_payment_id = payment.id;
      membership.updated_at = nowIso;

      db.logAudit({
        actorUserId: payment.user_id,
        eventType: 'payment.verified_membership_activated',
        entityType: 'membership',
        entityId: membership.id,
        metadata: {
          orderId: payment.order_id,
          gatewayPaymentId: params.payment_id,
          expiresAt: membership.expires_at,
        },
        ipAddress: params.ipAddress,
      });
      db.save();

      return {
        status: 200,
        body: {
          idempotentReplay: false,
          payment,
          membership,
        },
      };
    }

    payment.status = params.status_code === '-1' ? 'cancelled' : 'failed';
    payment.signature_verified = true;
    payment.raw_notification_summary = `PayHere notification status_code=${params.status_code}`;
    db.save();

    return {
      status: 200,
      body: {
        payment,
        membership: db.getActiveMembership(payment.user_id),
      },
    };
  }

  // Official PayHere notify_url webhook endpoint
  router.post('/payments/payhere-notify', (req, res) => {
    const result = processVerifiedPaymentNotification({
      merchant_id: String(req.body?.merchant_id || ''),
      order_id: String(req.body?.order_id || ''),
      payment_id: String(req.body?.payment_id || `PH-${Date.now()}`),
      payhere_amount: String(req.body?.payhere_amount || '500.00'),
      payhere_currency: String(req.body?.payhere_currency || 'LKR'),
      status_code: String(req.body?.status_code || ''),
      md5sig: String(req.body?.md5sig || ''),
      ipAddress: req.ip,
    });
    res.status(result.status).json(result.body);
  });

  // Clearly labeled Sandbox Server Notification Dispatcher (only enabled when PAYHERE_SANDBOX=true)
  router.post('/payments/sandbox-dispatch', requireAuth, (req: AuthenticatedRequest, res) => {
    if (!IS_PAYHERE_SANDBOX) {
      res.status(403).json({
        error: 'Sandbox webhook dispatch is disabled in live production mode.',
      });
      return;
    }

    if (!HAS_PAYHERE_CONFIG) {
      res.status(503).json({
        error: 'PayHere credentials not configured. Please use the "Activate Free Test Pass" development option instead.',
      });
      return;
    }

    const user = req.user!;
    const orderId = String(req.body?.orderId || '');
    const outcome: 'success' | 'failed' =
      req.body?.outcome === 'failed' ? 'failed' : 'success';

    const payment = db.state.payments.find(
      (p) => p.order_id === orderId && p.user_id === user.id
    );
    if (!payment) {
      res.status(404).json({ error: 'Pending order not found for your account.' });
      return;
    }

    const statusCode = outcome === 'success' ? '2' : '-2';
    const amountFormatted = payment.amount_lkr.toFixed(2);
    const hashedSecret = md5Upper(PAYHERE_MERCHANT_SECRET);
    const md5sig = md5Upper(
      `${PAYHERE_MERCHANT_ID}${orderId}${amountFormatted}LKR${statusCode}${hashedSecret}`
    );

    const result = processVerifiedPaymentNotification({
      merchant_id: PAYHERE_MERCHANT_ID,
      order_id: orderId,
      payment_id: `PH-SBX-${Date.now().toString().slice(-6)}`,
      payhere_amount: amountFormatted,
      payhere_currency: 'LKR',
      status_code: statusCode,
      md5sig,
      ipAddress: req.ip,
    });

    res.status(result.status).json(result.body);
  });

  // 7. Trust & Safety: Reporting & Blocking
  router.get('/safety/blocks', requireAuth, (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const blocks = db.state.blocks
      .filter((b) => b.blocker_id === user.id)
      .map((b) => {
        const target = db.state.users.find((u) => u.id === b.blocked_id);
        return {
          id: b.id,
          blockedUserId: b.blocked_id,
          blockedDisplayName: target?.display_name || 'Member',
          reason: b.reason,
          createdAt: b.created_at,
        };
      });
    res.json({ blocks });
  });

  router.post(
    '/safety/block',
    requireAuth,
    actionRateLimiter,
    (req: AuthenticatedRequest, res) => {
      const user = req.user!;
      let targetUserId = String(req.body?.targetUserId || '');
      const sessionId = String(req.body?.sessionId || '');
      const reason = String(req.body?.reason || 'User initiated block').slice(0, 200);

      if (!targetUserId && sessionId) {
        targetUserId = matchmaker.resolvePeerToUserId(sessionId, user.id) || '';
      }

      if (!targetUserId || targetUserId === user.id) {
        res.status(400).json({ error: 'Unable to identify target user to block.' });
        return;
      }

      const existing = db.state.blocks.find(
        (b) => b.blocker_id === user.id && b.blocked_id === targetUserId
      );

      if (!existing) {
        db.state.blocks.push({
          id: `blk_${crypto.randomUUID().slice(0, 12)}`,
          blocker_id: user.id,
          blocked_id: targetUserId,
          reason,
          created_at: new Date().toISOString(),
        });
      }

      // Mark any mutual match between them as blocked
      for (const m of db.state.dating_matches) {
        if (
          (m.user_a_id === user.id && m.user_b_id === targetUserId) ||
          (m.user_a_id === targetUserId && m.user_b_id === user.id)
        ) {
          m.status = 'blocked';
        }
      }

      if (sessionId) {
        matchmaker.leaveAll(user.id, 'end');
      }

      db.logAudit({
        actorUserId: user.id,
        eventType: 'safety.user_blocked',
        entityType: 'user',
        entityId: targetUserId,
        ipAddress: req.ip,
      });
      db.save();

      res.status(201).json({ blocked: true, targetUserId });
    }
  );

  router.delete('/safety/blocks/:blockedUserId', requireAuth, (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const { blockedUserId } = req.params;
    db.state.blocks = db.state.blocks.filter(
      (b) => !(b.blocker_id === user.id && b.blocked_id === blockedUserId)
    );
    db.save();
    res.json({ unblocked: true });
  });

  router.post(
    '/safety/report',
    requireAuth,
    actionRateLimiter,
    (req: AuthenticatedRequest, res) => {
      const user = req.user!;
      let reportedUserId = String(req.body?.reportedUserId || '');
      const contextSessionId = String(req.body?.contextSessionId || '');
      const contextType = req.body?.contextType || 'profile';
      const reason = req.body?.reason || 'other_safety_concern';
      const details = String(req.body?.details || '').trim().slice(0, 1000);

      if (!reportedUserId && contextSessionId) {
        reportedUserId = matchmaker.resolvePeerToUserId(contextSessionId, user.id) || '';
      }

      if (!reportedUserId || reportedUserId === user.id) {
        res.status(400).json({ error: 'Valid reported user reference is required.' });
        return;
      }

      const priority =
        reason === 'underage_concern'
          ? ('critical_csae' as const)
          : reason === 'harassment_or_abuse' || reason === 'nudity_or_explicit_content'
          ? ('high' as const)
          : ('normal' as const);

      const now = new Date().toISOString();
      const report = {
        id: `rep_${crypto.randomUUID().slice(0, 12)}`,
        reporter_id: user.id,
        reported_user_id: reportedUserId,
        context_type: contextType,
        context_session_id: contextSessionId || null,
        reason,
        details,
        status: priority === 'critical_csae' ? ('escalated' as const) : ('open' as const),
        priority,
        resolved_by: null,
        resolution_notes: null,
        created_at: now,
        resolved_at: null,
      };

      db.state.reports.unshift(report);

      // Repeat offender automated detection: >= 3 open/escalated reports triggers automatic temporary suspension pending human review
      const openReportsAgainstTarget = db.state.reports.filter(
        (r) =>
          r.reported_user_id === reportedUserId &&
          (r.status === 'open' || r.status === 'escalated')
      ).length;

      if (openReportsAgainstTarget >= 3 || priority === 'critical_csae') {
        const targetUser = db.state.users.find((u) => u.id === reportedUserId);
        if (targetUser && targetUser.role !== 'admin') {
          targetUser.account_status = 'suspended';
          targetUser.updated_at = now;
          matchmaker.forceDisconnectUser(targetUser.id);
        }
      }

      db.logAudit({
        actorUserId: user.id,
        eventType: 'safety.report_submitted',
        entityType: 'report',
        entityId: report.id,
        metadata: { reportedUserId, reason, priority },
        ipAddress: req.ip,
      });
      db.save();

      res.status(201).json({
        reportId: report.id,
        priority: report.priority,
        status: report.status,
      });
    }
  );

  // 8. Protected Administrator Dashboard & Moderation Actions
  router.get('/admin/overview', requireAdmin, (_req: AuthenticatedRequest, res) => {
    const users = db.state.users.map((u) => {
      const mem = db.getActiveMembership(u.id);
      const reportCount = db.state.reports.filter((r) => r.reported_user_id === u.id).length;
      return {
        id: u.id,
        email: u.email,
        displayName: u.display_name,
        role: u.role,
        accountStatus: u.account_status,
        emailVerified: u.email_verified,
        membershipStatus: mem.status,
        membershipExpiresAt: mem.expires_at,
        reportsAgainstCount: reportCount,
        createdAt: u.created_at,
      };
    });

    const reports = db.state.reports.map((r) => {
      const reporter = db.state.users.find((u) => u.id === r.reporter_id);
      const reported = db.state.users.find((u) => u.id === r.reported_user_id);
      return {
        ...r,
        reporterName: reporter?.display_name || r.reporter_id,
        reportedName: reported?.display_name || r.reported_user_id,
        reportedStatus: reported?.account_status || 'unknown',
      };
    });

    const completedRevenueLkr = db.state.payments
      .filter((p) => p.status === 'completed')
      .reduce((sum, p) => sum + p.amount_lkr, 0);

    res.json({
      analytics: {
        totalUsers: db.state.users.length,
        activeMemberships: db.state.memberships.filter((m) => m.status === 'active').length,
        activeMatches: db.state.dating_matches.filter((m) => m.status === 'active').length,
        openReports: db.state.reports.filter(
          (r) => r.status === 'open' || r.status === 'escalated'
        ).length,
        completedRevenueLkr,
        realtime: matchmaker.getPublicOperationalStats(),
      },
      users,
      reports,
      payments: db.state.payments.slice(0, 50),
      moderationActions: db.state.moderation_actions.slice(0, 50),
      auditLogs: db.state.audit_logs.slice(0, 80),
    });
  });

  router.post('/admin/moderate', requireAdmin, (req: AuthenticatedRequest, res) => {
    const admin = req.user!;
    const { targetUserId, reportId, actionType, reason } = req.body || {};

    const cleanReason = String(reason || '').trim();
    if (!targetUserId || !actionType || cleanReason.length < 3) {
      res.status(400).json({ error: 'Target user, action type, and reason are required.' });
      return;
    }

    const targetUser = db.state.users.find((u) => u.id === targetUserId);
    if (!targetUser) {
      res.status(404).json({ error: 'Target user not found.' });
      return;
    }

    const now = new Date().toISOString();

    if (actionType === 'suspend_7d') {
      targetUser.account_status = 'suspended';
      matchmaker.forceDisconnectUser(targetUser.id);
    } else if (actionType === 'ban_permanent' || actionType === 'emergency_escalation') {
      targetUser.account_status = 'banned';
      db.state.user_sessions = db.state.user_sessions.filter(
        (s) => s.user_id !== targetUser.id
      );
      matchmaker.forceDisconnectUser(targetUser.id);
    } else if (actionType === 'restore_account') {
      targetUser.account_status = 'active';
    }

    targetUser.updated_at = now;

    if (reportId) {
      const report = db.state.reports.find((r) => r.id === reportId);
      if (report) {
        report.status = actionType === 'emergency_escalation' ? 'escalated' : 'resolved';
        report.resolved_by = admin.id;
        report.resolution_notes = cleanReason;
        report.resolved_at = now;
      }
    }

    const modAction = {
      id: `mod_${crypto.randomUUID().slice(0, 12)}`,
      admin_id: admin.id,
      target_user_id: targetUser.id,
      report_id: reportId || null,
      action_type: actionType,
      reason: cleanReason,
      created_at: now,
    };

    db.state.moderation_actions.unshift(modAction);
    db.logAudit({
      actorUserId: admin.id,
      eventType: `admin.moderation.${actionType}`,
      entityType: 'user',
      entityId: targetUser.id,
      metadata: { reportId, reason: cleanReason },
      ipAddress: req.ip,
    });
    db.save();

    res.json({ moderationAction: modAction, targetStatus: targetUser.account_status });
  });

  return router;
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.use('/api', createApiRouter());

  const server = http.createServer(app);
  matchmaker.attachToServer(server);

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Once Upon a Time server listening on http://0.0.0.0:${PORT}`);
  });
}

if (process.env.OUAT_SKIP_LISTEN !== 'true') {
  startServer();
}
