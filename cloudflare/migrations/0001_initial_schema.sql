-- ============================================================================
-- ONCE UPON A TIME (OUAT) — CLOUDFLARE D1 NORMALIZED DATABASE SCHEMA
-- Migration: 0001_initial_schema.sql
-- Market: Sri Lanka (LKR) | Policy: Adults 18+ Only
-- ============================================================================

PRAGMA foreign_keys = ON;

-- 1. USERS
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  display_name TEXT NOT NULL,
  date_of_birth TEXT NOT NULL, -- ISO-8601 YYYY-MM-DD (Verified >= 18 years server-side)
  age_verified_at TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  email_verification_token TEXT,
  password_reset_token TEXT,
  password_reset_expires_at TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'moderator', 'admin')),
  account_status TEXT NOT NULL DEFAULT 'active' CHECK (account_status IN ('active', 'suspended', 'banned', 'deleted')),
  onboarding_completed INTEGER NOT NULL DEFAULT 0,
  preferred_language TEXT NOT NULL DEFAULT 'en' CHECK (preferred_language IN ('en', 'si', 'ta')),
  terms_accepted_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(account_status);

-- 2. PROFILES
CREATE TABLE IF NOT EXISTS profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  avatar_url TEXT,
  bio TEXT DEFAULT '',
  region TEXT DEFAULT '', -- General region only (e.g. Colombo, Kandy, Galle, Jaffna) if explicitly shared
  show_region INTEGER NOT NULL DEFAULT 1,
  dating_intention TEXT NOT NULL DEFAULT 'long_term_story' CHECK (
    dating_intention IN ('long_term_story', 'meaningful_dating', 'new_conversations', 'friendship_first')
  ),
  spoken_languages TEXT NOT NULL DEFAULT '["English"]', -- JSON array
  discoverable INTEGER NOT NULL DEFAULT 1,
  allow_random_video INTEGER NOT NULL DEFAULT 1,
  allow_random_text INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_profiles_discoverable ON profiles(discoverable, dating_intention);

-- 3. USER SESSIONS
CREATE TABLE IF NOT EXISTS user_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  ip_address TEXT,
  user_agent TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_token ON user_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON user_sessions(user_id);

-- 4. INTERESTS
CREATE TABLE IF NOT EXISTS interests (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  label_en TEXT NOT NULL,
  label_si TEXT NOT NULL,
  label_ta TEXT NOT NULL,
  category TEXT NOT NULL
);

-- 5. USER INTERESTS
CREATE TABLE IF NOT EXISTS user_interests (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  interest_id TEXT NOT NULL REFERENCES interests(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, interest_id)
);

CREATE INDEX IF NOT EXISTS idx_user_interests_interest ON user_interests(interest_id);

-- 6. LIKES (Discovery Interactions)
CREATE TABLE IF NOT EXISTS likes (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('like', 'pass')),
  created_at TEXT NOT NULL,
  UNIQUE(actor_id, target_id),
  CHECK (actor_id != target_id)
);

CREATE INDEX IF NOT EXISTS idx_likes_actor ON likes(actor_id, action);
CREATE INDEX IF NOT EXISTS idx_likes_target ON likes(target_id, action);

-- 7. DATING MATCHES (Canonical ordering user_a_id < user_b_id prevents duplicates)
CREATE TABLE IF NOT EXISTS dating_matches (
  id TEXT PRIMARY KEY,
  user_a_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'unmatched', 'blocked')),
  created_at TEXT NOT NULL,
  UNIQUE(user_a_id, user_b_id),
  CHECK (user_a_id < user_b_id)
);

CREATE INDEX IF NOT EXISTS idx_matches_user_a ON dating_matches(user_a_id, status);
CREATE INDEX IF NOT EXISTS idx_matches_user_b ON dating_matches(user_b_id, status);

-- 8. CONVERSATIONS
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL UNIQUE REFERENCES dating_matches(id) ON DELETE CASCADE,
  last_message_at TEXT,
  created_at TEXT NOT NULL
);

-- 9. MESSAGES
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  read_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);

-- 10. MEMBERSHIPS (Single Tier: Once Upon a Time Membership - Rs. 500 / 30 days)
CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  plan_name TEXT NOT NULL DEFAULT 'Once Upon a Time Membership',
  price_lkr INTEGER NOT NULL DEFAULT 500,
  status TEXT NOT NULL DEFAULT 'inactive' CHECK (status IN ('inactive', 'active', 'expired')),
  starts_at TEXT,
  expires_at TEXT,
  last_payment_id TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memberships_user_status ON memberships(user_id, status, expires_at);

-- 11. PAYMENTS (Idempotent server-verified PayHere / Sandbox orders)
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_lkr INTEGER NOT NULL DEFAULT 500,
  currency TEXT NOT NULL DEFAULT 'LKR',
  gateway TEXT NOT NULL CHECK (gateway IN ('payhere_live', 'payhere_sandbox')),
  gateway_payment_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed', 'cancelled')),
  idempotency_key TEXT NOT NULL UNIQUE,
  signature_verified INTEGER NOT NULL DEFAULT 0,
  raw_notification_summary TEXT,
  created_at TEXT NOT NULL,
  verified_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);

-- 12. REPORTS
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reported_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  context_type TEXT NOT NULL CHECK (context_type IN ('profile', 'random_video', 'random_text', 'direct_message')),
  context_session_id TEXT,
  reason TEXT NOT NULL CHECK (
    reason IN (
      'underage_concern',
      'harassment_or_abuse',
      'nudity_or_explicit_content',
      'spam_or_scam',
      'impersonation',
      'hate_speech',
      'other_safety_concern'
    )
  ),
  details TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_review', 'resolved', 'escalated')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'high', 'critical_csae')),
  resolved_by TEXT REFERENCES users(id),
  resolution_notes TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_reports_reported_user ON reports(reported_user_id);

-- 13. BLOCKS
CREATE TABLE IF NOT EXISTS blocks (
  id TEXT PRIMARY KEY,
  blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(blocker_id, blocked_id),
  CHECK (blocker_id != blocked_id)
);

CREATE INDEX IF NOT EXISTS idx_blocks_blocker ON blocks(blocker_id);
CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks(blocked_id);

-- 14. MODERATION ACTIONS
CREATE TABLE IF NOT EXISTS moderation_actions (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL REFERENCES users(id),
  target_user_id TEXT NOT NULL REFERENCES users(id),
  report_id TEXT REFERENCES reports(id),
  action_type TEXT NOT NULL CHECK (
    action_type IN ('warning', 'suspend_7d', 'ban_permanent', 'restore_account', 'dismiss_report', 'emergency_escalation')
  ),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 15. AUDIT LOGS
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  ip_address TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);
