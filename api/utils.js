/**
 * Utility functions for the API
 */
export function cors(response = new Response(null, { status: 204 })) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', BASE_URL);
  headers.set('Access-Control-Allow-Credentials', 'true');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, If-Match');
  headers.set('Access-Control-Max-Age', '86400');
  headers.append('Vary', 'Origin');
  
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

/**
 * JSON response helper
 */
export function jsonResponse(data, status = 200) {
  return cors(new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // Never cache API JSON. Prevents stale reads after writes (e.g. waypoint reorder).
      'Cache-Control': 'no-store, no-cache, max-age=0, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0'
    }
  }));
}

/**
 * Error response helper
 */
export function errorResponse(message, status = 400) {
  return jsonResponse({ error: message }, status);
}

/**
 * Generate unique ID (CSPRNG)
 */
export function generateId() {
  return crypto.randomUUID();
}

/**
 * Generate deterministic short code from a stable ID (base62, default length 6).
 * Uses a 64-bit rolling hash to keep the same code for the same ID and keep
 * regeneration consistent across environments. Collisions are extremely rare
 * but still handled by callers.
 */
const BASE62_CHARS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function generateShortCodeForId(id, length = 6) {
  if (!id) return generateShortCode(length);
  const prime = 1099511628211n; // FNV-like prime
  const modMask = (1n << 64n) - 1n; // Keep hash bounded
  let hash = 14695981039346656037n; // FNV offset basis

  for (let i = 0; i < id.length; i++) {
    hash = (hash ^ BigInt(id.charCodeAt(i))) * prime & modMask;
  }

  const base = BigInt(BASE62_CHARS.length);
  let code = '';
  let value = hash;
  for (let i = 0; i < length; i++) {
    code += BASE62_CHARS[Number(value % base)];
    value = value / base;
  }
  return code;
}

/**
 * Generate short URL code (base62). Uses characters: 0-9, a-z, A-Z.
 */
export function generateShortCode(length = 6) {
  let code = '';
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  for (let i = 0; i < length; i++) {
    code += BASE62_CHARS[array[i] % 62];
  }
  return code;
}

/**
 * Base URL for the application
 */
export const BASE_URL = 'https://ride.incitat.io';

/**
 * Parse JSON body safely
 */
export async function parseBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/**
 * Authentication middleware
 */
export async function requireAuth(context) {
  const { request, env } = context;
  
  // Get token from Authorization header or cookie
  let token = null;
  
  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else {
    // Check cookie
    const cookies = request.headers.get('Cookie') || '';
    const match = cookies.match(/ride_session=([^;]+)/);
    if (match) {
      token = match[1];
    }
  }
  
  if (!token) {
    return errorResponse('Unauthorized', 401);
  }
  
  // Verify token from KV store
  try {
    const sessionData = await env.RIDE_TRIP_PLANNER_SESSIONS.get(token, 'json');
    if (!sessionData) {
      return errorResponse('Session expired', 401);
    }
    
    // Check expiry
    if (sessionData.expiresAt && Date.now() > sessionData.expiresAt) {
      await env.RIDE_TRIP_PLANNER_SESSIONS.delete(token);
      return errorResponse('Session expired', 401);
    }
    
    // Attach user to context
    context.user = sessionData.user;

    // Check if user is banned or suspended
    try {
      const row = await env.RIDE_TRIP_PLANNER_DB.prepare(
        'SELECT status FROM users WHERE id = ?'
      ).bind(sessionData.user.id).first();
      if (row && row.status === 'banned') {
        return errorResponse('Account has been suspended. Contact support.', 403);
      }
      if (row && row.status === 'suspended') {
        return errorResponse('Account temporarily suspended. Contact support.', 403);
      }
    } catch (_) { /* status column may not exist yet */ }

    // Continue to next handler (return nothing)
    return;
  } catch (error) {
    console.error('Auth error:', error);
    return errorResponse('Authentication failed', 401);
  }
}

/**
 * Optional authentication middleware - doesn't fail if not logged in
 */
