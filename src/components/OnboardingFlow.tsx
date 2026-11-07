import React, { useState } from 'react';
import { Upload, Check, ArrowRight, Shield } from 'lucide-react';
import type {
  AuthenticatedUser,
  DatingIntention,
  InterestItem,
  LanguageCode,
} from '../types';
import {
  EDITORIAL_PORTRAIT_PRESETS,
  INTENTION_LABELS,
  getInterestLabel,
} from '../i18n';
import { apiRequest } from '../api';
import { EditorialImage } from './EditorialImage';

interface OnboardingFlowProps {
  user: AuthenticatedUser;
  interestsCatalog: InterestItem[];
  language: LanguageCode;
  onComplete: (updatedUser: AuthenticatedUser) => void;
}

export const OnboardingFlow: React.FC<OnboardingFlowProps> = ({
  user,
  interestsCatalog,
  language,
  onComplete,
}) => {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [displayName, setDisplayName] = useState(user.displayName);
  const [avatarUrl, setAvatarUrl] = useState(
    user.profile?.avatarUrl || EDITORIAL_PORTRAIT_PRESETS[0].url
  );
  const [bio, setBio] = useState(user.profile?.bio || '');
  const [region, setRegion] = useState(user.profile?.region || 'Colombo');
  const [showRegion, setShowRegion] = useState(user.profile?.showRegion ?? true);
  const [datingIntention, setDatingIntention] = useState<DatingIntention>(
    user.profile?.datingIntention || 'long_term_story'
  );
  const [spokenLanguages, setSpokenLanguages] = useState<string[]>(
    user.profile?.spokenLanguages || ['English', 'Sinhala']
  );
  const [selectedInterestIds, setSelectedInterestIds] = useState<string[]>(
    user.interests.length > 0
      ? user.interests.map((i) => i.id)
      : interestsCatalog.slice(0, 3).map((i) => i.id)
  );
  const [discoverable, setDiscoverable] = useState(user.profile?.discoverable ?? true);
  const [allowRandomVideo, setAllowRandomVideo] = useState(
    user.profile?.allowRandomVideo ?? true
  );
  const [allowRandomText, setAllowRandomText] = useState(
    user.profile?.allowRandomText ?? true
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 1.5 * 1024 * 1024) {
      setError('Please choose an image smaller than 1.5 MB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setAvatarUrl(reader.result);
      }
    };
    reader.readAsDataURL(file);
  };

  const toggleLanguage = (langName: string) => {
    setSpokenLanguages((prev) => {
      if (prev.includes(langName)) {
        return prev.length > 1 ? prev.filter((l) => l !== langName) : prev;
      }
      return [...prev, langName];
    });
  };

  const toggleInterest = (id: string) => {
    setSelectedInterestIds((prev) => {
      if (prev.includes(id)) {
        return prev.filter((item) => item !== id);
      }
      if (prev.length >= 6) return prev;
      return [...prev, id];
    });
  };

  const handleFinishOnboarding = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await apiRequest<{ user: AuthenticatedUser }>('/profile', {
        method: 'PUT',
        body: JSON.stringify({
          displayName,
          avatarUrl,
          bio,
          region,
          showRegion,
          datingIntention,
          spokenLanguages,
          interestIds: selectedInterestIds,
          discoverable,
          allowRandomVideo,
          allowRandomText,
          onboardingCompleted: true,
        }),
      });
      onComplete(res.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#f5f6f2] text-[#14201b] py-12 px-6">
      <div className="max-w-3xl mx-auto space-y-8">
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div>
            <p className="text-xs font-black text-[#557d27] uppercase tracking-widest">
              PROFILE SETUP · STEP 0{step} OF 03
            </p>
            <h1 className="font-outfit font-extrabold text-3xl md:text-5xl text-[#14201b] mt-1">
              Set up your story.
            </h1>
          </div>
          <button
            type="button"
            onClick={handleFinishOnboarding}
            className="text-xs font-extrabold text-[#467d1c] hover:underline"
          >
            Skip optional fields ↗
          </button>
        </div>

        {error && (
          <div className="p-3.5 rounded-xl bg-red-50 border border-red-200 text-xs text-red-900 font-bold">
            {error}
          </div>
        )}

        <div className="p-8 md:p-10 rounded-[26px] bg-white border border-[#e7ebe5] shadow-[0_12px_40px_rgba(24,39,29,0.06)] space-y-8">
          {step === 1 && (
            <div className="space-y-6">
              <div>
                <h2 className="font-outfit font-extrabold text-2xl text-[#14201b]">
                  01. Photo, Display Name & Bio
                </h2>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-12 gap-6 items-start">
                <div className="md:col-span-4 space-y-3">
                  <div className="aspect-[3/4] rounded-[22px] overflow-hidden border-4 border-[#17221c]">
                    <EditorialImage
                      src={avatarUrl}
                      alt={displayName}
                      aspectClassName="w-full h-full"
                    />
                  </div>
                  <label className="w-full py-2.5 px-3 rounded-xl bg-[#f0f7e3] hover:bg-[#dff4b3] text-xs font-extrabold text-[#14201b] flex items-center justify-center gap-2 cursor-pointer">
                    <Upload className="w-3.5 h-3.5" />
                    <span>Upload Photo</span>
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handleFileUpload}
                      className="hidden"
                    />
                  </label>
                </div>

                <div className="md:col-span-8 space-y-5">

                  <div>
                    <label className="block text-xs font-extrabold mb-1.5">Display Name</label>
                    <input
                      type="text"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      className="w-full p-3.5 border border-[#d7ded5] rounded-[12px] text-sm"
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-xs font-extrabold">Short Bio</label>
                      <span className="text-[11px] font-bold text-[#557d27]">Optional</span>
                    </div>
                    <textarea
                      rows={3}
                      maxLength={500}
                      value={bio}
                      onChange={(e) => setBio(e.target.value)}
                      placeholder="A line or two about what you enjoy..."
                      className="w-full p-3.5 border border-[#d7ded5] rounded-[12px] text-sm"
                    />
                  </div>
                </div>
              </div>

              <div className="flex justify-end pt-2">
                <button
                  type="button"
                  onClick={() => setStep(2)}
                  className="px-6 py-3.5 bg-[#c5fa5a] hover:bg-[#b8f244] text-[#14201b] font-black text-xs rounded-[14px] inline-flex items-center gap-2"
                >
                  <span>Next: Interests & Languages</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-6">
              <h2 className="font-outfit font-extrabold text-2xl text-[#14201b]">
                02. Languages, Intentions & Shared Interests
              </h2>

              <div>
                <label className="block text-xs font-extrabold mb-2">Spoken Languages</label>
                <div className="flex flex-wrap gap-2">
                  {['English', 'Sinhala', 'Tamil'].map((lang) => {
                    const active = spokenLanguages.includes(lang);
                    return (
                      <button
                        key={lang}
                        type="button"
                        onClick={() => toggleLanguage(lang)}
                        className={`px-4 py-2 rounded-full text-xs font-extrabold transition-colors ${
                          active
                            ? 'bg-[#17221c] text-[#c5fa5a]'
                            : 'bg-[#f5f6f2] text-[#14201b] border border-[#d7ded5]'
                        }`}
                      >
                        {lang}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <label className="block text-xs font-extrabold mb-2">Dating Intention</label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {(Object.keys(INTENTION_LABELS) as DatingIntention[]).map((key) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setDatingIntention(key)}
                      className={`p-3.5 rounded-xl border text-left text-xs font-bold flex items-center justify-between ${
                        datingIntention === key
                          ? 'border-[#17221c] bg-[#dff4b3] text-[#14201b]'
                          : 'border-[#d7ded5] bg-white text-[#6d7a72]'
                      }`}
                    >
                      <span>{INTENTION_LABELS[key]}</span>
                      {datingIntention === key && <Check className="w-4 h-4 text-[#14201b]" />}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-extrabold mb-2">
                  Select up to 6 Interests ({selectedInterestIds.length}/6)
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {interestsCatalog.map((item) => {
                    const active = selectedInterestIds.includes(item.id);
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => toggleInterest(item.id)}
                        className={`px-3.5 py-2.5 rounded-xl border text-xs font-bold text-left ${
                          active
                            ? 'border-[#17221c] bg-[#17221c] text-[#c5fa5a]'
                            : 'border-[#e7ebe5] bg-[#f5f6f2] text-[#14201b]'
                        }`}
                      >
                        {getInterestLabel(item, language)}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="flex items-center justify-between pt-4">
                <button
                  type="button"
                  onClick={() => setStep(1)}
                  className="text-xs font-extrabold text-[#6d7a72]"
                >
                  ← Back
                </button>
                <button
                  type="button"
                  onClick={() => setStep(3)}
                  className="px-6 py-3.5 bg-[#c5fa5a] text-[#14201b] font-black text-xs rounded-[14px] inline-flex items-center gap-2"
                >
                  <span>Next: Privacy Controls</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-6">
              <h2 className="font-outfit font-extrabold text-2xl text-[#14201b]">
                03. Privacy & Discovery Controls
              </h2>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-extrabold mb-1.5">
                    General Region (Optional)
                  </label>
                  <input
                    type="text"
                    value={region}
                    onChange={(e) => setRegion(e.target.value)}
                    placeholder="Colombo, Kandy, Galle..."
                    className="w-full p-3.5 border border-[#d7ded5] rounded-[12px] text-sm"
                  />
                </div>
                <div className="flex flex-col justify-end">
                  <label className="flex items-center gap-2.5 text-xs font-bold p-3.5 rounded-xl bg-[#f5f6f2] border border-[#e7ebe5] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={showRegion}
                      onChange={(e) => setShowRegion(e.target.checked)}
                      className="accent-[#14201b]"
                    />
                    <span>Show general region on my profile</span>
                  </label>
                </div>
              </div>

              <div className="space-y-2.5">
                {[
                  {
                    label: 'Show my profile in Dating Discovery',
                    checked: discoverable,
                    set: setDiscoverable,
                  },
                  {
                    label: 'Allow Random Video Chat pairing',
                    checked: allowRandomVideo,
                    set: setAllowRandomVideo,
                  },
                  {
                    label: 'Allow Random Text Chat pairing',
                    checked: allowRandomText,
                    set: setAllowRandomText,
                  },
                ].map((row) => (
                  <label
                    key={row.label}
                    className="flex items-center justify-between p-3.5 rounded-xl bg-[#f5f6f2] border border-[#e7ebe5] text-xs font-bold cursor-pointer"
                  >
                    <span>{row.label}</span>
                    <input
                      type="checkbox"
                      checked={row.checked}
                      onChange={(e) => row.set(e.target.checked)}
                      className="accent-[#14201b]"
                    />
                  </label>
                ))}
              </div>

              <div className="p-4 rounded-xl bg-[#eaf5d5] text-[#415b28] flex items-start gap-2.5 text-xs font-bold">
                <Shield className="w-4 h-4 shrink-0 mt-0.5" />
                <span>
                  Exact birthdates, email addresses, and private account details are never shown
                  publicly.
                </span>
              </div>

              <div className="flex items-center justify-between pt-4">
                <button
                  type="button"
                  onClick={() => setStep(2)}
                  className="text-xs font-extrabold text-[#6d7a72]"
                >
                  ← Back
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={handleFinishOnboarding}
                  className="px-7 py-4 bg-[#c5fa5a] hover:bg-[#b8f244] text-[#14201b] font-black text-xs rounded-[15px]"
                >
                  {saving ? 'Saving...' : 'Finish & Enter Once Upon a Time ↗'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
