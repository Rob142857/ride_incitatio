/**
 * OAuth Authentication Handler
 * Supports Google and Microsoft SSO
 * Domain: ride.incitat.io
 */

import { jsonResponse, errorResponse, generateId, createSession, setSessionCookie, clearSessionCookie, BASE_URL } from './utils.js';

// OAuth provider configurations
const PROVIDERS = {
  google: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
    scopes: ['openid', 'email', 'profile'],
    getClientId: (env) => env.GOOGLE_CLIENT_ID,
    getClientSecret: (env) => env.GOOGLE_CLIENT_SECRET,
    parseUser: (data) => ({
      email: data.email,
      name: data.name,
      avatar_url: data.picture,
      provider_id: data.id
    })
  },
  
  microsoft: {
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    userUrl: 'https://graph.microsoft.com/v1.0/me',
    scopes: ['openid', 'email', 'profile', 'User.Read'],
    getClientId: (env) => env.MICROSOFT_CLIENT_ID,
    getClientSecret: (env) => env.MICROSOFT_CLIENT_SECRET,
    parseUser: (data) => ({
      email: data.mail || data.userPrincipalName,
      name: data.displayName,
      avatar_url: null, // MS Graph requires separate call for photo
      provider_id: data.id
    })
  }
};

export const AuthHandler = {
  /**
   * Initiate OAuth login - redirect to provider
   */
  async initiateLogin(context) {
    const { params, env, url } = context;
    const providerName = params.provider;
    
    const provider = PROVIDERS[providerName];
    if (!provider) {
      return errorResponse('Invalid provider', 400);
    }
    
    const clientId = provider.getClientId(env);
    if (!clientId) {
      return errorResponse('Provider not configured', 500);
    }
    
    // Generate state for CSRF protection
    const state = crypto.randomUUID();
    
    // Store state in KV temporarily (5 minutes)
    // Validate return URL — extract path from same-origin URLs, reject foreign origins
    let returnUrl = url.searchParams.get('return') || '/';
    try {
      const parsed = new URL(returnUrl, BASE_URL);
      // Only allow same-origin return URLs
      if (parsed.origin === new URL(BASE_URL).origin) {
        returnUrl = parsed.pathname + parsed.search + parsed.hash;
      } else {
        returnUrl = '/';
      }
    } catch {
      // If URL parsing fails, ensure it's a safe relative path
      if (!returnUrl.startsWith('/') || returnUrl.startsWith('//')) {
        returnUrl = '/';
      }
    }
    await env.RIDE_TRIP_PLANNER_SESSIONS.put(`oauth_state_${state}`, JSON.stringify({
      provider: providerName,
      returnUrl
    }), { expirationTtl: 300 });
    
    // Build redirect URL - use BASE_URL in production for consistency
    const origin = env.ENVIRONMENT === 'production' ? BASE_URL : url.origin;
    const redirectUri = `${origin}/api/auth/callback/${providerName}`;
    
    const authParams = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: provider.scopes.join(' '),
      state: state
    });
    
    // Microsoft requires additional params
    if (providerName === 'microsoft') {
      authParams.set('response_mode', 'query');
    }
    
    const authUrl = `${provider.authUrl}?${authParams.toString()}`;
    
    return Response.redirect(authUrl, 302);
  },
  
  /**
   * Handle OAuth callback from provider
   */
  async handleCallback(context) {
    const { params, env, url, request } = context;
    const providerName = params.provider;
    
    const provider = PROVIDERS[providerName];
    if (!provider) {
      return errorResponse('Invalid provider', 400);
    }
    
    // Verify state
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    
    if (error) {
      console.error('OAuth error:', error, url.searchParams.get('error_description'));
      return Response.redirect(`/?error=auth_failed`, 302);
    }
    
    if (!state || !code) {
      return errorResponse('Missing state or code', 400);
    }
    
    // Verify state from KV
    const stateData = await env.RIDE_TRIP_PLANNER_SESSIONS.get(`oauth_state_${state}`, 'json');
    if (!stateData || stateData.provider !== providerName) {
      return errorResponse('Invalid state', 400);
    }
    await env.RIDE_TRIP_PLANNER_SESSIONS.delete(`oauth_state_${state}`);
    
    // Exchange code for token — use BASE_URL for consistent redirect_uri
    const origin = env.ENVIRONMENT === 'production' ? BASE_URL : url.origin;
    const redirectUri = `${origin}/api/auth/callback/${providerName}`;
    
    const tokenParams = new URLSearchParams({
      client_id: provider.getClientId(env),
      client_secret: provider.getClientSecret(env),
      code: code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    });
    
    const tokenResponse = await fetch(provider.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: tokenParams.toString()
    });
    
    if (!tokenResponse.ok) {
      console.error('Token exchange failed:', await tokenResponse.text());
      return Response.redirect(`/?error=token_failed`, 302);
    }
    
    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;
    
    // Fetch user info
    const userResponse = await fetch(provider.userUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json'
      }
    });
    
    if (!userResponse.ok) {
      console.error('User info fetch failed:', await userResponse.text());
      return Response.redirect(`/?error=user_fetch_failed`, 302);
    }
    
    const userData = await userResponse.json();
    const parsedUser = provider.parseUser(userData);
    if (!parsedUser?.email) {
      console.error('OAuth user missing email', providerName, userData);
      return Response.redirect(`/?error=no_email`, 302);
    }
    const normalizedEmail = parsedUser.email.toLowerCase();
    
    // Create or update user in D1
    const user = await createOrUpdateUser(env.RIDE_TRIP_PLANNER_DB, {
      ...parsedUser,
      email: normalizedEmail,
      provider: providerName
    });
    
    // Create session
    const session = await createSession(env, {
      id: user.id,
      email: user.email,
      name: user.name,
      avatar_url: user.avatar_url
    });

    // Lightweight audit log — use waitUntil so it finishes even after response
    context.ctx.waitUntil(
      recordLogin(env, user, providerName, request).catch((err) => {
        console.error('login audit failed', err);
      })
    );
    
    // Redirect to app with session cookie (Response.redirect requires absolute URL)
    const returnPath = stateData.returnUrl || '/';
    const absoluteReturnUrl = returnPath.startsWith('http') ? returnPath : `${BASE_URL}${returnPath}`;
    const response = Response.redirect(absoluteReturnUrl, 302);
    
    return setSessionCookie(response, session.token, session.expiresAt);
  },
  
  /**
   * Get current logged-in user
   */
  async getCurrentUser(context) {
    return jsonResponse({ user: context.user });
  },
  
  /**
   * Logout - clear session
   */
  async logout(context) {
    const { request, env } = context;
    
    // Get token from cookie
    const cookies = request.headers.get('Cookie') || '';
    const match = cookies.match(/ride_session=([^;]+)/);
    
    if (match) {
      const token = match[1];

      // Read session to get user ID for registry cleanup
      try {
        const sessionData = await env.RIDE_TRIP_PLANNER_SESSIONS.get(token, 'json');
        if (sessionData?.user?.id) {
          const registryKey = `sessions:${sessionData.user.id}`;
          const raw = await env.RIDE_TRIP_PLANNER_SESSIONS.get(registryKey, 'json');
          if (Array.isArray(raw)) {
            const filtered = raw.filter(s => s.token !== token);
            if (filtered.length > 0) {
              await env.RIDE_TRIP_PLANNER_SESSIONS.put(registryKey, JSON.stringify(filtered), {
                expirationTtl: 30 * 24 * 60 * 60
              });
            } else {
              await env.RIDE_TRIP_PLANNER_SESSIONS.delete(registryKey);
            }
          }
        }
      } catch (_) { /* non-critical */ }

      // Delete session from KV
      await env.RIDE_TRIP_PLANNER_SESSIONS.delete(token);
    }
    
    const response = jsonResponse({ success: true });
    return clearSessionCookie(response);
  },

  /**
   * Admin: dashboard stats
   */
  async adminStats(context) {
    const { env } = context;
    const db = env.RIDE_TRIP_PLANNER_DB;

    // Run all stat queries in parallel
    const [users, trips, waypoints, journals, attachments, providers, signups7d, signups30d, logins7d, logins30d, loginsByDay] = await Promise.all([
      db.prepare('SELECT COUNT(*) AS c FROM users').first(),
      db.prepare('SELECT COUNT(*) AS c FROM trips').first(),
      db.prepare('SELECT COUNT(*) AS c FROM waypoints').first(),
      db.prepare('SELECT COUNT(*) AS c FROM journal_entries').first(),
      db.prepare('SELECT COALESCE(COUNT(*),0) AS c, COALESCE(SUM(size_bytes),0) AS bytes FROM attachments').first(),
      db.prepare("SELECT provider, COUNT(*) AS c FROM users GROUP BY provider ORDER BY c DESC").all(),
      db.prepare("SELECT COUNT(*) AS c FROM users WHERE created_at >= datetime('now','-7 days')").first(),
      db.prepare("SELECT COUNT(*) AS c FROM users WHERE created_at >= datetime('now','-30 days')").first(),
      db.prepare("SELECT COUNT(*) AS c FROM login_events WHERE created_at >= datetime('now','-7 days')").first(),
      db.prepare("SELECT COUNT(*) AS c FROM login_events WHERE created_at >= datetime('now','-30 days')").first(),
      db.prepare("SELECT date(created_at) AS day, COUNT(*) AS c FROM login_events WHERE created_at >= datetime('now','-30 days') GROUP BY day ORDER BY day").all(),
    ]);

    return jsonResponse({
      users: users.c,
      trips: trips.c,
      waypoints: waypoints.c,
      journals: journals.c,
      attachments: attachments.c,
      storageBytes: attachments.bytes,
      providers: (providers.results || []).map(r => ({ provider: r.provider, count: r.c })),
      signups7d: signups7d.c,
      signups30d: signups30d.c,
      logins7d: logins7d.c,
      logins30d: logins30d.c,
      loginsByDay: (loginsByDay.results || []).map(r => ({ day: r.day, count: r.c })),
    });
  },

  /**
   * Admin: list users with trip counts
   */
  async listUsersAdmin(context) {
    const { env } = context;

    const result = await env.RIDE_TRIP_PLANNER_DB.prepare(
      `SELECT u.id, u.email, u.name, u.avatar_url, u.provider, u.provider_id, u.status, u.created_at, u.updated_at, u.last_login,
              (SELECT COUNT(*) FROM trips t WHERE t.user_id = u.id) AS trip_count,
              (SELECT COUNT(*) FROM auth_identities ai WHERE ai.user_id = u.id) AS identity_count
       FROM users u ORDER BY u.created_at DESC`
    ).all();

    return jsonResponse({ users: result.results || [] });
  },

  /**
   * Admin: recent login events
   */
  async listLoginsAdmin(context) {
    const { env } = context;

    const result = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT id, user_id, email, provider, ip, user_agent, client_hints, created_at FROM login_events ORDER BY created_at DESC LIMIT 200'
    ).all();

    return jsonResponse({ events: result.results || [] });
  },

  /**
   * Admin: full account audit snapshot
   * Returns user profile, all trips (with waypoints, journal, attachments),
   * admin notes, login history, and automated content flags.
   */
  async auditUser(context) {
    const { env, params } = context;
    const userId = params.id;
    const db = env.RIDE_TRIP_PLANNER_DB;

    // Fetch user
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
    if (!user) return errorResponse('User not found', 404);

    // Parallel fetch everything
    const [trips, waypoints, journals, attachments, identities, logins, notes] = await Promise.all([
      db.prepare('SELECT id, name, description, public_title, public_description, public_contact, is_public, cover_image_url, created_at, updated_at FROM trips WHERE user_id = ?').bind(userId).all(),
      db.prepare('SELECT w.id, w.trip_id, w.name, w.address, w.notes FROM waypoints w JOIN trips t ON w.trip_id = t.id WHERE t.user_id = ?').bind(userId).all(),
      db.prepare('SELECT j.id, j.trip_id, j.title, j.content, j.tags, j.is_private, j.created_at FROM journal_entries j JOIN trips t ON j.trip_id = t.id WHERE t.user_id = ?').bind(userId).all(),
      db.prepare('SELECT a.id, a.trip_id, a.filename, a.original_name, a.mime_type, a.size_bytes, a.storage_key, a.is_cover, a.caption, a.created_at FROM attachments a JOIN trips t ON a.trip_id = t.id WHERE t.user_id = ?').bind(userId).all(),
      db.prepare('SELECT id, provider, provider_id, email, created_at, last_login FROM auth_identities WHERE user_id = ?').bind(userId).all(),
      db.prepare('SELECT email, provider, ip, user_agent, client_hints, created_at FROM login_events WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').bind(userId).all(),
      db.prepare('SELECT id, admin_email, action, content, created_at FROM admin_notes WHERE user_id = ? ORDER BY created_at DESC').bind(userId).all(),
    ]);

    // Automated content scan
    const flags = scanContent({
      user,
      trips: trips.results || [],
      waypoints: waypoints.results || [],
      journals: journals.results || [],
      attachments: attachments.results || [],
    });

    // Build attachment URLs for image preview
    const images = (attachments.results || []).filter(a => a.mime_type && a.mime_type.startsWith('image/')).map(a => ({
      id: a.id,
      name: a.original_name,
      url: '/api/attachments/' + a.id,
      size: a.size_bytes,
      caption: a.caption,
      isCover: !!a.is_cover,
    }));

    return jsonResponse({
      user: { id: user.id, email: user.email, name: user.name, avatar_url: user.avatar_url, provider: user.provider, status: user.status || 'active', created_at: user.created_at, last_login: user.last_login },
      trips: trips.results || [],
      waypoints: waypoints.results || [],
      journals: journals.results || [],
      images,
      identities: identities.results || [],
      logins: logins.results || [],
      notes: notes.results || [],
      flags,
    });
  },

  /**
   * Admin: update user status (active / suspended / banned)
   */
  async setUserStatus(context) {
    const { env, params, request } = context;
    const userId = params.id;
    const body = await request.json();
    const { status, reason, adminEmail } = body;

    if (!['active', 'suspended', 'banned'].includes(status)) {
      return errorResponse('Invalid status. Must be active, suspended, or banned.', 400);
    }

    const db = env.RIDE_TRIP_PLANNER_DB;
    const user = await db.prepare('SELECT id, email, status FROM users WHERE id = ?').bind(userId).first();
    if (!user) return errorResponse('User not found', 404);

    // Update status
    await db.prepare('UPDATE users SET status = ?, updated_at = datetime("now") WHERE id = ?').bind(status, userId).run();

    // Record admin note
    const noteId = generateId();
    const actionLabel = status === 'active' ? 'restore' : status;
    await db.prepare(
      'INSERT INTO admin_notes (id, user_id, admin_email, action, content, created_at) VALUES (?, ?, ?, ?, ?, datetime("now"))'
    ).bind(noteId, userId, adminEmail || 'admin', actionLabel, reason || `Status changed to ${status}`).run();

    // If banning/suspending, revoke all sessions
    if (status !== 'active') {
      try {
        const registryKey = `sessions:${userId}`;
        const raw = await env.RIDE_TRIP_PLANNER_SESSIONS.get(registryKey, 'json');
        if (Array.isArray(raw)) {
          await Promise.all(raw.map(s => env.RIDE_TRIP_PLANNER_SESSIONS.delete(s.token)));
          await env.RIDE_TRIP_PLANNER_SESSIONS.delete(registryKey);
        }
      } catch (_) { /* best effort */ }
    }

    return jsonResponse({ ok: true, status, userId });
  },

  /**
   * Admin: add a note to a user's record
   */
  async addAdminNote(context) {
    const { env, params, request } = context;
    const userId = params.id;
    const body = await request.json();
    const { content, adminEmail } = body;
    if (!content) return errorResponse('Note content is required', 400);

    const db = env.RIDE_TRIP_PLANNER_DB;
    const user = await db.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();
    if (!user) return errorResponse('User not found', 404);

    const noteId = generateId();
    await db.prepare(
      'INSERT INTO admin_notes (id, user_id, admin_email, action, content, created_at) VALUES (?, ?, ?, ?, ?, datetime("now"))'
    ).bind(noteId, userId, adminEmail || 'admin', 'note', content).run();

    return jsonResponse({ ok: true, id: noteId });
  },
};

