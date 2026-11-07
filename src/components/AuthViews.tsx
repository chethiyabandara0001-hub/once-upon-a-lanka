import React, { useState } from 'react';
import { ArrowLeft, CheckCircle2, AlertCircle, ShieldCheck } from 'lucide-react';
import type { AuthenticatedUser, GenderType, LanguageCode, PublicRoute } from '../types';
import { apiRequest, authenticateWithGooglePopup, setStoredToken } from '../api';
import { EditorialImage } from './EditorialImage';

interface AuthViewsProps {
  route: 'login' | 'register' | 'forgot-password' | 'reset-password' | 'verify-email';
  language: LanguageCode;
  currentUser: AuthenticatedUser | null;
  onNavigate: (route: PublicRoute) => void;
  onAuthSuccess: (user: AuthenticatedUser) => void;
}

export const AuthViews: React.FC<AuthViewsProps> = ({
  route,
  language,
  currentUser,
  onNavigate,
  onAuthSuccess,
}) => {
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('1999-05-15');
  const [gender, setGender] = useState<GenderType>('male');
  const [nicNumber, setNicNumber] = useState('');
  const [termsAccepted, setTermsAccepted] = useState(false);

  const [resetToken, setResetToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [verificationCode, setVerificationCode] = useState(
    currentUser?.emailVerificationTokenHint || ''
  );

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);

  const clearFeedback = () => {
    setError(null);
    setInfoMessage(null);
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    clearFeedback();
    setLoading(true);
    try {
      const res = await apiRequest<{ token: string; user: AuthenticatedUser }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      setStoredToken(res.token);
      onAuthSuccess(res.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    clearFeedback();
    setLoading(true);
    try {
      const cleanFullName = name.trim();
      const cleanDisplay = displayName.trim() || cleanFullName;
      const res = await apiRequest<{ token: string; user: AuthenticatedUser }>('/auth/register', {
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
      });
      setStoredToken(res.token);
      onAuthSuccess(res.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleAuth = async (isRegister: boolean) => {
    clearFeedback();
    setLoading(true);
    try {
      const res = await authenticateWithGooglePopup(
        isRegister
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
      onAuthSuccess(res.user);
    } catch (err) {
      const customErr = err as Error & {
        code?: string;
        googleDisplayName?: string;
        googleEmail?: string;
      };
      if (customErr.code === 'GOOGLE_NEEDS_NIC_REGISTRATION') {
        if (customErr.googleDisplayName && !name) {
          setName(customErr.googleDisplayName);
          setDisplayName(customErr.googleDisplayName.split(' ')[0] || customErr.googleDisplayName);
        }
        if (customErr.googleEmail && !email) {
          setEmail(customErr.googleEmail);
        }
        onNavigate('register');
        setInfoMessage(customErr.message);
      } else {
        setError(customErr.message);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    clearFeedback();
    setLoading(true);
    try {
      const res = await apiRequest<{ message: string; sandboxResetToken?: string | null }>(
        '/auth/forgot-password',
        {
          method: 'POST',
          body: JSON.stringify({ email }),
        }
      );
      if (res.sandboxResetToken) {
        setResetToken(res.sandboxResetToken);
        setInfoMessage(
          `${res.message} Sandbox Reset Code generated: ${res.sandboxResetToken}`
        );
      } else {
        setInfoMessage(res.message);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    clearFeedback();
    setLoading(true);
    try {
      await apiRequest('/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ email, token: resetToken, newPassword }),
      });
      setInfoMessage('Your password has been updated. You can now log in.');
      setTimeout(() => onNavigate('login'), 1200);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    clearFeedback();
    setLoading(true);
    try {
      const res = await apiRequest<{ user: AuthenticatedUser }>('/auth/verify-email', {
        method: 'POST',
        body: JSON.stringify({ code: verificationCode }),
      });
      onAuthSuccess(res.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#101417] text-white flex flex-col justify-between">
      <header className="px-6 md:px-14 py-6 flex items-center justify-between border-b border-white/10">
        <button
          type="button"
          onClick={() => onNavigate('landing')}
          className="inline-flex items-center gap-2 text-xs font-bold text-[#bac3be] hover:text-[#c5fa5a] transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to Home</span>
        </button>

        <div className="font-outfit text-2xl font-black tracking-[-0.06em] flex items-center gap-2">
          <span className="brand-leaf">✦</span>
          <span>
            once upon a time<span className="text-[#c5fa5a]">.</span>
          </span>
        </div>

        <span className="text-xs font-extrabold text-[#c5fa5a]">18+ · NIC VERIFIED</span>
      </header>

      <main className="flex-1 flex items-center justify-center py-12 px-5">
        <div className="max-w-[980px] w-full grid grid-cols-1 lg:grid-cols-12 rounded-[28px] overflow-hidden bg-white text-[#14201b] shadow-2xl">
          {/* Left Visual Column */}
          <div className="hidden lg:flex lg:col-span-5 bg-[#17221c] text-white p-9 flex-col justify-between relative overflow-hidden">
            <div className="relative z-10">
              <span className="inline-block bg-[#c5fa5a] text-[#14201b] text-xs font-black px-3 py-1 rounded-full">
                ✦ EVERY CONNECTION HAS A STORY
              </span>
              <h2 className="font-outfit font-black text-4xl leading-tight mt-5">
                Strangers today. <span className="text-[#c5fa5a]">Stories</span> tomorrow.
              </h2>
            </div>

            <div className="my-6 rounded-[22px] overflow-hidden border-4 border-[#222a28] aspect-[4/4]">
              <EditorialImage
                src="/src/assets/images/hero_colombo_evening_1793978348276.jpg"
                alt="Evening conversation in Colombo"
                aspectClassName="w-full h-full"
              />
            </div>

            <p className="text-xs text-[#b4c0b7]">
              Adults 18+ across Colombo, Kandy, Galle, Jaffna & Mirissa · Verified by Sri Lankan
              NIC (1 account per NIC).
            </p>
          </div>

          {/* Right Form Column */}
          <div className="lg:col-span-7 p-8 md:p-11 flex flex-col justify-center">
            {error && (
              <div className="mb-5 p-3.5 rounded-xl bg-red-50 border border-red-200 flex items-start gap-2.5 text-xs text-red-900 font-medium">
                <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            {infoMessage && (
              <div className="mb-5 p-3.5 rounded-xl bg-[#eaf5d5] border border-[#c5fa5a] flex items-start gap-2.5 text-xs text-[#14201b] font-bold">
                <CheckCircle2 className="w-4 h-4 text-[#467d1c] shrink-0 mt-0.5" />
                <span>{infoMessage}</span>
              </div>
            )}

            {route === 'login' && (
              <div className="space-y-5">
                <div>
                  <h1 className="font-outfit font-extrabold text-3xl md:text-4xl text-[#14201b]">
                    Welcome back
                  </h1>
                  <p className="text-xs text-[#66766c] mt-1">
                    Log in to continue your conversations and matches.
                  </p>
                </div>

                <form onSubmit={handleLogin} className="space-y-4">
                  <div>
                    <label className="block text-xs font-extrabold mb-1.5">Email address</label>
                    <input
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@example.lk"
                      className="w-full p-3.5 border border-[#d7ded5] rounded-[10px] text-sm focus:outline-none focus:border-[#14201b]"
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-xs font-extrabold">Password</label>
                      <button
                        type="button"
                        onClick={() => {
                          clearFeedback();
                          onNavigate('forgot-password');
                        }}
                        className="text-xs font-extrabold text-[#467d1c] hover:underline"
                      >
                        Forgot password?
                      </button>
                    </div>
                    <input
                      type="password"
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••"
                      className="w-full p-3.5 border border-[#d7ded5] rounded-[10px] text-sm focus:outline-none focus:border-[#14201b]"
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full py-4 bg-[#c5fa5a] hover:bg-[#b8f244] text-[#132014] font-black text-sm rounded-[15px] transition-colors"
                  >
                    {loading ? 'Signing in...' : 'Log in'}
                  </button>
                </form>

                <button
                  type="button"
                  disabled={loading}
                  onClick={() => handleGoogleAuth(false)}
                  className="w-full py-3.5 border border-[#d7ded5] hover:border-[#14201b] bg-[#f8f9f6] text-[#14201b] font-extrabold text-xs rounded-[15px] transition-colors"
                >
                  Continue with Google
                </button>

                <p className="text-xs text-center text-[#66766c]">
                  New to Once Upon a Time?{' '}
                  <button
                    type="button"
                    onClick={() => {
                      clearFeedback();
                      onNavigate('register');
                    }}
                    className="text-[#467d1c] font-extrabold hover:underline"
                  >
                    Sign up
                  </button>
                </p>
              </div>
            )}

            {route === 'register' && (
              <div className="space-y-4">
                <div>
                  <h1 className="font-outfit font-extrabold text-3xl md:text-4xl text-[#14201b]">
                    Join Once Upon a Time
                  </h1>
                  <p className="text-xs text-[#66766c] mt-1">
                    Create a verified adult 18+ account. Only one account is allowed per Sri Lankan
                    NIC number.
                  </p>
                </div>

                <form onSubmit={handleRegister} className="space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-extrabold mb-1">Full Name</label>
                      <input
                        type="text"
                        required
                        minLength={2}
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="e.g., Kasun Jayawardena"
                        className="w-full p-3 border border-[#d7ded5] rounded-[10px] text-sm"
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
                        placeholder="e.g., Kasun"
                        className="w-full p-3 border border-[#d7ded5] rounded-[10px] text-sm"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-extrabold mb-1">
                      Sri Lankan National Identity Card (NIC) Number
                    </label>
                    <input
                      type="text"
                      required
                      value={nicNumber}
                      onChange={(e) => setNicNumber(e.target.value.toUpperCase())}
                      placeholder="e.g., 199912345678 or 991234567V"
                      className="w-full p-3 border border-[#d7ded5] rounded-[10px] text-sm font-mono uppercase"
                    />
                    <p className="text-[11px] text-[#557d27] font-bold mt-1">
                      One NIC number can only ever be used for one account.
                    </p>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-extrabold mb-1">
                        Date of birth (18+)
                      </label>
                      <input
                        type="date"
                        required
                        value={dateOfBirth}
                        onChange={(e) => setDateOfBirth(e.target.value)}
                        className="w-full p-3 border border-[#d7ded5] rounded-[10px] text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-extrabold mb-1">Gender</label>
                      <select
                        value={gender}
                        onChange={(e) => setGender(e.target.value as GenderType)}
                        className="w-full p-3 border border-[#d7ded5] rounded-[10px] text-sm bg-white"
                      >
                        <option value="male">Male</option>
                        <option value="female">Female</option>
                        <option value="non_binary">Non-binary</option>
                        <option value="prefer_not_to_say">Prefer not to say</option>
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-extrabold mb-1">Email address</label>
                      <input
                        type="email"
                        required
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="you@example.lk"
                        className="w-full p-3 border border-[#d7ded5] rounded-[10px] text-sm"
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
                        className="w-full p-3 border border-[#d7ded5] rounded-[10px] text-sm"
                      />
                    </div>
                  </div>

                  <label className="flex items-start gap-2 text-xs text-[#66766c] pt-1 cursor-pointer">
                    <input
                      type="checkbox"
                      required
                      checked={termsAccepted}
                      onChange={(e) => setTermsAccepted(e.target.checked)}
                      className="mt-0.5 accent-[#14201b]"
                    />
                    <span>
                      I confirm I am at least 18 years old and agree to the Terms and Privacy
                      Policy.
                    </span>
                  </label>

                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full py-3.5 bg-[#c5fa5a] hover:bg-[#b8f244] text-[#132014] font-black text-sm rounded-[15px]"
                  >
                    {loading ? 'Creating account...' : 'Create account'}
                  </button>
                </form>

                <button
                  type="button"
                  disabled={loading}
                  onClick={() => handleGoogleAuth(true)}
                  className="w-full py-3 border border-[#d7ded5] hover:border-[#14201b] bg-[#f8f9f6] text-[#14201b] font-extrabold text-xs rounded-[15px] transition-colors"
                >
                  Sign up with Google (uses NIC & details above)
                </button>

                <p className="text-xs text-center text-[#66766c]">
                  Already have an account?{' '}
                  <button
                    type="button"
                    onClick={() => {
                      clearFeedback();
                      onNavigate('login');
                    }}
                    className="text-[#467d1c] font-extrabold hover:underline"
                  >
                    Log in
                  </button>
                </p>
              </div>
            )}

            {route === 'forgot-password' && (
              <div className="space-y-4">
                <h1 className="font-outfit font-extrabold text-3xl text-[#14201b]">
                  Reset your password
                </h1>
                <form onSubmit={handleForgotPassword} className="space-y-4">
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.lk"
                    className="w-full p-3.5 border border-[#d7ded5] rounded-[10px] text-sm"
                  />
                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full py-4 bg-[#c5fa5a] text-[#132014] font-black text-sm rounded-[15px]"
                  >
                    Send Reset Code
                  </button>
                </form>
                <div className="flex justify-between text-xs pt-2">
                  <button
                    type="button"
                    onClick={() => onNavigate('reset-password')}
                    className="text-[#467d1c] font-extrabold"
                  >
                    Enter Reset Code →
                  </button>
                  <button
                    type="button"
                    onClick={() => onNavigate('login')}
                    className="text-[#66766c]"
                  >
                    Back to Log in
                  </button>
                </div>
              </div>
            )}

            {route === 'reset-password' && (
              <div className="space-y-4">
                <h1 className="font-outfit font-extrabold text-3xl text-[#14201b]">
                  Set a new password
                </h1>
                <form onSubmit={handleResetPassword} className="space-y-3.5">
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="Email address"
                    className="w-full p-3.5 border border-[#d7ded5] rounded-[10px] text-sm"
                  />
                  <input
                    type="text"
                    required
                    value={resetToken}
                    onChange={(e) => setResetToken(e.target.value)}
                    placeholder="RESET-XXXXXX"
                    className="w-full p-3.5 border border-[#d7ded5] rounded-[10px] text-sm font-mono-tabular"
                  />
                  <input
                    type="password"
                    required
                    minLength={8}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="New password (min 8 chars)"
                    className="w-full p-3.5 border border-[#d7ded5] rounded-[10px] text-sm"
                  />
                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full py-4 bg-[#c5fa5a] text-[#132014] font-black text-sm rounded-[15px]"
                  >
                    Update password
                  </button>
                </form>
              </div>
            )}

            {route === 'verify-email' && (
              <div className="space-y-4">
                <div className="inline-flex items-center gap-2 text-xs font-extrabold text-[#467d1c]">
                  <ShieldCheck className="w-4 h-4" />
                  <span>VERIFY EMAIL</span>
                </div>
                <h1 className="font-outfit font-extrabold text-3xl text-[#14201b]">
                  Confirm your email
                </h1>
                {currentUser?.emailVerificationTokenHint && (
                  <p className="text-xs bg-[#eaf5d5] p-3 rounded-lg text-[#415b28] font-bold">
                    Sandbox Verification Code: {currentUser.emailVerificationTokenHint}
                  </p>
                )}
                <form onSubmit={handleVerifyEmail} className="space-y-4">
                  <input
                    type="text"
                    required
                    value={verificationCode}
                    onChange={(e) => setVerificationCode(e.target.value)}
                    placeholder="VERIFY-XXXXXX"
                    className="w-full p-3.5 border border-[#d7ded5] rounded-[10px] text-sm font-mono-tabular"
                  />
                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full py-4 bg-[#c5fa5a] text-[#132014] font-black text-sm rounded-[15px]"
                  >
                    Confirm Code
                  </button>
                </form>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
};
