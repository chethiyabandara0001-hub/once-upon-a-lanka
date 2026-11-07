# Once Upon a Time — Firestore Zero-Trust Security Specification

## 1. Data Invariants
1. **PII Isolation Invariant (Pillar 6)**: A user's private identity details (`name`, `email`, `dateOfBirth`, `gender`, `nicNumber`) are stored exclusively in `/users/{userId}/private/account` and may ONLY be read or written by the authenticated owner (`request.auth.uid == userId`) or a verified administrator.
2. **One-NIC-Per-Account Uniqueness & Atomicity Invariant (Pillar 1 & Pillar 7)**:
   - Every `/users/{userId}/private/account` creation MUST atomically create `/nic_registry/{nicNumber}` in the same transaction/batch (`existsAfter` + `getAfter`), proving that the Sri Lankan NIC (`^([0-9]{9}[VX]|[0-9]{12})$`) has not been used by any other account.
   - Every `/nic_registry/{nicId}` document is immutable once created (`allow update, delete: if false`) and can only be created if `nicId == incoming().nicNumber`, `incoming().ownerId == request.auth.uid`, and `getAfter(/databases/$(database)/documents/users/$(request.auth.uid)/private/account).data.nicNumber == nicId`.
   - A user's `nicNumber`, `userId`, and `createdAt` fields in `/users/{userId}/private/account` are strictly immutable on update.
3. **Master Gate Invariant (Pillar 1)**: `/users/{userId}/private/account` requires the parent `/users/{userId}` document to exist (via `exists` or `existsAfter` during initial batch creation) and belong to `request.auth.uid`.
4. **Temporal & Volumetric Integrity (Pillars 2, 3, 5, 13)**:
   - Every string and list is strictly bounded by `.size()`.
   - `createdAt` and `updatedAt` must equal `request.time`.

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Payload 1 (Duplicate NIC Hijack)**: User B attempts to `create` or `update` `/nic_registry/199812345678` already owned by User A -> `PERMISSION_DENIED`.
2. **Payload 2 (Orphaned NIC Claim)**: User A attempts to `create` `/nic_registry/199812345678` without atomically creating `/users/{uid}/private/account` with matching `nicNumber` -> `PERMISSION_DENIED`.
3. **Payload 3 (Unregistered NIC Account Creation)**: User A attempts to `create` `/users/{uid}/private/account` without atomically creating `/nic_registry/{nicNumber}` -> `PERMISSION_DENIED`.
4. **Payload 4 (NIC Mutation on Update)**: User A attempts to `update` `nicNumber` in `/users/{uid}/private/account` after creation -> `PERMISSION_DENIED`.
5. **Payload 5 (Cross-User PII Read)**: Authenticated User B attempts `get` on `/users/{userA}/private/account` -> `PERMISSION_DENIED`.
6. **Payload 6 (Shadow Field Injection)**: User A sends `{ ..., isAdmin: true }` to `/users/{uid}` or `/users/{uid}/private/account` -> `PERMISSION_DENIED`.
7. **Payload 7 (Identity Spoofing)**: User A attempts to create `/users/{userB}` where `incoming().userId != request.auth.uid` -> `PERMISSION_DENIED`.
8. **Payload 8 (Invalid Sri Lankan NIC Format)**: User A attempts to register with `nicNumber: "INVALID-NIC-123"` -> `PERMISSION_DENIED`.
9. **Payload 9 (Timestamp Forgery)**: User A sends a past/future `createdAt` or `updatedAt` != `request.time` -> `PERMISSION_DENIED`.
10. **Payload 10 (Oversized Payload / Denial of Wallet)**: User A sends a 10,000-character `bio` or 50-element `interestIds` array -> `PERMISSION_DENIED`.
11. **Payload 11 (Underage Profile Creation)**: User A attempts to create `/users/{uid}` with `age: 16` (< 18) -> `PERMISSION_DENIED`.
12. **Payload 12 (Blanket Unfiltered List Query)**: User A attempts an unfiltered `list` on `/users` without `where('discoverable', '==', true)` -> `PERMISSION_DENIED`.