/* ── Content analysis ────────────────────────────────────── */

const PROPRIETARY_PATTERNS = /\u00a9|\u00ae|\u2122|\btrademark\b|\bpatent\b|\bcopyrighted\b|\ball rights reserved\b|\bconfidential\b|\bproprietary\b/i;
const SPAM_PATTERNS = /\b(buy now|click here|free money|act now|limited offer|subscribe|unsubscribe|\$\$\$)\b/i;
const IMPERSONATION_PATTERNS = /\b(official|verified|admin|support team|customer service|helpdesk)\b/i;
const OFFENSIVE_PATTERNS = /\b(hate|kill|threat|bomb|attack|terror)\b/i;
const URL_PATTERN = /https?:\/\/[^\s]{20,}/gi;

function scanContent({ user, trips, waypoints, journals, attachments }) {
  const flags = [];

  // Collect all text fields
  function check(source, field, text) {
    if (!text) return;
    if (PROPRIETARY_PATTERNS.test(text)) flags.push({ severity: 'warning', category: 'proprietary', source, field, snippet: text.slice(0, 120) });
    if (SPAM_PATTERNS.test(text)) flags.push({ severity: 'info', category: 'spam', source, field, snippet: text.slice(0, 120) });
    if (IMPERSONATION_PATTERNS.test(text)) flags.push({ severity: 'warning', category: 'impersonation', source, field, snippet: text.slice(0, 120) });
    if (OFFENSIVE_PATTERNS.test(text)) flags.push({ severity: 'alert', category: 'offensive', source, field, snippet: text.slice(0, 120) });
    const urls = text.match(URL_PATTERN);
    if (urls && urls.length > 2) flags.push({ severity: 'info', category: 'link-heavy', source, field, snippet: urls.slice(0, 3).join(', ') });
  }

  // User profile
  check('profile', 'name', user.name);

  // Trips
  for (const t of trips) {
    check(`trip:${t.id}`, 'name', t.name);
    check(`trip:${t.id}`, 'description', t.description);
    check(`trip:${t.id}`, 'public_title', t.public_title);
    check(`trip:${t.id}`, 'public_description', t.public_description);
    check(`trip:${t.id}`, 'public_contact', t.public_contact);
  }

  // Waypoints
  for (const w of waypoints) {
    check(`waypoint:${w.id}`, 'name', w.name);
    check(`waypoint:${w.id}`, 'notes', w.notes);
  }

  // Journal entries
  for (const j of journals) {
    check(`journal:${j.id}`, 'title', j.title);
    check(`journal:${j.id}`, 'content', j.content);
  }

  // Attachment filenames / captions
  for (const a of attachments) {
    check(`attachment:${a.id}`, 'original_name', a.original_name);
    check(`attachment:${a.id}`, 'caption', a.caption);
  }

  return flags;
}

