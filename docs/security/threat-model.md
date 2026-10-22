# Threat Model and Security Assumptions

Scope: the VisionIQ backend (`backend/app/`), its storage and persistence
adapters, and the Terraform under `infrastructure/terraform/`. Every mitigation
below points at code that exists today; everything not yet mitigated is listed
explicitly in §6.

> **Deployment status:** nothing has been deployed. The cloud-side mitigations
> described here are what the Terraform and application code *specify*; none has
> been exercised against a live account.

---

## 1. Trust boundaries

```
  UNTRUSTED                    │ SEMI-TRUSTED              │ TRUSTED
───────────────────────────────┼───────────────────────────┼──────────────────────
  Browser / API client         │                           │
   - arbitrary bytes           │                           │
   - arbitrary headers         │                           │
   - lies about size & type    │                           │
            │                  │                           │
            ▼ ①                │                           │
  ┌──────────────────────┐     │  ┌─────────────────────┐  │
  │ Cognito hosted UI    │     │  │ app/auth/           │  │
  │  ⓪ⓐ code flow+PKCE  │     │  │ TokenClaims.subject │  │
  │ Amazon Cognito       │     │  │ = the ONLY owner id │  │
  │  user pool, SRP only │     │  │                     │  │
  │  issues RS256 JWTs   │     │  └──────────▲──────────┘  │
  └──────────┬───────────┘     │             │             │
             │ access token    │             │             │
             ▼ ⓪              │             │             │
  ┌──────────────────────┐     │             │             │
  │ API Gateway / FastAPI│─────┼─▶ ② request handlers      │
  │  CORS, throttling,   │     │    validation, rate limit │
  │  JWT authorizer on   │     │    tenant scoping         │
  │  ALL FOUR routes     │     │                           │
  └──────────────────────┘     │            │              │
            │ ③ presigned PUT  │            ▼ ④            │
            ▼                  │   ┌──────────────────┐    │
  ┌──────────────────────┐     │   │ SQS (SSE, DLQ)   │    │
  │ S3 (private, SSE)    │◀────┼───┤                  │    │
  │  object bytes are    │     │   └────────┬─────────┘    │
  │  STILL untrusted     │     │            ▼ ⑤            │
  └──────────────────────┘     │   ┌──────────────────┐    │  ┌─────────────────┐
                               │   │ Fargate worker   │────┼─▶│ DynamoDB        │
                               │   │ Pillow decode    │    │  │ (SSE, PITR)     │
                               │   │ YOLO inference   │    │  └─────────────────┘
                               │   └────────┬─────────┘    │
                               │            ▼ ⑥            │
                               │   ┌──────────────────┐    │
                               │   │ Amazon Bedrock   │    │ ← output is UNTRUSTED
                               │   │ structured counts│    │   (strict JSON parse)
                               │   └──────────────────┘    │
```

