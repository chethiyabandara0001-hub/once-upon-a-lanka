import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

/**
 * Cryptographic Password Hashing (scrypt + timingSafeEqual)
 */
export function hashPassword(password: string, existingSalt?: string): { hash: string; salt: string } {
  const salt = existingSalt || crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(password, salt, 64);
  return {
    hash: derivedKey.toString('hex'),
    salt,
  };
}

export function verifyPassword(password: string, storedHash: string, storedSalt: string): boolean {
  try {
    const { hash } = hashPassword(password, storedSalt);
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(storedHash, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Server-Side Age Assurance: Strictly 18+ Adults Only
 */
export function verifyAdultAge(dateOfBirthIso: string): {
  eligible: boolean;
  age: number;
  error?: string;
} {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirthIso)) {
    return { eligible: false, age: 0, error: 'Date of birth must be in YYYY-MM-DD format.' };
  }

  const dob = new Date(`${dateOfBirthIso}T00:00:00Z`);
  if (Number.isNaN(dob.getTime())) {
    return { eligible: false, age: 0, error: 'Invalid date of birth provided.' };
  }

  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - dob.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < dob.getUTCDate())) {
    age--;
  }

  if (age < 18) {
    return {
      eligible: false,
      age,
      error: 'Once Upon a Time is strictly restricted to adults aged 18 and older.',
    };
  }

  if (age > 105) {
    return {
      eligible: false,
      age,
      error: 'Please enter a valid date of birth.',
    };
  }

  return { eligible: true, age };
}

/**
 * Session Token Generation & SHA-256 Hashing
 */
export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * PayHere Sri Lanka (LKR) Official MD5 Checkout & Webhook Signature Verification
 * Formula: UPPERCASE(MD5(merchant_id + order_id + amount_formatted + currency + UPPERCASE(MD5(merchant_secret))))
 */
export function md5Upper(input: string): string {
  return crypto.createHash('md5').update(input).digest('hex').toUpperCase();
}

export function generatePayHereCheckoutHash(params: {
  merchantId: string;
  orderId: string;
  amountLkr: number;
  currency: string;
  merchantSecret: string;
}): string {
  const amountFormatted = params.amountLkr.toFixed(2);
  const hashedSecret = md5Upper(params.merchantSecret);
  return md5Upper(
    `${params.merchantId}${params.orderId}${amountFormatted}${params.currency}${hashedSecret}`
  );
}

export function verifyPayHereWebhookSignature(params: {
  merchantId: string;
  orderId: string;
  payhereAmount: string;
  payhereCurrency: string;
  statusCode: string;
  md5sig: string;
  merchantSecret: string;
}): boolean {
  const hashedSecret = md5Upper(params.merchantSecret);
  const expectedSig = md5Upper(
    `${params.merchantId}${params.orderId}${params.payhereAmount}${params.payhereCurrency}${params.statusCode}${hashedSecret}`
  );
  try {
    const a = Buffer.from(expectedSig, 'utf8');
    const b = Buffer.from(params.md5sig.toUpperCase(), 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * In-Memory Sliding Window Rate Limiter
 */
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

export function createRateLimiter(options: { windowMs: number; maxRequests: number; label: string }) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || 'local';
    const key = `${options.label}:${ip}`;
    const now = Date.now();
    const current = rateBuckets.get(key);

    if (!current || now > current.resetAt) {
      rateBuckets.set(key, { count: 1, resetAt: now + options.windowMs });
      next();
      return;
    }

    current.count += 1;
    if (current.count > options.maxRequests) {
      res.status(429).json({
        error: 'Too many requests. Please wait a moment before trying again.',
        retryAfterSeconds: Math.ceil((current.resetAt - now) / 1000),
      });
      return;
    }

    next();
  };
}

/**
 * Cloudflare Turnstile Verification
 * Supports Cloudflare's official test sitekeys and secret keys during development:
 * - Always passes: Secret "1x0000000000000000000000000000000AA"
 * - Always fails: Secret "2x0000000000000000000000000000000AA"
 * - Token already spent: Secret "3x0000000000000000000000000000000AA"
 */
export async function verifyTurnstileToken(params: {
  token: string;
  remoteIp?: string;
  secretKey?: string;
}): Promise<{ success: boolean; error?: string }> {
  const secretKey = params.secretKey || process.env.TURNSTILE_SECRET_KEY || '1x0000000000000000000000000000000AA';

  // Check failure test tokens and secrets first
  if (params.token === '2x00000000000000000000AA' || secretKey === '2x0000000000000000000000000000000AA') {
    return { success: false, error: 'Turnstile test verification forced failure.' };
  }
  // Check pass test tokens and pass secret keys
  if (params.token === '1x00000000000000000000AA' || secretKey === '1x0000000000000000000000000000000AA') {
    return { success: true };
  }

  if (!params.token) {
    return { success: false, error: 'Turnstile token missing.' };
  }

  try {
    const formData = new URLSearchParams();
    formData.append('secret', secretKey);
    formData.append('response', params.token);
    if (params.remoteIp) {
      formData.append('remoteip', params.remoteIp);
    }

    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: formData,
    });
    const outcome = (await response.json()) as { success: boolean; 'error-codes'?: string[] };
    return {
      success: Boolean(outcome.success),
      error: outcome['error-codes']?.join(', '),
    };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Server-only SESSION_SECRET manager:
 * Mandatory for authentication, generated cryptographically if not provided in environment,
 * and never exposed to the client.
 */
let cachedSessionSecret: string | null = null;

export function getServerSessionSecret(): string {
  if (cachedSessionSecret) return cachedSessionSecret;

  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.trim().length >= 16) {
    cachedSessionSecret = process.env.SESSION_SECRET.trim();
  } else {
    // Cryptographically strong random secret generated securely on the server
    cachedSessionSecret = crypto.randomBytes(32).toString('hex');
    console.info('[Security] Ephemeral secure SESSION_SECRET generated on server.');
  }
  return cachedSessionSecret;
}

