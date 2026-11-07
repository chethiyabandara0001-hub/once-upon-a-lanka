import React, { useEffect, useState } from 'react';
import {
  Compass,
  Video,
  Heart,
  MessageSquare,
  User as UserIcon,
  Settings as SettingsIcon,
  ShieldAlert,
  LogOut,
  X,
  Send,
  Sparkles,
  Trash2,
  RefreshCw,
} from 'lucide-react';
import type {
  AuthenticatedUser,
  DashboardTab,
  DatingIntention,
  DirectMessageItem,
  DiscoverProfileCard,
  GenderType,
  InterestItem,
  LanguageCode,
  MatchSummaryItem,
} from '../types';
import {
  EDITORIAL_PORTRAIT_PRESETS,
  INTENTION_LABELS,
  getInterestLabel,
} from '../i18n';
import { apiRequest, setStoredToken } from '../api';
import { EditorialImage } from './EditorialImage';
import { RandomChatStudio } from './RandomChatStudio';

interface DashboardShellProps {
  user: AuthenticatedUser;
  interestsCatalog: InterestItem[];
  language: LanguageCode;
  onLanguageChange: (lang: LanguageCode) => void;
  onUserUpdate: (user: AuthenticatedUser) => void;
  onLogout: () => void;
  onVerifyEmailRoute: () => void;
}

