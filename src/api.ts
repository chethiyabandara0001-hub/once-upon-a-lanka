import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  sendPasswordResetEmail,
  deleteUser,
  type User as FirebaseUser,
} from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  where,
  writeBatch,
} from 'firebase/firestore';
import {
  auth,
  db,
  googleProvider,
  handleFirestoreError,
  OperationType,
  normalizeAndValidateSriLankanNic,
  calculateAgeFromDob,
} from './firebase';
import type {
  AuthenticatedUser,
  DatingIntention,
  DirectMessageItem,
  DiscoverProfileCard,
  GenderType,
  InterestItem,
  LanguageCode,
  MatchSummaryItem,
} from './types';

const TOKEN_STORAGE_KEY = 'ouat_session_token_v1';
const LOCAL_INTERACTIONS_KEY = 'ouat_local_interactions_v1';

export const STANDALONE_INTERESTS: InterestItem[] = [
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

const SEEDED_DISCOVER_PROFILES: DiscoverProfileCard[] = [
  {
    userId: 'usr_kavan',
    displayName: 'Kavan',
    age: 28,
    gender: 'male',
    region: 'Colombo 03',
    bio: 'Architectural designer. Interested in tropical modernism, analog film, and live jazz sessions.',
    avatarUrl: '/src/assets/images/editorial_portrait_kavan_1793978350314.jpg',
    datingIntention: 'meaningful_dating',
    spokenLanguages: ['English', 'Sinhala'],
    interests: [STANDALONE_INTERESTS[2], STANDALONE_INTERESTS[5], STANDALONE_INTERESTS[6]],
    allowRandomVideo: true,
    allowRandomText: true,
  },
  {
    userId: 'usr_dilini',
    displayName: 'Dilini',
    age: 25,
    gender: 'female',
    region: 'Kandy',
    bio: 'Botanist in the Central Highlands. Passionate about endemic hill flora and quiet rainy evenings.',
    avatarUrl: '/src/assets/images/editorial_portrait_dilini_1793978350862.jpg',
    datingIntention: 'long_term_story',
    spokenLanguages: ['Sinhala', 'English'],
    interests: [STANDALONE_INTERESTS[0], STANDALONE_INTERESTS[7], STANDALONE_INTERESTS[4]],
    allowRandomVideo: true,
    allowRandomText: true,
  },
  {
    userId: 'usr_ehan',
    displayName: 'Ehan',
    age: 27,
    gender: 'male',
    region: 'Jaffna',
    bio: 'Sound designer & record collector. Chasing monsoon recordings and old Ceylon vinyls.',
    avatarUrl: '/src/assets/images/editorial_portrait_ehan_1793978352895.jpg',
    datingIntention: 'new_conversations',
    spokenLanguages: ['Tamil', 'English'],
    interests: [STANDALONE_INTERESTS[5], STANDALONE_INTERESTS[1], STANDALONE_INTERESTS[9]],
    allowRandomVideo: true,
    allowRandomText: true,
  },
  {
    userId: 'usr_amaya',
    displayName: 'Amaya',
    age: 26,
    gender: 'female',
    region: 'Colombo 07',
    bio: 'Documentary archivist & tea enthusiast. Weekends spent browsing antique bookshops in Galle Fort.',
    avatarUrl: '/src/assets/images/editorial_portrait_amaya_1793978349458.jpg',
    datingIntention: 'meaningful_dating',
    spokenLanguages: ['English', 'Sinhala'],
    interests: [STANDALONE_INTERESTS[0], STANDALONE_INTERESTS[1], STANDALONE_INTERESTS[4]],
    allowRandomVideo: true,
    allowRandomText: true,
  },
];

interface LocalInteractionsState {
  matches: Array<{
    id: string;
    conversationId: string;
    userAId: string;
    userBId: string;
    partnerCard: DiscoverProfileCard;
    status: 'active' | 'unmatched' | 'blocked';
    createdAt: string;
  }>;
  messages: DirectMessageItem[];
  likes: string[];
  passes: string[];
  blocks: Array<{
    id: string;
    blockerId: string;
    blockedUserId: string;
    blockedDisplayName: string;
    reason: string;
    createdAt: string;
  }>;
  reports: Array<{
    id: string;
    reporter_id: string;
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
}

function loadInteractions(): LocalInteractionsState {
  try {
    const raw = localStorage.getItem(LOCAL_INTERACTIONS_KEY);
    if (raw) {
      return JSON.parse(raw) as LocalInteractionsState;
    }
  } catch {
    // Ignore
  }
  return {
    matches: [],
    messages: [],
    likes: [],
    passes: [],
    blocks: [],
    reports: [],
  };
}

function saveInteractions(state: LocalInteractionsState): void {
  try {
    localStorage.setItem(LOCAL_INTERACTIONS_KEY, JSON.stringify(state));
  } catch {
    // Ignore
  }
}

export function getStoredToken(): string | null {
  if (auth.currentUser) {
    return auth.currentUser.uid;
  }
  try {
    return sessionStorage.getItem(TOKEN_STORAGE_KEY) || localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setStoredToken(token: string | null): void {
  try {
    if (token) {
      sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
      localStorage.setItem(TOKEN_STORAGE_KEY, token);
    } else {
      sessionStorage.removeItem(TOKEN_STORAGE_KEY);
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    }
  } catch {
    // Ignore
  }
}

/**
 * Loads the complete AuthenticatedUser from Firestore (`/users/{uid}` + `/users/{uid}/private/account`).
 */
export async function fetchAuthenticatedUserFromFirestore(
  fbUser: FirebaseUser
): Promise<AuthenticatedUser | null> {
  const uid = fbUser.uid;
  const publicPath = `users/${uid}`;
  const privatePath = `users/${uid}/private/account`;

  let publicSnap;
  let privateSnap;
  try {
    [publicSnap, privateSnap] = await Promise.all([
      getDoc(doc(db, 'users', uid)),
      getDoc(doc(db, 'users', uid, 'private', 'account')),
    ]);
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, publicPath);
  }

  if (!publicSnap.exists() || !privateSnap.exists()) {
    return null;
  }

  const pub = publicSnap.data();
  const priv = privateSnap.data();

  const interestIds: string[] = Array.isArray(pub.interestIds)
    ? pub.interestIds.map(String)
    : ['int_tea', 'int_cinema', 'int_literature'];
  const interests = STANDALONE_INTERESTS.filter((i) => interestIds.includes(i.id));

  const interactions = loadInteractions();
  const activeMatches = interactions.matches.filter(
    (m) => m.status === 'active' && m.userAId === uid
  );

  return {
    id: uid,
    userId: String(priv.userId || uid),
    name: String(priv.name || pub.displayName || 'Member'),
    displayName: String(pub.displayName || priv.displayName || 'Member'),
    email: String(priv.email || fbUser.email || ''),
    dateOfBirth: String(priv.dateOfBirth || '1999-01-01'),
    gender: (priv.gender as GenderType) || (pub.gender as GenderType) || 'prefer_not_to_say',
    nicNumber: String(priv.nicNumber || ''),
    age: Number(pub.age || 24),
    emailVerified: true,
    emailVerificationTokenHint: null,
    role: 'member',
    accountStatus: 'active',
    onboardingCompleted: Boolean(pub.onboardingCompleted),
    preferredLanguage: (pub.preferredLanguage as LanguageCode) || 'en',
    createdAt: new Date().toISOString(),
    profile: {
      avatarUrl:
        String(pub.avatarUrl || '') ||
        '/src/assets/images/editorial_portrait_amaya_1793978349458.jpg',
      bio: String(pub.bio || ''),
      region: String(pub.region || 'Colombo'),
      showRegion: typeof pub.showRegion === 'boolean' ? pub.showRegion : true,
      datingIntention: (pub.datingIntention as DatingIntention) || 'meaningful_dating',
      spokenLanguages: Array.isArray(pub.spokenLanguages)
        ? pub.spokenLanguages.map(String)
        : ['English'],
      discoverable: typeof pub.discoverable === 'boolean' ? pub.discoverable : true,
      allowRandomVideo: typeof pub.allowRandomVideo === 'boolean' ? pub.allowRandomVideo : true,
      allowRandomText: typeof pub.allowRandomText === 'boolean' ? pub.allowRandomText : true,
    },
    interests: interests.length > 0 ? interests : STANDALONE_INTERESTS.slice(0, 3),
    counts: {
      activeMatches: activeMatches.length,
      unreadMessages: 0,
    },
  };
}

/**
 * Atomically creates `/users/{uid}`, `/users/{uid}/private/account`, and `/nic_registry/{nicNumber}`
 * in Firestore, guaranteeing that one Sri Lankan NIC number can only ever be used for one account.
 */
export async function createFirestoreAccountWithUniqueNic(params: {
  fbUser: FirebaseUser;
  name: string;
  displayName: string;
  email: string;
  dateOfBirth: string;
  gender: GenderType;
  nicNumber: string;
  preferredLanguage: LanguageCode;
  cleanupAuthUserOnDuplicateNic?: boolean;
}): Promise<AuthenticatedUser> {
  const {
    fbUser,
    name,
    displayName,
    email,
    dateOfBirth,
    gender,
    nicNumber,
    preferredLanguage,
    cleanupAuthUserOnDuplicateNic = false,
  } = params;

  const cleanName = String(name || '').trim().slice(0, 100);
  const cleanDisplayName = String(displayName || cleanName).trim().slice(0, 50);
  const cleanEmail = String(email || fbUser.email || '').trim().toLowerCase().slice(0, 160);
  const cleanDob = String(dateOfBirth || '').trim();

  if (cleanName.length < 2) {
    throw new Error('Full name must be at least 2 characters.');
  }
  if (cleanDisplayName.length < 2) {
    throw new Error('Display name must be at least 2 characters.');
  }
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(cleanDob)) {
    throw new Error('Please provide a valid date of birth (YYYY-MM-DD).');
  }

  const age = calculateAgeFromDob(cleanDob);
  if (age < 18 || age > 120) {
    throw new Error('Once Upon a Time is strictly for adults aged 18 and older.');
  }

  const validGenders: GenderType[] = ['male', 'female', 'non_binary', 'prefer_not_to_say'];
  const cleanGender: GenderType = validGenders.includes(gender) ? gender : 'prefer_not_to_say';

  const nicValidation = normalizeAndValidateSriLankanNic(nicNumber);
  if (!nicValidation.valid) {
    throw new Error(nicValidation.error || 'Invalid Sri Lankan NIC number.');
  }
  const normalizedNic = nicValidation.normalized;

  // 1. Check if this Sri Lankan NIC number is already registered in /nic_registry/{normalizedNic}
  const nicDocRef = doc(db, 'nic_registry', normalizedNic);
  let existingNicSnap;
  try {
    existingNicSnap = await getDoc(nicDocRef);
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, `nic_registry/${normalizedNic}`);
  }

  if (existingNicSnap.exists()) {
    const existingOwner = existingNicSnap.data()?.ownerId;
    if (existingOwner !== fbUser.uid) {
      if (cleanupAuthUserOnDuplicateNic) {
        try {
          await deleteUser(fbUser);
        } catch {
          await signOut(auth);
        }
      }
      throw new Error(
        `Sri Lankan NIC number ${normalizedNic} is already registered to an existing account. Only one account is permitted per NIC number.`
      );
    }
  }

  // 2. Atomically create /users/{uid}, /users/{uid}/private/account, and /nic_registry/{normalizedNic}
  const uid = fbUser.uid;
  const userPublicRef = doc(db, 'users', uid);
  const userPrivateRef = doc(db, 'users', uid, 'private', 'account');

  const batch = writeBatch(db);

  batch.set(userPublicRef, {
    userId: uid,
    displayName: cleanDisplayName,
    age,
    gender: cleanGender,
    avatarUrl: '/src/assets/images/editorial_portrait_amaya_1793978349458.jpg',
    bio: '',
    region: 'Colombo',
    showRegion: true,
    datingIntention: 'meaningful_dating',
    spokenLanguages: ['English'],
    interestIds: ['int_tea', 'int_cinema', 'int_literature'],
    discoverable: true,
    allowRandomVideo: true,
    allowRandomText: true,
    onboardingCompleted: false,
    preferredLanguage: ['en', 'si', 'ta'].includes(preferredLanguage) ? preferredLanguage : 'en',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  batch.set(userPrivateRef, {
    userId: uid,
    name: cleanName,
    displayName: cleanDisplayName,
    email: cleanEmail,
    dateOfBirth: cleanDob,
    gender: cleanGender,
    nicNumber: normalizedNic,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  batch.set(nicDocRef, {
    nicNumber: normalizedNic,
    ownerId: uid,
    createdAt: serverTimestamp(),
  });

  try {
    await batch.commit();
  } catch (err) {
    if (cleanupAuthUserOnDuplicateNic) {
      try {
        await deleteUser(fbUser);
      } catch {
        // Ignore
      }
    }
    handleFirestoreError(err, OperationType.WRITE, `users/${uid}`);
  }

  const createdUser = await fetchAuthenticatedUserFromFirestore(fbUser);
  if (!createdUser) {
    throw new Error('Failed to load newly created user profile from Firestore.');
  }
  return createdUser;
}

/**
 * Google Sign-In / Sign-Up helper.
 * - For existing users who already have `/users/{uid}/private/account`, logs them right in.
 * - For new users signing up with Google, requires their `name`, `displayName`, `dateOfBirth`, `gender`, and `nicNumber`
 *   to enforce the one-NIC-per-account rule before writing to Firestore.
 */
export async function authenticateWithGooglePopup(registrationFields?: {
  name: string;
  displayName: string;
  dateOfBirth: string;
  gender: GenderType;
  nicNumber: string;
  preferredLanguage: LanguageCode;
}): Promise<{ token: string; user: AuthenticatedUser }> {
  const credential = await signInWithPopup(auth, googleProvider);
  const fbUser = credential.user;

  const existingProfile = await fetchAuthenticatedUserFromFirestore(fbUser);
  if (existingProfile) {
    setStoredToken(fbUser.uid);
    return { token: fbUser.uid, user: existingProfile };
  }

  if (!registrationFields || !registrationFields.nicNumber) {
    await signOut(auth);
    throw new Error(
      'No account found for this Google email yet. Please switch to "Sign up", enter your Full Name, Date of Birth, Gender, and Sri Lankan NIC Number, and click "Sign up with Google".'
    );
  }

  const created = await createFirestoreAccountWithUniqueNic({
    fbUser,
    name: registrationFields.name || fbUser.displayName || 'Member',
    displayName:
      registrationFields.displayName ||
      registrationFields.name ||
      fbUser.displayName ||
      'Member',
    email: fbUser.email || '',
    dateOfBirth: registrationFields.dateOfBirth,
    gender: registrationFields.gender,
    nicNumber: registrationFields.nicNumber,
    preferredLanguage: registrationFields.preferredLanguage,
    cleanupAuthUserOnDuplicateNic: false,
  });

  setStoredToken(fbUser.uid);
  return { token: fbUser.uid, user: created };
}

/**
 * Unified API handler backed by Firebase Authentication and Cloud Firestore.
 */
export async function apiRequest<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const method = (options.method || 'GET').toUpperCase();
  const [rawPath, queryString = ''] = endpoint.split('?');
  const path = rawPath.replace(/\/+$/, '') || '/';
  const params = new URLSearchParams(queryString);
  const body = options.body ? JSON.parse(String(options.body)) : {};

  // 1. Health & Interests
  if (path === '/health' && method === 'GET') {
    return {
      status: 'ok',
      platform: 'Once Upon a Time (Firebase Auth + Firestore)',
    } as unknown as T;
  }

  if (path === '/interests' && method === 'GET') {
    return { interests: STANDALONE_INTERESTS } as unknown as T;
  }

  // 2. Auth Routes (Firebase Authentication + Firestore User & NIC Registry)
  if (path === '/auth/me' && method === 'GET') {
    const fbUser = auth.currentUser;
    if (!fbUser) {
      throw new Error('Not signed in.');
    }
    const user = await fetchAuthenticatedUserFromFirestore(fbUser);
    if (!user) {
      throw new Error('User profile not found in Firestore.');
    }
    return { user } as unknown as T;
  }

  if (path === '/auth/login' && method === 'POST') {
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');

    if (!email || !password) {
      throw new Error('Please enter both your email address and password.');
    }

    try {
      const credential = await signInWithEmailAndPassword(auth, email, password);
      const user = await fetchAuthenticatedUserFromFirestore(credential.user);
      if (!user) {
        throw new Error(
          'Your account record was not found in Firestore. Please register with your Sri Lankan NIC number.'
        );
      }
      setStoredToken(credential.user.uid);
      return { token: credential.user.uid, user } as unknown as T;
    } catch (err) {
      const code = (err as { code?: string })?.code || '';
      if (code === 'auth/operation-not-allowed') {
        throw new Error(
          'FIREBASE_EMAIL_PROVIDER_DISABLED: Email/Password sign-in is not enabled yet in your Firebase Console. Enable Email/Password in Firebase Console > Authentication > Sign-in method, or use "Continue with Google" below.'
        );
      }
      if (
        code === 'auth/invalid-credential' ||
        code === 'auth/user-not-found' ||
        code === 'auth/wrong-password'
      ) {
        throw new Error('Invalid email or password.');
      }
      throw err;
    }
  }

  if (path === '/auth/register' && method === 'POST') {
    const name = String(body.name || body.displayName || '').trim();
    const displayName = String(body.displayName || body.name || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const dateOfBirth = String(body.dateOfBirth || '').trim();
    const gender = (body.gender as GenderType) || 'prefer_not_to_say';
    const nicNumber = String(body.nicNumber || '').trim();
    const preferredLanguage = (body.preferredLanguage as LanguageCode) || 'en';

    if (name.length < 2 || name.length > 100) {
      throw new Error('Full name must be between 2 and 100 characters.');
    }
    if (displayName.length < 2 || displayName.length > 50) {
      throw new Error('Display name must be between 2 and 50 characters.');
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error('Please enter a valid email address.');
    }
    if (password.length < 8) {
      throw new Error('Password must be at least 8 characters long.');
    }
    if (!dateOfBirth) {
      throw new Error('Date of birth is required (18+ only).');
    }

    const age = calculateAgeFromDob(dateOfBirth);
    if (age < 18) {
      throw new Error('Once Upon a Time is strictly restricted to adults aged 18 and older.');
    }

    const nicCheck = normalizeAndValidateSriLankanNic(nicNumber);
    if (!nicCheck.valid) {
      throw new Error(nicCheck.error || 'Please enter a valid Sri Lankan NIC number.');
    }

    let fbUser: FirebaseUser;
    try {
      const credential = await createUserWithEmailAndPassword(auth, email, password);
      fbUser = credential.user;
    } catch (err) {
      const code = (err as { code?: string })?.code || '';
      if (code === 'auth/operation-not-allowed') {
        throw new Error(
          'FIREBASE_EMAIL_PROVIDER_DISABLED: Email/Password sign-up is not enabled yet in your Firebase Console. Enable Email/Password in Firebase Console > Authentication > Sign-in method, or click "Sign up with Google" below (which will still save your Name, DOB, Gender, and unique Sri Lankan NIC to Firestore).'
        );
      }
      if (code === 'auth/email-already-in-use') {
        throw new Error('An account with this email address already exists.');
      }
      throw err;
    }

    const createdUser = await createFirestoreAccountWithUniqueNic({
      fbUser,
      name,
      displayName,
      email,
      dateOfBirth,
      gender,
      nicNumber: nicCheck.normalized,
      preferredLanguage,
      cleanupAuthUserOnDuplicateNic: true,
    });

    setStoredToken(fbUser.uid);
    return { token: fbUser.uid, user: createdUser } as unknown as T;
  }

  if (path === '/auth/logout' && method === 'POST') {
    await signOut(auth);
    setStoredToken(null);
    return { success: true } as unknown as T;
  }

  if (path === '/auth/forgot-password' && method === 'POST') {
    const email = String(body.email || '').trim().toLowerCase();
    if (!email) {
      throw new Error('Please enter your email address.');
    }
    await sendPasswordResetEmail(auth, email);
    return {
      message: 'Password reset link has been sent to your email address via Firebase Auth.',
    } as unknown as T;
  }

  if (path === '/auth/verify-email' && method === 'POST') {
    const fbUser = auth.currentUser;
    if (!fbUser) throw new Error('Not signed in.');
    const user = await fetchAuthenticatedUserFromFirestore(fbUser);
    return { user } as unknown as T;
  }

  // 3. Profile Update (Updates Firestore `/users/{uid}` and `/users/{uid}/private/account`)
  if (path === '/profile' && method === 'PUT') {
    const fbUser = auth.currentUser;
    if (!fbUser) {
      throw new Error('Authentication required.');
    }
    const uid = fbUser.uid;
    const current = await fetchAuthenticatedUserFromFirestore(fbUser);
    if (!current) {
      throw new Error('Profile not found in Firestore.');
    }

    const updatedName =
      typeof body.name === 'string' && body.name.trim().length >= 2
        ? body.name.trim().slice(0, 100)
        : current.name;
    const updatedDisplayName =
      typeof body.displayName === 'string' && body.displayName.trim().length >= 2
        ? body.displayName.trim().slice(0, 50)
        : current.displayName;
    const updatedGender: GenderType =
      body.gender &&
      ['male', 'female', 'non_binary', 'prefer_not_to_say'].includes(body.gender)
        ? (body.gender as GenderType)
        : current.gender;
    const updatedDob =
      typeof body.dateOfBirth === 'string' &&
      /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(body.dateOfBirth)
        ? body.dateOfBirth
        : current.dateOfBirth;
    const updatedAge = calculateAgeFromDob(updatedDob) >= 18 ? calculateAgeFromDob(updatedDob) : current.age;

    const updatedAvatarUrl =
      typeof body.avatarUrl === 'string' && body.avatarUrl.trim()
        ? body.avatarUrl.trim().slice(0, 2048)
        : current.profile?.avatarUrl ||
          '/src/assets/images/editorial_portrait_amaya_1793978349458.jpg';
    const updatedBio =
      typeof body.bio === 'string'
        ? body.bio.trim().slice(0, 500)
        : current.profile?.bio || '';
    const updatedRegion =
      typeof body.region === 'string'
        ? body.region.trim().slice(0, 60)
        : current.profile?.region || 'Colombo';
    const updatedShowRegion =
      typeof body.showRegion === 'boolean'
        ? body.showRegion
        : current.profile?.showRegion ?? true;
    const updatedIntention: DatingIntention =
      body.datingIntention &&
      ['long_term_story', 'meaningful_dating', 'new_conversations', 'friendship_first'].includes(
        body.datingIntention
      )
        ? (body.datingIntention as DatingIntention)
        : current.profile?.datingIntention || 'meaningful_dating';
    const updatedLanguages: string[] =
      Array.isArray(body.spokenLanguages) && body.spokenLanguages.length > 0
        ? body.spokenLanguages.map((s: unknown) => String(s).slice(0, 30)).slice(0, 5)
        : current.profile?.spokenLanguages || ['English'];
    const updatedInterestIds: string[] =
      Array.isArray(body.interestIds) && body.interestIds.length > 0
        ? body.interestIds.map((s: unknown) => String(s).slice(0, 40)).slice(0, 6)
        : current.interests.map((i) => i.id);
    const updatedDiscoverable =
      typeof body.discoverable === 'boolean'
        ? body.discoverable
        : current.profile?.discoverable ?? true;
    const updatedAllowVideo =
      typeof body.allowRandomVideo === 'boolean'
        ? body.allowRandomVideo
        : current.profile?.allowRandomVideo ?? true;
    const updatedAllowText =
      typeof body.allowRandomText === 'boolean'
        ? body.allowRandomText
        : current.profile?.allowRandomText ?? true;

    const batch = writeBatch(db);
    batch.update(doc(db, 'users', uid), {
      displayName: updatedDisplayName,
      age: updatedAge,
      gender: updatedGender,
      avatarUrl: updatedAvatarUrl,
      bio: updatedBio,
      region: updatedRegion,
      showRegion: updatedShowRegion,
      datingIntention: updatedIntention,
      spokenLanguages: updatedLanguages,
      interestIds: updatedInterestIds,
      discoverable: updatedDiscoverable,
      allowRandomVideo: updatedAllowVideo,
      allowRandomText: updatedAllowText,
      onboardingCompleted: true,
      preferredLanguage: current.preferredLanguage,
      updatedAt: serverTimestamp(),
    });

    batch.update(doc(db, 'users', uid, 'private', 'account'), {
      name: updatedName,
      displayName: updatedDisplayName,
      dateOfBirth: updatedDob,
      gender: updatedGender,
      updatedAt: serverTimestamp(),
    });

    try {
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `users/${uid}`);
    }

    const refreshed = await fetchAuthenticatedUserFromFirestore(fbUser);
    return { user: refreshed } as unknown as T;
  }

  if (path === '/account' && method === 'DELETE') {
    await signOut(auth);
    setStoredToken(null);
    return { deleted: true } as unknown as T;
  }

  // 4. Discover & Matching (Queries real Firestore discoverable profiles + seeded profiles)
  if (path === '/discover' && method === 'GET') {
    const uid = auth.currentUser?.uid || '';
    const intention = params.get('intention') || 'all';
    const interestId = params.get('interestId') || 'all';
    const interactions = loadInteractions();

    const blockedIds = new Set(
      interactions.blocks
        .filter((b) => b.blockerId === uid)
        .map((b) => b.blockedUserId)
    );

    const firestoreProfiles: DiscoverProfileCard[] = [];
    if (auth.currentUser) {
      try {
        const q = query(collection(db, 'users'), where('discoverable', '==', true));
        const snap = await getDocs(q);
        snap.forEach((docSnap) => {
          const d = docSnap.data();
          if (d.userId && d.userId !== uid) {
            const ids: string[] = Array.isArray(d.interestIds) ? d.interestIds.map(String) : [];
            firestoreProfiles.push({
              userId: String(d.userId),
              displayName: String(d.displayName || 'Member'),
              age: Number(d.age || 24),
              gender: (d.gender as GenderType) || 'prefer_not_to_say',
              region: d.showRegion ? String(d.region || 'Sri Lanka') : '',
              bio: String(d.bio || ''),
              avatarUrl:
                String(d.avatarUrl || '') ||
                '/src/assets/images/editorial_portrait_amaya_1793978349458.jpg',
              datingIntention: (d.datingIntention as DatingIntention) || 'meaningful_dating',
              spokenLanguages: Array.isArray(d.spokenLanguages)
                ? d.spokenLanguages.map(String)
                : ['English'],
              interests: STANDALONE_INTERESTS.filter((i) => ids.includes(i.id)),
              allowRandomVideo: Boolean(d.allowRandomVideo ?? true),
              allowRandomText: Boolean(d.allowRandomText ?? true),
            });
          }
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.LIST, 'users');
      }
    }

    const mergedMap = new Map<string, DiscoverProfileCard>();
    for (const p of [...firestoreProfiles, ...SEEDED_DISCOVER_PROFILES]) {
      if (p.userId !== uid && !mergedMap.has(p.userId)) {
        mergedMap.set(p.userId, p);
      }
    }

    const filtered = Array.from(mergedMap.values()).filter((candidate) => {
      if (blockedIds.has(candidate.userId)) return false;
      if (interactions.passes.includes(`${uid}:${candidate.userId}`)) return false;
      if (interactions.likes.includes(`${uid}:${candidate.userId}`)) return false;
      if (intention !== 'all' && candidate.datingIntention !== intention) return false;
      if (interestId !== 'all' && !candidate.interests.some((i) => i.id === interestId)) {
        return false;
      }
      return true;
    });

    return { profiles: filtered } as unknown as T;
  }

  if (path === '/discover/reset-passes' && method === 'POST') {
    const uid = auth.currentUser?.uid || '';
    const interactions = loadInteractions();
    interactions.passes = interactions.passes.filter((k) => !k.startsWith(`${uid}:`));
    saveInteractions(interactions);
    return { reset: true } as unknown as T;
  }

  if (path === '/discover/action' && method === 'POST') {
    const uid = auth.currentUser?.uid || '';
    const targetUserId = String(body.targetUserId || '');
    const action = body.action === 'like' ? 'like' : 'pass';
    const interactions = loadInteractions();

    if (action === 'pass') {
      interactions.passes.push(`${uid}:${targetUserId}`);
      saveInteractions(interactions);
      return {
        matched: false,
        conversationId: null,
        partnerProfile: null,
      } as unknown as T;
    }

    interactions.likes.push(`${uid}:${targetUserId}`);
    let partnerProfile = SEEDED_DISCOVER_PROFILES.find((p) => p.userId === targetUserId) || null;
    if (!partnerProfile && auth.currentUser) {
      try {
        const snap = await getDoc(doc(db, 'users', targetUserId));
        if (snap.exists()) {
          const d = snap.data();
          const ids: string[] = Array.isArray(d.interestIds) ? d.interestIds.map(String) : [];
          partnerProfile = {
            userId: String(d.userId),
            displayName: String(d.displayName || 'Member'),
            age: Number(d.age || 24),
            gender: (d.gender as GenderType) || 'prefer_not_to_say',
            region: d.showRegion ? String(d.region || 'Sri Lanka') : '',
            bio: String(d.bio || ''),
            avatarUrl:
              String(d.avatarUrl || '') ||
              '/src/assets/images/editorial_portrait_amaya_1793978349458.jpg',
            datingIntention: (d.datingIntention as DatingIntention) || 'meaningful_dating',
            spokenLanguages: Array.isArray(d.spokenLanguages)
              ? d.spokenLanguages.map(String)
              : ['English'],
            interests: STANDALONE_INTERESTS.filter((i) => ids.includes(i.id)),
            allowRandomVideo: true,
            allowRandomText: true,
          };
        }
      } catch {
        // Ignore
      }
    }

    if (!partnerProfile) {
      partnerProfile = SEEDED_DISCOVER_PROFILES[0];
    }

    let matchRecord = interactions.matches.find(
      (m) => m.userAId === uid && m.userBId === targetUserId
    );
    if (!matchRecord) {
      matchRecord = {
        id: `mtc_${Date.now().toString(36)}`,
        conversationId: `cnv_${Date.now().toString(36)}`,
        userAId: uid,
        userBId: targetUserId,
        partnerCard: partnerProfile,
        status: 'active',
        createdAt: new Date().toISOString(),
      };
      interactions.matches.unshift(matchRecord);
      interactions.messages.push({
        id: `msg_${Date.now().toString(36)}`,
        conversation_id: matchRecord.conversationId,
        sender_id: targetUserId,
        body: `Hi! Great matching with you on Once Upon a Time.`,
        read_at: null,
        created_at: new Date().toISOString(),
      });
    }
    saveInteractions(interactions);

    return {
      matched: true,
      conversationId: matchRecord.conversationId,
      partnerProfile,
    } as unknown as T;
  }

  // 5. Matches & Conversations
  if (path === '/matches' && method === 'GET') {
    const uid = auth.currentUser?.uid || '';
    const interactions = loadInteractions();
    const matches: MatchSummaryItem[] = interactions.matches
      .filter((m) => m.status === 'active' && m.userAId === uid)
      .map((m) => {
        const msgs = interactions.messages.filter(
          (msg) => msg.conversation_id === m.conversationId
        );
        const lastMessage = msgs.length > 0 ? msgs[msgs.length - 1] : null;
        return {
          matchId: m.id,
          conversationId: m.conversationId,
          matchedAt: m.createdAt,
          partner: m.partnerCard,
          lastMessage,
          unreadCount: 0,
        };
      });
    return { matches } as unknown as T;
  }

  const convMatch = path.match(/^\/conversations\/([^/]+)\/messages$/);
  if (convMatch) {
    const uid = auth.currentUser?.uid || '';
    const convId = convMatch[1];
    const interactions = loadInteractions();
    const matchObj = interactions.matches.find((m) => m.conversationId === convId);
    const partner = matchObj?.partnerCard || SEEDED_DISCOVER_PROFILES[0];

    if (method === 'GET') {
      const messages = interactions.messages.filter((m) => m.conversation_id === convId);
      return {
        messages,
        partner,
      } as unknown as T;
    }

    if (method === 'POST') {
      const cleanBody = String(body.body || '').trim();
      const newMessage: DirectMessageItem = {
        id: `msg_${Date.now().toString(36)}`,
        conversation_id: convId,
        sender_id: uid,
        body: cleanBody,
        read_at: null,
        created_at: new Date().toISOString(),
      };
      interactions.messages.push(newMessage);
      saveInteractions(interactions);
      return { message: newMessage } as unknown as T;
    }
  }

  // 6. Safety Blocks & Reports
  if (path === '/safety/blocks' && method === 'GET') {
    const uid = auth.currentUser?.uid || '';
    const interactions = loadInteractions();
    return {
      blocks: interactions.blocks.filter((b) => b.blockerId === uid),
    } as unknown as T;
  }

  if (path === '/safety/block' && method === 'POST') {
    const uid = auth.currentUser?.uid || '';
    const targetUserId = String(body.targetUserId || 'usr_stranger');
    const interactions = loadInteractions();
    const seeded = SEEDED_DISCOVER_PROFILES.find((p) => p.userId === targetUserId);
    interactions.blocks.push({
      id: `blk_${Date.now().toString(36)}`,
      blockerId: uid,
      blockedUserId: targetUserId,
      blockedDisplayName: seeded?.displayName || 'Member',
      reason: String(body.reason || 'Blocked by user'),
      createdAt: new Date().toISOString(),
    });
    saveInteractions(interactions);
    return { blocked: true, targetUserId } as unknown as T;
  }

  const unblockMatch = path.match(/^\/safety\/blocks\/([^/]+)$/);
  if (unblockMatch && method === 'DELETE') {
    const uid = auth.currentUser?.uid || '';
    const targetId = unblockMatch[1];
    const interactions = loadInteractions();
    interactions.blocks = interactions.blocks.filter(
      (b) => !(b.blockerId === uid && b.blockedUserId === targetId)
    );
    saveInteractions(interactions);
    return { unblocked: true } as unknown as T;
  }

  if (path === '/safety/report' && method === 'POST') {
    const uid = auth.currentUser?.uid || '';
    const interactions = loadInteractions();
    const report = {
      id: `rep_${Date.now().toString(36)}`,
      reporter_id: uid,
      reporterName: auth.currentUser?.displayName || 'Member',
      reported_user_id: String(body.reportedUserId || 'usr_stranger'),
      reportedName: 'Reported Member',
      reportedStatus: 'active',
      context_type: String(body.contextType || 'random_video'),
      reason: String(body.reason || 'harassment_or_abuse'),
      details: String(body.details || ''),
      status: 'open',
      priority: 'normal',
      created_at: new Date().toISOString(),
    };
    interactions.reports.unshift(report);
    saveInteractions(interactions);
    return { reportId: report.id, status: 'open' } as unknown as T;
  }

  return {} as unknown as T;
}
