import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { hashPassword, verifyAdultAge } from './security';

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  password_salt: string;
  display_name: string;
  date_of_birth: string;
  age_verified_at: string;
  email_verified: boolean;
  email_verification_token: string | null;
  password_reset_token: string | null;
  password_reset_expires_at: string | null;
  role: 'member' | 'moderator' | 'admin';
  account_status: 'active' | 'suspended' | 'banned' | 'deleted';
  onboarding_completed: boolean;
  preferred_language: 'en' | 'si' | 'ta';
  terms_accepted_at: string;
  created_at: string;
  updated_at: string;
}

export interface ProfileRow {
  user_id: string;
  avatar_url: string;
  bio: string;
  region: string;
  show_region: boolean;
  dating_intention: 'long_term_story' | 'meaningful_dating' | 'new_conversations' | 'friendship_first';
  spoken_languages: string[];
  discoverable: boolean;
  allow_random_video: boolean;
  allow_random_text: boolean;
  updated_at: string;
}

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  ip_address: string;
  user_agent: string;
  expires_at: string;
  created_at: string;
}

export interface InterestRow {
  id: string;
  slug: string;
  label_en: string;
  label_si: string;
  label_ta: string;
  category: string;
}

export interface UserInterestRow {
  user_id: string;
  interest_id: string;
  created_at: string;
}

export interface LikeRow {
  id: string;
  actor_id: string;
  target_id: string;
  action: 'like' | 'pass';
  created_at: string;
}

export interface DatingMatchRow {
  id: string;
  user_a_id: string;
  user_b_id: string;
  status: 'active' | 'unmatched' | 'blocked';
  created_at: string;
}

export interface ConversationRow {
  id: string;
  match_id: string;
  last_message_at: string | null;
  created_at: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  read_at: string | null;
  created_at: string;
}

export interface MembershipRow {
  id: string;
  user_id: string;
  plan_name: string;
  price_lkr: number;
  status: 'inactive' | 'active' | 'expired';
  starts_at: string | null;
  expires_at: string | null;
  last_payment_id: string | null;
  updated_at: string;
}

export interface PaymentRow {
  id: string;
  order_id: string;
  user_id: string;
  amount_lkr: number;
  currency: 'LKR';
  gateway: 'payhere_live' | 'payhere_sandbox' | 'dev_test';
  gateway_payment_id: string | null;
  status: 'pending' | 'completed' | 'failed' | 'cancelled';
  idempotency_key: string;
  signature_verified: boolean;
  raw_notification_summary: string | null;
  created_at: string;
  verified_at: string | null;
}

export interface ReportRow {
  id: string;
  reporter_id: string;
  reported_user_id: string;
  context_type: 'profile' | 'random_video' | 'random_text' | 'direct_message';
  context_session_id: string | null;
  reason:
    | 'underage_concern'
    | 'harassment_or_abuse'
    | 'nudity_or_explicit_content'
    | 'spam_or_scam'
    | 'impersonation'
    | 'hate_speech'
    | 'other_safety_concern';
  details: string;
  status: 'open' | 'in_review' | 'resolved' | 'escalated';
  priority: 'normal' | 'high' | 'critical_csae';
  resolved_by: string | null;
  resolution_notes: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface BlockRow {
  id: string;
  blocker_id: string;
  blocked_id: string;
  reason: string;
  created_at: string;
}

export interface ModerationActionRow {
  id: string;
  admin_id: string;
  target_user_id: string;
  report_id: string | null;
  action_type:
    | 'warning'
    | 'suspend_7d'
    | 'ban_permanent'
    | 'restore_account'
    | 'dismiss_report'
    | 'emergency_escalation';
  reason: string;
  created_at: string;
}

export interface AuditLogRow {
  id: string;
  actor_user_id: string | null;
  event_type: string;
  entity_type: string;
  entity_id: string | null;
  metadata_json: string;
  ip_address: string;
  created_at: string;
}

export interface DatabaseSchema {
  users: UserRow[];
  profiles: ProfileRow[];
  user_sessions: SessionRow[];
  interests: InterestRow[];
  user_interests: UserInterestRow[];
  likes: LikeRow[];
  dating_matches: DatingMatchRow[];
  conversations: ConversationRow[];
  messages: MessageRow[];
  memberships: MembershipRow[];
  payments: PaymentRow[];
  reports: ReportRow[];
  blocks: BlockRow[];
  moderation_actions: ModerationActionRow[];
  audit_logs: AuditLogRow[];
}

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'ouat_database.json');