export async function optionalAuth(context) {
  const { request, env } = context;
  
  // Get token from Authorization header or cookie
  let token = null;
  
  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else {
    const cookies = request.headers.get('Cookie') || '';
    const match = cookies.match(/ride_session=([^;]+)/);
    if (match) {
      token = match[1];
    }
  }
  
  if (!token) {
    context.user = null;
    return; // Continue without auth
  }
  
  try {
    const sessionData = await env.RIDE_TRIP_PLANNER_SESSIONS.get(token, 'json');
    if (sessionData && (!sessionData.expiresAt || Date.now() <= sessionData.expiresAt)) {
      context.user = sessionData.user;
    } else {
      context.user = null;
    }
  } catch {
    context.user = null;
  }
  
  return; // Always continue
}

/**
 * Max concurrent sessions per user. When exceeded, the oldest session is evicted.
 * Cloudflare KV TTL handles cleanup of expired entries automatically.
 */
const MAX_SESSIONS_PER_USER = 10;
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

/**
 * Create session token, store in KV, and register it in the per-user session list.
 * Multiple sessions (e.g. desktop + mobile) are fully supported; the list is
 * capped at MAX_SESSIONS_PER_USER to prevent unbounded KV growth.
 */
export async function createSession(env, user) {
  // 256-bit CSPRNG session token
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
  const expiresAt = Date.now() + (SESSION_TTL_SECONDS * 1000);
  
  await env.RIDE_TRIP_PLANNER_SESSIONS.put(token, JSON.stringify({
    user,
    expiresAt
  }), {
    expirationTtl: SESSION_TTL_SECONDS
  });

  // Track active sessions per user (KV key: sessions:{userId})
  // This allows us to cap sessions and provides a "revoke all" path.
  const registryKey = `sessions:${user.id}`;
  try {
    const raw = await env.RIDE_TRIP_PLANNER_SESSIONS.get(registryKey, 'json');
    let sessions = Array.isArray(raw) ? raw : [];

    // Prune expired entries
    const now = Date.now();
    sessions = sessions.filter(s => s.expiresAt > now);

    // Add the new session
    sessions.push({ token, expiresAt });

    // If over the cap, evict the oldest sessions
    if (sessions.length > MAX_SESSIONS_PER_USER) {
      const evicted = sessions.splice(0, sessions.length - MAX_SESSIONS_PER_USER);
      // Delete the evicted session tokens from KV (fire-and-forget)
      await Promise.allSettled(evicted.map(s => env.RIDE_TRIP_PLANNER_SESSIONS.delete(s.token)));
    }

    await env.RIDE_TRIP_PLANNER_SESSIONS.put(registryKey, JSON.stringify(sessions), {
      expirationTtl: SESSION_TTL_SECONDS
    });
  } catch (_) {
    // Non-critical — session still works, just no registry tracking
  }

  return { token, expiresAt };
}

/**
 * Set session cookie
 */
export function setSessionCookie(response, token, expiresAt) {
  const headers = new Headers(response.headers);
  const expires = new Date(expiresAt).toUTCString();
  headers.append('Set-Cookie', `ride_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${expires}`);
  
  return new Response(response.body, {
    status: response.status,
    headers
  });
}

/**
 * Admin authentication middleware - requires ADMIN_KEY env var
 */
export async function requireAdmin(context) {
  const { env, request } = context;

  if (!env.ADMIN_KEY) {
    return errorResponse('Admin access not configured', 403);
  }

  const provided = request.headers.get('x-admin-key');
  if (!provided) return errorResponse('Unauthorized', 401);

  // Constant-time comparison to prevent timing side-channel attacks
  const enc = new TextEncoder();
  const a = enc.encode(provided);
  const b = enc.encode(env.ADMIN_KEY);
  if (a.byteLength !== b.byteLength || !crypto.subtle.timingSafeEqual(a, b)) {
    return errorResponse('Unauthorized', 401);
  }

  // Continue to next handler
  return;
}

/**
 * Clear session cookie
 */
export function clearSessionCookie(response) {
  const headers = new Headers(response.headers);
  headers.append('Set-Cookie', 'ride_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
  
  return new Response(response.body, {
    status: response.status,
    headers
  });
}
