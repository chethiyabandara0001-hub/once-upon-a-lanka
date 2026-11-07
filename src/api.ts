const TOKEN_STORAGE_KEY = 'ouat_session_token_v1';
const TAB_CLIENT_ID_KEY = 'ouat_tab_client_id_v1';

/**
 * Reads the session token for this tab.
 * Uses sessionStorage first so multiple tabs in the same browser can sign into
 * different accounts simultaneously without overwriting each other's session,
 * while falling back to localStorage for newly opened tabs.
 */
export function getStoredToken(): string | null {
  try {
    const tabToken = sessionStorage.getItem(TOKEN_STORAGE_KEY);
    if (tabToken) {
      return tabToken;
    }
    const sharedToken = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (sharedToken) {
      sessionStorage.setItem(TOKEN_STORAGE_KEY, sharedToken);
      return sharedToken;
    }
    return null;
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
    // Ignore storage quota errors
  }
}

/**
 * Returns a stable per-tab client identifier so the Matchmaker Durable Object
 * can distinguish a same-tab reconnection from a second open browser tab.
 */
export function getTabClientId(): string {
  try {
    let clientId = sessionStorage.getItem(TAB_CLIENT_ID_KEY);
    if (!clientId) {
      const randomPart =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID().slice(0, 12)
          : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      clientId = `tab_${randomPart}`;
      sessionStorage.setItem(TAB_CLIENT_ID_KEY, clientId);
    }
    return clientId;
  } catch {
    return `tab_${Date.now().toString(36)}`;
  }
}

export async function apiRequest<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const token = getStoredToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`/api${endpoint}`, {
    ...options,
    headers,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status})`) as Error & {
      status?: number;
      requiresMembership?: boolean;
    };
    error.status = response.status;
    error.requiresMembership = Boolean(data.requiresMembership);
    throw error;
  }

  return data as T;
}

export function buildWebSocketUrl(): string {
  const token = getStoredToken() || '';
  const clientId = getTabClientId();
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(
    token
  )}&clientId=${encodeURIComponent(clientId)}`;
}
