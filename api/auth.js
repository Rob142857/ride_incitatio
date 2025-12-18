/**
 * OAuth Authentication Handler
 * Supports Google, Facebook, and Microsoft SSO
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
  
  facebook: {
    authUrl: 'https://www.facebook.com/v18.0/dialog/oauth',
    tokenUrl: 'https://graph.facebook.com/v18.0/oauth/access_token',
    userUrl: 'https://graph.facebook.com/me?fields=id,name,email,picture.type(large)',
    scopes: ['email', 'public_profile'],
    getClientId: (env) => env.FACEBOOK_APP_ID,
    getClientSecret: (env) => env.FACEBOOK_APP_SECRET,
    parseUser: (data) => ({
      email: data.email,
      name: data.name,
      avatar_url: data.picture?.data?.url,
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
    const state = generateId();
    
    // Store state in KV temporarily (5 minutes)
    await env.SESSIONS.put(`oauth_state_${state}`, JSON.stringify({
      provider: providerName,
      returnUrl: url.searchParams.get('return') || '/'
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
    const { params, env, url } = context;
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
    const stateData = await env.SESSIONS.get(`oauth_state_${state}`, 'json');
    if (!stateData || stateData.provider !== providerName) {
      return errorResponse('Invalid state', 400);
    }
    await env.SESSIONS.delete(`oauth_state_${state}`);
    
    // Exchange code for token
    const redirectUri = `${url.origin}/api/auth/callback/${providerName}`;
    
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
    const user = await createOrUpdateUser(env.DB, {
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
    
    // Redirect to app with session cookie
    const returnUrl = stateData.returnUrl || '/';
    const response = Response.redirect(returnUrl, 302);
    
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
      // Delete session from KV
      await env.SESSIONS.delete(match[1]);
    }
    
    const response = jsonResponse({ success: true });
    return clearSessionCookie(response);
  }
};

/**
 * Create or update user in database
 */
async function createOrUpdateUser(db, userData) {
  const { email, name, avatar_url, provider, provider_id } = userData;
  const normalizedEmail = email?.toLowerCase();
  
  // Check if user exists
  const existing = await db.prepare(
    'SELECT * FROM users WHERE provider = ? AND provider_id = ?'
  ).bind(provider, provider_id).first();
  
  if (existing) {
    // Update existing user
    await db.prepare(
      'UPDATE users SET email = ?, name = ?, avatar_url = ?, updated_at = datetime("now") WHERE id = ?'
    ).bind(normalizedEmail, name, avatar_url, existing.id).run();
    
    return { ...existing, email: normalizedEmail, name, avatar_url };
  }
  
  // Create new user
  const id = generateId();
  await db.prepare(
    'INSERT INTO users (id, email, name, avatar_url, provider, provider_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(id, normalizedEmail, name, avatar_url, provider, provider_id).run();
  
  return { id, email: normalizedEmail, name, avatar_url, provider, provider_id };
}
