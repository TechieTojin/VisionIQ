# $0 deployment checklist

Ordered. Work top to bottom. Every step below costs **nothing** — where a step
touches something that *could* cost money, it says so explicitly.

Read [**Things that would cost money**](#things-that-would-cost-money--do-not-do-these)
at the bottom **before** you start, not after.

---

## A. Verify locally

- [ ] **Backend suite passes.** No cost — runs on your machine, inference is
      mocked, no weights are downloaded.
      ```bash
      cd backend && .venv\Scripts\python.exe -m pytest -q
      ```
      Expect **232 passed**.

- [ ] **Backend lints clean.** No cost.
      ```bash
      cd backend && .venv\Scripts\python.exe -m ruff check . --config ruff.toml
      ```

- [ ] **Frontend lints, typechecks and tests clean.** No cost.
      ```bash
      cd frontend && npm run lint && npm run typecheck && npm test
      ```
      Expect **217 passed across 13 files**, including the 18 demo-mode tests
      in `src/demo/demo.test.ts`.

- [ ] **Production build succeeds.** No cost.
      ```bash
      cd frontend && npm run build
      ```
      If this fails on Vercel it will fail here first, and debugging is faster
      locally.

- [ ] **Preview the demo build locally before deploying.** No cost.
      ```bash
      cd frontend && VITE_API_MODE=demo npm run build && npm run preview
      ```
      (PowerShell: `$env:VITE_API_MODE='demo'; npm run build; npm run preview`.)
      Confirm the banner appears, there is **no upload control**, and all three
      samples open — including the 0-detection one.

- [ ] **Regenerate demo fixtures — OPTIONAL, already committed.** No cost;
      requires the 64-bit venv with torch, and downloads ~6 MB of weights on
      first run. Only needed if you changed the pipeline and want the
      recordings to match it.
      ```bash
      cd backend && .venv\Scripts\python.exe scripts\generate_demo_fixtures.py
      ```
      Rerun `npm test` afterwards — the demo tests assert properties of the
      fixture.

---

## B. Publish the repository

- [ ] **Decide whether the repository goes public. ASK THE OWNER FIRST.**
      This is **your call, not the deploying tool's**. Vercel Hobby can deploy
      from a private repository, so going public is *not* required for the
      demo to work — it is required only if you want reviewers to read the
      code. Making a repository public is effectively irreversible: once it is
      cloned or indexed, taking it private again does not recall it.

      Before flipping the switch, confirm:
      - [ ] No `.env` file is committed. (`.env` is gitignored; `.env.example`
            is the committed one and contains no secrets.)
      - [ ] `git log -p` contains no credential that was committed and later
            removed — history is public too.
      - [ ] You are comfortable with the AGPL-3.0 implications of shipping
            YOLOv8n-derived output and configuration (see the README's
            Model & licensing section).

      No cost either way. Public and private repositories are both free on
      GitHub.

- [ ] **Push to the remote.** No cost.

---

## C. Deploy to Vercel

Full detail in [`../deployment/vercel.md`](../deployment/vercel.md).

- [ ] **Create a Vercel account on the Hobby plan.** No cost, **no card
      required**. If you are ever asked for a card, stop — you are on the wrong
      signup path.

- [ ] **Import the Git repository.** No cost. Leave **Root Directory** at the
      repository root (`./`), not `frontend` — the root `vercel.json` drives
      the build.

- [ ] **Set the environment variable** `VITE_API_MODE` = `demo`, for
      **Production, Preview and Development**. No cost. This is mandatory:
      demo mode is never the default, and an unset value or a typo silently
      falls back to `local`, which will render an upload box that cannot work.

- [ ] **Deploy.** No cost. Build is `cd frontend && npm ci && npm run build`,
      output `frontend/dist`, both already in `vercel.json`.

---

## D. Verify the deployment

- [ ] **Security headers are present.** No cost.
      ```bash
      curl -sI https://<your-deployment>.vercel.app | grep -i \
        -e content-security-policy -e strict-transport-security \
        -e x-content-type-options -e x-frame-options -e referrer-policy
      ```
      All five must appear. If none do, the Root Directory setting is wrong.

- [ ] **The demo banner is visible** at the top of the page and states that
      results are pre-recorded and that this deployment cannot analyse new
      images. No cost.

- [ ] **There is no upload control.** A **Sample analyses** panel stands where
      the dropzone would be. No cost.

- [ ] **Deep links resolve.** Type a non-root path straight into the address
      bar; it must render the app, not a 404. No cost.

- [ ] **All three samples open**, with **6**, **3** and **0** detections
      respectively, and the 0-detection sample shows status `empty` rather than
      an invented reading. No cost.

- [ ] **Known gaps, expected to fail:** comparing two scans and deleting a scan
      both call the API and are not demo-aware. They will error on the
      deployment. Do not treat this as a broken deploy; capture those features
      from a local run instead.

---

## E. Finish the portfolio artefacts

- [ ] **Add the live URL to the README.** No cost. Replace the
      `<!-- DEPLOY: replace … -->` placeholder in the **Live demo** section at
      the top, and leave the honesty note beneath it intact.

- [ ] **Take the screenshots.** No cost. Follow
      [`screenshots.md`](screenshots.md) — nine shots, two of which must come
      from a local run (comparison, and the test output).

- [ ] **Commit the README URL and the images, and push.** No cost. Vercel will
      redeploy automatically; that is still free.

---

## Things that would cost money — do NOT do these

Each of these is a real, billable action. None of them is required for the
demo, and none should be taken without an explicit, deliberate decision to
start spending.

| Action | What it costs | Note |
|---|---|---|
| `terraform apply` | **Real AWS charges, recurring.** Roughly **$1.50/month idle for the dev workspace**, plus usage — and that figure assumes everything is sized as configured and nothing is left running | The Terraform stack is in this repo as an **architecture demonstration that is deliberately never applied**. `fmt`, `init -backend=false` and `validate` are free and make no AWS calls. `apply` is the line |
| `terraform plan` against real credentials | Usually free in itself, but requires an AWS account and credentials to exist | There is no AWS account. Creating one to run `plan` puts you one command away from `apply` |
| **Creating an AWS account and provisioning anything** | Free tiers expire, several services here have no free tier, and an idle NAT gateway or ECS task bills around the clock | Do not create the account "just to look" |
| **Vercel Pro** | **$20/user/month** | Only needed if the deployment becomes commercial. A personal portfolio does not need it |
| **Hugging Face PRO** | **$9/month** | Would be needed to host the FastAPI backend as a Docker Space. See [`../deployment/free-hosting.md`](../deployment/free-hosting.md) |
| **Render / Fly.io / Railway / Koyeb paid instances** | $5–$25/month, and several now require a card or place a hold before anything runs | No free tier among them can hold PyTorch in memory. Do not sign up "to test" |
| **A custom domain** | Registration fee, annually | The `*.vercel.app` URL is free and adequate |
| **An Ultralytics Enterprise Licence** | Quoted, not published | Only relevant if you want to ship the default model commercially without AGPL-3.0 obligations |

All pricing above is a snapshot of **2026-10-23** and changes often. Verify on
the provider's own pricing page before relying on any figure.
