import React, { useState, useEffect } from 'react';
import {
  Video,
  VideoOff,
  Mic,
  MicOff,
  SkipForward,
  ShieldAlert,
  Ban,
  Send,
  AlertCircle,
} from 'lucide-react';
import type { AuthenticatedUser, LanguageCode, PublicRoute } from '../types';
import { TRANSLATIONS } from '../i18n';
import { apiRequest, setStoredToken } from '../api';
import { EditorialImage } from './EditorialImage';

interface LandingPageProps {
  language: LanguageCode;
  onLanguageChange: (lang: LanguageCode) => void;
  onNavigate: (route: PublicRoute) => void;
  onAuthSuccess: (user: AuthenticatedUser) => void;
}

interface DemoPartner {
  id: string;
  name: string;
  age: number;
  region: string;
  intention: string;
  languages: string;
  sharedInterests: string[];
  portrait: string;
  openingLine: string;
  replyLine: string;
}

const DEMO_PARTNERS: DemoPartner[] = [
  {
    id: 'demo_amaya',
    name: 'Amaya',
    age: 26,
    region: 'Galle & Colombo',
    intention: 'Long-term story',
    languages: 'English · සිංහල',
    sharedInterests: ['Ceylon Tea & Cafés', 'Independent Cinema', 'Southern Coast Escapes'],
    portrait: '/src/assets/images/editorial_portrait_amaya_1793978349458.jpg',
    openingLine:
      'Good evening from Galle Fort! The rain just cleared over the ramparts—how is Colombo tonight?',
    replyLine: 'That sounds lovely. Nothing beats a quiet cup of tea after an evening downpour.',
  },
  {
    id: 'demo_kavan',
    name: 'Kavan',
    age: 28,
    region: 'Colombo 07',
    intention: 'Meaningful dating',
    languages: 'English · සිංහල',
    sharedInterests: ['Tropical Architecture', 'Live Acoustic & Jazz', '35mm Film Photography'],
    portrait: '/src/assets/images/editorial_portrait_kavan_1793978350314.jpg',
    openingLine:
      'Just wrapped up a studio sketch session. Are you more of a mountain hills person or southern coast?',
    replyLine: 'Agreed—driving down the coast at dusk with good music is hard to beat.',
  },
  {
    id: 'demo_dilini',
    name: 'Dilini',
    age: 25,
    region: 'Kandy',
    intention: 'Long-term story',
    languages: 'සිංහල · English',
    sharedInterests: ['Literature & Poetry', 'Hill Country Trails', 'Ceylon Tea & Cafés'],
    portrait: '/src/assets/images/editorial_portrait_dilini_1793978350862.jpg',
    openingLine:
      'Hello from Kandy! Currently reading beside a monsoon shower. What book is on your table?',
    replyLine: 'I have been meaning to read that next—thank you for the recommendation.',
  },
  {
    id: 'demo_ehan',
    name: 'Ehan',
    age: 29,
    region: 'Mirissa & Colombo',
    intention: 'Meaningful dating',
    languages: 'தமிழ் · English · සිංහල',
    sharedInterests: ['Independent Cinema', '35mm Film Photography', 'Island Gastronomy'],
    portrait: '/src/assets/images/editorial_portrait_ehan_1793978352895.jpg',
    openingLine:
      'Evening! Editing a short coastal film in Mirissa right now. Favourite movie you watched this year?',
    replyLine: 'Great choice—the cinematography in that film stayed with me for weeks.',
  },
];