async function recordLogin(env, user, provider, request) {
  const ip = request.headers.get('cf-connecting-ip')
    || request.headers.get('x-forwarded-for')
    || 'unknown';
  const userAgent = request.headers.get('user-agent') || '';
  const id = generateId();

  const clientHints = {
    ua: request.headers.get('sec-ch-ua') || undefined,
    uaPlatform: request.headers.get('sec-ch-ua-platform') || undefined,
    uaMobile: request.headers.get('sec-ch-ua-mobile') || undefined,
    acceptLanguage: request.headers.get('accept-language') || undefined,
    cfRay: request.headers.get('cf-ray') || undefined,
    cfCountry: request.headers.get('cf-ipcountry') || undefined
  };

  // Backward compatible: if extra columns don't exist yet, fall back to the base insert.
  try {
    await env.RIDE_TRIP_PLANNER_DB.prepare(
      'INSERT INTO login_events (id, user_id, email, provider, provider_id, ip, user_agent, client_hints) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, user.id, user.email, provider, user.provider_id || null, ip, userAgent, JSON.stringify(clientHints)).run();
  } catch (err) {
    await env.RIDE_TRIP_PLANNER_DB.prepare(
      'INSERT INTO login_events (id, user_id, email, provider, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(id, user.id, user.email, provider, ip, userAgent).run();
  }
}

/**
 * Create or update user in database
 */
async function createOrUpdateUser(db, userData) {
  const { email, name, avatar_url, provider, provider_id } = userData;
  const normalizedEmail = email?.toLowerCase();

  // Prefer the linked identities table if present.
  try {
    const existingIdentity = await db.prepare(
      'SELECT u.* FROM auth_identities ai JOIN users u ON ai.user_id = u.id WHERE ai.provider = ? AND ai.provider_id = ?'
    ).bind(provider, provider_id).first();

    if (existingIdentity) {
      // Only overwrite avatar_url if the new provider actually supplies one
      const effectiveAvatar = avatar_url || existingIdentity.avatar_url;
      await db.prepare(
        'UPDATE users SET email = ?, name = ?, avatar_url = COALESCE(?, avatar_url), last_login = datetime("now"), updated_at = datetime("now") WHERE id = ?'
      ).bind(normalizedEmail, name, avatar_url, existingIdentity.id).run();

      await db.prepare(
        'UPDATE auth_identities SET email = ?, last_login = datetime("now") WHERE provider = ? AND provider_id = ?'
      ).bind(normalizedEmail, provider, provider_id).run();

      return { ...existingIdentity, email: normalizedEmail, name, avatar_url: effectiveAvatar, provider, provider_id, last_login: new Date().toISOString() };
    }

    const existingUser = await db.prepare('SELECT * FROM users WHERE email = ?').bind(normalizedEmail).first();
    if (existingUser) {
      // Link this provider identity to the existing user (one user per email).
      try {
        await db.prepare(
          'INSERT INTO auth_identities (id, user_id, provider, provider_id, email, created_at, last_login) VALUES (?, ?, ?, ?, ?, datetime("now"), datetime("now"))'
        ).bind(generateId(), existingUser.id, provider, provider_id, normalizedEmail).run();
      } catch (_) {
        // Ignore if a concurrent login already inserted it.
      }

      const effectiveAvatar = avatar_url || existingUser.avatar_url;
      await db.prepare(
        'UPDATE users SET name = ?, avatar_url = COALESCE(?, avatar_url), last_login = datetime("now"), updated_at = datetime("now") WHERE id = ?'
      ).bind(name, avatar_url, existingUser.id).run();

      return { ...existingUser, name, avatar_url: effectiveAvatar, provider, provider_id, last_login: new Date().toISOString() };
    }

    // Create new user + first linked identity.
    const id = generateId();
    await db.prepare(
      'INSERT INTO users (id, email, name, avatar_url, provider, provider_id, last_login) VALUES (?, ?, ?, ?, ?, ?, datetime("now"))'
    ).bind(id, normalizedEmail, name, avatar_url, provider, provider_id).run();

    await db.prepare(
      'INSERT INTO auth_identities (id, user_id, provider, provider_id, email, created_at, last_login) VALUES (?, ?, ?, ?, ?, datetime("now"), datetime("now"))'
    ).bind(generateId(), id, provider, provider_id, normalizedEmail).run();

    return { id, email: normalizedEmail, name, avatar_url, provider, provider_id, last_login: new Date().toISOString() };
  } catch (err) {
    // Legacy fallback (no auth_identities table yet): keep one account per email by reusing existing user.

    // First try provider+id match
    const existingByProvider = await db.prepare(
      'SELECT * FROM users WHERE provider = ? AND provider_id = ?'
    ).bind(provider, provider_id).first();

    if (existingByProvider) {
      const effectiveAvatar = avatar_url || existingByProvider.avatar_url;
      await db.prepare(
        'UPDATE users SET email = ?, name = ?, avatar_url = COALESCE(?, avatar_url), last_login = datetime("now"), updated_at = datetime("now") WHERE id = ?'
      ).bind(normalizedEmail, name, avatar_url, existingByProvider.id).run();
      return { ...existingByProvider, email: normalizedEmail, name, avatar_url: effectiveAvatar, provider, provider_id, last_login: new Date().toISOString() };
    }

    // Then try email match to merge accounts across providers
    const existingByEmail = await db.prepare('SELECT * FROM users WHERE email = ?').bind(normalizedEmail).first();

    if (existingByEmail) {
      // IMPORTANT: do not create a second user for the same email.
      // In legacy mode we cannot persist multiple identities, so we keep the existing user record.
      const effectiveAvatar = avatar_url || existingByEmail.avatar_url;
      await db.prepare(
        'UPDATE users SET name = ?, avatar_url = COALESCE(?, avatar_url), last_login = datetime("now"), updated_at = datetime("now") WHERE id = ?'
      ).bind(name, avatar_url, existingByEmail.id).run();
      return { ...existingByEmail, name, avatar_url: effectiveAvatar, provider, provider_id, last_login: new Date().toISOString() };
    }

    // Create new user
    const id = generateId();
    await db.prepare(
      'INSERT INTO users (id, email, name, avatar_url, provider, provider_id, last_login) VALUES (?, ?, ?, ?, ?, ?, datetime("now"))'
    ).bind(id, normalizedEmail, name, avatar_url, provider, provider_id).run();

    return { id, email: normalizedEmail, name, avatar_url, provider, provider_id, last_login: new Date().toISOString() };
  }
}
