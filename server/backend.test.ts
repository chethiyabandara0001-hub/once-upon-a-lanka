import assert from 'node:assert/strict';
import {
  hashPassword,
  verifyPassword,
  verifyAdultAge,
  generatePayHereCheckoutHash,
  verifyPayHereWebhookSignature,
  md5Upper,
  verifyTurnstileToken,
  getServerSessionSecret,
} from './security';
import { db } from './db';

async function runBackendVerificationTests(): Promise<void> {
  console.log('Running Once Upon a Time Backend Security & Invariant Suite...');

  // 1. Password hashing & timing-safe verification
  const { hash, salt } = hashPassword('ColomboTwilight2026!');
  assert.notEqual(hash, 'ColomboTwilight2026!', 'Password must never be stored in plaintext');
  assert.equal(verifyPassword('ColomboTwilight2026!', hash, salt), true, 'Valid password must verify');
  assert.equal(verifyPassword('WrongPassword123!', hash, salt), false, 'Wrong password must fail');

  // 2. Server-side 18+ age assurance
  const underageYear = new Date().getUTCFullYear() - 16;
  const underageResult = verifyAdultAge(`${underageYear}-05-10`);
  assert.equal(underageResult.eligible, false, 'Under-18 user must be rejected');

  const adultResult = verifyAdultAge('1998-07-15');
  assert.equal(adultResult.eligible, true, 'Adult 18+ user must be accepted');
  assert.ok(adultResult.age >= 18, 'Calculated age must be >= 18');

  // 3. PayHere Sri Lanka (LKR 500.00) MD5 signature & webhook verification
  const merchantId = '1210001';
  const orderId = 'OUAT-LK-TEST-99';
  const secret = 'TEST_SECRET_KEY';
  const checkoutHash = generatePayHereCheckoutHash({
    merchantId,
    orderId,
    amountLkr: 500,
    currency: 'LKR',
    merchantSecret: secret,
  });
  assert.equal(checkoutHash.length, 32, 'PayHere checkout hash must be 32-char uppercase MD5');

  const validSig = md5Upper(`${merchantId}${orderId}500.00LKR2${md5Upper(secret)}`);
  assert.equal(
    verifyPayHereWebhookSignature({
      merchantId,
      orderId,
      payhereAmount: '500.00',
      payhereCurrency: 'LKR',
      statusCode: '2',
      md5sig: validSig,
      merchantSecret: secret,
    }),
    true,
    'Authentic PayHere server-to-server webhook signature must pass'
  );

  assert.equal(
    verifyPayHereWebhookSignature({
      merchantId,
      orderId,
      payhereAmount: '500.00',
      payhereCurrency: 'LKR',
      statusCode: '2',
      md5sig: '00000000000000000000000000000000',
      merchantSecret: secret,
    }),
    false,
    'Forged PayHere signature must be rejected'
  );

  // 4. Normalized Database & Block Invariant
  assert.ok(db.state.interests.length >= 10, 'Trilingual Sri Lankan interests must be seeded');
  assert.equal(
    db.isBlockedBetween('usr_amaya', 'usr_kavan'),
    false,
    'Unblocked users should be able to interact'
  );

  // 5. Free Development Mode: Cloudflare Turnstile official test key support
  const testSecret = '1x0000000000000000000000000000000AA';
  const passRes = await verifyTurnstileToken({
    token: '1x00000000000000000000AA',
    secretKey: testSecret,
  });
  assert.equal(
    passRes.success,
    true,
    'Cloudflare official test key 1x00000000000000000000AA must always pass in dev'
  );

  const failRes = await verifyTurnstileToken({
    token: '2x00000000000000000000AA',
    secretKey: testSecret,
  });
  assert.equal(
    failRes.success,
    false,
    'Cloudflare official test key 2x00000000000000000000AA must fail verification'
  );

  // 6. Mandatory Server Session Secret Generation
  const sessionSecret = getServerSessionSecret();
  assert.ok(typeof sessionSecret === 'string' && sessionSecret.length >= 32, 'Session secret must be >= 32 chars');

  // 7. Development-only Test Membership DB Invariant
  const testUserId = 'usr_kavan';
  const initialUser = db.state.users.find((u) => u.id === testUserId);
  assert.ok(initialUser, 'User must exist');
  const now = new Date();
  const startsAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const membership = db.getActiveMembership(testUserId);
  membership.status = 'active';
  membership.plan_name = 'OUAT Development Test Pass (30 Days)';
  membership.price_lkr = 0;
  membership.starts_at = startsAt;
  membership.expires_at = expiresAt;
  membership.updated_at = startsAt;

  const testOrderId = `DEV-TEST-${Date.now()}`;
  db.state.payments.unshift({
    id: `pay_test_${Date.now()}`,
    order_id: testOrderId,
    user_id: testUserId,
    amount_lkr: 0,
    currency: 'LKR',
    gateway: 'dev_test',
    gateway_payment_id: `DEV-PASS-${Date.now()}`,
    status: 'completed',
    idempotency_key: `dev_test_idem_${Date.now()}`,
    signature_verified: true,
    raw_notification_summary: 'Development Test Membership Pass (Zero Payment)',
    created_at: startsAt,
    verified_at: startsAt,
  });

  const refreshedMembership = db.getActiveMembership(testUserId);
  assert.equal(refreshedMembership.status, 'active', 'Dev test membership must be active');
  assert.equal(refreshedMembership.price_lkr, 0, 'Dev test membership price must be 0');

  const recordedPayment = db.state.payments.find((p) => p.order_id === testOrderId);
  assert.ok(recordedPayment, 'Payment row must be found');
  assert.equal(recordedPayment?.gateway, 'dev_test', 'Gateway must be recorded as dev_test');
  assert.equal(recordedPayment?.amount_lkr, 0, 'Amount must be 0 LKR');

  console.log('ALL BACKEND TESTS PASSED.');
}

runBackendVerificationTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
