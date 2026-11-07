import React, { useState } from 'react';
import { AlertCircle, ShieldCheck } from 'lucide-react';
import type { AuthenticatedUser, GenderType, LanguageCode, PublicRoute } from '../types';
import { TRANSLATIONS } from '../i18n';
import { apiRequest, authenticateWithGooglePopup, setStoredToken } from '../api';
import { EditorialImage } from './EditorialImage';

interface LandingPageProps {
  language: LanguageCode;
  onLanguageChange: (lang: LanguageCode) => void;
  onNavigate: (route: PublicRoute) => void;
  onAuthSuccess: (user: AuthenticatedUser) => void;
}

export const LandingPage: React.FC<LandingPageProps> = ({
  language,
  onNavigate,
  onAuthSuccess,
}) => {
  const t = TRANSLATIONS[language];

  // Built-in Auth Modal state connected to Firebase Auth & Firestore
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authMode, setAuthMode] = useState<'signup' | 'login'>('signup');
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('1999-05-15');
  const [gender, setGender] = useState<GenderType>('male');
  const [nicNumber, setNicNumber] = useState('');
  const [termsAccepted, setTermsAccepted] = useState(true);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const openAuthModal = (mode: 'signup' | 'login') => {
    setAuthMode(mode);
    setAuthError(null);
    setAuthModalOpen(true);
  };

  const handleModalAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setAuthLoading(true);
    try {
      if (authMode === 'login') {
        const res = await apiRequest<{ token: string; user: AuthenticatedUser }>('/auth/login', {
          method: 'POST',
          body: JSON.stringify({ email, password }),
        });
        setStoredToken(res.token);
        setAuthModalOpen(false);
        onAuthSuccess(res.user);
      } else {
        const cleanFullName = name.trim();
        const cleanDisplay = displayName.trim() || cleanFullName;
        const res = await apiRequest<{ token: string; user: AuthenticatedUser }>(
          '/auth/register',
          {
            method: 'POST',
            body: JSON.stringify({
              name: cleanFullName,
              displayName: cleanDisplay,
              email,
              password,
              dateOfBirth,
              gender,
              nicNumber: nicNumber.trim().toUpperCase(),
              termsAccepted,
              preferredLanguage: language,
            }),
          }
        );
        setStoredToken(res.token);
        setAuthModalOpen(false);
        onAuthSuccess(res.user);
      }
    } catch (err) {
      setAuthError((err as Error).message);
    } finally {
      setAuthLoading(false);
    }
  };

  const handleGoogleAuth = async () => {
    setAuthError(null);
    setAuthLoading(true);
    try {
      const res = await authenticateWithGooglePopup(
        authMode === 'signup'
          ? {
              name: name.trim(),
              displayName: displayName.trim() || name.trim(),
              dateOfBirth,
              gender,
              nicNumber: nicNumber.trim().toUpperCase(),
              preferredLanguage: language,
            }
          : undefined
      );
      setStoredToken(res.token);
      setAuthModalOpen(false);
      onAuthSuccess(res.user);
    } catch (err) {
      setAuthError((err as Error).message);
    } finally {
      setAuthLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#f5f6f2] text-[#14201b] flex flex-col font-sans-ui">
      {/* ABSOLUTE OVERLAY HEADER ON DARK HERO (Matches Reference HTML) */}
      <header className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-6 md:px-14 lg:px-20 py-6 text-white">
        {/* Zone 1: Brand lockup with rotated lime leaf */}
        <a
          href="#top"
          className="font-outfit text-[26px] md:text-[30px] font-black tracking-[-0.06em] flex items-center gap-2.5 whitespace-nowrap shrink-0 text-white"
        >
          <span className="brand-leaf">✦</span>
          <span>
            once upon a time<span className="text-[#c5fa5a]">.</span>
          </span>
        </a>

        {/* Zone 3: Log in + Join now */}
        <div className="flex items-center gap-2.5 md:gap-3 shrink-0">

          <button
            type="button"
            onClick={() => openAuthModal('login')}
            className="border border-white/45 text-white bg-transparent hover:border-white px-4 md:px-5 py-2.5 rounded-[30px] text-sm font-bold transition-colors whitespace-nowrap shrink-0"
          >
            {t.login}
          </button>

          <button
            type="button"
            onClick={() => openAuthModal('signup')}
            className="bg-[#c5fa5a] hover:bg-[#d2ff75] text-[#142016] px-5 py-2.5 rounded-[30px] text-sm font-extrabold transition-colors whitespace-nowrap shrink-0"
          >
            Join now ↗
          </button>
        </div>
      </header>

      <main id="top">
        {/* HERO SECTION (#101417 with radial forest glow + tilted dual portrait cards) */}
        <div className="bg-[#101417] text-white min-h-[760px] relative overflow-hidden grid grid-cols-1 lg:grid-cols-12 pt-32 pb-28 px-6 md:px-14 lg:px-20 gap-10">
          {/* Ambient radial forest glow */}
          <div
            className="pointer-events-none absolute w-[650px] h-[650px] rounded-full bg-[#33533c] opacity-35 blur-[160px] -left-80 top-40"
            aria-hidden="true"
          />

          {/* Left Copy Column */}
          <div className="lg:col-span-6 relative z-10 self-center max-w-[610px]">
            <div className="inline-flex items-center gap-2 text-[#d7e4d4] bg-white/10 border border-white/15 px-3.5 py-2 rounded-full text-xs font-extrabold tracking-wider uppercase">
              <span>✦ ONCE UPON A TIME · SRI LANKA</span>
            </div>

            <h1
              className="font-outfit font-black text-white leading-[0.98] tracking-[-0.055em] my-7"
              style={{ fontSize: 'clamp(54px, 6.2vw, 98px)' }}
            >
              Strangers
              <br />
              today.
              <br />
              <span className="text-[#c5fa5a]">Stories</span>
              <br />
              tomorrow.
            </h1>

            <p className="text-[17px] text-[#bac3be] leading-[1.75] max-w-[460px] mb-8">
              {t.heroHeadline} Meet new people across Sri Lanka through spontaneous video chats,
              instant text conversations, and shared-interest dating profiles.
            </p>

            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => openAuthModal('signup')}
                className="bg-[#c5fa5a] hover:bg-[#d2ff75] text-[#132014] rounded-[15px] px-7 py-4 font-black text-[15px] transition-transform active:scale-[0.99] whitespace-nowrap shrink-0"
              >
                ◉ &nbsp; Start video chat ↗
              </button>

              <button
                type="button"
                onClick={() => openAuthModal('signup')}
                className="bg-white/10 hover:bg-white/15 border border-white/35 text-white rounded-[15px] px-7 py-4 font-extrabold text-[15px] transition-colors whitespace-nowrap shrink-0"
              >
                ▤ &nbsp; Start text chat
              </button>
            </div>

            <div className="flex items-center gap-3 mt-10 text-[#aab5ad] text-xs font-medium">
              <div className="flex pl-2">
                <span className="w-8 h-8 rounded-full border-2 border-[#111a14] -ml-2 bg-[#d8b3a1] grid place-items-center text-[#14201b] font-bold text-xs">
                  A
                </span>
                <span className="w-8 h-8 rounded-full border-2 border-[#111a14] -ml-2 bg-[#b7d2f1] grid place-items-center text-[#14201b] font-bold text-xs">
                  K
                </span>
                <span className="w-8 h-8 rounded-full border-2 border-[#111a14] -ml-2 bg-[#f2c883] grid place-items-center text-[#14201b] font-bold text-xs">
                  D
                </span>
              </div>
              <span>
                Every connection has a story · Real conversations · Adults 18+ only
              </span>
            </div>
          </div>

          {/* Right Art Column: Tilted Overlapping Portraits & Callouts */}
          <div className="lg:col-span-6 relative min-h-[420px] sm:min-h-[520px] self-center">
            {/* Photo One (Left Tilted -7deg) */}
            <div className="absolute w-[56%] h-[320px] sm:h-[430px] left-[2%] top-[35px] rounded-[30px] overflow-hidden border-[7px] border-[#222a28] shadow-[0_25px_70px_rgba(0,0,0,0.6)] bg-[#283331] -rotate-[7deg]">
              <EditorialImage
                src="/src/assets/images/editorial_portrait_amaya_1793978349458.jpg"
                alt="Amaya in Galle Fort"
                aspectClassName="w-full h-full"
                className="w-full h-full object-cover"
              />
              <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/80 to-transparent" />
              <div className="absolute bottom-5 left-5 z-10 text-white text-xs sm:text-[13px] font-extrabold">
                ✳ Say hello to someone new
              </div>
            </div>

            {/* Photo Two (Right Tilted +7deg) */}
            <div className="absolute w-[54%] h-[330px] sm:h-[440px] right-0 top-[75px] rounded-[30px] overflow-hidden border-[7px] border-[#222a28] shadow-[0_25px_70px_rgba(0,0,0,0.6)] bg-[#283331] rotate-[7deg]">
              <EditorialImage
                src="/src/assets/images/editorial_portrait_kavan_1793978350314.jpg"
                alt="Kavan in Colombo Studio"
                aspectClassName="w-full h-full"
                className="w-full h-full object-cover"
              />
              <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/80 to-transparent" />
              <div className="absolute bottom-5 left-5 z-10 text-white text-xs sm:text-[13px] font-extrabold">
                ✳ Your next connection awaits
              </div>
            </div>

            {/* Top-Right Floating Tag */}
            <div className="absolute z-20 top-0 right-[6%] bg-[#f8f9ef] text-[#162018] rounded-[16px] px-5 py-3.5 font-extrabold text-xs sm:text-sm shadow-[0_15px_50px_rgba(0,0,0,0.35)] rotate-[5deg]">
              <span className="text-[#56b64e] mr-1.5">●</span> Your people are out there
            </div>

            {/* Bottom-Left Lime Floating Card */}
            <div className="absolute z-20 bottom-2 left-[18%] bg-[#c5fa5a] text-[#172116] rounded-[18px] px-5 py-4 text-xs sm:text-[15px] font-black shadow-[0_15px_40px_rgba(0,0,0,0.3)] -rotate-[6deg]">
              ✦ One click. A new connection.
            </div>
          </div>
        </div>

        {/* OVERLAPPING 4-COLUMN WHITE FEATURE BAR (-55px pull-up) */}
        <div
          id="how"
          className="max-w-[1280px] mx-4 xl:mx-auto -mt-[55px] relative z-20 bg-white rounded-[24px] p-6 md:p-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 shadow-[0_12px_40px_rgba(24,39,29,0.08)]"
        >
          <div className="flex gap-3.5 items-center lg:border-r border-[#e8eae6] pr-4">
            <div className="w-12 h-12 rounded-[15px] bg-[#f0f7e3] text-[#14201b] font-outfit font-black text-base grid place-items-center shrink-0">
              LK
            </div>
            <div>
              <strong className="text-sm font-extrabold block text-[#14201b]">
                Local connections
              </strong>
              <p className="text-xs text-[#718078] mt-1 leading-relaxed">
                Meet people across Colombo, Kandy, Galle & beyond
              </p>
            </div>
          </div>

          <div className="flex gap-3.5 items-center lg:border-r border-[#e8eae6] pr-4">
            <div className="w-12 h-12 rounded-[15px] bg-[#f0f7e3] text-[#14201b] font-outfit font-black text-lg grid place-items-center shrink-0">
              ⚡
            </div>
            <div>
              <strong className="text-sm font-extrabold block text-[#14201b]">
                Quick matching
              </strong>
              <p className="text-xs text-[#718078] mt-1 leading-relaxed">
                Atomic WebRTC video & instant text pairing
              </p>
            </div>
          </div>

          <div className="flex gap-3.5 items-center lg:border-r border-[#e8eae6] pr-4">
            <div className="w-12 h-12 rounded-[15px] bg-[#f0f7e3] text-[#14201b] font-outfit font-black text-lg grid place-items-center shrink-0">
              🛡️
            </div>
            <div>
              <strong className="text-sm font-extrabold block text-[#14201b]">
                Safety first
              </strong>
              <p className="text-xs text-[#718078] mt-1 leading-relaxed">
                1-click reporting, blocking & 18+ verification
              </p>
            </div>
          </div>

          <div className="flex gap-3.5 items-center">
            <div className="w-12 h-12 rounded-[15px] bg-[#f0f7e3] text-[#14201b] font-outfit font-black text-lg grid place-items-center shrink-0">
              ✦
            </div>
            <div>
              <strong className="text-sm font-extrabold block text-[#14201b]">
                More your way
              </strong>
              <p className="text-xs text-[#718078] mt-1 leading-relaxed">
                Dating profiles, mutual likes & shared interests
              </p>
            </div>
          </div>
        </div>

        {/* 3-CARD CONTRAST SECTION (White / Soft Lime #dff4b3 / Deep Forest #17221c) */}
        <section id="features" className="py-24 px-6 md:px-14 lg:px-24">
          <div className="text-center max-w-[700px] mx-auto mb-12">
            <div className="font-black text-[#557d27] text-xs tracking-[2px] uppercase">
              A DIFFERENT KIND OF HELLO
            </div>
            <h2
              className="font-outfit font-extrabold text-[#14201b] my-3.5"
              style={{ fontSize: 'clamp(38px, 4vw, 60px)' }}
            >
              Good conversations start here.
            </h2>
            <p className="text-[#6d7a72] leading-[1.7] text-base">
              Whether you are here to form a meaningful relationship, discover shared interests, or
              share a spontaneous laugh, Once Upon a Time makes it effortless to break the ice.
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 max-w-[1200px] mx-auto">
            {/* Card 1: Crisp White */}
            <article className="p-9 rounded-[24px] bg-white min-h-[270px] border border-[#e7ebe5] flex flex-col justify-between">
              <div>
                <div className="text-4xl font-outfit font-black text-[#14201b]">◉</div>
                <h3 className="font-outfit font-extrabold text-[27px] text-[#14201b] mt-6 mb-2.5">
                  Face to face, instantly.
                </h3>
                <p className="text-[#718078] leading-[1.7] text-sm">
                  Meet new people through spontaneous one-on-one WebRTC video conversations. Camera
                  and microphone controls stay in your hands at every second.
                </p>
              </div>
              <p className="text-xs font-bold text-[#557d27] mt-6">
                01. Random Video Connections
              </p>
            </article>

            {/* Card 2: Soft Lime (#dff4b3) */}
            <article className="p-9 rounded-[24px] bg-[#dff4b3] min-h-[270px] border border-[#d2eba0] flex flex-col justify-between">
              <div>
                <div className="text-4xl font-outfit font-black text-[#14201b]">☰</div>
                <h3 className="font-outfit font-extrabold text-[27px] text-[#14201b] mt-6 mb-2.5">
                  More of a texter?
                </h3>
                <p className="text-[#3f5145] leading-[1.7] text-sm">
                  Start with words instead. Discover a fresh anonymous conversation or chat
                  privately with your mutual dating matches without switching on your camera.
                </p>
              </div>
              <p className="text-xs font-bold text-[#14201b] mt-6">
                02. Instant Text & Match Messaging
              </p>
            </article>

            {/* Card 3: Deep Forest (#17221c) */}
            <article
              id="safety"
              className="p-9 rounded-[24px] bg-[#17221c] text-white min-h-[270px] flex flex-col justify-between"
            >
              <div>
                <div className="text-4xl font-outfit font-black text-[#c5fa5a]">✳</div>
                <h3 className="font-outfit font-extrabold text-[27px] text-white mt-6 mb-2.5">
                  Stay in control.
                </h3>
                <p className="text-[#b4c0b7] leading-[1.7] text-sm">
                  Skip, leave, block, or report any conversation in one click. Strictly designed
                  for adults 18+, with human moderation and zero recording of private video chats.
                </p>
              </div>
              <p className="text-xs font-bold text-[#c5fa5a] mt-6">03. Trust, Privacy & Safety</p>
            </article>
          </div>
        </section>


        {/* CALL TO ACTION SECTION */}
        <section className="bg-[#e9eee5] py-24 px-6 md:px-14 lg:px-24">
          <div className="text-center max-w-[700px] mx-auto mb-11">
            <div className="font-black text-[#557d27] text-xs tracking-[2px] uppercase">
              START YOUR STORY
            </div>
            <h2
              className="font-outfit font-extrabold text-[#14201b] my-3.5"
              style={{ fontSize: 'clamp(39px, 4vw, 62px)' }}
            >
              Ready to say hello?
            </h2>
            <p className="text-[#6d7a72] leading-[1.7] text-base">
              All ways to connect across Sri Lanka—spontaneous video chat, text conversations,
              shared interest matching, and private messaging.
            </p>
          </div>

          <div className="max-w-[450px] mx-auto">
            <div className="bg-[#17221c] text-white rounded-[25px] p-9 shadow-[0_20px_60px_rgba(23,34,28,0.18)]">
              <h3 className="font-outfit font-extrabold text-[26px]">
                Once Upon a Time <span className="text-[#c5fa5a]">✦</span>
              </h3>
              <ul className="pl-5 list-disc leading-[2.3] text-sm text-[#e4e8e5] mt-5">
                <li>Random video chat</li>
                <li>Random text chat</li>
                <li>Dating profile creation & discovery</li>
                <li>Shared interest matching & mutual likes</li>
                <li>Private messaging with mutual matches</li>
                <li>Report, block & privacy controls</li>
              </ul>

              <button
                type="button"
                onClick={() => openAuthModal('signup')}
                className="w-full mt-6 bg-[#c5fa5a] hover:bg-[#d2ff75] text-[#132014] rounded-[15px] py-4 px-6 font-black text-[15px] transition-colors"
              >
                Create free account ↗
              </button>
            </div>
          </div>
        </section>
      </main>

      {/* DARK FOOTER (#101417 matching reference HTML) */}
      <footer className="bg-[#101417] text-white py-12 px-6 md:px-14 lg:px-20 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6">
        <div>
          <div className="font-outfit text-[28px] font-black tracking-[-0.06em] flex items-center gap-2.5">
            <span className="brand-leaf">✦</span>
            <span>
              once upon a time<span className="text-[#c5fa5a]">.</span>
            </span>
          </div>
          <p className="text-[#96a49a] text-[13px] mt-2">
            Every connection has a story · Made for new connections in Sri Lanka.
          </p>
        </div>

        <div className="text-[#96a49a] text-[13px] space-y-1 sm:text-right">
          <p>Adults 18+ only · Respect others · Stay safe online</p>
          <p>
            © 2026 Once Upon a Time (OUAT) ·{' '}
            <button
              type="button"
              onClick={() => onNavigate('login')}
              className="text-[#c5fa5a] hover:underline font-bold"
            >
              Full Auth Page
            </button>
          </p>
        </div>
      </footer>

      {/* AUTH MODAL (Connected to Firebase Auth + Cloud Firestore NIC Registry) */}
      {authModalOpen && (
        <div
          className="fixed inset-0 bg-[#050b08]/80 z-50 flex items-center justify-center p-4 overflow-y-auto"
          onClick={(e) => {
            if (e.target === e.currentTarget) setAuthModalOpen(false);
          }}
        >
          <div className="bg-white text-[#14201b] rounded-[25px] p-7 md:p-8 w-full max-w-[490px] relative shadow-2xl my-6 max-h-[92vh] overflow-y-auto">
            <button
              type="button"
              onClick={() => setAuthModalOpen(false)}
              className="absolute right-5 top-4 text-2xl font-bold text-[#66766c] hover:text-[#14201b]"
            >
              ×
            </button>

            <h2 className="font-outfit font-extrabold text-[30px] leading-tight mb-1">
              {authMode === 'signup' ? 'Join Once Upon a Time' : 'Welcome back'}
            </h2>
            <p className="text-[13px] text-[#66766c] leading-relaxed">
              {authMode === 'signup'
                ? 'Create a verified 18+ Sri Lankan account. One National Identity Card (NIC) number can only be used for one account.'
                : 'Log in with your registered email and password or Google account.'}
            </p>

            {authError && (
              <div className="mt-4 p-3 rounded-xl bg-red-50 border border-red-200 text-red-800 text-xs flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{authError}</span>
              </div>
            )}

            <form onSubmit={handleModalAuthSubmit} className="space-y-3.5 mt-4">
              {authMode === 'signup' && (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-extrabold mb-1">Full Name</label>
                      <input
                        type="text"
                        required
                        minLength={2}
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="Kasun Jayawardena"
                        className="w-full p-3 border border-[#d7ded5] rounded-[10px] text-sm focus:outline-none focus:border-[#14201b]"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-extrabold mb-1">Display Name</label>
                      <input
                        type="text"
                        required
                        minLength={2}
                        value={displayName}
                        onChange={(e) => setDisplayName(e.target.value)}
                        placeholder="Kasun"
                        className="w-full p-3 border border-[#d7ded5] rounded-[10px] text-sm focus:outline-none focus:border-[#14201b]"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-extrabold mb-1">
                      Sri Lankan NIC Number (1 Account Per NIC)
                    </label>
                    <input
                      type="text"
                      required
                      value={nicNumber}
                      onChange={(e) => setNicNumber(e.target.value.toUpperCase())}
                      placeholder="e.g., 199912345678 or 991234567V"
                      className="w-full p-3 border border-[#d7ded5] rounded-[10px] text-sm font-mono uppercase focus:outline-none focus:border-[#14201b]"
                    />
                    <p className="text-[11px] text-[#557d27] font-bold mt-1 flex items-center gap-1">
                      <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
                      <span>
                        Supports 12-digit new NIC or 9-digit + V/X old NIC. Strictly 1 NIC per
                        account.
                      </span>
                    </p>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-extrabold mb-1">
                        Date of Birth (18+)
                      </label>
                      <input
                        type="date"
                        required
                        value={dateOfBirth}
                        onChange={(e) => setDateOfBirth(e.target.value)}
                        className="w-full p-3 border border-[#d7ded5] rounded-[10px] text-sm focus:outline-none focus:border-[#14201b]"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-extrabold mb-1">Gender</label>
                      <select
                        value={gender}
                        onChange={(e) => setGender(e.target.value as GenderType)}
                        className="w-full p-3 border border-[#d7ded5] rounded-[10px] text-sm bg-white focus:outline-none focus:border-[#14201b]"
                      >
                        <option value="male">Male</option>
                        <option value="female">Female</option>
                        <option value="non_binary">Non-binary</option>
                        <option value="prefer_not_to_say">Prefer not to say</option>
                      </select>
                    </div>
                  </div>
                </>
              )}

              <div>
                <label className="block text-xs font-extrabold mb-1">Email address</label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.lk"
                  className="w-full p-3 border border-[#d7ded5] rounded-[10px] text-sm focus:outline-none focus:border-[#14201b]"
                />
              </div>

              <div>
                <label className="block text-xs font-extrabold mb-1">Password</label>
                <input
                  type="password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 8 characters"
                  className="w-full p-3 border border-[#d7ded5] rounded-[10px] text-sm focus:outline-none focus:border-[#14201b]"
                />
              </div>

              {authMode === 'signup' && (
                <label className="flex items-center gap-2 text-xs font-medium pt-1 cursor-pointer">
                  <input
                    type="checkbox"
                    required
                    checked={termsAccepted}
                    onChange={(e) => setTermsAccepted(e.target.checked)}
                    className="w-4 h-4 accent-[#14201b]"
                  />
                  <span>I confirm I am at least 18 years old and agree to the Terms</span>
                </label>
              )}

              <button
                type="submit"
                disabled={authLoading}
                className="w-full mt-2 bg-[#c5fa5a] hover:bg-[#b8f244] text-[#132014] rounded-[15px] py-3.5 font-black text-[15px] transition-colors disabled:opacity-50"
              >
                {authLoading
                  ? 'Please wait...'
                  : authMode === 'signup'
                  ? 'Create account'
                  : 'Log in'}
              </button>
            </form>

            <div className="my-3.5 flex items-center gap-3 text-[11px] text-[#66766c] font-bold uppercase tracking-wider">
              <div className="h-px flex-1 bg-[#e4e8e5]" />
              <span>or</span>
              <div className="h-px flex-1 bg-[#e4e8e5]" />
            </div>

            <button
              type="button"
              disabled={authLoading}
              onClick={handleGoogleAuth}
              className="w-full border border-[#d7ded5] hover:border-[#14201b] bg-[#f8f9f6] text-[#14201b] rounded-[15px] py-3 font-extrabold text-xs transition-colors disabled:opacity-50"
            >
              {authMode === 'signup'
                ? 'Sign up with Google (requires NIC & details above)'
                : 'Continue with Google'}
            </button>

            <div className="text-center mt-4 text-[13px]">
              <span>
                {authMode === 'signup' ? 'Already have an account?' : 'New to Once Upon a Time?'}
              </span>{' '}
              <button
                type="button"
                onClick={() => {
                  setAuthError(null);
                  setAuthMode(authMode === 'signup' ? 'login' : 'signup');
                }}
                className="text-[#467d1c] font-extrabold hover:underline"
              >
                {authMode === 'signup' ? 'Log in' : 'Sign up'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
