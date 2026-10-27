# Quickstart: the scraper in Docker

You need Docker with the Compose plugin (`docker compose version` should work).
Nothing else is required on the host. The image includes the browser, the
virtual display, and noVNC for solving challenges by hand.

Run it on a machine with a residential IP, such as a home server or desktop.
Data-center IPs get Cloudflare challenges on nearly every page.

## 1. Start it

**From the published image** (no clone needed):

```bash
mkdir -p t9-scraper/data && cd t9-scraper
curl -fsSLO https://raw.githubusercontent.com/SpiraMirabilis/t9-scraper/main/compose.yaml
docker compose pull
docker compose up -d
```

**Or build it from a clone:**

```bash
git clone https://github.com/SpiraMirabilis/t9-scraper
cd t9-scraper
mkdir -p data
docker compose up -d --build
```

Creating `data/` yourself first means its files belong to you (see
[Your data](#your-data)). The image runs on x86-64 and ARM64; ARM64 uses
Chromium, because Google doesn't publish Chrome for Linux on ARM. Expect more
challenges there.

When `docker compose ps` shows `(healthy)`, open
**http://localhost:6080/vnc.html** to see the scraper's browser, and
**http://localhost:8787/docs** for the API.

## 2. Your API token and VNC password

The first start creates `data/.env` with a random `API_TOKEN` and
`VNC_PASSWORD`:

```bash
cat data/.env
```

- **`API_TOKEN`**: clients send it as `Authorization: Bearer <token>` (T9's
  `SCRAPER_TOKEN`).
- **`VNC_PASSWORD`**: the password noVNC asks for.

Set `NOTIFY_URL` there too if you want a push notification when a job needs
you (an [ntfy](https://ntfy.sh) topic URL works). Other settings go in the
same file; see `deploy/scraper.env.example`. Then restart:

```bash
docker compose restart
```

## 3. Everyday commands

```bash
docker compose logs -f                        # follow logs
docker compose down                           # stop (data/ is kept)
docker compose pull && docker compose up -d   # upgrade (published image)
git pull && docker compose up -d --build      # upgrade (from a clone)
```

To stay on a specific release instead of `latest`, put `SCRAPER_VERSION=0.3.0`
in a `.env` file next to `compose.yaml` (not `data/.env`).

Try it on a book page:

```bash
export SCRAPER_TOKEN=$(grep ^API_TOKEN= data/.env | cut -d= -f2)
python3 client/scraper_client.py toc https://www.novel543.com/<book-id>/
```

`client/scraper_client.py` uses only the Python standard library. Download it
from the repo if you didn't clone.

## Solving challenges

The browser opens when the container starts, so it's waiting on noVNC from
the start. When a challenge doesn't clear on its own and the scraper's
checkbox clicks fail, the job turns `blocked`. Open noVNC, solve the
challenge, and the job continues. The browser profile is kept in
`data/chrome-profile-*`, so clearance and logins survive restarts.

## Using the extension engine

The default engine (Patchright) needs no setup. To try the `extension`
engine, put `ENGINE=extension` in `data/.env` and restart. On its first start,
the browser opens on `chrome://extensions`. Over noVNC, turn on **Developer
mode**, click **Load unpacked**, and pick `/app/extension`. It stays installed
in `data/chrome-profile-extension`.

## Running alongside T9

If you run [T9](https://github.com/SpiraMirabilis/translate) in Docker, you
don't need this compose file. T9's own `compose.yaml` runs the scraper and
T9's scrape worker together with `docker compose --profile scraper up -d`
(see "Automated source scraping" in T9's `QUICKSTART-Docker.md`). That needs a
T9 release newer than 1.1.1; until one is published, build T9 from a clone.

Use this compose file when the scraper runs on a different machine from T9.
There, T9 runs only its worker (`--profile scrape-worker`). T9's **Scraper
URL** points at this machine (see the next section), and its scraper token is
this `API_TOKEN`.

## Exposing it beyond this machine

By default both ports are bound to `127.0.0.1` only. Neither should ever face
the internet. To reach them from your own other machines, publish them on a
private address instead, such as a LAN or Tailscale IP. In `compose.yaml`:

```yaml
    ports:
      - "100.x.y.z:8787:8787"
      - "100.x.y.z:6080:6080"
```

Then set `VNC_URL` in `data/.env` to the address you'll open it from, so
notices and blocked jobs link to the right place:

```env
VNC_URL=http://100.x.y.z:6080/vnc.html?autoconnect=1&resize=scale
```

Keep `API_TOKEN` and `VNC_PASSWORD` set. The browser holds your sites' cookies.

## Your data

Everything persists in `./data` on the host:

- `scraper.db`: the job queue and results (SQLite)
- `chrome-profile-patchright/`, `chrome-profile-extension/`: the browser profiles
- `sites.json`: optional per-site overrides (see `sites.json.example`)
- `.env`: your secrets and settings

To back up, stop the container and copy the `data/` directory.

The container runs as whoever owns `data/`, so the files stay yours. If Docker
created `data/` itself, it's owned by root and the container falls back to uid
1000. To choose explicitly, set `PUID` and `PGID` in the `.env` file next to
`compose.yaml`.

## Browser sandbox

`compose.yaml` runs the container with `seccomp=unconfined`. Chrome's sandbox
needs user namespaces, which Docker's default seccomp profile blocks, and
Chrome then puts each page in its own, stricter seccomp sandbox. If your
platform doesn't allow that, remove the `security_opt` lines and put
`CHROME_SANDBOX=0` in `data/.env`. Pages then run without Chrome's sandbox,
with only the container's isolation around them.

For installing without Docker, see [README.md](README.md#setup-without-docker).