export const LandingPage: React.FC<LandingPageProps> = ({
  language,
  onLanguageChange,
  onNavigate,
  onAuthSuccess,
}) => {
  const t = TRANSLATIONS[language];

  // Built-in Auth Modal state (matching reference HTML behavior + real backend)
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authMode, setAuthMode] = useState<'signup' | 'login'>('signup');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('1999-05-15');
  const [termsAccepted, setTermsAccepted] = useState(true);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // Interactive Demo Studio state
  const [demoIndex, setDemoIndex] = useState(0);
  const [demoCameraOn, setDemoCameraOn] = useState(true);
  const [demoMicOn, setDemoMicOn] = useState(true);
  const [demoMode, setDemoMode] = useState<'video' | 'text'>('video');
  const [demoSafetyOpen, setDemoSafetyOpen] = useState(false);
  const [demoSafetyFeedback, setDemoSafetyFeedback] = useState<string | null>(null);
  const [demoInput, setDemoInput] = useState('');
  const [demoMessages, setDemoMessages] = useState<
    Array<{ id: string; sender: 'partner' | 'you'; text: string; time: string }>
  >([
    {
      id: 'm1',
      sender: 'partner',
      text: DEMO_PARTNERS[0].openingLine,
      time: '20:41',
    },
  ]);

  const [selectedInterestFilter, setSelectedInterestFilter] = useState<string>('All');
  const [healthInfo, setHealthInfo] = useState<{
    paymentsConfigured?: boolean;
    devMode?: boolean;
  } | null>(null);

  useEffect(() => {
    apiRequest<{ paymentsConfigured: boolean; devMode: boolean }>('/health')
      .then((res) => setHealthInfo(res))
      .catch(() => {});
  }, []);

  const currentDemoPartner = DEMO_PARTNERS[demoIndex];

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
        const res = await apiRequest<{ token: string; user: AuthenticatedUser }>(
          '/auth/register',
          {
            method: 'POST',
            body: JSON.stringify({
              displayName: displayName.trim() || email.split('@')[0] || 'Member',
              email,
              password,
              dateOfBirth,
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

  const handleQuickDemoAccount = async (demoEmail: string, demoPassword: string) => {
    setAuthError(null);
    setAuthLoading(true);
    try {
      const res = await apiRequest<{ token: string; user: AuthenticatedUser }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: demoEmail, password: demoPassword }),
      });
      setStoredToken(res.token);
      setAuthModalOpen(false);
      onAuthSuccess(res.user);
    } catch (err) {
      setAuthError((err as Error).message);
    } finally {
      setAuthLoading(false);
    }
  };

  const handleNextDemoPartner = () => {
    const nextIdx = (demoIndex + 1) % DEMO_PARTNERS.length;
    setDemoIndex(nextIdx);
    setDemoSafetyOpen(false);
    setDemoSafetyFeedback(null);
    setDemoMessages([
      {
        id: `m_${Date.now()}`,
        sender: 'partner',
        text: DEMO_PARTNERS[nextIdx].openingLine,
        time: '20:42',
      },
    ]);
  };

  const handleSendDemoMessage = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = demoInput.trim();
    if (!clean) return;
    setDemoMessages((prev) => [
      ...prev,
      { id: `u_${Date.now()}`, sender: 'you', text: clean, time: '20:43' },
      {
        id: `p_${Date.now() + 1}`,
        sender: 'partner',
        text: currentDemoPartner.replyLine,
        time: '20:43',
      },
    ]);
    setDemoInput('');
  };

  const filteredProfiles =
    selectedInterestFilter === 'All'
      ? DEMO_PARTNERS
      : DEMO_PARTNERS.filter((p) => p.sharedInterests.includes(selectedInterestFilter));

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

        {/* Zone 2: Clean Bold Nav Links */}
        <nav className="hidden lg:flex items-center gap-8">
          <a
            href="#how"
            className="text-[#e4e8e5] hover:text-[#c5fa5a] text-sm font-bold transition-colors whitespace-nowrap shrink-0"
          >
            {t.navHowItWorks}
          </a>
          <a
            href="#features"
            className="text-[#e4e8e5] hover:text-[#c5fa5a] text-sm font-bold transition-colors whitespace-nowrap shrink-0"
          >
            {t.navFeatures}
          </a>
          <a
            href="#discover-section"
            className="text-[#e4e8e5] hover:text-[#c5fa5a] text-sm font-bold transition-colors whitespace-nowrap shrink-0"
          >
            {t.navDiscover}
          </a>
          <a
            href="#pricing"
            className="text-[#e4e8e5] hover:text-[#c5fa5a] text-sm font-bold transition-colors whitespace-nowrap shrink-0"
          >
            {t.navMembership}
          </a>
          <a
            href="#safety"
            className="text-[#e4e8e5] hover:text-[#c5fa5a] text-sm font-bold transition-colors whitespace-nowrap shrink-0"
          >
            {t.navSafety}
          </a>
        </nav>

        {/* Zone 3: Language + Log in + Join now */}
        <div className="flex items-center gap-2.5 md:gap-3 shrink-0">
          <div className="hidden sm:flex items-center bg-white/10 border border-white/15 rounded-full p-0.5 text-xs">
            {(['en', 'si', 'ta'] as LanguageCode[]).map((code) => (
              <button
                key={code}
                type="button"
                onClick={() => onLanguageChange(code)}
                className={`px-2.5 py-1 rounded-full font-bold transition-colors whitespace-nowrap shrink-0 ${
                  language === code
                    ? 'bg-[#c5fa5a] text-[#142016]'
                    : 'text-[#e4e8e5] hover:text-white'
                }`}
              >
                {code === 'en' ? 'EN' : code === 'si' ? 'සිං' : 'தமிழ்'}
              </button>
            ))}
          </div>

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

        {/* INTERACTIVE LIVE STUDIO PREVIEW (Clearly labeled simulated demonstration) */}
        <section className="py-16 px-6 md:px-14 lg:px-24 bg-[#e9eee5]/60">
          <div className="max-w-[1200px] mx-auto space-y-8">
            <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
              <div>
                <div className="font-black text-[#557d27] text-xs tracking-[2px] uppercase">
                  INTERACTIVE STUDIO PREVIEW · SIMULATED DEMO
                </div>
                <h2 className="font-outfit font-extrabold text-3xl md:text-5xl text-[#14201b] mt-2">
                  Try the video & text controls right now.
                </h2>
              </div>
              <p className="text-xs text-[#6d7a72] max-w-sm">
                This interactive demonstration uses curated preview profiles so you can test
                camera, mic, skip, and report controls before joining.
              </p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 rounded-[26px] overflow-hidden bg-[#101417] text-white shadow-[0_20px_60px_rgba(16,20,23,0.16)] border border-[#222d26]">
              {/* Left 7 Cols: Video Stage */}
              <div className="lg:col-span-7 relative min-h-[420px] md:min-h-[460px] flex flex-col justify-between p-6 border-b lg:border-b-0 lg:border-r border-white/10">
                {demoMode === 'video' ? (
                  <div className="absolute inset-0">
                    <EditorialImage
                      src={currentDemoPartner.portrait}
                      alt={currentDemoPartner.name}
                      aspectClassName="w-full h-full"
                      className="w-full h-full object-cover"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-[#101417] via-[#101417]/20 to-[#101417]/40" />
                  </div>
                ) : (
                  <div className="absolute inset-0 bg-[#17221c] flex flex-col items-center justify-center p-8 text-center">
                    <span className="brand-leaf mb-4">✦</span>
                    <p className="font-outfit font-extrabold text-3xl text-white">
                      Text-Only Conversation Mode
                    </p>
                    <p className="text-sm text-[#b4c0b7] mt-2 max-w-sm">
                      Camera transmission is switched off—ideal for relaxed late-night chats or
                      mobile data saver mode.
                    </p>
                  </div>
                )}

                <div className="relative z-10 flex items-center justify-between gap-3">
                  <div className="bg-[#101417]/80 backdrop-blur-md border border-white/15 px-4 py-2 rounded-full text-xs font-bold">
                    <span className="text-[#c5fa5a]">Simulated Demo</span> ·{' '}
                    {currentDemoPartner.name}, {currentDemoPartner.age} ·{' '}
                    {currentDemoPartner.region}
                  </div>

                  <div className="flex items-center bg-[#101417]/80 border border-white/15 rounded-full p-1 text-xs font-bold">
                    <button
                      type="button"
                      onClick={() => setDemoMode('video')}
                      className={`px-3 py-1 rounded-full transition-colors ${
                        demoMode === 'video'
                          ? 'bg-[#c5fa5a] text-[#14201b]'
                          : 'text-white/80 hover:text-white'
                      }`}
                    >
                      Video
                    </button>
                    <button
                      type="button"
                      onClick={() => setDemoMode('text')}
                      className={`px-3 py-1 rounded-full transition-colors ${
                        demoMode === 'text'
                          ? 'bg-[#c5fa5a] text-[#14201b]'
                          : 'text-white/80 hover:text-white'
                      }`}
                    >
                      Text
                    </button>
                  </div>
                </div>

                <div className="relative z-10 space-y-4">
                  <div className="flex items-end justify-between gap-4">
                    <div>
                      <p className="font-outfit font-extrabold text-2xl text-white">
                        {currentDemoPartner.name}, {currentDemoPartner.age}
                      </p>
                      <p className="text-xs text-[#bac3be]">
                        {currentDemoPartner.region} · {currentDemoPartner.intention} ·{' '}
                        {currentDemoPartner.languages}
                      </p>
                      <p className="text-xs text-[#c5fa5a] font-bold mt-1">
                        Shared: {currentDemoPartner.sharedInterests.join(' · ')}
                      </p>
                    </div>

                    <div className="w-28 h-20 rounded-2xl bg-[#17221c]/90 border border-white/20 flex flex-col items-center justify-center p-2 text-center shrink-0">
                      <span className="text-[11px] font-bold text-white">
                        {demoCameraOn ? 'Your Camera' : 'Camera Off'}
                      </span>
                      <span className="text-[10px] text-[#c5fa5a]">
                        {demoMicOn ? 'Mic Active' : 'Muted'}
                      </span>
                    </div>
                  </div>

                  <div className="pt-3 border-t border-white/15 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setDemoCameraOn((v) => !v)}
                        className="px-3.5 py-2 rounded-xl bg-white/10 hover:bg-white/15 border border-white/20 text-xs font-bold inline-flex items-center gap-1.5"
                      >
                        {demoCameraOn ? (
                          <Video className="w-3.5 h-3.5 text-[#c5fa5a]" />
                        ) : (
                          <VideoOff className="w-3.5 h-3.5 text-red-300" />
                        )}
                        <span>{demoCameraOn ? 'Camera On' : 'Camera Off'}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => setDemoMicOn((v) => !v)}
                        className="px-3.5 py-2 rounded-xl bg-white/10 hover:bg-white/15 border border-white/20 text-xs font-bold inline-flex items-center gap-1.5"
                      >
                        {demoMicOn ? (
                          <Mic className="w-3.5 h-3.5 text-[#c5fa5a]" />
                        ) : (
                          <MicOff className="w-3.5 h-3.5 text-red-300" />
                        )}
                        <span>{demoMicOn ? 'Mic On' : 'Muted'}</span>
                      </button>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setDemoSafetyOpen((v) => !v)}
                        className="px-3.5 py-2 rounded-xl bg-white/10 hover:bg-white/15 text-xs font-bold inline-flex items-center gap-1.5"
                      >
                        <ShieldAlert className="w-3.5 h-3.5 text-[#c5fa5a]" />
                        <span>Safety</span>
                      </button>

                      <button
                        type="button"
                        onClick={handleNextDemoPartner}
                        className="px-4 py-2 rounded-xl bg-[#c5fa5a] hover:bg-[#d2ff75] text-[#14201b] text-xs font-black inline-flex items-center gap-1.5"
                      >
                        <SkipForward className="w-3.5 h-3.5" />
                        <span>Next person ↗</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Right 5 Cols: Interactive Demo Chat */}
              <div className="lg:col-span-5 flex flex-col justify-between h-[420px] md:h-[460px] bg-[#141c18]">
                <div className="p-4 border-b border-white/10 flex items-center justify-between">
                  <div>
                    <p className="text-sm font-bold text-white">
                      Chat with {currentDemoPartner.name}
                    </p>
                    <p className="text-[11px] text-[#96a49a]">
                      Simulated preview · Click Join now for live matchmaking
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => openAuthModal('signup')}
                    className="text-xs font-extrabold text-[#c5fa5a] hover:underline"
                  >
                    Join live ↗
                  </button>
                </div>

                {demoSafetyOpen ? (
                  <div className="p-5 flex-1 space-y-3 overflow-y-auto">
                    <p className="text-xs font-bold text-[#c5fa5a] uppercase tracking-wider">
                      Safety Controls Preview
                    </p>
                    <p className="text-xs text-[#bac3be] leading-relaxed">
                      Every live video or text chat includes instant one-click Block and Report
                      actions.
                    </p>
                    {demoSafetyFeedback ? (
                      <div className="p-3 rounded-xl bg-[#dff4b3] text-[#14201b] text-xs font-bold">
                        {demoSafetyFeedback}
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <button
                          type="button"
                          onClick={() =>
                            setDemoSafetyFeedback(
                              `Preview: ${currentDemoPartner.name} blocked and skipped immediately.`
                            )
                          }
                          className="w-full p-3 rounded-xl bg-white/10 hover:bg-white/15 text-xs font-bold text-left flex items-center justify-between"
                        >
                          <span>Block {currentDemoPartner.name} & Skip</span>
                          <Ban className="w-4 h-4 text-[#c5fa5a]" />
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setDemoSafetyFeedback(
                              'Preview: Safety report sent to human moderation queue.'
                            )
                          }
                          className="w-full p-3 rounded-xl bg-white/10 hover:bg-white/15 text-xs font-bold text-left flex items-center justify-between"
                        >
                          <span>Report Inappropriate Conduct</span>
                          <ShieldAlert className="w-4 h-4 text-[#c5fa5a]" />
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="p-5 flex-1 overflow-y-auto space-y-3">
                    {demoMessages.map((m) => (
                      <div
                        key={m.id}
                        className={`flex flex-col ${
                          m.sender === 'you' ? 'items-end' : 'items-start'
                        }`}
                      >
                        <div
                          className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-xs leading-relaxed ${
                            m.sender === 'you'
                              ? 'bg-[#c5fa5a] text-[#14201b] font-bold'
                              : 'bg-white/10 text-white'
                          }`}
                        >
                          {m.text}
                        </div>
                        <span className="text-[10px] text-[#96a49a] mt-1 tabular-nums">
                          {m.sender === 'you' ? 'You' : currentDemoPartner.name} · {m.time}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                <form
                  onSubmit={handleSendDemoMessage}
                  className="p-3.5 border-t border-white/10 flex items-center gap-2"
                >
                  <input
                    type="text"
                    value={demoInput}
                    onChange={(e) => setDemoInput(e.target.value)}
                    placeholder={`Say hello to ${currentDemoPartner.name}...`}
                    className="flex-1 bg-white/10 border border-white/15 rounded-xl px-3.5 py-2.5 text-xs text-white placeholder:text-white/50 focus:outline-none focus:border-[#c5fa5a]"
                  />
                  <button
                    type="submit"
                    className="px-4 py-2.5 bg-[#c5fa5a] text-[#14201b] rounded-xl text-xs font-black inline-flex items-center gap-1"
                  >
                    <Send className="w-3.5 h-3.5" />
                    <span>Send</span>
                  </button>
                </form>
              </div>
            </div>
          </div>
        </section>

        {/* DISCOVER DATING PROFILES & SHARED INTERESTS SECTION */}
        <section id="discover-section" className="py-24 px-6 md:px-14 lg:px-24">
          <div className="max-w-[1200px] mx-auto space-y-10">
            <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-6">
              <div>
                <div className="font-black text-[#557d27] text-xs tracking-[2px] uppercase">
                  DATING PROFILES & SHARED INTERESTS
                </div>
                <h2
                  className="font-outfit font-extrabold text-[#14201b] mt-2"
                  style={{ fontSize: 'clamp(34px, 3.6vw, 52px)' }}
                >
                  Meet beyond your circle.
                </h2>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {[
                  'All',
                  'Ceylon Tea & Cafés',
                  'Independent Cinema',
                  'Tropical Architecture',
                  'Literature & Poetry',
                ].map((interest) => (
                  <button
                    key={interest}
                    type="button"
                    onClick={() => setSelectedInterestFilter(interest)}
                    className={`px-4 py-2 rounded-full text-xs font-extrabold transition-colors whitespace-nowrap shrink-0 ${
                      selectedInterestFilter === interest
                        ? 'bg-[#17221c] text-[#c5fa5a]'
                        : 'bg-white border border-[#dce2d9] text-[#14201b] hover:bg-[#dff4b3]'
                    }`}
                  >
                    {interest}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
              {filteredProfiles.map((person) => (
                <div
                  key={person.id}
                  className="rounded-[24px] overflow-hidden bg-white border border-[#e7ebe5] shadow-[0_10px_30px_rgba(20,32,27,0.05)] flex flex-col justify-between"
                >
                  <div className="relative aspect-[3/4]">
                    <EditorialImage
                      src={person.portrait}
                      alt={person.name}
                      aspectClassName="w-full h-full"
                      className="w-full h-full object-cover"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-transparent to-transparent" />
                    <div className="absolute bottom-4 left-4 right-4 text-white">
                      <p className="font-outfit font-extrabold text-2xl">
                        {person.name}, {person.age}
                      </p>
                      <p className="text-xs text-white/85 font-medium">
                        {person.region} · {person.intention}
                      </p>
                    </div>
                  </div>
                  <div className="p-5 space-y-3 flex-1 flex flex-col justify-between">
                    <p className="text-xs text-[#6d7a72] leading-relaxed">
                      {person.sharedInterests.join(' · ')}
                    </p>
                    <button
                      type="button"
                      onClick={() => openAuthModal('signup')}
                      className="w-full py-2.5 rounded-xl bg-[#f0f7e3] hover:bg-[#dff4b3] text-[#14201b] text-xs font-extrabold transition-colors"
                    >
                      Connect with {person.name} ↗
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* PRICING SECTION (Matches .pricing on #e9eee5 with .plan.featured on #17221c) */}
        <section id="pricing" className="bg-[#e9eee5] py-24 px-6 md:px-14 lg:px-24">
          <div className="text-center max-w-[700px] mx-auto mb-11">
            <div className="font-black text-[#557d27] text-xs tracking-[2px] uppercase">
              ONE SIMPLE MEMBERSHIP
            </div>
            <h2
              className="font-outfit font-extrabold text-[#14201b] my-3.5"
              style={{ fontSize: 'clamp(39px, 4vw, 62px)' }}
            >
              Everything for Rs. 500.
            </h2>
            <p className="text-[#6d7a72] leading-[1.7] text-base">
              One membership. All the ways to connect across Sri Lanka for 30 days—manually
              renewed with zero automatic recurring billing traps.
            </p>
          </div>

          <div className="max-w-[450px] mx-auto">
            <div className="bg-[#17221c] text-white rounded-[25px] p-9 shadow-[0_20px_60px_rgba(23,34,28,0.18)]">
              <h3 className="font-outfit font-extrabold text-[26px]">
                Once Upon a Time Membership <span className="text-[#c5fa5a]">✦</span>
              </h3>
              <div className="font-outfit text-[46px] font-black my-5 tabular-nums">
                Rs. 500{' '}
                <small className="text-sm font-medium text-[#849187]">/ 30 days</small>
              </div>
              <ul className="pl-5 list-disc leading-[2.3] text-sm text-[#e4e8e5]">
                <li>Random video chat (live WebRTC)</li>
                <li>Random text chat</li>
                <li>Dating profile creation & discovery</li>
                <li>Shared interest matching & mutual likes</li>
                <li>Private messaging with mutual matches</li>
                <li>Report, block & privacy controls</li>
              </ul>

              {healthInfo && !healthInfo.paymentsConfigured && (
                <div className="mt-4 p-3 rounded-xl bg-white/10 border border-white/15 text-[11px] text-[#c5fa5a] font-medium leading-relaxed">
                  <strong>Notice:</strong> Payments coming soon. Live PayHere checkout is disabled; full features can be explored in free development preview.
                </div>
              )}

              <button
                type="button"
                onClick={() => openAuthModal('signup')}
                className="w-full mt-6 bg-[#c5fa5a] hover:bg-[#d2ff75] text-[#132014] rounded-[15px] py-4 px-6 font-black text-[15px] transition-colors"
              >
                {healthInfo && !healthInfo.paymentsConfigured
                  ? 'Join Free Development Preview'
                  : 'Get membership — Rs. 500'}
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

      {/* AUTH MODAL (Exact styling of .modal in reference HTML + connected to real backend!) */}
      {authModalOpen && (
        <div
          className="fixed inset-0 bg-[#050b08]/80 z-50 flex items-center justify-center p-5"
          onClick={(e) => {
            if (e.target === e.currentTarget) setAuthModalOpen(false);
          }}
        >
          <div className="bg-white text-[#14201b] rounded-[25px] p-8 md:p-9 w-full max-w-[440px] relative shadow-2xl">
            <button
              type="button"
              onClick={() => setAuthModalOpen(false)}
              className="absolute right-5 top-4 text-2xl font-bold text-[#66766c] hover:text-[#14201b]"
            >
              ×
            </button>

            <h2 className="font-outfit font-extrabold text-[32px] leading-tight mb-1.5">
              {authMode === 'signup' ? 'Join Once Upon a Time' : 'Welcome back'}
            </h2>
            <p className="text-[13px] text-[#66766c] leading-relaxed">
              {authMode === 'signup'
                ? 'Create an adult 18+ account to start meeting new people across Sri Lanka.'
                : 'Log in to continue your conversations and matches.'}
            </p>

            {authError && (
              <div className="mt-4 p-3 rounded-xl bg-red-50 border border-red-200 text-red-800 text-xs flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{authError}</span>
              </div>
            )}

            <form onSubmit={handleModalAuthSubmit}>
              {authMode === 'signup' && (
                <>
                  <label className="block text-xs font-extrabold mt-4 mb-1.5">Display name</label>
                  <input
                    type="text"
                    required
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="Your name"
                    className="w-full p-3.5 border border-[#d7ded5] rounded-[10px] text-sm focus:outline-none focus:border-[#14201b]"
                  />
                </>
              )}

              <label className="block text-xs font-extrabold mt-4 mb-1.5">Email address</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full p-3.5 border border-[#d7ded5] rounded-[10px] text-sm focus:outline-none focus:border-[#14201b]"
              />

              <label className="block text-xs font-extrabold mt-4 mb-1.5">Password</label>
              <input
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters"
                className="w-full p-3.5 border border-[#d7ded5] rounded-[10px] text-sm focus:outline-none focus:border-[#14201b]"
              />

              {authMode === 'signup' && (
                <>
                  <label className="block text-xs font-extrabold mt-4 mb-1.5">
                    Date of birth (18+ required)
                  </label>
                  <input
                    type="date"
                    required
                    value={dateOfBirth}
                    onChange={(e) => setDateOfBirth(e.target.value)}
                    className="w-full p-3.5 border border-[#d7ded5] rounded-[10px] text-sm focus:outline-none focus:border-[#14201b]"
                  />

                  <label className="flex items-center gap-2 text-xs font-medium mt-4 cursor-pointer">
                    <input
                      type="checkbox"
                      required
                      checked={termsAccepted}
                      onChange={(e) => setTermsAccepted(e.target.checked)}
                      className="w-4 h-4 accent-[#14201b]"
                    />
                    <span>I confirm I am at least 18 years old and agree to the Terms</span>
                  </label>
                </>
              )}

              <button
                type="submit"
                disabled={authLoading}
                className="w-full mt-5 bg-[#c5fa5a] hover:bg-[#b8f244] text-[#132014] rounded-[15px] py-4 font-black text-[15px] transition-colors disabled:opacity-50"
              >
                {authLoading
                  ? 'Please wait...'
                  : authMode === 'signup'
                  ? 'Create account'
                  : 'Log in'}
              </button>
            </form>

            {/* Quick 1-Click Test Accounts */}
            <div className="bg-[#eaf5d5] p-3 rounded-[11px] text-[#415b28] text-xs mt-4 space-y-2">
              <p className="font-extrabold">Instant Demo Accounts (Real Database):</p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() =>
                    handleQuickDemoAccount('amaya@onceuponatime.lk', 'ColomboStory2026!')
                  }
                  className="px-2.5 py-1.5 rounded-lg bg-white text-[#14201b] font-bold text-[11px] shadow-xs hover:bg-[#c5fa5a]"
                >
                  Login as Amaya (Member)
                </button>
                <button
                  type="button"
                  onClick={() =>
                    handleQuickDemoAccount('admin@onceuponatime.lk', 'StoryAdmin2026!')
                  }
                  className="px-2.5 py-1.5 rounded-lg bg-[#17221c] text-white font-bold text-[11px] hover:opacity-90"
                >
                  Login as Nalin (Admin)
                </button>
              </div>
            </div>

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
