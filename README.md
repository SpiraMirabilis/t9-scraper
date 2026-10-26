# chapter-scraper

Tailnet-only HTTP API that scrapes raw web-novel chapters on demand with a real,
headed Chrome on a virtual display. The translation VM queues a job, polls it,
and fetches the result: the same JSON shape the TamperMonkey scripts
(`twkan.js`, `wfxs.js`, `novellunar.js`) export.

```
translation VM ──HTTP (tailnet)──▶ API :8787 ──▶ SQLite job queue ──▶ runner ──▶ engine ──▶ Chrome on Xvfb :99
                                                                                              ▲
                                                 you ──browser──▶ noVNC :6080 ──▶ x11vnc ─────┘
```

## Setup

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

noVNC: `http://100.65.58.103:6080/vnc.html`

## API

Interactive docs: `http://100.65.58.103:8787/docs` (no token needed to read them).
All other routes except `/health` need `Authorization: Bearer $API_TOKEN`.

| Route | |
|---|---|
| `POST /toc` | `{url, engine?}`: read a book's chapter list without fetching chapters |
| `POST /jobs` | `{url, fromChapter?, fromUrl?, toChapter?, maxChapters?, delayMs?, priority?, engine?}`: scrape chapters |
| `GET /jobs/:id` | `status`: queued, running, blocked, done, failed or cancelled. Also `progress`, `stopReason`, `error`, and `vncUrl` while blocked |
| `GET /jobs/:id/result?offset=&limit=` | Chapters: export JSON, readable while the job runs and partial for failed or cancelled jobs; `offset`/`limit` return a slice of chapters. TOC: the chapter list |
| `POST /jobs/:id/retry` | Requeue a failed or cancelled job; it resumes after its last captured page |
| `DELETE /jobs/:id` | Cancel |
| `GET /jobs?status=&limit=` | List, newest first |
| `GET /sites` | Effective per-site settings |
| `GET /supported_sites` | JSON array of supported domains (subdomains included) |
| `GET /stats/challenges?since=` | Challenge outcomes per engine and site |
| `GET /health` | Engine and display status |

Both `POST` routes return `202` with a new job. If an identical job (same
site, URL, range and engine) is already queued, running or blocked, they
return `200` with that job and `deduped: true` instead of starting a second copy.

How the chapter job fields work:
- **`url`** can be a book page or a chapter page. The site is picked from the URL.
- **`fromChapter`** is a TOC entry's `position`: the 1-based TOC position on twkan, wfxs and 69shuba, and the URL chapter number on novellunar. If that position doesn't exist (sources have gaps), the job starts at the next one that does.
- **Defaults:** start at chapter 1, or at `url` if it's a chapter page, and run to the end of the book.
- **`toChapter`** is inclusive and compared against the chapter number parsed from the title.
- **`delayMs`** can only raise the site's pacing, never drop it below the floor.
- **`priority: "low"`** is for backfills (a whole new book). Low jobs run only when nothing normal is queued, and step aside between pages when a normal job arrives, resuming later from their last captured page. Daily updates never wait behind a backfill.
- **`engine`** picks the browser engine for this job; the default is `ENGINE`. The worker closes one engine's browser before starting the other.

A TOC result has `chapterCount`, `latest`, and `chapters[]` of
`{position, number, title, url}`. TOCs can include unnumbered extras (author's
notes, discussion posts) and can skip numbers; `number` is missing for extras.
Chapter exports list any skipped numbers in `numberGaps`.

### Python client

`client/scraper_client.py` uses only the standard library. Copy it into the translation pipeline:

```python
sc = ScraperClient("http://100.65.58.103:8787", token=TOKEN)
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

Every outcome is logged to `challenge_events`.

## Engines (`ENGINE=`)

- **`patchright`** (default): Patchright, a Playwright fork with the CDP leaks
  patched, driving the real Chrome with a persistent profile.
- **`extension`**: plain Chrome with no debugging port. The `extension/` MV3
  extension talks to a loopback WebSocket, and keys and clicks go through
  `xdotool`. Google Chrome ignores `--load-extension`, so you install it once
  over noVNC: open `chrome://extensions`, turn on Developer mode, click "Load
  unpacked", and pick `~/scraper/extension`.

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
