export type LanguageCode = 'en' | 'si' | 'ta';

export type DatingIntention =
  | 'long_term_story'
  | 'meaningful_dating'
  | 'new_conversations'
  | 'friendship_first';

export interface InterestItem {
  id: string;
  slug: string;
  label_en: string;
  label_si: string;
  label_ta: string;
  category: string;
}

export interface UserProfileData {
  avatarUrl: string;
  bio: string;
  region: string;
  showRegion: boolean;
  datingIntention: DatingIntention;
  spokenLanguages: string[];
  discoverable: boolean;
  allowRandomVideo: boolean;
  allowRandomText: boolean;
}

export interface MembershipSummary {
  planName: string;
  priceLkr: number;
  status: 'inactive' | 'active' | 'expired';
  startsAt: string | null;
  expiresAt: string | null;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  displayName: string;
  age: number;
  emailVerified: boolean;
  emailVerificationTokenHint: string | null;
  role: 'member' | 'moderator' | 'admin';
  accountStatus: 'active' | 'suspended' | 'banned' | 'deleted';
  onboardingCompleted: boolean;
  preferredLanguage: LanguageCode;
  createdAt: string;
  profile: UserProfileData | null;
  interests: InterestItem[];
  membership: MembershipSummary;
  counts: {
    activeMatches: number;
    unreadMessages: number;
  };
}

export interface DiscoverProfileCard {
  userId: string;
  displayName: string;
  age: number;
  region: string;
  bio: string;
  avatarUrl: string;
  datingIntention: DatingIntention;
  spokenLanguages: string[];
  interests: InterestItem[];
  allowRandomVideo: boolean;
  allowRandomText: boolean;
  sharedInterestsCount?: number;
  likedMeHint?: boolean;
}

export interface MatchSummaryItem {
  matchId: string;
  conversationId: string;
  matchedAt: string;
  partner: DiscoverProfileCard;
  lastMessage: {
    id: string;
    conversation_id: string;
    sender_id: string;
    body: string;
    read_at: string | null;
    created_at: string;
  } | null;
  unreadCount: number;
}

export interface DirectMessageItem {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  read_at: string | null;
  created_at: string;
}

export interface PaymentRecord {
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
}

export type PublicRoute =
  | 'landing'
  | 'login'
  | 'register'
  | 'forgot-password'
  | 'reset-password'
  | 'verify-email'
  | 'onboarding';

export type DashboardTab =
  | 'home'
  | 'discover'
  | 'random-chat'
  | 'matches'
  | 'messages'
  | 'membership'
  | 'profile'
  | 'settings'
  | 'admin';
