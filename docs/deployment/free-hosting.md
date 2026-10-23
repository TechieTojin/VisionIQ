# Free hosting for a CPU YOLO service — the research, and the decision

**Question:** can the VisionIQ backend (FastAPI + PyTorch CPU + Ultralytics
YOLOv8n) be hosted publicly for **$0**, with no credit card and no trial that
converts to a bill?

**Answer:** no. Not reliably, and not on any provider surveyed on **2026-10-23**.

What is deployed instead is the **React frontend only**, on Vercel Hobby, in
**demo mode** — replaying detections that a real local YOLOv8n run produced.

> Free-tier terms change often, and several below changed within the last year.
> **Verify every figure on the provider's own pricing page before relying on
> it.** The findings here are a snapshot of 2026-10-23, not a standing promise.

---

## 1. What the backend actually needs

This is the constraint that kills every free tier, so it is worth stating
precisely before the table.

| Requirement | Reality |
|---|---|
| Resident memory | PyTorch CPU alone is roughly **300–500 MB** resident once imported, before the model, before FastAPI, before the image buffer |
| Disk | The torch CPU wheel plus Ultralytics plus Pillow is a multi-hundred-megabyte install; `yolov8n.pt` adds ~6 MB, downloaded on first use |
| CPU | Measured locally: **~2.9–7.5 s** warm inference on an 810×1080 image, **~18 s** cold including the weight download. That is on a full developer CPU core |
| Process model | A long-lived container. Not a function with a bundle-size cap |

Two numbers matter most: **~500 MB resident** and **a real CPU core**. A tier
that gives 512 MB total, or a fraction of a core, does not merely run slowly —
it OOMs, or it turns a 3-second request into a multi-minute one.

---

## 2. The options, and why each one fails