| # | Boundary | Assumption |
|---|---|---|
| ⓪ | Browser → Cognito | Cognito is the **only** identity authority. It is semi-trusted as an issuer: the app still verifies algorithm, signature, issuer, audience, expiry and `token_use` before acting on a token (or relies on the gateway's authorizer having done so). A token is trusted for exactly one thing — its `sub`. |
| ⓪ⓐ | Browser ↔ Cognito hosted UI | A **separate origin** from the SPA, crossed by full-page redirects the user's browser controls. The SPA therefore treats everything coming back across it as untrusted input: the `state` is validated before the code is used, the code is single-use and exchanged with a PKCE verifier the SPA generated, and claims read from the returned token (`readClaimsUnsafe`) are for **display only** — never an authorization decision. Credentials are entered on Cognito's origin, never in the SPA. The app client is public (`generate_secret = false`), so possession of a code alone proves nothing; the verifier does. |
| ① | Browser → API | Nothing from the client is trusted: not the filename, not the `Content-Type` header, not the declared size, and above all **not an owner id**. No code path reads an owner id from a header, query parameter or body. |
| ② | API → services | Services receive only validated, typed inputs. They never see raw headers. |
| ③ | Client → S3 (direct PUT) | The bytes bypass the API entirely. S3 enforces key, content-type and encryption via the signature; **size and actual pixel content are re-checked server-side afterwards**. |
| ④ | API → SQS | The message carries only `analysis_id`, `owner_id`, `image_key` — identifiers, never bytes or credentials. |
| ⑤ | Worker → data stores | The worker holds IAM permissions scoped to one bucket prefix, one table and one queue. |
| ⑥ | Worker → Bedrock | An LLM is treated as an untrusted transform: structured facts in, strictly validated JSON out, deterministic fallback on anything else. |

---

## 2. Assets

| Asset | Where it lives | Why it matters |
|---|---|---|
| Uploaded shelf images | S3 (cloud) / `backend/data/images/` (local) | Customer premises imagery; may incidentally contain faces, staff, documents. COCO includes a `person` class. |
| Analysis results | DynamoDB / SQLite | Detected counts per store over time — commercially sensitive as a trend even though they are not inventory. |
| Storage keys and object URLs | API responses, logs | A leaked presigned URL is a bearer token for one object for up to `VISIONIQ_PRESIGN_TTL` seconds. |
| AWS credentials | ECS task role, Lambda execution role, GitHub OIDC role | Full blast radius if leaked. No static keys exist anywhere in the repo. |
| Terraform state | Bootstrapped S3 bucket (versioned, encrypted, public access fully blocked) | Contains every resource identifier; the lock table prevents concurrent corrupting applies. |
| Model weights | `backend/models/` locally; baked into the container image | Not secret, but AGPL-3.0 — a licensing asset. See `docs/architecture/models.md`. |

---

## 3. Threats and mitigations

### Authentication and authorization

Three modes, selected by `VISIONIQ_AUTH_MODE` (`app/auth/resolver.py`): `none`
(local, pseudo-tenant `local`), `apigateway` (the gateway's JWT authorizer
already verified the token; claims are read from
`request.scope["aws.event"].requestContext.authorizer.jwt.claims`), and `jwt`
(this process verifies via JWKS). In every mode the owner id is
`TokenClaims.subject` and nothing else.

| Threat | Mitigation | Code |
|---|---|---|
| **Anonymous access to the whole API** | The API Gateway JWT authorizer is attached to **every route** (all six, via `for_each` over `local.functions`) — there is no public route. `lambda/api/handler.py` has no `anonymous` fallback: a missing `sub` is a `401`. In the app, `apigateway` and `jwt` modes both refuse a request with no verified identity. | `modules/api`, `lambda/api/handler.py`, `auth/resolver.py` |
| **Forged owner id** (client asserts who it is) | The trusted `X-VisionIQ-User` header path is **removed**. `security.get_owner_id` returns `get_claims(...).owner_id`, which is the `sub` of a verified token. There is no header, query or body path to an owner id anywhere in the codebase. | `security.py`, `auth/base.py` |
| **Algorithm confusion / `alg: none`** | The header `alg` is checked against an explicit allow-list of `RS256/384/512` **before any crypto is attempted**, and the same list is passed to `jwt.decode`. HS\* is never permitted: JWKS keys are public, so an HMAC-accepting verifier lets anyone sign their own token with the published key. | `auth/jwt_verifier.py:ALLOWED_ALGORITHMS` |
| **Token replay across token types** | `token_use` must equal the configured type, so an id token cannot be swapped in where an access token is expected. Cognito access tokens carry no `aud`, so PyJWT's audience check is disabled for them and `client_id` is checked explicitly instead — the audience is never simply skipped. | `jwt_verifier._validate_claims` |
| **Expired, not-yet-valid or foreign-issuer tokens** | `exp`, `iat` and `nbf` are all verified with a small configurable leeway (`VISIONIQ_JWT_LEEWAY`, default 30 s), `iss` must match exactly, and `exp`/`iat`/`sub`/`iss` are all in PyJWT's `require` list. Cognito access tokens live 1 h. | `jwt_verifier.verify`, `modules/auth` |
| **Token with no subject** | A missing or non-string `sub` is rejected: without it there is no tenant, and defaulting to one would be the `anonymous` bug again. | `jwt_verifier._validate_claims` |
| **Cross-tenant read** | A miss on `(owner_id, analysis_id)` is **404**, identical to a nonexistent id — a 403 would confirm the record exists under another tenant. | `repositories/*`, `routes/analyses.py`, `routes/cloud.py` |
| **Cross-tenant delete** | Same keying: `delete` is on `(owner_id, analysis_id)`, so a foreign id deletes nothing and returns 404. | `repositories/*` |
| **JWKS-flood amplification** (junk `kid`s turned into outbound request storms) | Keys are cached in-process with a TTL (`VISIONIQ_JWKS_CACHE_TTL`, default 1 h), and an unknown `kid` triggers at most **one refetch per 60 s** cooldown. Outside that window an unknown `kid` is simply `invalid_token`. Fetches have a 5 s timeout. | `jwt_verifier.JwksCache` |
| **Information leak through auth errors** | `AuthError.detail` is deliberately caller-safe and never echoes token contents, keys or internal state. JWKS/network failures are logged server-side and surface only as "Could not retrieve the token signing keys." | `auth/base.py`, `jwt_verifier._fetch` |
| **Misconfiguration silently opening the API** | An unknown mode, a missing issuer or audience, or an unreachable JWKS **fails closed** with `503`, never anonymous access. 401 (caller's fault, with `WWW-Authenticate: Bearer`) and 503 (ours) are kept strictly distinct. | `security._auth_http_error`, `resolver._get_verifier` |
| **Token theft via browser storage** | The SPA holds the access token **in memory only** — a module-scoped variable in `auth/session.ts`. It is never written to `localStorage` or `sessionStorage`, where any script on the origin can read it and one XSS becomes stolen credentials. Session continuity is Cognito's job, via silent re-authentication. | `frontend/src/auth/session.ts`, `frontend/src/api/auth.ts` |
| **Password on the wire / brute force** | The app client enables only `ALLOW_USER_SRP_AUTH` and `ALLOW_REFRESH_TOKEN_AUTH`; `ALLOW_USER_PASSWORD_AUTH` is deliberately absent. 12-char minimum with four character classes, optional TOTP MFA, token revocation on, `prevent_user_existence_errors = ENABLED`. | `modules/auth/main.tf` |
| **Stolen client secret** | There is no client secret — `generate_secret = false`, because a browser cannot keep one. The pool id, client id, issuer and JWKS URI are public by design and ship in the SPA bundle. | `modules/auth` |
| **Pre-sign-in reconnaissance via `GET /api/system/status`** | That endpoint is reachable before authentication, so once auth is enabled it stops reporting `storage_backend`, `repository_backend` and `insights_provider`, and returns a generic "Detection is currently unavailable." instead of the internal failure string. | `routes/cloud.py:system_status` |

### Frontend authentication (the SPA sign-in flow)

`frontend/src/auth/` implements the OAuth 2.0 **authorization code flow with
PKCE (S256)** against the Cognito hosted UI, by hand (no Amplify), so every
security-relevant step stays visible and testable. The design premise is
blunt: **a browser cannot keep a secret**, so the only credential that ever
exists in the page is a short-lived access token held in memory, and the only
long-lived session state is Cognito's own cookie on Cognito's own origin.

| Threat | Mitigation | Code |
|---|---|---|
| **Access-token leakage via the implicit flow** | `response_type` is always `code`, never `token`. The implicit flow returns the token in the URL fragment, where it leaks through browser history, `Referer` headers, server logs and extensions. Terraform independently enforces this: `allowed_oauth_flows = ["code"]` — the pool would reject an implicit request even if the SPA made one. A test asserts the SPA never attempts it. | `auth/cognito.ts:buildAuthorizeUrl`, `modules/auth/main.tf`, `auth/contract.test.ts` |
| **Authorization-code interception** (a malicious app or network observer redeeming a stolen code) | PKCE S256. A 64-byte random `code_verifier` is generated per request; only its SHA-256 challenge is sent on the authorize call, and the verifier is required at the token endpoint. The app client is public (`generate_secret = false`), so PKCE is *the* proof of legitimacy — there is no secret to fall back on. `plain` is never used. | `auth/pkce.ts`, `auth/cognito.ts:exchangeCodeForTokens` |
| **CSRF on the callback** (an attacker forcing their own authorization code into your session, or a forged callback) | An unguessable `state` is generated per request, stashed, and compared against the returned value with `statesMatch` (length-checked, constant-time-ish XOR). A mismatch throws **before** the code is exchanged — a test asserts `fetch` is never called in that path. | `auth/pkce.ts:createState`/`statesMatch`, `auth/AuthProvider.tsx` |
| **Token theft via web storage / XSS** | The access token lives in a module-scoped variable and nowhere else: not `localStorage`, not `sessionStorage`, not a JS-readable cookie, not the URL. A page reload starting with no token is the intended behaviour. | `auth/session.ts` |
| **Refresh-token theft — the big one** | **No refresh token ever enters the browser.** Cognito returns one on the code exchange and `exchangeCodeForTokens` deliberately never reads `payload.refresh_token`; it is not returned, not stored, not logged. A refresh token is a **30-day** credential (Terraform `refresh_token_validity_days` default), and every store a SPA can reach is JS-readable, so one XSS would buy a month of account access rather than minutes. A test asserts the refresh token appears neither on the returned object nor in `localStorage`/`sessionStorage`. | `auth/cognito.ts`, `modules/auth/variables.tf` |
| **Stale or replayed code reuse** | `consumeFlow()` reads and immediately clears the verifier and state — always single-use, in both the success and failure paths. A callback with no stashed verifier is rejected as `stale_flow` rather than attempted. A `useRef` guard stops React StrictMode's double-invocation from redeeming the same single-use code twice. | `auth/pkce.ts:consumeFlow`, `auth/AuthProvider.tsx` |
| **Code and state lingering in browser history** | After the callback is handled, `scrubCallbackParams()` removes `code`, `state`, `error` and `error_description` from the address bar via `history.replaceState`, so they are not left in history, bookmarks or anything that reads `document.URL`. | `auth/AuthProvider.tsx:scrubCallbackParams` |
| **Sign-out that does not actually sign out** | `logout()` clears the in-memory session *and* navigates to the hosted-UI `{domain}/logout`, so Cognito's own session cookie is cleared. Without that step the next silent re-authentication would immediately hand the session back — a "sign out" that signs nothing out, which is worse than none because the user believes it worked. | `auth/cognito.ts:buildLogoutUrl`, `auth/AuthProvider.tsx:logout` |
| **Authentication bypass shipped to production** | `resolveAuthConfig` **fails closed**. A production build with `VITE_AUTH_MODE=local` returns `misconfigured`, as does a missing `VITE_COGNITO_DOMAIN`/`VITE_COGNITO_CLIENT_ID`, an unknown mode, or an `http://` redirect URI in production. `misconfigured` renders a hard configuration error and **never a dashboard** — it does not degrade to "signed in". A shipped local bypass would authenticate every visitor as the same tenant. | `auth/config.ts`, `auth/config.test.ts` |
| **Authorization code returned over plaintext** | A production build rejects an `http://` redirect URI outright. | `auth/config.ts` |
| **Expired token sent to the API** | A timer fires `EXPIRY_SKEW_MS` (60 s) before expiry and moves the app to `expired`; independently, `getAccessToken()` returns `null` once `isExpired()` is true, so a stale token cannot be attached even if a timer is missed. A `401` from `fetch` or from the XHR upload path notifies `onUnauthorized` subscribers and drives the same transition. | `auth/session.ts`, `api/client.ts:onUnauthorized` |
| **Client-side authorization decisions** | `readClaimsUnsafe` performs **no** signature, issuer, audience or expiry verification and exists purely so the header can show who is signed in. All authorization happens server-side against a verified token. The dashboard is gated on `status === 'authenticated'` through `AuthGate`, but that is a UX gate, not a security boundary — the API is the boundary. | `auth/cognito.ts:readClaimsUnsafe`, `AuthenticatedApp.tsx` |
| **Error messages echoing request parameters** | A failed token exchange surfaces only the HTTP status, never the provider's response body, which can echo submitted parameters. | `auth/cognito.ts` |

**Why the PKCE verifier and `state` are allowed in `sessionStorage`.** They
must survive a full-page redirect, so they cannot live in memory. This is not a
violation of the no-tokens-in-web-storage rule, because a verifier is **not a
credential**: it is single-use, worthless without the matching authorization
code, scoped to one tab, and deleted the moment the code is exchanged
(`consumeFlow` always clears, including on failure). Its worst-case disclosure
costs an attacker nothing unless they *also* hold the code, which is exactly
the pairing PKCE exists to require.

**The accepted tradeoff.** The cost of refusing a refresh token in the browser
is that closing the browser — or Cognito's session cookie expiring — requires a
fresh interactive sign-in. That is deliberate. The upgrade path for persistent
sessions is a **backend-for-frontend** holding the refresh token in an
`HttpOnly`, `Secure`, `SameSite` cookie with CSRF protection, so JavaScript can
never read it. It is **not implemented**, because the deployed API is API
Gateway + Lambda with a JWT authorizer that expects a `Bearer` token, not a
same-origin cookie backend; adding a BFF means adding a stateful tier this
architecture does not currently have.

#### Sign-in reliability (availability, not confidentiality)

Two failure modes here are availability and cost problems rather than
confidentiality ones, but both are reachable by an attacker who can influence
the provider's responses or the victim's browser settings.

| Threat | Mitigation | Code |
|---|---|---|
| **Infinite redirect loop.** A misconfigured or hostile provider that redirects back with *neither* a `code` nor an `error` would send the SPA into a silent-auth attempt on every single page load — forever. Each round trip is a real request to Cognito, so this is a self-inflicted request amplifier as well as an unusable app. | `MAX_SILENT_ATTEMPTS = 2`, counted in `sessionStorage`. Past the budget the app stops redirecting and renders the signed-out screen. The budget is **reset** on a successful sign-in and on an explicit login, and **deliberately spent** when the provider returns `login_required`, so a reload after a genuine sign-out shows the login screen instead of paying for another round trip. | `auth/pkce.ts`, `auth/AuthProvider.tsx` |
| **Blocked browser storage.** With cookies/site data blocked, the PKCE verifier and `state` cannot survive the redirect. Redirecting anyway sends the user into a flow that *cannot* complete, and the failure surfaces as an opaque state mismatch. | `storageAvailable()` probe **plus a verified read-back** in `stashFlow` — some browsers accept a write and silently drop it, so probing alone is not enough. If storage is unusable the app does **not** redirect; it shows an actionable message about cookies and site data. | `auth/pkce.ts`, `auth/AuthProvider.tsx` |
| **Logout that silently reauthenticates.** If sign-out only cleared local state, the next silent `prompt=none` attempt would immediately succeed against Cognito's surviving session cookie and un-sign-out the user. | Logout goes to the hosted-UI `/logout` endpoint, which clears Cognito's own session cookie, and a signed-out hint suppresses the next silent attempt. Verified by test. | `auth/cognito.ts`, `auth/AuthProvider.tsx` |
| **Security state invisible to assistive technology.** A sign-in failure or a hard misconfiguration announced only visually is a security-relevant message a screen-reader user may never receive. | `role="alert"` on the sign-in-failed and misconfigured screens; `role="status" aria-live="polite"` on loading and session-expired. | `components/AuthScreens.tsx` |

**JWT validation was not weakened to achieve any of this.** `backend/app/auth/`
is unchanged: the RS256-only allow-list, JWKS cache, `iss`/`aud`/`exp`/`token_use`
checks and non-empty `sub` requirement all stand exactly as described above.

> **Verification status:** every item in this table is covered by unit or
> integration tests with a stubbed `fetch` and a stubbed `window.location`.
> **None of it has been exercised against a live Cognito user pool** — nothing
> is deployed and there are no AWS credentials on this machine. See
> `docs/deployment/aws.md` §8a for the live checks that remain outstanding.

### Content Security Policy and security headers

**CSP is defence in depth, not a fix for XSS.** It does not stop a cross-site
scripting bug from existing; it narrows what injected script can do once it
exists — chiefly, it stops the injected payload from loading or executing code
from anywhere the policy does not name, and it stops exfiltration to an
arbitrary origin. Preventing XSS itself is still the job of the app's own
rendering and input handling.

`frontend/src/security/csp.ts` is the single source of truth: `buildCsp()`
produces the policy, `securityHeaders()` the accompanying headers.
`vite.config.ts` serves the relaxed policy on the dev server and the **strict**
policy on `vite preview`, so the real production bundle can be checked locally.
Production delivery is CloudFront's response-headers policy in
`infrastructure/terraform/modules/frontend/` — a static S3 origin cannot set
response headers itself. The Lambda API sets its own
`x-content-type-options: nosniff` and `cache-control: no-store` on every
response, so an API response is not sniffable or cacheable either.

| Directive / header | Value | What it mitigates |
|---|---|---|
| `default-src` | `'none'` | Anything not explicitly allowed below is blocked — a deny-by-default floor. |
| `script-src` | `'self'` | Injected inline `<script>`, `javascript:` URLs, and third-party script loads. The highest-value directive in the policy. |
| `style-src` | `'self' 'unsafe-inline'` | Remote stylesheet injection. See the exception below. |
| `img-src` | `'self' data: blob:` | `blob:` is required — the dashboard previews uploads via `URL.createObjectURL`. |
| `connect-src` | `'self'` + API / Cognito hosted UI / Cognito IDP / upload bucket | Exfiltration of tokens or analysis data to an attacker-controlled endpoint. |
| `object-src`, `frame-src` | `'none'` | Flash/plugin and nested-frame injection vectors. |
| `base-uri` | `'self'` | `<base href>` injection, which otherwise silently repoints every relative script URL. |
| `frame-ancestors` | `'none'` | Clickjacking — the modern replacement for `X-Frame-Options`. |
| `form-action` | `'self'` + Cognito hosted UI | A form planted by injected markup POSTing credentials elsewhere. |
| `worker-src` | `'self' blob:` | Worker code from an untrusted origin. |
| `upgrade-insecure-requests` | production only | Mixed-content downgrade; pointless on a plaintext dev server. |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` | TLS stripping. Production only — setting it on a dev server would pin `localhost` to https. |
| `X-Content-Type-Options` | `nosniff` | MIME sniffing turning an uploaded or user-controlled response into script. |
| `X-Frame-Options` | `DENY` | Clickjacking on browsers predating `frame-ancestors`. |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Leaking paths — and any params that ever end up in one — to third parties. |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=()` | Injected script silently reaching for device APIs the app never uses. |
| `Cross-Origin-Opener-Policy` | `same-origin` | Cross-origin window references; XS-leaks. |
| `X-Permitted-Cross-Domain-Policies` | `none` | Legacy Adobe cross-domain policy loading. |

#### Measured evidence

Against the **real production bundle**, served by `vite preview` on `:4175`:

- **zero** inline `<script>` blocks; exactly **one** external module script,
  loaded from `'self'`
- **zero** occurrences of `eval(` or `new Function(` in the emitted bundle

So `script-src 'self'` holds with no unsafe directive. Headers confirmed served
on that preview: CSP, HSTS, `X-Content-Type-Options`, `X-Frame-Options: DENY`,
`Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`.

#### The exceptions, stated honestly

**Production: `style-src 'unsafe-inline'` is required.** Four
runtime-computed `style={{}}` props depend on it — the progress-bar width in
`App.tsx` and the category/detection swatch colours in `DetectionPanel.tsx`.
Removing it needs per-request nonces, and **CloudFront cannot generate a nonce
per request for a static origin**; a build-time hash does not help because the
values are computed at render time. The risk accepted is bounded: inline
*style* cannot execute JavaScript. The known residual is CSS-based data
exfiltration via attribute selectors — a far narrower primitive than script
execution, and one that still requires a markup-injection bug to reach.

**Dev server only** (`buildCsp(origins, dev = true)`): `'unsafe-inline'` and
`'unsafe-eval'` in `script-src` for Vite's React Refresh preamble and
on-the-fly transforms, and `ws:`/`wss:` in `connect-src` for HMR. **The
production policy needs none of these**, and none is reachable from a
production build — the `dev` flag is passed by `vite.config.ts`, not by an
environment variable a deployment could flip.

**Not verified behind CloudFront.** The policy was measured against the real
bundle locally. Nothing is deployed, so the CloudFront response-headers policy
has never actually served a byte.

### Upload handling

| Threat | Mitigation | Code |
|---|---|---|
| Oversized upload exhausts memory/disk | Hard 10 MB cap, checked **twice**: on the read buffer in the route and again inside the validator. `413 file_too_large`. | `routes/images.py:_read_validated`, `services/image_analyzer.py` |
| Decompression bomb (small file, gigapixel decode) | `width * height > VISIONIQ_MAX_PIXELS` (default 50 MP) → `400 image_too_large`, **checked before any further processing**. | `services/image_analyzer.py` |
| Non-image bytes with an image extension / forged MIME header | Pillow `Image.verify()` for a cheap integrity check, then a fresh `Image.open()` to read properties (verify leaves the handle unusable). Unreadable bytes → `400 invalid_image`. | `services/image_analyzer.py` |
| Content-type confusion / polyglot files | The returned `content_type` is derived **from the decoded Pillow format**, never from the request header: `ALLOWED_FORMATS[fmt]`. Only `JPEG`/`PNG`/`WEBP` pass; anything else → `400 unsupported_format`. | `config.ALLOWED_FORMATS`, `image_analyzer` |
| Empty file wasting a pipeline run | `400 empty_file` at byte zero. | `image_analyzer` |
| Malicious image crashing the decoder | Decode is wrapped and `UnidentifiedImageError`/`OSError`/`ValueError` are all mapped to a flat client-safe error; no stack trace reaches the client. | `image_analyzer` |

### Path traversal and key forgery

| Threat | Mitigation | Code |
|---|---|---|
| `../../etc/passwd` style keys escaping the storage root | `assert_owned()` rejects any key containing `..`, starting with `/`, or containing `\`, **and** requires the `{owner_id}/` prefix. | `storage/base.py` |
| Traversal via symlink / normalisation tricks on the local backend | `LocalImageStorage._resolve()` rejects the same patterns, then `Path.resolve()`s and re-verifies with `relative_to(root.resolve())` — a defence that survives normalisation. | `storage/local_storage.py` |
| Client naming an arbitrary S3 key on `POST /api/jobs` | `assert_owned(image_key, owner_id)` → `403 forbidden` before any `head_object`. | `routes/cloud.py` |
| Attacker-chosen filename becoming a path | Keys are always **constructed** by `build_key(owner, analysis_id, fmt)` from a server-generated UUID and a whitelisted extension; the user's filename is stored as metadata only, never used as a path. | `storage/base.py`, `services/analysis_service.py` |

### Cross-tenant access

| Threat | Mitigation | Code |
|---|---|---|
| Reading another tenant's analysis | `owner_id` is the DynamoDB **partition key** / first half of the SQLite primary key. Every `get`/`delete`/`set_status` is keyed on `(owner_id, analysis_id)`; a miss is `404 not_found`, identical to a nonexistent id — existence is not disclosed across tenants. | `repositories/*` , `routes/analyses.py` |
| Enumerating another tenant via pagination | `DynamoAnalysisRepository._decode_cursor()` **refuses a cursor whose `owner_id` does not match the requester** → `RepositoryError` → `400 bad_request`. SQLite cursors carry only `created_at\|analysis_id` and the owner clause is always applied server-side, so a forged cursor cannot cross tenants. | `repositories/dynamo_repo.py`, `sqlite_repo.py` |
| Client asserting an owner id | `get_owner_id` returns the `sub` of a verified token (or `local` when auth is off) and nothing else. The old trusted `X-VisionIQ-User` header path has been **removed**; no header, query parameter or body field can influence the owner id in any mode. See *Authentication and authorization* above. | `security.py`, `auth/resolver.py` |
| Comparing across tenants | `compare_analyses` fetches both records with the caller's `owner_id`; a foreign id is a `404`. | `routes/analyses.py` |
| Worker touching the wrong prefix | IAM: the worker can read only `uploads/*` and write only `results/*` in the one bucket, and touch only the one table and the one queue. No `"*"` resource on any data action. | `modules/security` |
| **Cross-tenant access through the deployed Lambda control plane** | The Lambda enforces ownership server-side on **every** path, not just the read paths. `_owner_id()` takes the `sub` from `requestContext.authorizer.jwt.claims` and has **no fallback** — absent claim is a `401`, and the owner id is never read from the body, query string or a header. Every DynamoDB access is keyed on `(owner_id, analysis_id)`; `create_job` runs `_owns_key()` on the client-supplied `object_key` before any `head_object`; `delete_job` re-checks the stored `image_key` against the caller's prefix before deleting the object; `list_jobs` and `cancel_job`/`delete_job` return the **identical** `404 not_found` for a missing record and another tenant's record. `_decode_cursor()` refuses a cursor whose `owner_id` is not the caller's. | `lambda/api/handler.py`, `tests/test_cloud_contracts.py` |
| Lambda role over-privileged for the new delete paths | `s3:DeleteObject` is scoped to `${bucket_arn}/${upload_prefix}*` — never bucket-wide, and never the `results/` prefix, which only the worker writes. `dynamodb:DeleteItem` is scoped to the one table and its index, and the key is always `(owner_id, analysis_id)` with `owner_id` from the verified JWT. | `modules/security/main.tf` |

### Presigned URLs and SSRF

| Threat | Mitigation | Code |
|---|---|---|
| Uploading a different content-type than declared | `ContentType` (and `ServerSideEncryption`) are **signed into** the presigned URL, so a mismatched PUT is rejected by S3 itself. | `storage/s3_storage.py:presign_put` |
| Presigned PUT cannot enforce a size limit | Acknowledged in the code comment. Enforced server-side instead: `head_object().ContentLength > 10 MB` → **delete the object** then `413`. | `storage/s3_storage.py:head`, `routes/cloud.py` |
| Uploading a non-image through a valid presign | `head_object().ContentType` is re-checked against the allow-list → **delete the object** then `400 unsupported_format`. Full pixel-level validation happens again in the worker, which has the bytes. | `routes/cloud.py`, `cloud/jobs.py` |
| Long-lived leaked upload URL | TTL is `VISIONIQ_PRESIGN_TTL`, default **300 s**, and the URL is scoped to exactly one key. | `config.py`, `s3_storage.py` |
| Public bucket / direct object access | All four public-access blocks true, `BucketOwnerEnforced` ownership, SSE-AES256 with bucket keys, versioning on, a bucket policy denying `aws:SecureTransport = false` and any unencrypted `PutObject`. CORS restricted to `allowed_origins` — never `*`. | `modules/storage` |
| Leaking the API bearer token to the storage endpoint | The browser's `PUT` to S3 sends **only** the `required_headers` that were signed, and **never an `Authorization` header**. The presigned signature in the URL *is* the credential for that one object; a bearer token would hand an API credential to a different service for no benefit (and an unsigned header breaks the signature anyway). A test asserts no `Authorization` header is set on the upload. | `frontend/src/api/analysisClient.ts::putToS3`, `api/analysisClient.test.ts` |
| Unauthenticated client wandering into the cloud flow | Cloud mode **fails closed**: `CloudAnalysisClient.analyze()` checks for an access token *before* requesting a presign and throws `unauthenticated` immediately, rather than letting the gateway answer `401` three steps later with a partially completed upload. | `frontend/src/api/analysisClient.ts` |
| SSRF — making the server fetch an attacker URL | There is **no code path that fetches a client-supplied URL**. Images arrive as bytes in a multipart body or as an S3 object key the server itself minted. The only outbound calls are to S3, DynamoDB, SQS, Bedrock and (optionally) SageMaker, all via boto3 with server-side configuration. The worker security group allows egress on 443 only, with **zero ingress rules**. | `routes/*`, `modules/network` |

### Prompt injection into Bedrock

| Threat | Mitigation | Code |
|---|---|---|
| Injected instructions reaching the LLM | The model receives **only** `_build_facts()`: model name, taxonomy, threshold, image dimensions, total detections, per-category label/count/mean confidence, low-confidence count, occupancy fraction, SKU status. **The image is never sent. No free text, no filename, no user string is ever included.** The only client-influenced values are numeric counts and model-emitted COCO labels from a fixed 80-word vocabulary. | `services/insights/bedrock.py` |
| Model talked into fabricating products/stock | A hard-rule system prompt: use only the provided counts; never invent a product, brand, SKU, count or price; labels are generic classes not products; do not claim stock levels or out-of-stock; say so plainly when data is insufficient; frame everything as requiring human verification. | `SYSTEM_PROMPT` |
| Malicious/garbled model output rendered to the user | `_parse()` extracts the outermost `{...}`, `json.loads` it, requires `summary` to be a non-empty string, coerces `observations`/`suggested_actions` to string lists capped at 10 entries, and returns `None` otherwise. `None` → deterministic rule-based fallback with `degraded = true`. | `bedrock.py:_parse` |
| Unbounded cost / hung request | Opt-in (`VISIONIQ_INSIGHTS_PROVIDER=bedrock`), `max_tokens` capped (default 600), read timeout 20 s, connect timeout `min(5, timeout)`, 2 retries. Never invoked when detection was `unavailable`. Never invoked in tests. | `bedrock.py`, `factory.py` |
| Bedrock outage breaking analyses | Any exception is caught, logged as `bedrock_insights_failed`, and the rule provider's output is returned with `degraded = true`. An analysis never fails because the optional narrator broke. | `bedrock.py:generate` |

### Denial of service

| Threat | Mitigation | Code |
|---|---|---|
| Request flood | `SlidingWindowRateLimiter`, default 60 req/min keyed on client IP, applied to `/api/images/detect`, `GET /api/analyses`, `/api/uploads/presign`, `POST /api/jobs` → `429 rate_limited`. | `security.py` |
| Concurrent inference thrashing / OOM | A module-level `_INFERENCE_LOCK` serialises every `model.predict` call. The worker additionally uses `MaxNumberOfMessages=1` to bound RSS. | `vision/yolo_provider.py`, `cloud/worker.py` |
| Unbounded detections per image | `VISIONIQ_MAX_DETECTIONS` (300) passed as `max_det`; hitting the cap adds a warning. | `analysis_service.py` |
| Unbounded page size | `limit` clamped to 1–100 at both the route (`Query(ge=1, le=100)`) and inside each repository. `cursor` ≤ 512 chars, `search` ≤ 120. | `routes/analyses.py`, `repositories/*` |
| Cloud-side flood | API Gateway throttling (`api_throttle_rate_limit`/`burst`: 10/20 dev, 100/200 prod); SQS long-polling with DLQ redrive at `maxReceiveCount = 3`; worker autoscaling capped at `worker_max_count`; AWS Budgets alerts at 50/80/100% plus a forecast alert. | `modules/api`, `modules/queue`, `modules/budget` |
| Poison-pill queue message | Unparseable messages raise immediately and are never deleted, so they redrive to the DLQ and alarm rather than looping. | `cloud/worker.py:process_message` |
| Duplicate work from at-least-once delivery | `process_job()` re-reads the record and returns early on a terminal status; `create_job()` is idempotent on `analysis_id`. | `cloud/jobs.py` |

### Secrets and supply chain

| Threat | Mitigation |
|---|---|
| Secrets in source | `config.py` states it plainly: *"Nothing here may contain secrets or account identifiers."* Every value is `os.getenv` with a non-secret default. `bedrock.py` refuses an empty model id rather than hardcoding one. |
| Secrets in Terraform | No account ids, no ARNs carrying an account id, no bucket names, no secrets committed. The bucket suffix is a hash of the caller account id and region, derived at plan time. Queue/ECR/SNS outputs are marked `sensitive` precisely because they embed the account id. |
| Secrets in git | `.gitignore` covers `.env`, `.env.*`, `*.pem`, `*.key`, `backend/.venv/`. Backend state (`backend.<env>.hcl`) is explicitly gitignored per the Terraform README. |
| Long-lived AWS keys in CI | None exist. `deploy.yml` uses GitHub OIDC (`id-token: write`) to assume a role whose ARN comes from an environment secret. |
| Unreviewed infrastructure changes | `deploy.yml` is `workflow_dispatch` only; `terraform-apply` targets a GitHub environment, and the prod environment is required to have **required reviewers**. `infra-ci.yml` runs `fmt -check`, `validate` and a tfsec SARIF scan on every infra change, and never holds credentials. |
| Unpinned dependencies | `requirements.txt`, `requirements-ml.txt` and `requirements-dev.txt` pin exact versions; Terraform pins `aws ~> 5.0` and the workflows pin Terraform `1.9.8`. |
| Weights pulled at runtime in production | Baked into the container image at build time (`backend/Dockerfile`), so a compromised or unreachable upstream cannot affect running workers. |
| Container running as root | The image creates and switches to uid `10001`. |

### Logging

`backend/app/observability.py` — *"We never log image bytes, credentials,
presigned URLs, or raw headers."*

- Logs are single-line JSON for CloudWatch Logs Insights.
- A `correlation_id` (client `X-Correlation-Id` or a fresh 16-hex id) flows
  through every line of a request and is echoed back in the response header.
- Structured `extra=` fields are merged, but any key in the redaction set is
  replaced with `"[redacted]"`:
  `authorization`, `cookie`, `x-api-key`, `password`, `secret`, `token`, `url`,
  `presigned_url`. Note `url` is blanket-redacted — presigned URLs can never
  appear even by accident.
- The per-request line records **method, path, status code and duration only**.
  The query string is deliberately excluded because it can carry user data
  (`search`, `cursor`).
- Headers are never logged as a block; request bodies are never logged.
- Uvicorn's access log is disabled to avoid an unredacted duplicate.

**Residual risk:** error strings from upstream services are logged verbatim
(e.g. `extra={"error": str(exc)}` in `jobs.py`, `analysis_service.py`,
`bedrock.py`). A boto3 exception message can embed a bucket name, key or
account id. Keep worker log retention bounded (`log_retention_days`: 7 dev /
90 prod) and treat log access as sensitive.

---

## 4. Honesty as a security property

Fabricated data is a safety problem, not just a quality one: an operator acting
on invented stock counts makes a real-world decision on fiction. The codebase
treats it as such.

- No provider ever returns synthetic detections. `ProviderUnavailable` and
  `InferenceFailed` propagate to `status: "unavailable"` / `"failed"` with zero
  detections.
- `unavailable` is explicitly distinguished from an empty shelf by a caveat on
  every affected result.
- SKU identity and shelf-gap detection are reported `unsupported` with reasons,
  rather than approximated.
- `SageMakerProvider` raises on a malformed response *"refusing to guess"*
  rather than coercing it into plausible detections.
- Every LLM-sourced observation carries `source: "bedrock"`,
  `confidence: "advisory"`, and a standing disclaimer that human review is
  required.

---

## 5. What an attacker gains at each step

| Compromise | Gains | Limited by |
|---|---|---|
| Stolen presigned PUT URL | Write one object, one key, one content-type, ≤ 300 s | Server-side head re-validation; a bad object is deleted and never processed |
| Stolen access token | Everything of that tenant's, for ≤ 1 hour | Token lifetime; revocation is enabled on the app client; the token is memory-only in the SPA so it is not sitting in browser storage |
| Valid session for tenant A | Everything of tenant A's | Partition-key isolation; cursor owner check; `404` on foreign ids |
| XSS in the SPA | Can act as the user while the page is open | Token is never persisted to `localStorage`/`sessionStorage`, so it does not survive the tab or leak to a later visit |
| Code execution in the worker container | Read `uploads/*`, write `results/*` in one bucket; one table; one queue | Scoped IAM, non-root uid, egress 443 only, zero ingress |
| Compromised GitHub repo | Can dispatch `deploy.yml` | OIDC role scoped to the repo (and `environment:prod`); prod apply blocked on required reviewers |
| Read access to CloudWatch Logs | Metadata, timings, error strings | No image bytes, no credentials, no URLs, no query strings |

---

## 6. NOT yet mitigated — be explicit

1. **There is no authentication in local mode, by design.** Every request is
   owner `"local"`. Anyone who can reach `127.0.0.1:8080` has full access to all
   local analyses. Acceptable for a developer workstation; never expose this
   binding beyond loopback.
2. **XSS still defeats the in-memory token, for its lifetime.** Keeping the
   access token out of web storage **reduces blast radius; it does not prevent
   theft.** Injected script running on the SPA's origin can call the same
   module, or simply ride the authenticated session and issue requests
   directly. What the design buys is a bound: an attacker gets at most the
   remaining lifetime of a 1-hour access token in one tab, rather than a
   30-day refresh token they can exfiltrate and use from anywhere. Preventing
   XSS itself remains the responsibility of the app's own input handling and a
   CSP. **This gap is now CLOSED for the SPA** (Phase 3.7): there is a real
   policy with `script-src 'self'` and no unsafe directive, defined in
   `frontend/src/security/csp.ts` and delivered by CloudFront's
   response-headers policy; the Lambda API returns its own `nosniff` and
   `no-store` headers. See §3, *Content Security Policy and security headers*.
   The residual exceptions are `style-src 'unsafe-inline'` in production
   (documented and justified there) and the dev-server relaxations, which a
   production build cannot reach. **It has not been served from a real
   CloudFront distribution**, because nothing is deployed. A CSP still does not
   prevent XSS — it bounds what a successful XSS can do.
3. **No refresh-token rotation — by design, with a real cost.** The browser
   never receives a refresh token, so there is nothing to rotate. The
   consequence is that closing the browser, or Cognito's session cookie
   expiring, forces a fresh interactive sign-in; there is no "stay signed in
   for 30 days". Accepting that is the point. The BFF upgrade path (§3,
   Frontend authentication) is documented but unimplemented.
4. **Silent re-authentication depends on third-party cookie behaviour.**
   `prompt=none` works only if the browser sends Cognito's session cookie on a
   top-level redirect to the hosted-UI origin. That is a top-level navigation
   rather than an embedded iframe, so it survives current third-party-cookie
   restrictions — but it is behaviour outside this project's control, and
   stricter future defaults (or a user blocking cookies for the Cognito
   domain) degrade it to an interactive sign-in each time. **This has not been
   tested in any real browser against a real pool.**
5. **The frontend `AuthGate` is not a security boundary.** It is a UX gate.
   Anyone can run the bundle with the gate removed; only the API's token
   verification actually protects data. Never move an authorization decision
   into the SPA.
6. **The whole SPA sign-in flow is unverified against live Cognito.** It is
   tested only against a stubbed `fetch` and a stubbed `window.location`. A
   stub agrees with whatever the code does; Cognito may not. See
   `docs/deployment/aws.md` §8a.
7. **`lambda/api/handler.py` is now complete**, not a skeleton. All six routes
   are implemented, ownership is enforced server-side on every path, errors use
   the shared envelope, and the Lambda↔backend data shapes are pinned by
   `backend/tests/test_cloud_contracts.py` (62 tests, boto3 mocked). What
   remains unverified is execution: **the Lambda has never run against real
   AWS**, so IAM grants, API Gateway route→integration wiring and the JWT
   authorizer attachment are reviewed-but-unexecuted. `terraform plan` has not
   been run.
8. **The rate limiter is in-process and does not span instances.** Its own
   docstring says so. `SlidingWindowRateLimiter` keeps counters in a local dict,
   so N Lambda containers or N Fargate tasks each permit the full quota, and the
   window resets whenever a process does. Cloud-side enforcement must come from
   API Gateway usage plans / throttling and WAF.
9. **The rate limiter keys on `request.client.host`.** Behind a proxy or API
   Gateway that is the proxy's address, so all callers may share one bucket.
   `X-Forwarded-For` is deliberately not trusted (it is trivially spoofable
   without a trusted-proxy allow-list), which is the safer failure mode but
   means local rate limiting is coarse.
10. **No virus/malware scanning of uploaded objects.** Validation proves the
   bytes decode as a JPEG/PNG/WEBP within the pixel cap; it does not prove they
   are safe for a downstream consumer that renders them differently.
11. **No PII handling for image contents.** COCO includes `person`; shelf photos
   may capture staff or customers. There is no face blurring, no consent
   tracking, and no DSAR tooling. S3 lifecycle expiry
   (`image_expiration_days`: 7 dev / 30 prod) is the only retention control.
12. **No encryption at rest for the local SQLite database or image directory.**
   Local mode relies entirely on OS file permissions.
13. **No audit log of reads.** Deletes and analyses are logged as request lines;
   there is no per-record access trail.
14. **No CSRF protection**, because there are no cookies and no session state —
    the API is header/token based. If cookie auth is ever added, this becomes a
    live gap.
15. **Errors from upstream services are logged verbatim** and may embed resource
    identifiers (see §3, Logging).
16. **tfsec runs soft-fail** (`continue-on-error: true`) in `infra-ci.yml`, so a
    new infrastructure finding will not block a merge. Read the SARIF.
17. **AGPL-3.0 licensing exposure** from the default YOLO provider is a legal
    risk, not a technical one, but it is unmitigated in the default
    configuration. See `docs/architecture/models.md` §2.
18. **`GET /api/system/status` is still public.** Enabling auth reduces what it
    says — backend topology and internal failure reasons are withheld — but it
    still discloses `execution_mode`, `auth_mode`, the model id and taxonomy,
    the confidence threshold and the upload cap to an unauthenticated caller.
19. **No per-user quota.** Rate limiting keys on the client IP (see 8 and 9),
    not on the authenticated `sub`, so one authenticated tenant can consume the
    whole budget. AWS Budgets notifies; it does not block.
20. **No WAF in front of the HTTP API.** API Gateway throttling
    (`throttle_rate` / `throttle_burst`) is the only edge control: no managed
    rule set, no IP reputation list, no bot control.
