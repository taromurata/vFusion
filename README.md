# vSplice

⚠️ **Beta — built by a Verkada SE, not an official Verkada product.** Expect breaking changes. This tool uses API keys with broad permissions and acts on real cameras, doors, and alarms. Review the code, run it on infrastructure you control, and don't point it at production orgs you can't afford to debug. No warranty; see [LICENSE](LICENSE).

Ever wish you could splice together custom Verkada API pipelines? Now it's possible by just using a UI and you don't have to type a single line of code. 

Self-hosted, Verkada-flavored workflow automation — a visual router for webhooks and API events. Think Zapier/n8/make.com, but built around the Verkada API surface (Helix, Access, etc.).

## Features

- 📥 **Webhook inbox** — catch any Verkada webhook at `/hooks/*`, auto-classify into family (camera / access / lpr / sensor / intercom), auto-detect new orgs on first sight
- 🎨 **Visual flow editor** — drag-and-drop canvas (React Flow) for event-driven automations. Conditions, branches, per-step ▶ Run button for testing
- 🎥 **Gemini video analysis** — pull a historical clip from any Verkada camera at trigger time, send to Gemini (2.5 / 3.x Flash or Pro), get AI summary back. Or analyze a single live frame for ~10× cost savings
- 🚪 **Verkada actions** — unlock doors, post Helix events (schema-aware attribute validation), or call any cataloged endpoint generically
- 📚 **API catalog** — auto-syncs every Verkada OpenAPI spec every 4 hours, generates structured request forms for path / query / body params on every endpoint
- ⏰ **Triggers** — Verkada webhooks + scheduled jobs (interval / daily / weekly)
- 🧪 **Workbench** — one-shot Gemini test page. Pick a camera, write a prompt, optionally chain a Helix post — without building a full flow first. "Run it back" to rehydrate any past test
- 📊 **Stats & cost** — ingest counters (24h / 7d / 30d), top event types with inbox drill-down, Gemini spend tracking per model, real-time server load (CPU / memory / disk)
- 🌍 **Public URLs built-in** — three deploy modes: LAN-only, quick tunnel (free TryCloudflare, zero setup), named tunnel (your own domain). URL auto-displayed in the UI banner
- 🔐 **Secrets at rest** — Fernet encryption for stored API keys + signing secrets, HMAC webhook signature verification, sensitive headers redacted before persistence

## Three ways to run

| Mode | Webhook URL | Best for |
|---|---|---|
| **LAN-only** | `http://localhost:18080/hooks/...` | Evaluating the UI, testing flows with synthetic curl traffic, Tailscale-only homelabs |
| **Quick tunnel** | `https://<random>.trycloudflare.com/hooks/verkada` — changes on every restart | "Just let me try the full Verkada→webhook flow without setting up a domain" |
| **Named tunnel** | `https://hooks.yourdomain.com/hooks/verkada` — stable | Production. You own a domain on Cloudflare. |

The setup below covers LAN-only. Add `--profile quick` for an ephemeral public URL, or follow **Production deploy with Cloudflare Tunnel** further down for a stable one.

## Try it locally (Mac / Linux / Windows)

Requires only Docker. This is the LAN-only path — webhooks from Verkada's cloud won't reach a laptop, so use this for evaluating the UI and testing flows with synthetic webhooks.

### 1. Install Docker Desktop

Download from [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/) (free for personal / small-business use). Open the app once after install to start the engine.

Verify:
```bash
docker --version
docker compose version
```

### 2. Clone, configure, generate key — one paste

This block clones into `~/vsplice`, copies `.env.example` → `.env`, generates a Fernet key (used to encrypt API keys at rest in Postgres), prints it, and writes it into `.env` for you:

