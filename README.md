# chapter-scraper

An HTTP API that scrapes raw web-novel chapters on demand, using a real,
headed Chrome on a virtual display. It's built to feed the
[T9 translation pipeline](https://github.com/SpiraMirabilis/translate), but any
client can use it. A client queues a job, polls it, and fetches the result:
the same JSON shape the TamperMonkey scripts (`twkan.js`, `wfxs.js`,
`novellunar.js`) export. When a site throws a challenge it can't clear, you
solve it by hand in the scraper's browser over noVNC.

```
pipeline ──HTTP──▶ API :8787 ──▶ SQLite job queue ──▶ runner ──▶ engine ──▶ Chrome on Xvfb :99
                                                                                 ▲
                                    you ──browser──▶ noVNC :6080 ──▶ x11vnc ─────┘
```

Run it somewhere with a residential IP (a home server or desktop). Data-center
IPs get Cloudflare challenges on nearly every page.

## Docker

The quickest way to run it: see [QUICKSTART-Docker.md](QUICKSTART-Docker.md).
If you run T9 in Docker on the same machine, T9's `compose.yaml` includes the
scraper: `docker compose --profile scraper up -d` there.

```bash
mkdir -p t9-scraper/data && cd t9-scraper
curl -fsSLO https://raw.githubusercontent.com/SpiraMirabilis/t9-scraper/main/compose.yaml
docker compose up -d
```

## Setup without Docker

Linux with systemd, Node 22.13+, and Google Chrome (or Chromium, see
`deploy/scraper.env.example`). Clone to `~/scraper` (the systemd units assume
that path), then:

```sh
sudo apt install xvfb x11vnc novnc websockify xdotool
x11vnc -storepasswd ~/.vnc/passwd
npm install
cp deploy/scraper.env.example .env        # set API_TOKEN, NOTIFY_URL
mkdir -p ~/.config/systemd/user && cp deploy/*.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now scraper-xvfb scraper-vnc scraper-novnc scraper
loginctl enable-linger "$USER"             # keep user services running after logout
```

Everything listens on loopback by default. noVNC: `http://localhost:6080/vnc.html`.
Add `LAUNCH_ON_START=1` to `.env` to open the browser at startup rather than
on the first job.

### Reaching it from another machine

If the pipeline runs elsewhere, or you want to solve challenges from your
phone, bind to a private network address. Never use a public one. With
[Tailscale](https://tailscale.com), for example, use the box's tailnet IP in
`.env`:

```env
BIND_HOST=100.x.y.z
NOVNC_BIND=100.x.y.z
VNC_URL="http://100.x.y.z:6080/vnc.html?autoconnect=1&resize=scale"
API_TOKEN=...                               # always set one off loopback
```

The units order themselves after `tailscaled.service` when it exists, so the
address is up before they bind. A LAN address works the same way.

## API

Interactive docs: `http://localhost:8787/docs` (no token needed to read them).
All other routes except `/health` need `Authorization: Bearer $API_TOKEN`.

| Route | |
|---|---|
| `POST /toc` | `{url, engine?}`: read a book's chapter list without fetching chapters |
| `POST /page` | `{url, format?, waitMs?, fullPage?, priority?}`: fetch any page as rendered HTML or a PNG screenshot |
| `POST /jobs` | `{url, fromChapter?, fromUrl?, toChapter?, maxChapters?, delayMs?, priority?, engine?}`: scrape chapters |
| `GET /jobs/:id` | `status`: queued, running, blocked, done, failed or cancelled. Also `progress`, `stopReason`, `error`, and `vncUrl` while blocked |
| `GET /jobs/:id/result?offset=&limit=` | Chapters: export JSON, readable while the job runs and partial for failed or cancelled jobs; `offset`/`limit` return a slice of chapters. TOC: the chapter list. Page: the raw capture |
| `POST /jobs/:id/retry` | Requeue a failed or cancelled job; it resumes after its last captured page |
| `DELETE /jobs/:id` | Cancel |
| `GET /jobs?status=&limit=` | List, newest first |
| `GET /sites` | Effective per-site settings |
| `GET /supported_sites` | JSON array of supported domains (subdomains included) |
| `GET /stats/challenges?since=` | Challenge outcomes per engine and site |
| `GET /health` | Engine and display status |

All three `POST` routes return `202` with a new job. If an identical job (same
site, URL, range and engine) is already queued, running or blocked, they
return `200` with that job and `deduped: true` instead of starting a second copy.

How the chapter job fields work:
- **`url`** can be a book page or a chapter page. The site is picked from the URL.
- **`fromChapter`** is a TOC entry's `position`: the 1-based TOC position on twkan, wfxs, 69shuba, novel543, biquge, ixdzs and uukanshu, and the URL chapter number on novellunar. If that position doesn't exist (sources have gaps), the job starts at the next one that does.
- **Defaults:** start at chapter 1, or at `url` if it's a chapter page, and run to the end of the book.
- **`toChapter`** is inclusive and compared against the chapter number parsed from the title.
- **`delayMs`** can only raise the site's pacing, never drop it below the floor.
- **`priority: "low"`** is for backfills (a whole new book). Low jobs run only when nothing normal is queued, and step aside between pages when a normal job arrives, resuming later from their last captured page. Daily updates never wait behind a backfill.
- **`engine`** picks the browser engine for this job; the default is `ENGINE`. The worker closes one engine's browser before starting the other.

### Page fetches

`POST /page` loads any http(s) URL, not just supported sites, in the same
browser. It waits out challenges the same way, paging you over noVNC if
needed. It captures once the page's load event fires (15 s cap), then waits
`waitMs` longer if set, for pages that render late:

- **`format`**: `html` (default; the live DOM, serialized after
  scripts ran) or `screenshot` (PNG).
- **`fullPage`**: screenshots only; `true` (default) captures the whole
  scrollable page, `false` just the 1600×1000 window.
- The result route returns the bytes as `text/html; charset=utf-8` or
  `image/png`, with `X-Final-Url` set to the URL after redirects. The job's
  `progress` also has `finalUrl`, `title` and `bytes`.
- Captures are files under `data/captures/`, deleted `CAPTURE_TTL_HOURS`
  (default 24, `0` = keep) after they're taken; after that the result route
  returns `410`. Fetch soon after the job finishes.
- Page jobs always run on Patchright: the extension only has permission for
  the supported sites.

A TOC result has `chapterCount`, `latest`, and `chapters[]` of
`{position, number, title, url}`. TOCs can include unnumbered extras (author's
notes, discussion posts) and can skip numbers; `number` is missing for extras.
Chapter exports list any skipped numbers in `numberGaps`.

### Python client

`client/scraper_client.py` uses only the standard library. Copy it into your pipeline (T9 ships a copy):

```python
sc = ScraperClient("http://127.0.0.1:8787", token=TOKEN)
toc = sc.toc(book_url)                                  # what's out there
export = sc.chapters(book_url, from_chapter=have + 1)   # blocks until done

job = sc.submit_chapters(book_url, priority="low")      # backfill
for ch in sc.iter_chapters(job["id"]):                  # read in slices, even mid-run
    ...
```

The module docstring has a fuller backfill loop. It also works as a CLI:
`SCRAPER_TOKEN=... python scraper_client.py chapters <url> --from 120 -o out.json`
(add `--backfill` for low priority).

## Per-site settings

Defaults live in each adapter's `defaults` (twkan: `delayMs: 4000, minDelayMs: 4000`,
because going faster triggers Turnstile). You can override them in `sites.json`
(see `sites.json.example`); it's re-read for every job. The keys are:
- pacing: `delayMs`, `minDelayMs`, `jitter`
- timeouts: `navTimeoutMs`, `challengeTimeoutMs`
- challenge handling: `challengeAutoWaitMs`, `challengeClicks`, `challengeClickWaitMs`

## Challenges

When a challenge shows up, the runner escalates in this order:
1. Wait for it to clear by itself.
2. Click the Turnstile checkbox, up to `challengeClicks` times.
3. Mark the job `blocked`, send a notice to `NOTIFY_URL` with the noVNC link, and wait up to `CHALLENGE_TIMEOUT_MS` for you to solve it.

A job can also name its own `notifyUrl` (plus `notifyKind`: `ntfy` or `json`) in
`POST /jobs` or `POST /toc`. Its notice goes there as well as to `NOTIFY_URL`.

Each target can have a secret: `NOTIFY_SECRET` for the global one, and
`notifySecret` on the job (stored separately and never returned by the API).
Don't reuse `API_TOKEN` for either.
- `json`: the secret is an HMAC-SHA256 key and is never sent. Each notice has an
  `X-Scraper-Signature: t=<unix seconds>,v1=<hex>` header, where `v1` is
  `HMAC(secret, "<t>.<raw body>")`. Verify against the raw body, before parsing
  the JSON, and reject old timestamps. `verify_signature()` in the Python client does both:

  ```python
  from scraper_client import verify_signature
  if not verify_signature(SECRET, request.get_data(), request.headers.get("X-Scraper-Signature", "")):
      abort(401)
  ```
- `ntfy`: ntfy can't check signatures, so the secret is sent as an access token
  (`Authorization: Bearer tk_...`) for a protected topic.

Every outcome is logged to `challenge_events`.

## Engines (`ENGINE=`)

- **`patchright`** (default): Patchright, a Playwright fork with the CDP leaks
  patched, driving the real Chrome with a persistent profile.
- **`extension`**: plain Chrome with no debugging port. The `extension/` MV3
  extension talks to a loopback WebSocket, and keys and clicks go through
  `xdotool`. Google Chrome ignores `--load-extension`, so you install it once
  over noVNC: open `chrome://extensions`, turn on Developer mode, click "Load
  unpacked", and pick the repo's `extension/` directory (`/app/extension` in
  Docker). With `LAUNCH_ON_START=1` and `ENGINE=extension`, the browser opens
  on `chrome://extensions` until the extension is installed.

