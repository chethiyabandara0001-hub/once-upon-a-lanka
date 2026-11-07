export type LanguageCode = 'en' | 'si' | 'ta';

export type GenderType = 'male' | 'female' | 'non_binary' | 'prefer_not_to_say';

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

export interface AuthenticatedUser {
  id: string;
  userId: string;
  name: string;
  displayName: string;
  email: string;
  dateOfBirth: string;
  gender: GenderType;
  nicNumber: string;
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
  counts: {
    activeMatches: number;
    unreadMessages: number;
  };
}

export interface DiscoverProfileCard {
  userId: string;
  displayName: string;
  age: number;
  gender?: GenderType;
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
  | 'profile'
  | 'settings'
  | 'admin';
