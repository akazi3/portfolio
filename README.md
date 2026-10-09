# Studio Portfolio CMS

Self-hosted portfolio site with a built-in CMS. Zero npm dependencies (Node 20+). All content, including video, is stored on your own server in one `data/` folder. Nothing is loaded from third-party services.

## Run

```bash
ADMIN_PASSWORD='choose-a-strong-one' SESSION_SECRET="$(openssl rand -hex 32)" node server.js
# site:  http://localhost:3000
# admin: http://localhost:3000/admin
```

Docker: `docker build -t studio-cms . && docker run -d -p 3000:3000 -v studio-data:/data -e ADMIN_PASSWORD=... -e SESSION_SECRET=... studio-cms`

## Using the CMS

- **Projects → New project:** title, category (Film / Social / Digital), client, year, summary, description, credits (`Role: Name` per line), tags, cover image, and any number of videos/images (drag to reorder with ↑ ↓, optional captions).
- **Draft / Published:** drafts are invisible publicly; signed-in editors can preview them at the project URL. **Featured** pins a project to the top.
- **Settings:** studio name, tagline, About text, contact email, and categories.

## Configuration (env vars)

| Var | Default | Notes |
|---|---|---|
| `ADMIN_USER` / `ADMIN_PASSWORD` | `admin` / random (printed at start) | Set a real password |
| `SESSION_SECRET` | random per start | Set it so logins survive restarts |
| `PORT` | 3000 | |
| `DATA_DIR` | `./data` | Content DB + uploads. **Back this up.** |
| `MAX_UPLOAD_MB` | 2048 | Per file |
| `COOKIE_SECURE` | off | Set `1` when served over HTTPS |
| `SSO_HEADER` | off | e.g. `x-forwarded-user`. Trusts that header from your internal SSO proxy for admin access. Only enable if the app is reachable *only* through that proxy |

## Internal deployment notes

- Put it behind your internal reverse proxy (nginx/Caddy/ALB) with TLS, and set `COOKIE_SECURE=1`. Raise the proxy's `client_max_body_size` / request timeout for large video uploads.
- Restrict `/admin` to the corporate network or SSO group at the proxy.
- Videos are served as-is (with range requests). Upload web-ready H.264 MP4s; for heavy traffic, front `/uploads` with your internal CDN/cache.
- Single admin account is built in; for per-editor identity and audit, use `SSO_HEADER`.
- Content is stored in `data/db.json` plus `data/uploads/`. That suits hundreds of projects; move to a database if you outgrow it.

## Before go-live

Run it through your standard security review and Technology Intake. Confirm that talent likenesses, music and client work are cleared for display.
