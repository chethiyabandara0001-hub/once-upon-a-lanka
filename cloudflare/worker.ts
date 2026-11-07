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
  STUN_SERVERS?: string;
  VITE_STUN_SERVERS?: string;
  TURN_KEY_ID?: string;
  TURN_API_TOKEN?: string;
  TURN_URLS?: string;
  TURN_USERNAME?: string;
  TURN_CREDENTIAL?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Trusted server-side WebRTC ICE / Cloudflare Realtime TURN credentials endpoint
    if (url.pathname === '/api/webrtc/ice-servers' && request.method === 'GET') {
      const authHeader = request.headers.get('Authorization') || '';
      if (!authHeader.startsWith('Bearer ') || authHeader.slice(7).trim().length < 5) {
        return new Response(
          JSON.stringify({ error: 'Authentication required to request ICE credentials.' }),
          { status: 401, headers: { 'Content-Type': 'application/json' } }
        );
      }

      const stunUrls = (
        env.STUN_SERVERS ||
        env.VITE_STUN_SERVERS ||
        'stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302'
      )
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      const iceServers: Array<{
        urls: string | string[];
        username?: string;
        credential?: string;
      }> = [{ urls: stunUrls }];

      let turnConfigured = false;
      let turnProvider: 'cloudflare_calls' | 'static_turn' | 'none' = 'none';

      if (env.TURN_URLS && env.TURN_USERNAME && env.TURN_CREDENTIAL) {
        iceServers.push({
          urls: env.TURN_URLS.split(',').map((u) => u.trim()).filter(Boolean),
          username: env.TURN_USERNAME.trim(),
          credential: env.TURN_CREDENTIAL.trim(),
        });
        turnConfigured = true;
        turnProvider = 'static_turn';
      }

      if (!turnConfigured && env.TURN_KEY_ID && env.TURN_API_TOKEN) {
        try {
          const cfTurnRes = await fetch(
            `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(
              env.TURN_KEY_ID.trim()
            )}/credentials/generate`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${env.TURN_API_TOKEN.trim()}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ ttl: 3600 }),
            }
          );
          if (cfTurnRes.ok) {
            const cfTurnData = (await cfTurnRes.json()) as {
              iceServers?:
                | { urls: string | string[]; username?: string; credential?: string }
                | Array<{ urls: string | string[]; username?: string; credential?: string }>;
            };
            if (cfTurnData.iceServers) {
              const entries = Array.isArray(cfTurnData.iceServers)
                ? cfTurnData.iceServers
                : [cfTurnData.iceServers];
              for (const entry of entries) {
                if (entry && entry.urls) {
                  iceServers.push(entry);
                  turnConfigured = true;
                  turnProvider = 'cloudflare_calls';
                }
              }
            }
          }
        } catch {
          // Fallback to STUN
        }
      }

      return new Response(
        JSON.stringify({
          iceServers,
          turnConfigured,
          turnProvider,
          mediaConstraints: {
            width: 640,
            height: 360,
            frameRate: 24,
            maxVideoBitrateBps: 500_000,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

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