## Bake-off

Compares the engines on your real books:

1. `cp bakeoff/books.json.example bakeoff/books.json` and list your books (2-3 per site).
2. Install the timer: `cp deploy/scraper-bakeoff.* ~/.config/systemd/user/`, then
   `systemctl --user daemon-reload && systemctl --user enable --now scraper-bakeoff.timer`.
3. Each run (08:30 and 20:30, plus up to 30 min of random delay) reads every book's TOC and scrapes what's new
   with one engine. Morning and evening alternate engines, and the order swaps
   daily. Each engine keeps its own position per book (`bakeoff/state.json`),
   starting `initialBacklog` chapters back.
4. Once per engine, run a burst: `node scripts/bakeoff-run.js --engine patchright --burst 100`
   (100 consecutive chapters from the first book of each site).
5. Score it: `node scripts/bakeoff-report.js`. The deciding column is
   `human /100`: challenges that needed you, per 100 page loads.

Manual runs: `node scripts/bakeoff-run.js [--engine X] [--dry-run]`, with
`.env`'s `API_TOKEN` in the environment. Backfills and other pipeline jobs
don't count in the report (it only reads `bakeoff/runs.jsonl`), but they do
share the IP's reputation with Cloudflare.

## Adding a site

Copy an adapter in `src/sites/`. Its in-page half (`makeSite(common)`) must be
self-contained, because it gets serialized. Register it in
`src/sites/index.js`, then run `node scripts/build-inpage.js` to regenerate the
extension's files, and reload the extension.

## Tests

`npm test`. The API tests start a server with `WORKER=0` (jobs queue but
nothing runs), which is also useful for maintenance.
