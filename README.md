# ReForward

ReForward is a Cloudflare Worker reverse-proxy console built around a first-run OOBE flow.

On a fresh deployment, any visited path opens setup. OOBE writes the admin path, default entry strategy, and password hash into D1. After setup completes, OOBE is permanently locked and the Worker starts serving normal traffic.

## Features

- public routes support `proxy`, `site`, `redirect`, and `text`
- admin path is stored in D1 instead of hardcoded in the repo
- first-run setup is browser driven through OOBE
- route data, bootstrap settings, login throttling, and security mode are stored in D1
- admin sessions are invalidated on new deployments when `CF_VERSION_METADATA` is available
- public proxy caching can be tuned with runtime env vars

## Quick Start

1. Create a D1 database.
2. Bind it as `DB` in `wrangler.jsonc`.
3. Run the schema:

```bash
npx wrangler d1 execute DB --file migrations/0001_initial_schema.sql
```

4. Deploy:

```bash
npm run deploy
```

5. Open any path on the Worker domain.
6. Complete OOBE once.

After that:

- the admin path you chose becomes the login entry
- `/_oobe` behaves like any other unmatched public path
- `/` and unmatched public paths follow the default entry strategy from OOBE

## GitHub + Cloudflare Deploy

If you want GitHub-triggered automatic deploys, use Cloudflare Workers Builds.

### One-time setup

1. Push this project to GitHub.
2. Make sure the Worker name in the Cloudflare dashboard matches the `name` in `wrangler.jsonc`.
3. In the Cloudflare dashboard, go to `Workers & Pages`.
4. Either:
   - create a new Worker with `Create application` -> `Import a repository`, or
   - open an existing Worker -> `Settings` -> `Builds` -> `Connect`
5. Connect your GitHub account and select this repository.
6. Set the project root to the directory that contains `wrangler.jsonc`.
7. Keep the deploy command as `npx wrangler deploy`, or set an equivalent custom command if you need one.
8. Save and deploy.

### Required follow-up

- bind your D1 database to the Worker as `DB`
- add any optional environment variables in the dashboard if you use them
- run `migrations/0001_initial_schema.sql` against the bound D1 database
- open any Worker URL and complete OOBE once

### Recommended branch behavior

- set your production branch to `main` or whatever branch you actually release from
- enable non-production branch builds if you want preview versions for feature branches

### Notes for this repo

- this project is a Worker, not a Pages project
- Git deploys do not replace the D1 schema initialization step
- Git deploys do not bypass OOBE; first-run setup still happens in the browser

## OOBE

OOBE collects three things:

1. admin path
2. default entry strategy
3. admin password

Supported default entry strategies:

- `site`: reverse-proxy a default upstream site without changing the browser URL
- `login`: show the admin login page
- `text`: return plain text
- `status_code`: return the configured HTTP status directly

If bootstrap settings already exist in D1, OOBE refuses to overwrite them.

## Route Types

- `proxy`: proxy a specific upstream URL
- `site`: mount an upstream site under a public path, with optional HTML rewriting
- `redirect`: return a `302` redirect
- `text`: return plain text directly

## Runtime Requirements

### Required

| Item | Value | Notes |
| --- | --- | --- |
| D1 binding | `DB` | Required for routes, bootstrap settings, login throttling, and security mode |

### Optional Env Vars

| Env var | Example | Purpose |
| --- | --- | --- |
| `DEFAULT_REDIRECT_URL` | `https://example.com` | OOBE prefill only for the default `site` strategy |
| `SESSION_SECRET` | `long-random-string` | Stable admin session signing fallback when deployment metadata is unavailable |
| `PUBLIC_PROXY_CACHE_CONTROL` | `public, max-age=300, s-maxage=300` | Overrides `Cache-Control` for public `proxy/site` responses |
| `PUBLIC_PROXY_CACHE_TTL_SECONDS` | `300` | Enables Cloudflare edge caching for public `proxy/site` GET/HEAD requests when cookies are stripped |
| `BACKEND_PATH` | `old-admin-path` | Legacy migration fallback only |

Notes:

- `CONSOLE_PASSWORD` is no longer used as a required runtime variable.
- If neither `SESSION_SECRET` nor `CF_VERSION_METADATA` is available, admin sessions fall back to an in-memory runtime secret and may not stay stable across isolates.
- Set `PUBLIC_PROXY_CACHE_CONTROL=pass-through` if you want to keep the upstream `Cache-Control` header.

## Local Development

Preferred:

```bash
cp .env.example .env
npm run dev:local
```

Or, if you prefer Wrangler's native variable file:

```bash
cp .dev.vars.example .dev.vars
npm run dev:local
```

This script:

- stores Wrangler state under `local-tmp/wrangler-state`
- stores Wrangler config, logs, and registry under `local-tmp/xdg-config`
- stores npm cache under `local-tmp/npm-cache`
- initializes local D1 automatically
- loads `.env` if present, otherwise falls back to `.dev.vars`

Example `.env.example` / `.dev.vars.example`:

```dotenv
DEFAULT_REDIRECT_URL=https://example.com
SESSION_SECRET=replace-with-a-long-random-string
PUBLIC_PROXY_CACHE_CONTROL=public, max-age=300, s-maxage=300
PUBLIC_PROXY_CACHE_TTL_SECONDS=300
```

If you remove `local-tmp/`, local D1 data, local Wrangler state, logs, registry data, and the local npm cache are effectively reset.

## Storage Model

Stored in D1:

- public route definitions
- admin path
- default entry strategy and its parameters
- password hash, salt, and PBKDF2 iterations
- login throttle records
- security mode settings
- session revision

Not stored as a long-lived static secret:

- admin session signing key derived from deployment metadata

## Verify After Deploy

- first visit on a fresh install opens OOBE regardless of path
- submitting OOBE once locks it permanently
- revisiting `/_oobe` behaves the same as any other unmatched public path
- the configured admin path shows the login page
- route CRUD works after schema initialization
- repeated public GET/HEAD requests stop hammering the origin if edge caching is enabled and cookies are stripped

## Security Notes

- login attempts are throttled in D1
- admin mutations require same-origin checks and CSRF validation
- admin cookies use `HttpOnly` and `SameSite=Strict`
- private-target blocking exists for `proxy/site`, but DNS-level SSRF edge cases still need caution
- use a long random admin path
- use a strong admin password