| Option | Finding (2026-10-23) | Verdict |
|---|---|---|
| **Hugging Face Spaces** | The [Hub docs](https://huggingface.co/docs/hub/en/spaces-overview) state that Gradio and Docker Spaces run on compute and **require a paid plan to create: PRO for personal accounts**. Free personal accounts may host up to **2 Gradio Spaces on ZeroGPU only** — Docker Spaces do not qualify. Static Spaces remain free. CPU Basic hardware is 2 vCPU / 16 GB RAM / 50 GB **non-persistent** disk, and sleeps when unused | **Not free for this backend.** VisionIQ ships a FastAPI app in a Dockerfile, which is a Docker Space. PRO is **$9/mo** |
| **Render free web service** | [Render's free-tier docs](https://render.com/docs/free): **512 MB RAM, 0.1 CPU**, spins down after **15 minutes** idle with a cold start of roughly a minute, **750 instance-hours/month** per workspace, **no persistent disk**, and the docs say plainly it is not intended for production | **Too small and far too slow.** torch's resident set alone approaches the 512 MB ceiling, and 0.1 CPU turns multi-second inference into minutes |
| **Fly.io** | The free resource allowance was withdrawn for new accounts; a card is required, and what remains is a short trial | **Not free** |
| **Railway** | The free plan is gone. What is left is a one-time **$5 trial credit**, then pay-as-you-go | **Not free** |
| **Koyeb** | One **512 MB** service, scaling to zero after about an hour idle. There are **unconfirmed** reports of a card requirement plus a **$29 hold** introduced in February 2026 | **Too small**, and the card requirement is an unacceptable risk on a $0 budget |
| **Vercel Functions** | [Vercel's documented limits](https://vercel.com/docs/functions/limitations): **250 MB uncompressed bundle**, **500 MB for Python** | **Impossible.** The torch CPU wheel alone exceeds 500 MB before any other dependency |

Every row fails on the same two axes: **memory** or **bundle size**. Nothing
here is a matter of tuning.

---

## 3. What *is* free: the frontend

The SPA is a static bundle. Static hosting is genuinely free on several
providers, and Vercel Hobby was chosen for it.

**The Vercel Hobby caveat, stated plainly:** Vercel's fair-use terms restrict
the Hobby plan to **personal, non-commercial use**. A personal portfolio piece
is squarely within that. Anything revenue-generating — client work, a product,
ads — requires **Pro at $20/user/month**. This is a real term, it is enforced,
and it is yours to comply with: **read Vercel's current Fair Use Guidelines
yourself** before deploying anything that is not plainly personal.

See [`vercel.md`](vercel.md) for the deployment steps.

---

## 4. The decision

**Deploy the frontend only, on Vercel Hobby, with `VITE_API_MODE=demo`.**

The rationale:

1. **It costs nothing**, with no card, no trial clock and no hold.
2. **It shows real output.** The detections in
   `frontend/src/demo/samples.json` were produced by
   `backend/scripts/generate_demo_fixtures.py`, which runs the genuine pipeline
   (`analyse()` against the `yolo` provider) on real images and records the
   result verbatim. No number in the demo was invented.
3. **It does not lie about what it is.** `DemoAnalysisClient.analyze()`
   *throws* rather than returning a canned result for a user's own file; the
   dropzone is replaced by a sample picker, so there is no file input at all;
   every record carries `execution_mode: "demo"`, a `demo-` id prefix,
   `owner_id: "demo"` and a null `image_key`; and a banner states that these
   are recordings from a real model run and that this deployment cannot analyse
   new images. Eighteen tests in `frontend/src/demo/demo.test.ts` hold these
   properties in place.
4. **It keeps the unflattering case.** One of the three samples,
   `synthetic_shelf.jpg`, produced **0 detections** and status `empty`. It is
   kept deliberately, so the demo does not only show results that make the
   project look good.

The alternative — pay $9/mo for HF PRO, or $7/mo for a Render instance type
that can actually hold torch in memory — is not $0, and $0 is the constraint.

---

## 5. If you later want real inference for $0

Three routes, in increasing order of effort. **Only (a) exists today.**

### (a) Run it locally — implemented, works now

The honest answer, and the one the demo banner points at. Clone, create the
64-bit Python 3.10 venv, start the backend on `:8080` and the frontend on
`:5175`, and drop in your own photo. Real YOLOv8n, real boxes, ~3–8 s warm on
CPU. See the README's **Running locally** section.

Cost: $0. Reach: one machine.

### (b) Browser-side ONNX inference — **NOT IMPLEMENTED**

> **This is a proposal, not a feature. No part of it exists in this repo.**
> Do not read the paragraph below as a description of something you can use.

The idea: export `yolov8n` to ONNX (roughly **12 MB**) and run it in the
browser with [`onnxruntime-web`](https://onnxruntime.ai/) via WebAssembly or
WebGPU. That would be **genuinely live inference on the user's own image**,
with no server, no inference cost and no cold start — on a static host that
stays free.

What it would actually take, and why it is a substantial build rather than an
afternoon:

- Export and verify the ONNX graph matches the `.pt` model's outputs.
- Reimplement the pre-processing in TypeScript: letterbox resize to 640×640,
  BGR/RGB ordering, normalisation. Getting this subtly wrong produces
  plausible-looking but wrong boxes, which is worse than no boxes.
- Reimplement post-processing: output tensor decode, confidence thresholding,
  **non-maximum suppression**, and the letterbox coordinate transform back to
  original image space.
- Reproduce the backend's aggregation layer — category counts, confidence
  statistics, the occupancy estimate, the retail caveats, the rule-based
  insights — or accept that the browser path returns a different shape from
  the API, which breaks the project's single-contract property.
- Ship a WASM runtime plus a 12 MB model to every visitor, and handle the
  devices where it is too slow or unsupported.
- **The AGPL-3.0 obligation follows the weights.** Exporting YOLOv8n to ONNX
  does not launder the licence; shipping it to browsers is still distribution.

It is a legitimate and interesting direction. It is also a second
implementation of the inference pipeline, with a correctness surface that the
current demo simply does not have. It was not built.

### (c) Hugging Face Spaces, with PRO — costs $9/mo

If the $0 constraint is ever relaxed, this is the cheapest route to a real
hosted backend. A **PRO personal account ($9/mo)** can create a Docker Space;
CPU Basic hardware is 2 vCPU / 16 GB RAM / 50 GB non-persistent disk, which is
comfortably enough for `yolov8n` on CPU. The Space sleeps when unused, so the
first request after idle pays a cold start — including the weight download,
since the disk is not persistent, unless the weights are baked into the image.

The frontend would then be pointed at it by building with
`VITE_API_MODE=local` and `VITE_API_BASE_URL=<space url>`, and the Vercel CSP's
`connect-src` would need to be widened from `'self'` to include that origin.

Confirm the current plan terms in the
[Spaces overview](https://huggingface.co/docs/hub/en/spaces-overview) first —
this is exactly the sort of term that moves.

---

## 6. Sources

- Hugging Face — [Spaces overview](https://huggingface.co/docs/hub/en/spaces-overview)
- Vercel — [Functions limitations](https://vercel.com/docs/functions/limitations)
- Render — [Free tier](https://render.com/docs/free)
- Vercel — Fair Use Guidelines (check the current version on vercel.com)

Snapshot date: **2026-10-23**. Verify before relying on any figure above.
