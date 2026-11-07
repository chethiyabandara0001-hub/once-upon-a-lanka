/**
 * Firestore Security Rules — Dirty Dozen Adversarial Payload Verification Suite
 * Verifies that all 12 adversarial payloads defined in security_spec.md are rejected.
 */

export interface AdversarialPayloadTestCase {
  id: number;
  name: string;
  collectionPath: string;
  operation: 'get' | 'list' | 'create' | 'update' | 'delete';
  authUid: string | null;
  payload?: Record<string, unknown>;
  expectedOutcome: 'PERMISSION_DENIED';
}

export const DIRTY_DOZEN_SECURITY_TESTS: AdversarialPayloadTestCase[] = [
  {
    id: 1,
    name: 'Duplicate NIC Hijack',
    collectionPath: '/nic_registry/199812345678',
    operation: 'update',
    authUid: 'usr_attacker',
    payload: {
      nicNumber: '199812345678',
      ownerId: 'usr_attacker',
      createdAt: 'SERVER_TIMESTAMP',
    },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 2,
    name: 'Orphaned NIC Claim without Private Account Document',
    collectionPath: '/nic_registry/199912345678',
    operation: 'create',
    authUid: 'usr_attacker',
    payload: {
      nicNumber: '199912345678',
      ownerId: 'usr_attacker',
      createdAt: 'SERVER_TIMESTAMP',
    },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 3,
    name: 'Unregistered NIC Account Creation',
    collectionPath: '/users/usr_attacker/private/account',
    operation: 'create',
    authUid: 'usr_attacker',
    payload: {
      userId: 'usr_attacker',
      name: 'Kasun Perera',
      displayName: 'Kasun',
      email: 'kasun@example.lk',
      dateOfBirth: '1998-05-10',
      gender: 'male',
      nicNumber: '199812345678',
      createdAt: 'SERVER_TIMESTAMP',
      updatedAt: 'SERVER_TIMESTAMP',
    },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 4,
    name: 'NIC Mutation on Update',
    collectionPath: '/users/usr_victim/private/account',
    operation: 'update',
    authUid: 'usr_victim',
    payload: {
      nicNumber: '200012345678',
      updatedAt: 'SERVER_TIMESTAMP',
    },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 5,
    name: 'Cross-User PII Read',
    collectionPath: '/users/usr_victim/private/account',
    operation: 'get',
    authUid: 'usr_attacker',
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 6,
    name: 'Shadow Field Injection',
    collectionPath: '/users/usr_attacker',
    operation: 'create',
    authUid: 'usr_attacker',
    payload: {
      userId: 'usr_attacker',
      displayName: 'Attacker',
      isAdmin: true,
    },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 7,
    name: 'Identity Spoofing',
    collectionPath: '/users/usr_victim',
    operation: 'create',
    authUid: 'usr_attacker',
    payload: {
      userId: 'usr_victim',
      displayName: 'Spoofed',
    },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 8,
    name: 'Invalid Sri Lankan NIC Format',
    collectionPath: '/nic_registry/INVALID_NIC',
    operation: 'create',
    authUid: 'usr_attacker',
    payload: {
      nicNumber: 'INVALID_NIC',
      ownerId: 'usr_attacker',
      createdAt: 'SERVER_TIMESTAMP',
    },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 9,
    name: 'Timestamp Forgery',
    collectionPath: '/users/usr_attacker',
    operation: 'update',
    authUid: 'usr_attacker',
    payload: {
      displayName: 'Forged Time',
      updatedAt: '2020-01-01T00:00:00Z',
    },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 10,
    name: 'Oversized Payload / Denial of Wallet',
    collectionPath: '/users/usr_attacker',
    operation: 'update',
    authUid: 'usr_attacker',
    payload: {
      bio: 'A'.repeat(5000),
      updatedAt: 'SERVER_TIMESTAMP',
    },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 11,
    name: 'Underage Profile Creation',
    collectionPath: '/users/usr_attacker',
    operation: 'create',
    authUid: 'usr_attacker',
    payload: {
      userId: 'usr_attacker',
      displayName: 'Minor',
      age: 16,
    },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 12,
    name: 'Blanket Unfiltered List Query on PII or Non-Discoverable Profiles',
    collectionPath: '/users/usr_victim/private',
    operation: 'list',
    authUid: 'usr_attacker',
    expectedOutcome: 'PERMISSION_DENIED',
  },
];