const INITIAL_INTERESTS: InterestRow[] = [
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

class NormalizedDatabase {
  public state: DatabaseSchema;

  constructor() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      if (fs.existsSync(DB_FILE)) {
        const raw = fs.readFileSync(DB_FILE, 'utf-8');
        this.state = JSON.parse(raw) as DatabaseSchema;
        return;
      }
    } catch {
      // In-memory fallback if file system is read-only or running in serverless edge worker
    }
    this.state = this.createSeededDatabase();
    try {
      this.save();
    } catch {
      // Ignore write errors in read-only environments
    }
  }

  public save(): void {
    try {
      const tmpFile = `${DB_FILE}.tmp`;
      fs.writeFileSync(tmpFile, JSON.stringify(this.state, null, 2), 'utf-8');
      fs.renameSync(tmpFile, DB_FILE);
    } catch {
      // Ignore write errors in serverless edge environments
    }
  }

  public logAudit(params: {
    actorUserId: string | null;
    eventType: string;
    entityType: string;
    entityId?: string | null;
    metadata?: Record<string, unknown>;
    ipAddress?: string;
  }): void {
    this.state.audit_logs.unshift({
      id: `aud_${crypto.randomUUID().slice(0, 12)}`,
      actor_user_id: params.actorUserId,
      event_type: params.eventType,
      entity_type: params.entityType,
      entity_id: params.entityId || null,
      metadata_json: JSON.stringify(params.metadata || {}),
      ip_address: params.ipAddress || '127.0.0.1',
      created_at: new Date().toISOString(),
    });
    if (this.state.audit_logs.length > 500) {
      this.state.audit_logs.length = 500;
    }
  }

  public isBlockedBetween(userA: string, userB: string): boolean {
    return this.state.blocks.some(
      (b) =>
        (b.blocker_id === userA && b.blocked_id === userB) ||
        (b.blocker_id === userB && b.blocked_id === userA)
    );
  }

  public getActiveMembership(userId: string): MembershipRow {
    let membership = this.state.memberships.find((m) => m.user_id === userId);
    const now = new Date();
    if (!membership) {
      membership = {
        id: `mem_${crypto.randomUUID().slice(0, 10)}`,
        user_id: userId,
        plan_name: 'Once Upon a Time Membership',
        price_lkr: 500,
        status: 'inactive',
        starts_at: null,
        expires_at: null,
        last_payment_id: null,
        updated_at: now.toISOString(),
      };
      this.state.memberships.push(membership);
      this.save();
    } else if (
      membership.status === 'active' &&
      membership.expires_at &&
      new Date(membership.expires_at) < now
    ) {
      membership.status = 'expired';
      membership.updated_at = now.toISOString();
      this.save();
    }
    return membership;
  }

  public getPublicProfileCard(userId: string) {
    const user = this.state.users.find((u) => u.id === userId && u.account_status === 'active');
    if (!user) return null;
    const profile = this.state.profiles.find((p) => p.user_id === userId);
    if (!profile) return null;
    const ageCheck = verifyAdultAge(user.date_of_birth);
    const userInterestIds = this.state.user_interests
      .filter((ui) => ui.user_id === userId)
      .map((ui) => ui.interest_id);
    const interests = this.state.interests.filter((i) => userInterestIds.includes(i.id));

    return {
      userId: user.id,
      displayName: user.display_name,
      age: ageCheck.age,
      region: profile.show_region ? profile.region : '',
      bio: profile.bio,
      avatarUrl: profile.avatar_url,
      datingIntention: profile.dating_intention,
      spokenLanguages: profile.spoken_languages,
      interests,
      allowRandomVideo: profile.allow_random_video,
      allowRandomText: profile.allow_random_text,
    };
  }

  private createSeededDatabase(): DatabaseSchema {
    const now = new Date().toISOString();
    const thirtyDaysLater = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const adminPass = hashPassword('StoryAdmin2026!');
    const memberPass = hashPassword('ColomboStory2026!');

    const users: UserRow[] = [
      {
        id: 'usr_admin_lk',
        email: 'admin@onceuponatime.lk',
        password_hash: adminPass.hash,
        password_salt: adminPass.salt,
        display_name: 'Nalin Wijesinghe (Trust & Safety)',
        date_of_birth: '1991-04-14',
        age_verified_at: now,
        email_verified: true,
        email_verification_token: null,
        password_reset_token: null,
        password_reset_expires_at: null,
        role: 'admin',
        account_status: 'active',
        onboarding_completed: true,
        preferred_language: 'en',
        terms_accepted_at: now,
        created_at: now,
        updated_at: now,
      },
      {
        id: 'usr_amaya',
        email: 'amaya@onceuponatime.lk',
        password_hash: memberPass.hash,
        password_salt: memberPass.salt,
        display_name: 'Amaya Senanayake',
        date_of_birth: '1999-08-19',
        age_verified_at: now,
        email_verified: true,
        email_verification_token: null,
        password_reset_token: null,
        password_reset_expires_at: null,
        role: 'member',
        account_status: 'active',
        onboarding_completed: true,
        preferred_language: 'en',
        terms_accepted_at: now,
        created_at: now,
        updated_at: now,
      },
      {
        id: 'usr_kavan',
        email: 'kavan@onceuponatime.lk',
        password_hash: memberPass.hash,
        password_salt: memberPass.salt,
        display_name: 'Kavan Perera',
        date_of_birth: '1997-11-03',
        age_verified_at: now,
        email_verified: true,
        email_verification_token: null,
        password_reset_token: null,
        password_reset_expires_at: null,
        role: 'member',
        account_status: 'active',
        onboarding_completed: true,
        preferred_language: 'en',
        terms_accepted_at: now,
        created_at: now,
        updated_at: now,
      },
      {
        id: 'usr_dilini',
        email: 'dilini@onceuponatime.lk',
        password_hash: memberPass.hash,
        password_salt: memberPass.salt,
        display_name: 'Dilini Ratnayake',
        date_of_birth: '2000-02-24',
        age_verified_at: now,
        email_verified: true,
        email_verification_token: null,
        password_reset_token: null,
        password_reset_expires_at: null,
        role: 'member',
        account_status: 'active',
        onboarding_completed: true,
        preferred_language: 'si',
        terms_accepted_at: now,
        created_at: now,
        updated_at: now,
      },
      {
        id: 'usr_ehan',
        email: 'ehan@onceuponatime.lk',
        password_hash: memberPass.hash,
        password_salt: memberPass.salt,
        display_name: 'Ehan Selvarajah',
        date_of_birth: '1996-06-12',
        age_verified_at: now,
        email_verified: true,
        email_verification_token: null,
        password_reset_token: null,
        password_reset_expires_at: null,
        role: 'member',
        account_status: 'active',
        onboarding_completed: true,
        preferred_language: 'ta',
        terms_accepted_at: now,
        created_at: now,
        updated_at: now,
      },
    ];

    const profiles: ProfileRow[] = [
      {
        user_id: 'usr_admin_lk',
        avatar_url: '/src/assets/images/editorial_portrait_kavan_1793978350314.jpg',
        bio: 'Platform steward ensuring Once Upon a Time remains thoughtful, respectful, and safe for adults across Sri Lanka.',
        region: 'Colombo',
        show_region: true,
        dating_intention: 'new_conversations',
        spoken_languages: ['English', 'Sinhala', 'Tamil'],
        discoverable: false,
        allow_random_video: true,
        allow_random_text: true,
        updated_at: now,
      },
      {
        user_id: 'usr_amaya',
        avatar_url: '/src/assets/images/editorial_portrait_amaya_1793978349458.jpg',
        bio: 'Textile curator splitting weeks between Colombo and Galle Fort. Looking for someone who appreciates unhurried evening tea, old cinema, and honest conversation.',
        region: 'Galle & Colombo',
        show_region: true,
        dating_intention: 'long_term_story',
        spoken_languages: ['English', 'Sinhala'],
        discoverable: true,
        allow_random_video: true,
        allow_random_text: true,
        updated_at: now,
      },
      {
        user_id: 'usr_kavan',
        avatar_url: '/src/assets/images/editorial_portrait_kavan_1793978350314.jpg',
        bio: 'Spatial architect inspired by Geoffrey Bawa courtyards and monsoon afternoons. Always up for acoustic jazz nights or driving down the southern coast.',
        region: 'Colombo 07',
        show_region: true,
        dating_intention: 'meaningful_dating',
        spoken_languages: ['English', 'Sinhala'],
        discoverable: true,
        allow_random_video: true,
        allow_random_text: true,
        updated_at: now,
      },
      {
        user_id: 'usr_dilini',
        avatar_url: '/src/assets/images/editorial_portrait_dilini_1793978350862.jpg',
        bio: 'Literature postgraduate and classical pianist based in Kandy. Drawn to people who still read physical books and notice small details.',
        region: 'Kandy',
        show_region: true,
        dating_intention: 'long_term_story',
        spoken_languages: ['Sinhala', 'English'],
        discoverable: true,
        allow_random_video: true,
        allow_random_text: true,
        updated_at: now,
      },
      {
        user_id: 'usr_ehan',
        avatar_url: '/src/assets/images/editorial_portrait_ehan_1793978352895.jpg',
        bio: 'Documentary cinematographer working between Colombo and the southern coast. Best conversations happen over black coffee at blue hour.',
        region: 'Mirissa & Colombo',
        show_region: true,
        dating_intention: 'meaningful_dating',
        spoken_languages: ['Tamil', 'English', 'Sinhala'],
        discoverable: true,
        allow_random_video: true,
        allow_random_text: true,
        updated_at: now,
      },
    ];

    const user_interests: UserInterestRow[] = [
      { user_id: 'usr_amaya', interest_id: 'int_tea', created_at: now },
      { user_id: 'usr_amaya', interest_id: 'int_art', created_at: now },
      { user_id: 'usr_amaya', interest_id: 'int_cinema', created_at: now },
      { user_id: 'usr_amaya', interest_id: 'int_coastal', created_at: now },
      { user_id: 'usr_kavan', interest_id: 'int_architecture', created_at: now },
      { user_id: 'usr_kavan', interest_id: 'int_music', created_at: now },
      { user_id: 'usr_kavan', interest_id: 'int_coastal', created_at: now },
      { user_id: 'usr_kavan', interest_id: 'int_photography', created_at: now },
      { user_id: 'usr_dilini', interest_id: 'int_literature', created_at: now },
      { user_id: 'usr_dilini', interest_id: 'int_tea', created_at: now },
      { user_id: 'usr_dilini', interest_id: 'int_hillcountry', created_at: now },
      { user_id: 'usr_dilini', interest_id: 'int_philosophy', created_at: now },
      { user_id: 'usr_ehan', interest_id: 'int_cinema', created_at: now },
      { user_id: 'usr_ehan', interest_id: 'int_photography', created_at: now },
      { user_id: 'usr_ehan', interest_id: 'int_coastal', created_at: now },
      { user_id: 'usr_ehan', interest_id: 'int_culinary', created_at: now },
    ];

    // Pre-existing likes from Amaya and Kavan toward new members are NOT faked;
    // however, Amaya and Kavan already liked each other so logging into Amaya or Kavan shows a real database match.
    const likes: LikeRow[] = [
      {
        id: 'like_seed_1',
        actor_id: 'usr_amaya',
        target_id: 'usr_kavan',
        action: 'like',
        created_at: now,
      },
      {
        id: 'like_seed_2',
        actor_id: 'usr_kavan',
        target_id: 'usr_amaya',
        action: 'like',
        created_at: now,
      },
    ];

    const dating_matches: DatingMatchRow[] = [
      {
        id: 'mtc_amaya_kavan',
        user_a_id: 'usr_amaya',
        user_b_id: 'usr_kavan',
        status: 'active',
        created_at: now,
      },
    ];

    const conversations: ConversationRow[] = [
      {
        id: 'cnv_amaya_kavan',
        match_id: 'mtc_amaya_kavan',
        last_message_at: now,
        created_at: now,
      },
    ];

    const messages: MessageRow[] = [
      {
        id: 'msg_seed_1',
        conversation_id: 'cnv_amaya_kavan',
        sender_id: 'usr_kavan',
        body: 'Saw that you spend half your week in Galle Fort—have you visited the new textile archive near Church Street?',
        read_at: now,
        created_at: new Date(Date.now() - 3600 * 1000).toISOString(),
      },
      {
        id: 'msg_seed_2',
        conversation_id: 'cnv_amaya_kavan',
        sender_id: 'usr_amaya',
        body: 'Yes! I helped catalogue two of the handloom pieces last month. We should meet for evening tea at Pedlar Street next time you are down south.',
        read_at: null,
        created_at: now,
      },
    ];

    const memberships: MembershipRow[] = [
      {
        id: 'mem_admin',
        user_id: 'usr_admin_lk',
        plan_name: 'Once Upon a Time Membership',
        price_lkr: 500,
        status: 'active',
        starts_at: now,
        expires_at: thirtyDaysLater,
        last_payment_id: 'pay_seed_admin',
        updated_at: now,
      },
      {
        id: 'mem_amaya',
        user_id: 'usr_amaya',
        plan_name: 'Once Upon a Time Membership',
        price_lkr: 500,
        status: 'active',
        starts_at: now,
        expires_at: thirtyDaysLater,
        last_payment_id: 'pay_seed_amaya',
        updated_at: now,
      },
      {
        id: 'mem_kavan',
        user_id: 'usr_kavan',
        plan_name: 'Once Upon a Time Membership',
        price_lkr: 500,
        status: 'active',
        starts_at: now,
        expires_at: thirtyDaysLater,
        last_payment_id: 'pay_seed_kavan',
        updated_at: now,
      },
    ];

    const payments: PaymentRow[] = [
      {
        id: 'pay_seed_amaya',
        order_id: 'OUAT-LK-2026-0001',
        user_id: 'usr_amaya',
        amount_lkr: 500,
        currency: 'LKR',
        gateway: 'payhere_sandbox',
        gateway_payment_id: 'PH-SBX-884120',
        status: 'completed',
        idempotency_key: 'idem_seed_amaya_0001',
        signature_verified: true,
        raw_notification_summary: 'Verified PayHere Sandbox LKR 500.00 status_code=2',
        created_at: now,
        verified_at: now,
      },
    ];

    return {
      users,
      profiles,
      user_sessions: [],
      interests: INITIAL_INTERESTS,
      user_interests,
      likes,
      dating_matches,
      conversations,
      messages,
      memberships,
      payments,
      reports: [],
      blocks: [],
      moderation_actions: [],
      audit_logs: [
        {
          id: 'aud_init_1',
          actor_user_id: 'usr_admin_lk',
          event_type: 'database.initialized',
          entity_type: 'system',
          entity_id: '0001_initial_schema',
          metadata_json: JSON.stringify({ tables: 15, market: 'LK', currency: 'LKR' }),
          ip_address: '127.0.0.1',
          created_at: now,
        },
      ],
    };
  }
}

export const db = new NormalizedDatabase();