```bash
cd ~
git clone https://github.com/PacketTrace/verkadaRoute.git vsplice
cd vsplice
cp .env.example .env
FERNET_KEY=$(docker run --rm python:3.12-slim sh -c \
  "pip install -q cryptography && python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'")
echo "Generated FERNET_KEY: $FERNET_KEY"
sed -i.bak "s|^FERNET_KEY=.*|FERNET_KEY=$FERNET_KEY|" .env && rm .env.bak
echo "Wrote FERNET_KEY to .env"
```

No copy-paste required. Confirm with `grep ^FERNET_KEY .env`.

### 3. Start the stack

```bash
docker compose up --build -d
```

First build takes ~2–3 minutes (image pulls + npm install + alembic migrations). Subsequent starts are seconds.

Watch the backend come up:
```bash
docker compose logs -f backend     # wait for "Uvicorn running on http://0.0.0.0:8000"
```

### 4. Open the UI

- **Dashboard**: http://localhost:15173
- **Backend health**: http://localhost:18080/api/health
- **Webhook catch-all**: `POST http://localhost:18080/hooks/<anything>`

### 5. Send a test webhook

Fire a realistic LPR event at your endpoint. Pick one of these for `BASE`:

- `http://localhost:18080` if you're testing the LAN-only path
- your trycloudflare URL (e.g. `https://flying-purple-cat-1234.trycloudflare.com`) if you're testing the quick tunnel

```bash
BASE=http://localhost:18080

curl -X POST "$BASE/hooks/verkada" \
  -H "Content-Type: application/json" \
  -d '{
    "org_id": "topSecretOrgDoNotTellAnyone",
    "webhook_type": "lpr",
    "created_at": 1778722097,
    "webhook_id": "f319fb87-4ca6-47de-ae71-67b25aa1dab7",
    "data": {
      "camera_id": "93b90c2c-f06d-4fde-b25e-29b211282609",
      "created": 1778722095,
      "detected": 1778722097743,
      "license_plate_number": "BVZ0938",
      "confidence": 0.9379871428571429,
      "crop": [0.2533212900161743, 0.3052724301815033, 0.10247643291950226, 0.1325235664844513],
      "image_url": "https://ibb.co/nsShXXSs",
      "license_plate_state": "us-wa",
      "license_plate_state_confidence": 0.7,
      "vehicle_image_url": "https://ibb.co/cX76vMwY"
    }
  }'
```

It should appear in the **Webhook Inbox** within ~2s, classified as an **lpr** family event with the license plate `BVZ0938`.

## Quick tunnel (real public URL, no domain needed)

If you want to point real Verkada webhooks at your laptop without setting up a domain, use the `quick` profile. This runs `cloudflared` in **TryCloudflare** mode — Cloudflare hands you a random `https://<random-words>.trycloudflare.com` URL that's real public HTTPS. The Webhook Inbox banner shows the URL with a copy button so you know what to paste into Verkada Command.

```bash
docker compose --profile quick up --build -d
```

That's it. No account, no API key, no domain. Wait ~10 seconds for cloudflared to register, then open the dashboard — the amber banner at the top of the Webhook Inbox will show the URL.

**Catch:** the URL changes every time `cloudflared` restarts. Don't use this for production — when the URL rolls, you'd have to re-paste the new one into Verkada Command. For something stable, see the named tunnel below.

## Production deploy with Cloudflare Tunnel

For vSplice to receive real webhooks from Verkada's cloud, it needs a public URL. **Cloudflare Tunnel** gives you a free, stable HTTPS endpoint (`https://hooks.yourdomain.com`) without opening any ports on your router. We bundle the `cloudflared` connector as an opt-in compose profile, so the whole stack — vSplice plus its public ingress — comes up with one command.

### What you need

