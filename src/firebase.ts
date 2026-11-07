import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import { getFirestore, doc, getDocFromServer } from 'firebase/firestore';
import firebaseConfig from './firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

/**
 * Validates connection to Firestore on initial boot.
 */
async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}
testConnection();

/**
 * Validates and normalizes a Sri Lankan National Identity Card (NIC) number.
 * Supports:
 * - Old NIC format: 9 digits + V or X (e.g., 981234567V)
 * - New NIC format: 12 digits (e.g., 199812345678)
 */
export function normalizeAndValidateSriLankanNic(raw: string): {
  valid: boolean;
  normalized: string;
  error?: string;
} {
  const cleaned = String(raw || '')
    .trim()
    .replace(/\s+/g, '')
    .toUpperCase();

  if (!cleaned) {
    return {
      valid: false,
      normalized: '',
      error: 'Sri Lankan National Identity Card (NIC) number is required.',
    };
  }

  const nicRegex = /^([0-9]{9}[VX]|[0-9]{12})$/;
  if (!nicRegex.test(cleaned)) {
    return {
      valid: false,
      normalized: cleaned,
      error:
        'Please enter a valid Sri Lankan NIC number (9 digits ending in V/X, e.g. 981234567V, or 12 digits, e.g. 199812345678).',
    };
  }

  return {
    valid: true,
    normalized: cleaned,
  };
}

export function calculateAgeFromDob(dateOfBirth: string): number {
  const dob = new Date(`${dateOfBirth}T00:00:00Z`);
  if (Number.isNaN(dob.getTime())) return 0;
  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const m = now.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < dob.getUTCDate())) {
    age--;
  }
  return age;
}