export const DashboardShell: React.FC<DashboardShellProps> = ({
  user,
  interestsCatalog,
  language,
  onUserUpdate,
  onLogout,
  onVerifyEmailRoute,
}) => {
  const [activeTab, setActiveTab] = useState<DashboardTab>('home');

  const [discoverProfiles, setDiscoverProfiles] = useState<DiscoverProfileCard[]>([]);
  const [intentionFilter, setIntentionFilter] = useState<string>('all');
  const [interestFilter, setInterestFilter] = useState<string>('all');
  const [selectedProfileModal, setSelectedProfileModal] =
    useState<DiscoverProfileCard | null>(null);
  const [celebrationMatch, setCelebrationMatch] = useState<{
    partner: DiscoverProfileCard;
    conversationId: string;
  } | null>(null);

  const [matches, setMatches] = useState<MatchSummaryItem[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [conversationMessages, setConversationMessages] = useState<DirectMessageItem[]>([]);
  const [conversationPartner, setConversationPartner] =
    useState<DiscoverProfileCard | null>(null);
  const [dmInput, setDmInput] = useState('');
  const [dmError, setDmError] = useState<string | null>(null);

  const [editName, setEditName] = useState(user.name || user.displayName);
  const [editDisplayName, setEditDisplayName] = useState(user.displayName);
  const [editDateOfBirth, setEditDateOfBirth] = useState(user.dateOfBirth || '1999-05-15');
  const [editGender, setEditGender] = useState<GenderType>(user.gender || 'prefer_not_to_say');
  const [editAvatarUrl] = useState(
    user.profile?.avatarUrl || EDITORIAL_PORTRAIT_PRESETS[0].url
  );
  const [editBio, setEditBio] = useState(user.profile?.bio || '');
  const [editRegion, setEditRegion] = useState(user.profile?.region || '');
  const [editShowRegion, setEditShowRegion] = useState(user.profile?.showRegion ?? true);
  const [editIntention] = useState<DatingIntention>(
    user.profile?.datingIntention || 'long_term_story'
  );
  const [editLanguages] = useState<string[]>(
    user.profile?.spokenLanguages || ['English']
  );
  const [editInterestIds, setEditInterestIds] = useState<string[]>(
    user.interests.map((i) => i.id)
  );
  const [editDiscoverable, setEditDiscoverable] = useState(
    user.profile?.discoverable ?? true
  );
  const [editAllowVideo] = useState(user.profile?.allowRandomVideo ?? true);
  const [editAllowText] = useState(user.profile?.allowRandomText ?? true);
  const [profileSavedToast, setProfileSavedToast] = useState<string | null>(null);
  const [blockedUsers, setBlockedUsers] = useState<
    Array<{ id: string; blockedUserId: string; blockedDisplayName: string; createdAt: string }>
  >([]);

  const [reportTarget, setReportTarget] = useState<{
    userId: string;
    name: string;
    contextType: 'profile' | 'direct_message';
  } | null>(null);
  const [reportReason, setReportReason] = useState('harassment_or_abuse');
  const [reportDetails, setReportDetails] = useState('');

  const [adminData, setAdminData] = useState<{
    analytics: {
      totalUsers: number;
      activeMatches: number;
      openReports: number;
    };
    users: Array<{
      id: string;
      email: string;
      displayName: string;
      role: string;
      accountStatus: string;
      reportsAgainstCount: number;
    }>;
    reports: Array<{
      id: string;
      reporterName: string;
      reported_user_id: string;
      reportedName: string;
      reportedStatus: string;
      context_type: string;
      reason: string;
      details: string;
      status: string;
      priority: string;
      created_at: string;
    }>;
    auditLogs: Array<{
      id: string;
      event_type: string;
      entity_type: string;
      entity_id: string | null;
      created_at: string;
    }>;
  } | null>(null);

  const refreshMe = async () => {
    try {
      const res = await apiRequest<{ user: AuthenticatedUser }>('/auth/me');
      onUserUpdate(res.user);
    } catch {
      // Ignore
    }
  };

  const fetchDiscover = async () => {
    try {
      const res = await apiRequest<{ profiles: DiscoverProfileCard[] }>(
        `/discover?intention=${encodeURIComponent(
          intentionFilter
        )}&interestId=${encodeURIComponent(interestFilter)}`
      );
      setDiscoverProfiles(res.profiles);
    } catch {
      // Ignore
    }
  };

  const fetchMatches = async () => {
    try {
      const res = await apiRequest<{ matches: MatchSummaryItem[] }>('/matches');
      setMatches(res.matches);
      if (!activeConversationId && res.matches.length > 0) {
        setActiveConversationId(res.matches[0].conversationId);
      }
    } catch {
      // Ignore
    }
  };

  const fetchConversationMessages = async (convId: string) => {
    try {
      const res = await apiRequest<{
        messages: DirectMessageItem[];
        partner: DiscoverProfileCard;
      }>(`/conversations/${convId}/messages`);
      setConversationMessages(res.messages);
      setConversationPartner(res.partner);
    } catch {
      // Ignore
    }
  };

  const fetchBlocks = async () => {
    try {
      const res = await apiRequest<{
        blocks: Array<{
          id: string;
          blockedUserId: string;
          blockedDisplayName: string;
          createdAt: string;
        }>;
      }>('/safety/blocks');
      setBlockedUsers(res.blocks);
    } catch {
      // Ignore
    }
  };

  const fetchAdminOverview = async () => {
    if (user.role !== 'admin') return;
    try {
      const res = await apiRequest<typeof adminData>('/admin/overview');
      setAdminData(res);
    } catch {
      // Ignore
    }
  };

  useEffect(() => {
    fetchDiscover();
    fetchMatches();
  }, [intentionFilter, interestFilter]);

  useEffect(() => {
    if (activeTab === 'messages' && activeConversationId) {
      fetchConversationMessages(activeConversationId);
    }
    if (activeTab === 'settings') {
      fetchBlocks();
    }
    if (activeTab === 'admin' && user.role === 'admin') {
      fetchAdminOverview();
    }
  }, [activeTab, activeConversationId]);

  const handleDiscoverAction = async (targetUserId: string, action: 'like' | 'pass') => {
    try {
      const res = await apiRequest<{
        matched: boolean;
        conversationId: string | null;
        partnerProfile: DiscoverProfileCard | null;
      }>('/discover/action', {
        method: 'POST',
        body: JSON.stringify({ targetUserId, action }),
      });

      setDiscoverProfiles((prev) => prev.filter((p) => p.userId !== targetUserId));
      setSelectedProfileModal(null);

      if (res.matched && res.partnerProfile && res.conversationId) {
        setCelebrationMatch({
          partner: res.partnerProfile,
          conversationId: res.conversationId,
        });
        await fetchMatches();
        await refreshMe();
      }
    } catch {
      // Ignore
    }
  };

  const handleResetPasses = async () => {
    await apiRequest('/discover/reset-passes', { method: 'POST' });
    await fetchDiscover();
  };

  const handleSendDirectMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = dmInput.trim();
    if (!clean || !activeConversationId) return;
    setDmError(null);

    try {
      const res = await apiRequest<{ message: DirectMessageItem }>(
        `/conversations/${activeConversationId}/messages`,
        {
          method: 'POST',
          body: JSON.stringify({ body: clean }),
        }
      );
      setConversationMessages((prev) => [...prev, res.message]);
      setDmInput('');
      fetchMatches();
    } catch (err) {
      setDmError((err as Error).message);
    }
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setProfileSavedToast(null);
    try {
      const res = await apiRequest<{ user: AuthenticatedUser }>('/profile', {
        method: 'PUT',
        body: JSON.stringify({
          name: editName,
          displayName: editDisplayName,
          dateOfBirth: editDateOfBirth,
          gender: editGender,
          avatarUrl: editAvatarUrl,
          bio: editBio,
          region: editRegion,
          showRegion: editShowRegion,
          datingIntention: editIntention,
          spokenLanguages: editLanguages,
          interestIds: editInterestIds,
          discoverable: editDiscoverable,
          allowRandomVideo: editAllowVideo,
          allowRandomText: editAllowText,
        }),
      });
      onUserUpdate(res.user);
      setProfileSavedToast('Profile and account details saved to Firebase.');
    } catch (err) {
      setProfileSavedToast((err as Error).message);
    }
  };

  const handleBlockUser = async (targetUserId: string) => {
    await apiRequest('/safety/block', {
      method: 'POST',
      body: JSON.stringify({ targetUserId, reason: 'Blocked from profile/conversation' }),
    });
    setSelectedProfileModal(null);
    await fetchDiscover();
    await fetchMatches();
    await fetchBlocks();
  };

  const handleUnblockUser = async (blockedUserId: string) => {
    await apiRequest(`/safety/blocks/${blockedUserId}`, { method: 'DELETE' });
    await fetchBlocks();
    await fetchDiscover();
  };

  const handleSubmitSafetyReport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reportTarget) return;
    await apiRequest('/safety/report', {
      method: 'POST',
      body: JSON.stringify({
        reportedUserId: reportTarget.userId,
        contextType: reportTarget.contextType,
        reason: reportReason,
        details: reportDetails,
      }),
    });
    setReportTarget(null);
    setReportDetails('');
  };

  const handleAdminModeration = async (
    targetUserId: string,
    actionType: string,
    reportId?: string
  ) => {
    await apiRequest('/admin/moderate', {
      method: 'POST',
      body: JSON.stringify({
        targetUserId,
        reportId,
        actionType,
        reason: `Admin moderation action: ${actionType}`,
      }),
    });
    await fetchAdminOverview();
  };

  const handleDeleteAccount = async () => {
    await apiRequest('/account', { method: 'DELETE' });
    setStoredToken(null);
    onLogout();
  };

  const navItems: Array<{ id: DashboardTab; label: string; icon: React.ReactNode }> = [
    { id: 'home', label: 'Home', icon: <Sparkles className="w-4 h-4" /> },
    { id: 'random-chat', label: 'Video & Text', icon: <Video className="w-4 h-4" /> },
    { id: 'messages', label: 'Messages', icon: <MessageSquare className="w-4 h-4" /> },
    { id: 'settings', label: 'Settings', icon: <SettingsIcon className="w-4 h-4" /> },
  ];

  if (user.role === 'admin') {
    navItems.push({
      id: 'admin',
      label: 'Admin',
      icon: <ShieldAlert className="w-4 h-4" />,
    });
  }

  return (
    <div className="min-h-screen bg-[#f5f6f2] text-[#14201b] flex flex-col">
      {/* DARK FOREST HEADER (#101417 matching HAMU reference UI) */}
      <header className="sticky top-0 z-30 bg-[#101417] text-white shadow-md">
        <div className="max-w-[1380px] mx-auto px-6 h-20 flex items-center justify-between gap-6">
          <button
            type="button"
            onClick={() => setActiveTab('home')}
            className="font-outfit text-2xl font-black tracking-[-0.06em] flex items-center gap-2.5 whitespace-nowrap shrink-0 text-white"
          >
            <span className="brand-leaf">✦</span>
            <span>
              once upon a time<span className="text-[#c5fa5a]">.</span>
            </span>
          </button>

          <nav className="hidden xl:flex items-center gap-1.5">
            {navItems.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`px-4 py-2 rounded-full text-xs font-extrabold inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 ${
                  activeTab === item.id
                    ? 'bg-[#c5fa5a] text-[#14201b]'
                    : 'text-[#e4e8e5] hover:text-[#c5fa5a]'
                }`}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
          </nav>

          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={onLogout}
              className="px-4 py-2 rounded-full border border-white/35 text-xs font-bold text-white hover:border-[#c5fa5a] inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Log out</span>
            </button>
          </div>
        </div>

        <div className="xl:hidden border-t border-white/10 px-4 py-2.5 flex items-center gap-1.5 overflow-x-auto">
          {navItems.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveTab(item.id)}
              className={`px-3.5 py-1.5 rounded-full text-xs font-extrabold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 ${
                activeTab === item.id
                  ? 'bg-[#c5fa5a] text-[#14201b]'
                  : 'bg-white/10 text-white'
              }`}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      </header>

      <main className="flex-1 max-w-[1320px] w-full mx-auto px-6 py-10">
        {!user.emailVerified && (
          <div className="mb-8 p-4 rounded-2xl bg-[#dff4b3] border border-[#c5fa5a] flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="text-xs text-[#14201b]">
              <span className="font-extrabold">Verify your email address: </span>
              <span>Confirm {user.email} to complete your account verification.</span>
            </div>
            <button
              type="button"
              onClick={onVerifyEmailRoute}
              className="px-4 py-2 bg-[#17221c] text-[#c5fa5a] font-extrabold text-xs rounded-xl whitespace-nowrap shrink-0"
            >
              Enter Verification Code ↗
            </button>
          </div>
        )}

        {/* TAB 1: HOME OVERVIEW */}
        {activeTab === 'home' && (
          <div className="space-y-10">
            <div className="p-8 md:p-10 rounded-[26px] bg-[#101417] text-white flex flex-col justify-between shadow-lg">
              <div className="space-y-3">
                <span className="inline-block bg-[#c5fa5a] text-[#14201b] text-xs font-black px-3.5 py-1 rounded-full">
                  ✦ {user.profile?.region || 'SRI LANKA'} · 18+ VERIFIED
                </span>
                <h1 className="font-outfit font-black text-3xl md:text-5xl text-white">
                  Hello, {user.displayName}.
                </h1>
                <p className="text-sm text-[#bac3be] max-w-xl leading-relaxed">
                  Ready for your next conversation? Start a spontaneous one-on-one video or text
                  chat, or browse profiles that share your interests.
                </p>
              </div>

              <div className="pt-8 mt-8 border-t border-white/15 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => setActiveTab('random-chat')}
                  className="px-6 py-3.5 bg-[#c5fa5a] hover:bg-[#d2ff75] text-[#14201b] font-black text-xs rounded-[15px]"
                >
                  ◉ &nbsp; Start video or text chat ↗
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('messages')}
                  className="px-6 py-3.5 bg-white/10 hover:bg-white/15 border border-white/30 text-white font-extrabold text-xs rounded-[15px]"
                >
                  View Messages ({matches.length})
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="p-7 rounded-[24px] bg-white border border-[#e7ebe5] space-y-4 flex flex-col justify-between">
                <div>
                  <div className="w-12 h-12 rounded-2xl bg-[#dff4b3] text-[#14201b] grid place-items-center text-xl font-black mb-4">
                    ◉
                  </div>
                  <h2 className="font-outfit font-extrabold text-2xl text-[#14201b]">
                    Live Video & Text Chat
                  </h2>
                  <p className="text-xs text-[#6d7a72] mt-1 leading-relaxed">
                    Instantly pair 1-on-1 with verified members across Sri Lanka. Complete control over your camera and microphone with one-click skip and report.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setActiveTab('random-chat')}
                  className="w-full py-3.5 bg-[#c5fa5a] hover:bg-[#b8f244] text-[#14201b] font-black text-xs rounded-xl"
                >
                  Launch Chat Studio ↗
                </button>
              </div>

              <div className="p-7 rounded-[24px] bg-white border border-[#e7ebe5] space-y-4 flex flex-col justify-between">
                <div>
                  <div className="w-12 h-12 rounded-2xl bg-[#f0f7e3] text-[#14201b] grid place-items-center text-xl font-black mb-4">
                    ✉
                  </div>
                  <h2 className="font-outfit font-extrabold text-2xl text-[#14201b]">
                    Messages & Conversations
                  </h2>
                  <p className="text-xs text-[#6d7a72] mt-1 leading-relaxed">
                    Stay in touch with people you have connected with safely through private direct messaging.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setActiveTab('messages')}
                  className="w-full py-3.5 bg-[#17221c] hover:bg-[#25362c] text-white font-extrabold text-xs rounded-xl"
                >
                  Open Messages ↗
                </button>
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: DATING DISCOVERY */}
        {activeTab === 'discover' && (
          <div className="space-y-8">
            <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-6">
              <div>
                <p className="text-xs font-black text-[#557d27] uppercase tracking-wider">
                  SHARED INTERESTS & MUTUAL LIKES
                </p>
                <h1 className="font-outfit font-extrabold text-3xl md:text-4xl text-[#14201b] mt-1">
                  Discover People Across Sri Lanka
                </h1>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <select
                  value={intentionFilter}
                  onChange={(e) => setIntentionFilter(e.target.value)}
                  className="bg-white border border-[#d7ded5] rounded-xl px-3.5 py-2.5 text-xs font-bold text-[#14201b]"
                >
                  <option value="all">All Intentions</option>
                  <option value="long_term_story">Long-term story</option>
                  <option value="meaningful_dating">Meaningful dating</option>
                  <option value="new_conversations">New conversations</option>
                  <option value="friendship_first">Friendship first</option>
                </select>

                <select
                  value={interestFilter}
                  onChange={(e) => setInterestFilter(e.target.value)}
                  className="bg-white border border-[#d7ded5] rounded-xl px-3.5 py-2.5 text-xs font-bold text-[#14201b]"
                >
                  <option value="all">All Interests</option>
                  {interestsCatalog.map((item) => (
                    <option key={item.id} value={item.id}>
                      {getInterestLabel(item, language)}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {discoverProfiles.length === 0 ? (
              <div className="p-12 rounded-[26px] bg-white border border-[#e7ebe5] text-center space-y-4 max-w-xl mx-auto">
                <h2 className="font-outfit font-extrabold text-3xl text-[#14201b]">
                  No registered profiles found.
                </h2>
                <p className="text-xs text-[#6d7a72]">
                  New members will appear here as they register with their Sri Lankan NIC and enable public discovery.
                </p>
                <div className="flex items-center justify-center gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => {
                      setIntentionFilter('all');
                      setInterestFilter('all');
                    }}
                    className="px-4 py-2.5 rounded-xl bg-[#f5f6f2] text-xs font-bold text-[#14201b]"
                  >
                    Reset Filters
                  </button>
                  <button
                    type="button"
                    onClick={handleResetPasses}
                    className="px-5 py-2.5 rounded-xl bg-[#c5fa5a] text-[#14201b] font-black text-xs inline-flex items-center gap-1.5"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>Revisit Passed Profiles</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {discoverProfiles.map((prof) => (
                  <div
                    key={prof.userId}
                    className="rounded-[24px] overflow-hidden bg-white border border-[#e7ebe5] shadow-[0_12px_30px_rgba(20,32,27,0.05)] flex flex-col justify-between"
                  >
                    <div className="relative aspect-[3/4]">
                      <EditorialImage
                        src={prof.avatarUrl}
                        alt={prof.displayName}
                        aspectClassName="w-full h-full"
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/15 to-transparent" />
                      <div className="absolute bottom-4 left-5 right-5 text-white">
                        <h3 className="font-outfit font-extrabold text-3xl">
                          {prof.displayName}, {prof.age}
                        </h3>
                        <p className="text-xs text-white/85 font-medium mt-0.5">
                          {prof.region || 'Sri Lanka'} ·{' '}
                          {INTENTION_LABELS[prof.datingIntention]} ·{' '}
                          {prof.spokenLanguages.join(' / ')}
                        </p>
                      </div>
                    </div>

                    <div className="p-5 space-y-4 flex-1 flex flex-col justify-between">
                      <div className="space-y-2.5">
                        <p className="text-xs text-[#14201b] leading-relaxed line-clamp-3">
                          {prof.bio || 'Looking for great conversations and new connections.'}
                        </p>
                        <p className="text-xs font-bold text-[#557d27]">
                          {prof.interests.map((i) => getInterestLabel(i, language)).join(' · ')}
                        </p>
                      </div>

                      <div className="pt-4 border-t border-[#e7ebe5] flex items-center justify-between gap-2">
                        <button
                          type="button"
                          onClick={() => handleDiscoverAction(prof.userId, 'pass')}
                          className="px-4 py-2.5 rounded-xl bg-[#f5f6f2] hover:bg-[#e9eee5] text-xs font-extrabold text-[#14201b] inline-flex items-center gap-1"
                        >
                          <X className="w-3.5 h-3.5" />
                          <span>Pass</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => setSelectedProfileModal(prof)}
                          className="px-3 py-2 text-xs font-bold text-[#6d7a72] hover:text-[#14201b]"
                        >
                          Details
                        </button>

                        <button
                          type="button"
                          onClick={() => handleDiscoverAction(prof.userId, 'like')}
                          className="px-5 py-2.5 rounded-xl bg-[#c5fa5a] hover:bg-[#b8f244] text-[#14201b] font-black text-xs inline-flex items-center gap-1.5"
                        >
                          <Heart className="w-3.5 h-3.5" />
                          <span>Like ↗</span>
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* TAB 3: RANDOM CHAT STUDIO */}
        {activeTab === 'random-chat' && <RandomChatStudio user={user} />}

        {/* TAB 4: MATCHES */}
        {activeTab === 'matches' && (
          <div className="space-y-6">
            <div>
              <p className="text-xs font-black text-[#557d27] uppercase tracking-wider">
                MUTUAL CONNECTIONS
              </p>
              <h1 className="font-outfit font-extrabold text-3xl text-[#14201b] mt-1">
                Your Mutual Matches ({matches.length})
              </h1>
            </div>

            {matches.length === 0 ? (
              <div className="p-12 rounded-[26px] bg-white border border-[#e7ebe5] text-center space-y-4 max-w-lg mx-auto">
                <p className="font-outfit font-extrabold text-2xl text-[#14201b]">
                  No mutual matches yet.
                </p>
                <button
                  type="button"
                  onClick={() => setActiveTab('discover')}
                  className="px-6 py-3 bg-[#c5fa5a] text-[#14201b] font-black text-xs rounded-xl"
                >
                  Browse Profiles ↗
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
                {matches.map((m) => (
                  <div
                    key={m.matchId}
                    className="p-5 rounded-[24px] bg-white border border-[#e7ebe5] space-y-4 flex flex-col justify-between"
                  >
                    <div className="flex items-center gap-4">
                      <div className="w-16 h-20 rounded-2xl overflow-hidden shrink-0">
                        <EditorialImage
                          src={m.partner.avatarUrl}
                          alt={m.partner.displayName}
                          aspectClassName="w-full h-full"
                        />
                      </div>
                      <div>
                        <h3 className="font-outfit font-extrabold text-2xl text-[#14201b]">
                          {m.partner.displayName}, {m.partner.age}
                        </h3>
                        <p className="text-xs text-[#6d7a72]">
                          {m.partner.region || 'Sri Lanka'} ·{' '}
                          {INTENTION_LABELS[m.partner.datingIntention]}
                        </p>
                      </div>
                    </div>

                    <p className="text-xs text-[#6d7a72] line-clamp-2">{m.partner.bio}</p>

                    <div className="pt-3 border-t border-[#e7ebe5] flex items-center justify-between">
                      <button
                        type="button"
                        onClick={() => handleBlockUser(m.partner.userId)}
                        className="text-xs font-bold text-[#6d7a72] hover:text-red-600"
                      >
                        Block
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setActiveConversationId(m.conversationId);
                          setActiveTab('messages');
                        }}
                        className="px-4 py-2 bg-[#c5fa5a] text-[#14201b] font-black text-xs rounded-xl"
                      >
                        Message ↗
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* TAB 5: MESSAGES */}
        {activeTab === 'messages' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 rounded-[26px] overflow-hidden border border-[#e7ebe5] bg-white shadow-sm min-h-[540px]">
            <div className="lg:col-span-4 border-b lg:border-b-0 lg:border-r border-[#e7ebe5] bg-[#f5f6f2]">
              <div className="p-4 border-b border-[#e7ebe5]">
                <h2 className="font-outfit font-extrabold text-2xl text-[#14201b]">Messages</h2>
                <p className="text-[11px] text-[#6d7a72]">Mutual matches only</p>
              </div>

              {matches.length === 0 ? (
                <div className="p-6 text-xs text-[#6d7a72]">No matched conversations yet.</div>
              ) : (
                <div className="divide-y divide-[#e7ebe5]">
                  {matches.map((m) => (
                    <button
                      key={m.conversationId}
                      type="button"
                      onClick={() => setActiveConversationId(m.conversationId)}
                      className={`w-full p-4 text-left flex items-center gap-3 transition-colors ${
                        activeConversationId === m.conversationId
                          ? 'bg-[#dff4b3]'
                          : 'hover:bg-white'
                      }`}
                    >
                      <div className="w-11 h-11 rounded-full overflow-hidden shrink-0">
                        <EditorialImage
                          src={m.partner.avatarUrl}
                          alt={m.partner.displayName}
                          aspectClassName="w-full h-full"
                        />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-extrabold text-[#14201b] truncate">
                          {m.partner.displayName}, {m.partner.age}
                        </p>
                        <p className="text-[11px] text-[#6d7a72] truncate mt-0.5">
                          {m.lastMessage ? m.lastMessage.body : 'Say hello...'}
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="lg:col-span-8 flex flex-col justify-between h-[540px]">
              {conversationPartner ? (
                <>
                  <div className="p-4 border-b border-[#e7ebe5] flex items-center justify-between">
                    <div>
                      <p className="text-sm font-extrabold text-[#14201b]">
                        {conversationPartner.displayName}, {conversationPartner.age}
                      </p>
                      <p className="text-[11px] text-[#6d7a72]">
                        {conversationPartner.region || 'Sri Lanka'}
                      </p>
                    </div>
                    <div className="flex items-center gap-3 text-xs font-bold">
                      <button
                        type="button"
                        onClick={() =>
                          setReportTarget({
                            userId: conversationPartner.userId,
                            name: conversationPartner.displayName,
                            contextType: 'direct_message',
                          })
                        }
                        className="text-[#6d7a72] hover:text-[#14201b]"
                      >
                        Report
                      </button>
                      <button
                        type="button"
                        onClick={() => handleBlockUser(conversationPartner.userId)}
                        className="text-[#6d7a72] hover:text-red-600"
                      >
                        Block
                      </button>
                    </div>
                  </div>

                  <div className="flex-1 p-5 overflow-y-auto space-y-3 bg-[#f5f6f2]/50">
                    {conversationMessages.map((msg) => {
                      const isMe = msg.sender_id === user.id;
                      return (
                        <div
                          key={msg.id}
                          className={`flex flex-col ${isMe ? 'items-end' : 'items-start'}`}
                        >
                          <div
                            className={`max-w-[78%] rounded-2xl px-4 py-2.5 text-xs leading-relaxed ${
                              isMe
                                ? 'bg-[#17221c] text-[#c5fa5a] font-bold'
                                : 'bg-white text-[#14201b] border border-[#e7ebe5]'
                            }`}
                          >
                            {msg.body}
                          </div>
                          <span className="text-[10px] text-[#6d7a72] mt-1 tabular-nums">
                            {new Date(msg.created_at).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  {dmError && (
                    <div className="px-4 py-2 bg-red-50 text-xs text-red-900 font-bold">
                      <span>{dmError}</span>
                    </div>
                  )}

                  <form
                    onSubmit={handleSendDirectMessage}
                    className="p-3.5 border-t border-[#e7ebe5] flex items-center gap-2 bg-white"
                  >
                    <input
                      type="text"
                      value={dmInput}
                      onChange={(e) => setDmInput(e.target.value)}
                      placeholder={`Message ${conversationPartner.displayName}...`}
                      className="flex-1 bg-[#f5f6f2] border border-[#d7ded5] rounded-xl px-3.5 py-2.5 text-xs text-[#14201b]"
                    />
                    <button
                      type="submit"
                      className="px-5 py-2.5 bg-[#c5fa5a] text-[#14201b] font-black text-xs rounded-xl inline-flex items-center gap-1.5"
                    >
                      <Send className="w-3.5 h-3.5" />
                      <span>Send</span>
                    </button>
                  </form>
                </>
              ) : (
                <div className="m-auto text-center p-8 text-xs text-[#6d7a72]">
                  Select a matched conversation on the left to chat.
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 6: PROFILE */}
        {activeTab === 'profile' && (
          <form onSubmit={handleSaveProfile} className="max-w-3xl mx-auto space-y-6">
            <div className="flex items-center justify-between">
              <h1 className="font-outfit font-extrabold text-3xl text-[#14201b]">
                Edit Your Profile
              </h1>
              <button
                type="submit"
                className="px-6 py-3 bg-[#c5fa5a] text-[#14201b] font-black text-xs rounded-xl"
              >
                Save Changes
              </button>
            </div>

            {profileSavedToast && (
              <div className="p-3.5 rounded-xl bg-[#dff4b3] text-[#14201b] text-xs font-bold">
                {profileSavedToast}
              </div>
            )}

            <div className="p-8 rounded-[25px] bg-white border border-[#e7ebe5] space-y-5">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 p-4 rounded-2xl bg-[#f5f6f2] border border-[#e7ebe5]">
                <div>
                  <span className="block text-[11px] font-extrabold text-[#6d7a72] uppercase">
                    User ID (Firebase UID)
                  </span>
                  <span className="font-mono text-xs font-bold text-[#14201b] break-all">
                    {user.userId}
                  </span>
                </div>
                <div>
                  <span className="block text-[11px] font-extrabold text-[#6d7a72] uppercase">
                    Sri Lankan NIC (Verified · 1 Account)
                  </span>
                  <span className="font-mono text-xs font-extrabold text-[#467d1c]">
                    {user.nicNumber || 'Verified'}
                  </span>
                </div>
                <div>
                  <span className="block text-[11px] font-extrabold text-[#6d7a72] uppercase">
                    Registered Email
                  </span>
                  <span className="text-xs font-bold text-[#14201b] break-all">
                    {user.email}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-extrabold mb-1.5">Full Name</label>
                  <input
                    type="text"
                    required
                    minLength={2}
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="w-full p-3.5 border border-[#d7ded5] rounded-xl text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-extrabold mb-1.5">Display Name</label>
                  <input
                    type="text"
                    required
                    minLength={2}
                    value={editDisplayName}
                    onChange={(e) => setEditDisplayName(e.target.value)}
                    className="w-full p-3.5 border border-[#d7ded5] rounded-xl text-sm"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-extrabold mb-1.5">
                    Date of Birth (18+)
                  </label>
                  <input
                    type="date"
                    required
                    value={editDateOfBirth}
                    onChange={(e) => setEditDateOfBirth(e.target.value)}
                    className="w-full p-3.5 border border-[#d7ded5] rounded-xl text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-extrabold mb-1.5">Gender</label>
                  <select
                    value={editGender}
                    onChange={(e) => setEditGender(e.target.value as GenderType)}
                    className="w-full p-3.5 border border-[#d7ded5] rounded-xl text-sm bg-white"
                  >
                    <option value="male">Male</option>
                    <option value="female">Female</option>
                    <option value="non_binary">Non-binary</option>
                    <option value="prefer_not_to_say">Prefer not to say</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-extrabold mb-1.5">General Region</label>
                  <input
                    type="text"
                    value={editRegion}
                    onChange={(e) => setEditRegion(e.target.value)}
                    className="w-full p-3.5 border border-[#d7ded5] rounded-xl text-sm"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-extrabold mb-1.5">Bio</label>
                <textarea
                  rows={3}
                  value={editBio}
                  onChange={(e) => setEditBio(e.target.value)}
                  className="w-full p-3.5 border border-[#d7ded5] rounded-xl text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-extrabold mb-2">Shared Interests</label>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {interestsCatalog.map((item) => {
                    const selected = editInterestIds.includes(item.id);
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() =>
                          setEditInterestIds((prev) =>
                            prev.includes(item.id)
                              ? prev.filter((id) => id !== item.id)
                              : [...prev, item.id].slice(0, 6)
                          )
                        }
                        className={`px-3.5 py-2.5 rounded-xl border text-xs font-bold text-left ${
                          selected
                            ? 'bg-[#17221c] text-[#c5fa5a] border-[#17221c]'
                            : 'bg-[#f5f6f2] text-[#14201b] border-[#e7ebe5]'
                        }`}
                      >
                        {getInterestLabel(item, language)}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </form>
        )}

        {/* TAB 7: SETTINGS */}
        {activeTab === 'settings' && (
          <div className="max-w-3xl mx-auto space-y-6">
            <h1 className="font-outfit font-extrabold text-3xl text-[#14201b]">
              Privacy & Safety Settings
            </h1>

            <div className="p-7 rounded-[24px] bg-white border border-[#e7ebe5] space-y-4">
              <label className="flex items-center justify-between text-xs font-bold py-2 cursor-pointer">
                <span>Show general region on my profile</span>
                <input
                  type="checkbox"
                  checked={editShowRegion}
                  onChange={(e) => setEditShowRegion(e.target.checked)}
                  className="accent-[#14201b]"
                />
              </label>
              <label className="flex items-center justify-between text-xs font-bold py-2 cursor-pointer">
                <span>Show my profile in Dating Discovery</span>
                <input
                  type="checkbox"
                  checked={editDiscoverable}
                  onChange={(e) => setEditDiscoverable(e.target.checked)}
                  className="accent-[#14201b]"
                />
              </label>
              <button
                type="button"
                onClick={handleSaveProfile}
                className="px-5 py-2.5 bg-[#c5fa5a] text-[#14201b] font-black text-xs rounded-xl"
              >
                Save Preferences
              </button>
            </div>

            <div className="p-7 rounded-[24px] bg-white border border-[#e7ebe5] space-y-4">
              <h2 className="font-outfit font-extrabold text-2xl">
                Blocked Accounts ({blockedUsers.length})
              </h2>
              {blockedUsers.length === 0 ? (
                <p className="text-xs text-[#6d7a72]">No blocked accounts.</p>
              ) : (
                <div className="space-y-2">
                  {blockedUsers.map((b) => (
                    <div
                      key={b.id}
                      className="p-3 rounded-xl bg-[#f5f6f2] flex items-center justify-between text-xs font-bold"
                    >
                      <span>{b.blockedDisplayName}</span>
                      <button
                        type="button"
                        onClick={() => handleUnblockUser(b.blockedUserId)}
                        className="text-[#467d1c] hover:underline"
                      >
                        Unblock
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="p-7 rounded-[24px] bg-white border border-red-200 space-y-3">
              <h2 className="font-outfit font-extrabold text-2xl text-red-700">
                Delete Account
              </h2>
              <p className="text-xs text-[#6d7a72]">
                Permanently delete your account, profile, sessions, and messages.
              </p>
              <button
                type="button"
                onClick={handleDeleteAccount}
                className="px-4 py-2.5 bg-red-600 text-white text-xs font-bold rounded-xl inline-flex items-center gap-1.5"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Delete My Account</span>
              </button>
            </div>
          </div>
        )}

        {/* TAB 8: ADMIN CONSOLE */}
        {activeTab === 'admin' && user.role === 'admin' && adminData && (
          <div className="space-y-8">
            <div>
              <p className="text-xs font-black text-[#557d27] uppercase tracking-wider">
                TRUST & SAFETY ADMINISTRATION
              </p>
              <h1 className="font-outfit font-extrabold text-3xl md:text-4xl text-[#14201b] mt-1">
                Moderation & Operations Console
              </h1>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {[
                { label: 'Total Accounts', value: adminData.analytics.totalUsers },
                { label: 'Mutual Matches', value: adminData.analytics.activeMatches },
                { label: 'Open Reports', value: adminData.analytics.openReports },
              ].map((stat) => (
                <div
                  key={stat.label}
                  className="p-5 rounded-[20px] bg-white border border-[#e7ebe5]"
                >
                  <p className="text-[11px] font-bold text-[#6d7a72]">{stat.label}</p>
                  <p className="font-outfit font-black text-2xl text-[#14201b] mt-1 tabular-nums">
                    {stat.value}
                  </p>
                </div>
              ))}
            </div>

            <div className="p-7 rounded-[24px] bg-white border border-[#e7ebe5] space-y-4">
              <h2 className="font-outfit font-extrabold text-2xl">
                Safety Reports ({adminData.reports.length})
              </h2>
              {adminData.reports.length === 0 ? (
                <p className="text-xs text-[#6d7a72]">No open safety reports.</p>
              ) : (
                <div className="space-y-3">
                  {adminData.reports.map((rep) => (
                    <div
                      key={rep.id}
                      className="p-4 rounded-xl bg-[#f5f6f2] flex flex-col md:flex-row md:items-center justify-between gap-4 text-xs"
                    >
                      <div>
                        <p className="font-extrabold">
                          Reported: {rep.reportedName} ({rep.reportedStatus}) · {rep.reason}
                        </p>
                        <p className="text-[#6d7a72]">
                          Context: {rep.context_type} · Priority: {rep.priority}
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            handleAdminModeration(rep.reported_user_id, 'suspend_7d', rep.id)
                          }
                          className="px-3 py-1.5 rounded-lg bg-[#dff4b3] text-[#14201b] font-bold"
                        >
                          Suspend 7d
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            handleAdminModeration(rep.reported_user_id, 'ban_permanent', rep.id)
                          }
                          className="px-3 py-1.5 rounded-lg bg-red-600 text-white font-bold"
                        >
                          Ban
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {/* Profile Modal */}
      {selectedProfileModal && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4">
          <div className="max-w-lg w-full rounded-[25px] bg-white text-[#14201b] overflow-hidden shadow-2xl">
            <div className="aspect-[16/10] relative">
              <EditorialImage
                src={selectedProfileModal.avatarUrl}
                alt={selectedProfileModal.displayName}
                aspectClassName="w-full h-full"
              />
            </div>
            <div className="p-7 space-y-4">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-outfit font-extrabold text-3xl">
                    {selectedProfileModal.displayName}, {selectedProfileModal.age}
                  </h3>
                  <p className="text-xs text-[#6d7a72]">
                    {selectedProfileModal.region || 'Sri Lanka'} ·{' '}
                    {INTENTION_LABELS[selectedProfileModal.datingIntention]}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedProfileModal(null)}
                  className="text-xl font-bold text-[#6d7a72]"
                >
                  ×
                </button>
              </div>
              <p className="text-xs leading-relaxed">{selectedProfileModal.bio}</p>
              <div className="pt-4 border-t border-[#e7ebe5] flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => handleBlockUser(selectedProfileModal.userId)}
                  className="text-xs font-bold text-[#6d7a72] hover:text-red-600"
                >
                  Block
                </button>
                <button
                  type="button"
                  onClick={() => handleDiscoverAction(selectedProfileModal.userId, 'like')}
                  className="px-6 py-2.5 bg-[#c5fa5a] text-[#14201b] font-black text-xs rounded-xl"
                >
                  Like Profile ↗
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Celebration Match Modal */}
      {celebrationMatch && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
          <div className="max-w-md w-full p-8 rounded-[26px] bg-[#17221c] text-white text-center space-y-5 shadow-2xl">
            <span className="brand-leaf mx-auto">✦</span>
            <h3 className="font-outfit font-extrabold text-3xl">
              It’s a Match with {celebrationMatch.partner.displayName}!
            </h3>
            <p className="text-xs text-[#b4c0b7]">
              You both liked each other. Start a private conversation now.
            </p>
            <div className="flex items-center justify-center gap-3 pt-2">
              <button
                type="button"
                onClick={() => setCelebrationMatch(null)}
                className="px-4 py-2.5 text-xs font-bold text-[#b4c0b7]"
              >
                Keep Browsing
              </button>
              <button
                type="button"
                onClick={() => {
                  setActiveConversationId(celebrationMatch.conversationId);
                  setCelebrationMatch(null);
                  setActiveTab('messages');
                }}
                className="px-6 py-3 bg-[#c5fa5a] text-[#14201b] font-black text-xs rounded-xl"
              >
                Send Message ↗
              </button>
            </div>
          </div>
        </div>
      )}

      {reportTarget && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4">
          <div className="max-w-md w-full p-7 rounded-[25px] bg-white text-[#14201b] space-y-4">
            <h3 className="font-outfit font-extrabold text-2xl">Report {reportTarget.name}</h3>
            <form onSubmit={handleSubmitSafetyReport} className="space-y-4">
              <select
                value={reportReason}
                onChange={(e) => setReportReason(e.target.value)}
                className="w-full p-3 border border-[#d7ded5] rounded-xl text-xs font-bold"
              >
                <option value="harassment_or_abuse">Harassment or abuse</option>
                <option value="underage_concern">Suspected underage account</option>
                <option value="impersonation">Impersonation</option>
                <option value="spam_or_scam">Spam or scam</option>
              </select>
              <textarea
                rows={3}
                value={reportDetails}
                onChange={(e) => setReportDetails(e.target.value)}
                placeholder="Details..."
                className="w-full p-3 border border-[#d7ded5] rounded-xl text-xs"
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setReportTarget(null)}
                  className="px-4 py-2 text-xs font-bold text-[#6d7a72]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2.5 bg-[#c5fa5a] text-[#14201b] font-black text-xs rounded-xl"
                >
                  Submit Report
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
