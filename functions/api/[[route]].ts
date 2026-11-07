import { handleApiRequest, type Env } from '../../cloudflare/worker';

/**
 * Cloudflare Pages Functions catch-all handler for `/api/*`.
 * Ensures that deploying this repository as either a Cloudflare Pages project
 * OR a Cloudflare Worker (`wrangler.toml`) routes all `/api/*` requests identically.
 */
export const onRequest = async (context: {
  request: Request;
  env: Env;
}): Promise<Response> => {
  const url = new URL(context.request.url);
  return handleApiRequest(context.request, context.env, url);
};