- Everything from "Try it locally" above (Docker, this repo cloned, `.env` filled in)
- A free [Cloudflare account](https://cloudflare.com)
- A domain on Cloudflare (free tier is fine — you can transfer an existing domain or buy a cheap one)

### 1. Create the Cloudflare tunnel (~5 min in the dashboard)

1. Sign in to the [Cloudflare Zero Trust dashboard](https://one.dash.cloudflare.com/).
2. Navigate to **Networks** → **Tunnels** → **Create a tunnel**.
3. Choose **Cloudflared** as the connector type → **Next**.
4. Name the tunnel `vsplice` → **Save tunnel**.
5. The next screen shows install commands for various OSes. **Copy the token** — it's the long string in those commands, starting with `eyJhIjoi...`. You don't need to run any of the install commands; our `docker-compose.yml` runs `cloudflared` for you. Click **Next**.
6. On the **Public Hostnames** tab, click **Add a public hostname**:
   - **Subdomain**: `hooks`
   - **Domain**: pick the domain you added to Cloudflare
   - **Path**: `hooks/*` ← important: limits public exposure to webhook endpoints only
   - **Service** → **Type**: `HTTP` → **URL**: `backend:8000`
7. **Save hostname**. Your public webhook URL is now `https://hooks.yourdomain.com/hooks/verkada`.

### 2. Add the token to `.env`

```bash
cd ~/vsplice
echo "CF_TUNNEL_TOKEN=<paste-token-here>" >> .env
```

(Or open `.env` in an editor and fill in the `CF_TUNNEL_TOKEN=` line.)

### 3. Start the stack with the cloudflared profile

```bash
docker compose --profile cloudflared up --build -d
```

The `--profile cloudflared` flag tells compose to include the tunnel connector. Verify it connected:

```bash
docker compose logs cloudflared | grep -i "registered tunnel connection"
```

You should see 2–4 lines (Cloudflare connects to multiple POPs for redundancy).

### 4. Configure the webhook in Verkada Command

1. **Verkada Command** → **All Products** → **Settings** → **Webhooks** → **Create webhook**:
   - **Endpoint URL**: `https://hooks.yourdomain.com/hooks/verkada`
   - **Events**: pick whichever notification types you care about, or "all events" to start
   - **Save**
2. Copy the **signing secret** Verkada shows — you only see it once.
3. Click **Send test webhook**.

### 5. Finish setup in vSplice

The test webhook will land in the **Webhook Inbox** within a couple seconds. vSplice auto-detects the org and shows a banner: **"New Verkada org detected — finish setup"**. Click it and paste:
- Your **Verkada API key** (generate in Command → My Account → API Keys)
- The **webhook signing secret** from step 4

Save. Done — flows can now read camera footage, post Helix events, unlock doors, etc.

### Updating

```bash
cd ~/vsplice
git pull
docker compose --profile cloudflared up --build -d
```

Migrations run automatically on backend boot.

## Services

| Service  | Host port | Container port | Notes |
|----------|-----------|----------------|-------|
| frontend | 15173 | 5173 | Vite dev server, React + React Flow (later phases) |
| backend  | 18080 | 8000 | FastAPI; runs `alembic upgrade head` on start |
| worker   | — | — | arq worker; no-op job for now, will run flows in Phase 3 |
| postgres | — | 5432 | `verkada` / `verkada` / `verkadaroute` — internal only |
| redis    | — | 6379 | execution queue — internal only |

## Project layout

```
backend/        FastAPI + SQLAlchemy + Alembic + arq
  app/api/      route handlers
  app/models/   ORM models
  app/         (engine/, connectors/ — added in later phases)
frontend/       Vite + React + Tailwind
  src/pages/    one component per top-level route
  src/components/  shared UI (JSON viewer, etc.)
```

## Dev notes

- Sensitive headers (`Authorization`, `Cookie`, `X-API-Key`, `X-Verkada-Auth`) are redacted before being stored in `webhook_events`.
- Backend code is hot-reloaded via volume mount + `uvicorn --reload`. Frontend uses Vite HMR.
- To wipe captured webhooks: `docker compose exec postgres psql -U verkada -d verkadaroute -c "TRUNCATE webhook_events;"`
- To reset everything: `docker compose down -v`
