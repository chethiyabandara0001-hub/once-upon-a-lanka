/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import type {
  AuthenticatedUser,
  InterestItem,
  LanguageCode,
  PublicRoute,
} from './types';
import { auth } from './firebase';
import {
  apiRequest,
  fetchAuthenticatedUserFromFirestore,
  setStoredToken,
} from './api';
import { LandingPage } from './components/LandingPage';
import { AuthViews } from './components/AuthViews';
import { OnboardingFlow } from './components/OnboardingFlow';
import { DashboardShell } from './components/DashboardShell';

export default function App() {
  const [route, setRoute] = useState<PublicRoute>('landing');
  const [language, setLanguage] = useState<LanguageCode>('en');
  const [currentUser, setCurrentUser] = useState<AuthenticatedUser | null>(null);
  const [interestsCatalog, setInterestsCatalog] = useState<InterestItem[]>([]);
  const [bootstrapping, setBootstrapping] = useState(true);

  useEffect(() => {
    let mounted = true;

    apiRequest<{ interests: InterestItem[] }>('/interests')
      .then((res) => {
        if (mounted) {
          setInterestsCatalog(res.interests);
        }
      })
      .catch(() => {
        // Ignore
      });

    const unsubscribe = onAuthStateChanged(auth, async (fbUser) => {
      if (!mounted) return;
      if (!fbUser) {
        setStoredToken(null);
        setCurrentUser(null);
        setBootstrapping(false);
        return;
      }

      try {
        const userDoc = await fetchAuthenticatedUserFromFirestore(fbUser);
        if (mounted && userDoc) {
          setStoredToken(fbUser.uid);
          setCurrentUser(userDoc);
          setLanguage(userDoc.preferredLanguage || 'en');
        }
      } catch {
        // If user is mid-registration, handleAuthSuccess will update currentUser once batch commits
      } finally {
        if (mounted) {
          setBootstrapping(false);
        }
      }
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const handleAuthSuccess = (user: AuthenticatedUser) => {
    setCurrentUser(user);
    setLanguage(user.preferredLanguage || language);
    if (!user.onboardingCompleted) {
      setRoute('onboarding');
    } else {
      setRoute('landing');
    }
  };

  const handleLogout = async () => {
    try {
      await apiRequest('/auth/logout', { method: 'POST' });
    } catch {
      // Ignore
    }
    setStoredToken(null);
    setCurrentUser(null);
    setRoute('landing');
  };

  if (bootstrapping) {
    return (
      <div className="min-h-screen bg-[#101417] text-white flex items-center justify-center">
        <div className="text-center space-y-3">
          <div className="font-outfit text-3xl font-black tracking-[-0.06em] flex items-center justify-center gap-2.5">
            <span className="brand-leaf">✦</span>
            <span>
              once upon a time<span className="text-[#c5fa5a]">.</span>
            </span>
          </div>
          <p className="text-xs text-[#96a49a]">Every connection has a story...</p>
        </div>
      </div>
    );
  }

  if (currentUser && route === 'verify-email') {
    return (
      <AuthViews
        route="verify-email"
        language={language}
        currentUser={currentUser}
        onNavigate={setRoute}
        onAuthSuccess={(updated) => {
          setCurrentUser(updated);
          setRoute('landing');
        }}
      />
    );
  }

  if (currentUser && (!currentUser.onboardingCompleted || route === 'onboarding')) {
    return (
      <OnboardingFlow
        user={currentUser}
        interestsCatalog={interestsCatalog}
        language={language}
        onComplete={(updated) => {
          setCurrentUser(updated);
          setRoute('landing');
        }}
      />
    );
  }

  if (currentUser) {
    return (
      <DashboardShell
        user={currentUser}
        interestsCatalog={interestsCatalog}
        language={language}
        onLanguageChange={setLanguage}
        onUserUpdate={setCurrentUser}
        onLogout={handleLogout}
        onVerifyEmailRoute={() => setRoute('verify-email')}
      />
    );
  }

  if (
    route === 'login' ||
    route === 'register' ||
    route === 'forgot-password' ||
    route === 'reset-password' ||
    route === 'verify-email'
  ) {
    return (
      <AuthViews
        route={route}
        language={language}
        currentUser={currentUser}
        onNavigate={setRoute}
        onAuthSuccess={handleAuthSuccess}
      />
    );
  }

  return (
    <LandingPage
      language={language}
      onLanguageChange={setLanguage}
      onNavigate={setRoute}
      onAuthSuccess={handleAuthSuccess}
    />
  );
}
