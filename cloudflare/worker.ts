/**
 * ONCE UPON A TIME (OUAT) — CLOUDFLARE WORKER ENTRYPOINT
 * Serves the compiled React SPA from dist/ and exports a dependency-free
 * MatchmakerDurableObject class for Cloudflare deployment compatibility.
 */

export class MatchmakerDurableObject {
  state: unknown;
  env: Env;

  constructor(state: unknown, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(): Promise<Response> {
    return new Response(
      JSON.stringify({
        status: 'migrated',
        message: 'Matchmaking now operates directly on Firebase Cloud Firestore.',
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

export interface Env {
  ASSETS?: {
    fetch(request: Request | string): Promise<Response>;
  };
  MATCHMAKER?: unknown;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      return env.ASSETS.fetch(request);
    }

    return new Response(
      `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Once Upon a Time</title>
</head>
<body style="background:#101417;color:#f5f6f2;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;text-align:center;">
  <div style="background:#17221c;padding:32px;border-radius:20px;border:1px solid #28372e;max-width:500px;">
    <h1 style="color:#c5fa5a;font-size:24px;margin-bottom:8px;">Once Upon a Time</h1>
    <p style="color:#a4b3a8;font-size:14px;line-height:1.6;">Run <code>npm run build && npx wrangler deploy</code> to publish the static frontend.</p>
  </div>
</body>
</html>`,
      { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  },
};
