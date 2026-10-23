# Deploying the demo to Vercel Hobby

This deploys **the React frontend only**, as a static bundle, in **demo mode**.
No backend is deployed. No AWS account is involved. Cost: **$0**.

Why only the frontend: no genuinely free host can run CPU YOLO inference
reliably. The research is in [`free-hosting.md`](free-hosting.md).

---

## Before you start

- A GitHub (or GitLab/Bitbucket) account with this repo pushed to it.
- A Vercel account on the **Hobby** plan. No card required.
- Nothing else. No AWS, no Docker, no Terraform.

**Non-commercial caveat.** Vercel's fair-use terms restrict Hobby to
**personal, non-commercial use**. A portfolio piece qualifies; anything
revenue-generating needs **Pro ($20/user/month)**. Read Vercel's current Fair
Use Guidelines yourself before deploying — the terms are theirs to change.

---

## 1. Import the repository

1. Vercel dashboard → **Add New… → Project**.
2. Connect the Git provider and pick this repository.
3. On the configuration screen, **leave Root Directory as the repository
   root** (`./`). Do *not* set it to `frontend`.

That last point matters: `vercel.json` lives at the repository root and drives
the build from there. Setting the root directory to `frontend` would make
Vercel look for a `vercel.json` that is not there and apply framework
auto-detection instead.

---

## 2. The settings that matter

The repository's root `vercel.json` already specifies the build. You should
**not** need to type any of this into the dashboard — but know what it does, so
you can tell whether the dashboard is overriding it.

| Setting | Value in `vercel.json` | Why |
|---|---|---|
| `buildCommand` | `cd frontend && npm ci && npm run build` | The app is in a subdirectory. `npm ci` installs from the committed lockfile, so the deployed build matches the tested one |
| `outputDirectory` | `frontend/dist` | Where Vite writes the bundle |
| `installCommand` | a no-op `echo` | Installation happens inside `buildCommand`; this stops Vercel installing at the repo root, where there is no `package.json` |
| `framework` | `null` | Auto-detection is off. The build is stated explicitly rather than inferred |
| `github.silent` | `true` | No deployment-status comments pushed back onto commits |

If the dashboard shows different values under **Settings → Build & Development
Settings**, clear the overrides — dashboard overrides win over `vercel.json`.

### SPA rewrites

```
"rewrites": [
  { "source": "/((?!demo/|assets/|favicon|icons).*)", "destination": "/index.html" }
]
```

Everything that is not a real asset is served `index.html`, so client-side deep
links resolve instead of 404ing. The negative lookahead excludes `demo/` (the
three sample images), `assets/` (the hashed bundle), and the favicon/icon
files — those must be served as themselves, not rewritten to HTML.

### Security headers

`vercel.json` sets, on every response: a Content-Security-Policy,
`Strict-Transport-Security` (two years, `includeSubDomains`, `preload`),
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: strict-origin-when-cross-origin`, a `Permissions-Policy`
denying camera/microphone/geolocation/payment/USB,
`Cross-Origin-Opener-Policy: same-origin`, and
`X-Permitted-Cross-Domain-Policies: none`. Hashed assets get a one-year
immutable cache; `index.html` is `must-revalidate`.

The CSP is:

```
default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self'; connect-src 'self';
object-src 'none'; base-uri 'self'; frame-ancestors 'none'; frame-src 'none';
form-action 'self'; manifest-src 'self'; worker-src 'self' blob:;
upgrade-insecure-requests
```

Two directives are worth explaining:

- **`connect-src 'self'`** — deliberately the tightest possible value. Demo
  mode makes **no external network calls at all**: the fixtures are imported
  into the bundle at build time and the images are served from the same origin.
  There is nothing to allow. If you ever point this build at a real backend
  (see [`free-hosting.md`](free-hosting.md) §5c), this is the directive you
  must widen, and it should be widened to that one origin, not to `*`.
- **`style-src 'unsafe-inline'`** — required by runtime-computed `style={{}}`
  props (the progress bar, category colours). Removing it needs per-request
  nonces, which a static host cannot generate. Inline *style* cannot execute
  JavaScript; `script-src` stays `'self'` with no unsafe directives. Full
  reasoning in [`../security/threat-model.md`](../security/threat-model.md).

---

## 3. Set the environment variable

**Settings → Environment Variables**, applied to **Production**, **Preview**
and **Development**:

| Name | Value |
|---|---|
| `VITE_API_MODE` | `demo` |

This is the only variable required, and it is **not optional**. Demo mode is
never the default: `resolveApiConfig` falls back to `local` for an unset value
*and for a typo* (`frontend/src/api/config.ts`). A deployment that is missing
this variable, or that has `VITE_API_MODE=Demo ` with a stray character that
does not survive trimming, will build in **local** mode — it will render the
upload dropzone and then fail on every request to an API that is not there.
Fail-loud, not fail-silent, which is the intent, but check it anyway.

`VITE_*` values are embedded into the built JavaScript and are **public**.
There is nothing secret here, and nothing secret should ever be put here.

Changing an environment variable does not rebuild. **Redeploy** afterwards.

---

## 4. Deploy

Click **Deploy**. A cold build is typically a couple of minutes, most of it
`npm ci`.

---

## 5. Verify the deployment

Work through all five. The first four are quick; the fifth is the one that
matters.

**1. The build is in demo mode.** The page shows the demo banner — "These are
pre-recorded results, not live inference" — above the dashboard.

**2. There is no upload control.** The dropzone is replaced by a **Sample
analyses** panel listing three recorded samples. There should be no file input
anywhere on the page. Its absence is the point: demo mode cannot analyse a new
image, so it does not offer to.

**3. Deep links work.** Navigate to a non-root path directly in the address bar
(not by clicking). It must render the app, not a 404 — that is the SPA rewrite
doing its job.

**4. The headers are present.** From a terminal:

```bash
curl -sI https://<your-deployment>.vercel.app | grep -i \
  -e content-security-policy -e strict-transport-security \
  -e x-content-type-options -e x-frame-options -e referrer-policy
```

All five should be there. If they are not, the `headers` block in
`vercel.json` is not being applied — check that the Root Directory is the
repository root.

**5. The sample images load and the zero-detection case is intact.** Open each
of the three samples. `bus.jpg` shows **6** detections, `zidane.jpg` shows
**3**, and `synthetic_shelf.jpg` shows **0** with status `empty` and a plain
statement that nothing was detected — not an invented stock reading. If the
third one is missing or shows something, the fixture is wrong.

### Known limits of the demo build

Two dashboard features call the API directly and are **not** demo-aware:
**comparing two scans** and **deleting a scan** from the history list. In the
deployed demo these will fail, because there is no API. Capture screenshots of
comparison from a **local** run instead — see
[`../portfolio/screenshots.md`](../portfolio/screenshots.md).

---

## 6. Hobby plan limits

Current at **2026-10-23**, and all subject to change — **check Vercel's
pricing page before relying on any of them**:

- Personal, **non-commercial** use only (see above).
- Bandwidth, build minutes and deployment counts are capped per month; a
  static SPA with three small JPEGs is nowhere near any of them for a
  portfolio's traffic.
- No team members, no custom build concurrency.
- Preview deployments on every push, which is useful and also free.

A custom domain can be attached on Hobby, but the domain registration itself
is not free. The `*.vercel.app` URL is, and it is sufficient for a portfolio.

---

## 7. Teardown

Delete the project from the Vercel dashboard. There is nothing else to tear
down — no database, no storage bucket, no DNS record, no AWS resource. Nothing
was ever billable.
