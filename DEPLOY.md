# Cloudflare Deployment Guide

**Domain:** ride.incitat.io

## Prerequisites

1. Install Wrangler CLI:
   ```bash
   npm install -g wrangler
   ```

2. Login to Cloudflare:
   ```bash
   wrangler login
   ```

## Initial Setup

### 1. Create D1 Database

```bash
npm run db:create
```

This will output a database ID. Copy it and update `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "ride-db"
database_id = "YOUR_DATABASE_ID_HERE"
```

### 2. Create KV Namespace for Sessions

```bash
npm run kv:create
```

This will output a KV namespace ID. Copy it and update `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "SESSIONS"
id = "YOUR_KV_NAMESPACE_ID_HERE"
```

### 3. Create R2 Bucket for Attachments

```bash
wrangler r2 bucket create ride-attachments
```

The bucket name in wrangler.toml should match (`ride-attachments`).

### 4. Run Database Migrations

```bash
npm run db:migrate
```

### 5. Configure OAuth Providers

You need to set up OAuth apps with each provider and add the secrets to Cloudflare.

**Important:** Use `https://ride.incitat.io` as your redirect URI base.

#### Google OAuth

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing
3. Go to "APIs & Services" → "Credentials"
4. Create "OAuth 2.0 Client ID"
5. Set authorized redirect URI: `https://ride.incitat.io/api/auth/callback/google`
6. Copy Client ID and Client Secret

#### Facebook OAuth

1. Go to [Facebook Developers](https://developers.facebook.com/)
2. Create a new app (Consumer type)
3. Add "Facebook Login" product
4. Set Valid OAuth Redirect URI: `https://ride.incitat.io/api/auth/callback/facebook`
5. Copy App ID and App Secret

#### Microsoft OAuth

1. Go to [Azure Portal](https://portal.azure.com/)
2. Register a new application in Azure AD
3. Add redirect URI: `https://ride.incitat.io/api/auth/callback/microsoft`
4. Create a client secret
5. Copy Application (client) ID and Client Secret

### 6. Add Secrets to Cloudflare

```bash
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put FACEBOOK_APP_ID
wrangler secret put FACEBOOK_APP_SECRET
wrangler secret put MICROSOFT_CLIENT_ID
wrangler secret put MICROSOFT_CLIENT_SECRET
wrangler secret put JWT_SECRET
```

For JWT_SECRET, generate a random string:
```bash
openssl rand -hex 32
```

## Deploy

```bash
npm run deploy
```

Your app will be available at `https://ride.incitat.io`

## Custom Domain Setup

1. Go to Cloudflare Dashboard → Pages → Your Project
2. Click "Custom domains"
3. Add `ride.incitat.io`
4. Configure DNS (if not already on Cloudflare, add CNAME)

## Short URLs

Trips get automatic 6-character short codes:
- Share link: `https://ride.incitat.io/t/abc123`
- Full page: `https://ride.incitat.io/trip/abc123`

## Local Development with Cloud Services

To test with D1, KV and R2 locally:

```bash
npm run dev:remote
```

## Troubleshooting

### OAuth Callback Errors

Make sure your redirect URIs in the OAuth provider settings exactly match:
- `https://ride.incitat.io/api/auth/callback/google`
- `https://ride.incitat.io/api/auth/callback/facebook`
- `https://ride.incitat.io/api/auth/callback/microsoft`

### Database Errors

Check if migrations ran successfully:
```bash
wrangler d1 execute ride-db --command "SELECT name FROM sqlite_master WHERE type='table'"
```

### Session Issues

Check if KV namespace is properly bound by looking at the Pages deployment logs.

### R2 Attachment Issues

Verify R2 bucket exists:
```bash
wrangler r2 bucket list
```

Check bucket contents:
```bash
wrangler r2 object list ride-attachments
```
