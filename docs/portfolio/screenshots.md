# Screenshots checklist

Nine shots. Together they should let a reviewer understand what the project
does, what it refuses to do, and that it actually runs — without cloning it.

Save them to `docs/portfolio/images/`. Reference them from the README.

Two shots **must** be taken from a **local** run, not the deployed demo: the
comparison view and the test run. Both are marked below.

---

## Capture tips

- **Viewport: 1440×900.** Wide enough for the two-column dashboard, narrow
  enough that text is legible when the image is scaled down in a README.
- **Dark theme**, consistently. The app's palette is designed for it, and a
  mixed-theme set looks careless.
- **Crop the browser chrome** unless the URL is the point of the shot (shot 6
  is the exception — the live URL is worth showing there).
- **PNG**, not JPEG. Screenshots of UI text compress badly as JPEG.
- **Nothing needs redacting.** There is no real user data anywhere: owner ids
  are `local` or `demo`, the images are public sample photos shipped with
  Ultralytics plus one synthetic shelf, and no secret is ever rendered in the
  UI. Do not blur anything — blurring implies there was something sensitive.
- Keep each file under ~400 KB so the README loads quickly.

---

## 1. `01-dashboard-detections.png` — the headline shot

**Capture:** the full dashboard with the `bus.jpg` analysis loaded: the
annotated image with all 6 bounding boxes drawn and labelled, the detection
list beside it, and the category counts visible.

**Why it matters:** this is the one image that says "this is a working computer
vision app" in under a second. It should be the first screenshot in the README.

**How to reach it:** demo mode — open the deployment, click **bus.jpg** in the
Sample analyses panel. Locally — start the backend and frontend, drop in
`backend/.venv/Lib/site-packages/ultralytics/assets/bus.jpg`. Make sure
**Show boxes** is on and the confidence filter is at 0% so all six are visible.

---

## 2. `02-zero-detections.png` — the honest empty case

**Capture:** the `synthetic_shelf.jpg` analysis. 0 detections, detection status
`empty`, and the UI's plain statement that nothing was detected above the
threshold.

**Why it matters:** arguably the most important shot in the set. It shows the
app reporting *nothing found* rather than inventing a stock reading, and it
shows you were willing to put the unflattering case on the front page. Most
portfolio demos only ever show the success path.

**How to reach it:** click **synthetic_shelf.jpg** in the Sample analyses
panel. Locally, run `backend/scripts/generate_demo_fixtures.py`, which writes
the same image to `frontend/public/demo/`, and upload it.

---

## 3. `03-limitations.png` — the caveats panel

**Capture:** the **Limitations** disclosure in the insights panel, **expanded**,
with the retail block showing SKU recognition as `unsupported`, shelf-gap
detection as `unsupported`, and occupancy marked `estimated`.

**Why it matters:** this is the project's strongest engineering signal. A
generic COCO-80 detector cannot identify products, and the app says so in the
UI rather than in a footnote. Pair this shot with the README's "What it
deliberately does NOT do" table.

**How to reach it:** load any sample, scroll to the insights panel, and click
the **Limitations (n)** summary to expand the `<details>` element. Capture it
open — a collapsed disclosure shows nothing.

---

## 4. `04-confidence-filter.png` — interactive filtering

**Capture:** ideally a side-by-side or a single shot at a raised threshold:
`bus.jpg` with the confidence filter pushed up so that the two 0.26-confidence
detections (`person` and `stop sign`) drop out and only the four high-confidence
boxes remain. Make sure the slider position and the resulting count are both
visible.

**Why it matters:** it shows the detections are real data being filtered live,
not a static image with boxes baked in — and it shows an understanding that
confidence is a knob the user should control.

**How to reach it:** load `bus.jpg`, then drag the confidence slider above 26%
and below 83%. Something in the 40–60% range gives a clean 6 → 4.

---

## 5. `05-history-compare.png` — scan history and comparison

**Capture:** the scan history list with several entries, two of them selected
for comparison, and the category-count delta rendered.

**Why it matters:** it shows persistence, search and the time-series angle —
the part of the project that makes it "shelf intelligence" rather than "a YOLO
wrapper".

**How to reach it:** **local run required.** Comparison calls
`GET /api/analyses/{a}/compare/{b}` and is not demo-aware, so it does not work
on the deployed demo. Start the backend and frontend locally, analyse three or
four images so the history fills, then click the compare chip on two rows.

---

## 6. `06-demo-banner.png` — the honesty banner

**Capture:** the top of the deployed page, **including the browser address bar
showing the live `*.vercel.app` URL**, with the demo banner fully readable:
"These are pre-recorded results, not live inference… this deployment has no
model running, so it cannot analyse new images." Include enough of the page
below it to show the Sample analyses panel where an upload dropzone would
otherwise be.

**Why it matters:** it proves the deployment is live *and* that it does not
overclaim. The absence of an upload control, right there in the same frame, is
the visual argument.

**How to reach it:** open the deployed URL. This is the one shot where you keep
the browser chrome.

---

## 7. `07-architecture.png` — the three execution modes

**Capture:** a rendered diagram of the three paths — local synchronous, demo
static, and the AWS asynchronous design — labelled so the AWS path is visibly
marked as *validated, never applied*.

**Why it matters:** the README's ASCII diagram is fine in the terminal but does
not travel to a portfolio site or a slide. A rendered version does.

**How to reach it:** redraw the README's Architecture diagram in Excalidraw,
draw.io or Mermaid. Keep the same labels and the same three-way split so the
two artefacts agree. Do not add boxes the README does not have.

---

## 8. `08-tests.png` — the suites passing

**Capture:** a terminal showing both runs and their summary lines — backend
**232 passed** and frontend **217 passed across 13 files**. A split terminal
with both, or two stacked crops, works well.

**Why it matters:** a screenshot of a green suite is weak evidence on its own;
a screenshot of *449 tests across two languages, with the counts legible*, is
not. The demo-mode suite (`frontend/src/demo/demo.test.ts`, 18 tests) is worth
having visible in the frontend output.

**How to reach it:** **local run required.**

```bash
cd backend && .venv\Scripts\python.exe -m pytest -q
cd frontend && npm test
```

Use a readable terminal font size. Do not crop away the summary line.

---

## 9. `09-terraform-validate.png` — the unapplied infrastructure

**Capture:** the terminal output of `terraform fmt -check -recursive`,
`terraform init -backend=false` and `terraform validate`, ending on
*"Success! The configuration is valid."*

**Why it matters:** it substantiates the AWS architecture as real, reviewed
code rather than a diagram — while the command itself (`validate`, with
`-backend=false`, and conspicuously **not** `plan` or `apply`) makes clear that
nothing was ever deployed. Caption it that way.

**How to reach it:**

```bash
cd infrastructure/terraform
terraform fmt -check -recursive
terraform init -backend=false
terraform validate
```

These three commands make no AWS API calls and require no credentials. **Do not
run `terraform plan` or `terraform apply`** — see
[`deployment-checklist.md`](deployment-checklist.md).
