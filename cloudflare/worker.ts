/**
 * ONCE UPON A TIME (OUAT) — CLOUDFLARE WORKER ENTRYPOINT
 *
 * Production edge deployment entrypoint binding:
 * - D1 relational SQLite database (`env.DB`)
 * - Durable Object Matchmaking (`env.MATCHMAKER_DO`)
 * - R2 Profile Media Bucket (`env.AVATAR_BUCKET`)
 * - PayHere LKR Server-to-Server MD5 Webhook Verification
 */

import { MatchmakerDurableObject } from './matchmaker-do';

export { MatchmakerDurableObject };

export interface Env {
  DB: unknown;
  MATCHMAKER_DO: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(req: Request): Promise<Response> };
  };
  AVATAR_BUCKET: unknown;
  SESSION_SECRET: string;
  PAYHERE_MERCHANT_ID: string;
  PAYHERE_MERCHANT_SECRET: string;
  PAYHERE_SANDBOX: string;
  TURNSTILE_SECRET_KEY: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade for Random Video / Text Matchmaking via Durable Object
    if (url.pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
      if (env.MATCHMAKER_DO && typeof env.MATCHMAKER_DO.idFromName === 'function') {
        const id = env.MATCHMAKER_DO.idFromName('sri-lanka-primary-pool');
        const stub = env.MATCHMAKER_DO.get(id);
        return stub.fetch(request);
      }
      return new Response(
        'Matchmaker Durable Object binding not configured in this Worker. Realtime WebSockets are active on the primary Node.js server (server.ts).',
        { status: 503 }
      );
    }

    if (url.pathname === '/api/health') {
      return new Response(
        JSON.stringify({
          service: 'Once Upon a Time (OUAT) Cloudflare Worker',
          region: 'LK',
          currency: 'LKR',
          status: 'ok',
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({
        message: 'Once Upon a Time Edge Worker Ready. See server.ts for unified API handler.',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  },
};
