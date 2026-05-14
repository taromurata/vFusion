# vFusion

⚠️ **Beta — built by a Verkada SE, not an official Verkada product.** Expect breaking changes. This tool uses API keys with broad permissions and acts on real cameras, doors, and alarms. Review the code, run it on infrastructure you control, and don't point it at production orgs you can't afford to debug. No warranty; see [LICENSE](LICENSE).

Ever wish you could fuse together custom Verkada API pipelines? Now it's possible by just using a UI and you don't have to type a single line of code. 

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
- 🌍 **Public URLs built-in** — two deploy modes: quick mode (free TryCloudflare URL, zero Cloudflare setup) and production (named tunnel on your own domain). URL auto-displayed in the UI banner
- 🔐 **Secrets at rest** — Fernet encryption for stored API keys + signing secrets, HMAC webhook signature verification, sensitive headers redacted before persistence

## Two ways to run

| Mode | Webhook URL | Best for |
|---|---|---|
| **Quick** | `https://<random>.trycloudflare.com/hooks/verkada` — changes on every restart | Testing, demos, kicking the tires. No Cloudflare account or domain needed. |
| **Production** | `https://hooks.yourdomain.com/hooks/verkada` — stable | Always-on deploys. Requires a free Cloudflare account + a domain on Cloudflare. |

Both share the same bootstrap below. After that, pick one path.

---

## Bootstrap (one-time, ~5 min)

Same for both modes. If you're skipping ahead to Production, do these steps first.

### 1. Install Docker Desktop

Download from [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/) (free for personal / small-business use). Open the app once after install to start the engine.

Verify:
```bash
docker --version
docker compose version
```

### 2. Clone, configure, generate key — one paste

This block clones into `~/vfusion`, copies `.env.example` → `.env`, generates a Fernet key (used to encrypt API keys at rest in Postgres), and writes it into `.env` for you:

```bash
cd ~
git clone https://github.com/PacketTrace/verkadaRoute.git vfusion
cd vfusion
cp .env.example .env
FERNET_KEY=$(docker run --rm python:3.12-slim sh -c \
  "pip install -q cryptography && python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'")
echo "Generated FERNET_KEY: $FERNET_KEY"
sed -i.bak "s|^FERNET_KEY=.*|FERNET_KEY=$FERNET_KEY|" .env && rm .env.bak
echo "Wrote FERNET_KEY to .env"
```

Confirm with `grep ^FERNET_KEY .env`.

---

## Quick mode — testing & demos

For trying the full Verkada → webhook → flow loop without configuring a domain. Cloudflare hands you a random `https://<random-words>.trycloudflare.com` URL.

### 1. Start the stack

```bash
docker compose --profile quick up --build -d
```

First build takes ~2–3 min (image pulls + npm install + alembic migrations). Subsequent starts are seconds. Then open **http://localhost:15173** — the inbox banner shows your trycloudflare URL within ~10 seconds.

### 2. (Optional) Smoke test

Fire a realistic LPR webhook at the LAN address. Confirms the stack is alive and exercises the classifier. The fake `org_id` isn't a valid UUID so it's rejected by the org-detection logic — the webhook lands in the inbox but no fake Connection is auto-created. The welcome screen's "Stack received its first request ✓" indicator turns on within 2 seconds:

```bash
curl -X POST http://localhost:18080/hooks/verkada \
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
      "confidence": 0.93,
      "crop": [0.25, 0.30, 0.10, 0.13],
      "license_plate_state": "us-wa"
    }
  }'
```

This won't dismiss the welcome screen — only a real Verkada webhook (with a valid UUID org_id) does that.

### 3. Wire it into Verkada Command

The welcome modal in the dashboard shows your public webhook URL with a copy button. Before pasting it into Verkada Command, generate a shared secret — both sides compute HMAC-SHA256 against the same string so vFusion can verify each webhook came from your Verkada org. **Strongly recommended even in quick mode** — without it anyone who finds your trycloudflare URL could forge events.

1. **vFusion → Connections** → open your Verkada org form → click **Generate** next to "Webhook signing secret" → click **Copy**.
2. **Verkada Command** → **Settings** → **Webhooks** → **Create webhook**:
   - **Endpoint URL**: paste your trycloudflare URL with `/hooks/verkada` appended
   - **Shared secret**: paste the string you just generated
   - Pick the notification types you want
   - **Save**
3. Back **in vFusion** → save the Connection form.
4. **In Verkada Command** → click **Send test webhook**.

The dashboard auto-unlocks the moment the real webhook arrives. In the inbox, the event should show a green **✓ verified** badge.

### What's exposed through the tunnel

Only the exact path `POST /hooks/verkada`. A Caddy reverse proxy sits between the trycloudflare URL and the backend and returns 404 for anything else (admin API, dashboard, synthetic slugs, wrong HTTP methods). So even if the URL leaks — Slack screenshot, Verkada Command webhook config, etc. — attackers can only POST webhook payloads, same surface as Verkada's cloud has.

### Catch

The trycloudflare URL **changes every time `cloudflared` restarts**. You'd have to re-paste the new URL into Verkada Command after each restart. For something stable, see Production mode below.

---

## Production mode — 24/7 with your own domain

For always-on deploys with a stable URL. Requires a free Cloudflare account + a domain on Cloudflare.

### 1. Create the Cloudflare tunnel (~5 min in the dashboard)

1. Sign in to the [Cloudflare Zero Trust dashboard](https://one.dash.cloudflare.com/).
2. Navigate to **Networks** → **Tunnels** → **Create a tunnel**.
3. Choose **Cloudflared** as the connector type → **Next**.
4. Name the tunnel `vfusion` → **Save tunnel**.
5. The next screen shows install commands. **Copy the token** — the long string starting with `eyJhIjoi...`. Ignore the install commands; our `docker-compose.yml` runs `cloudflared` for you. Click **Next**.
6. On the **Public Hostnames** tab, click **Add a public hostname**:
   - **Subdomain**: `hooks`
   - **Domain**: pick the domain you added to Cloudflare
   - **Path**: `hooks/*` ← important: limits public exposure to webhook endpoints only
   - **Service** → **Type**: `HTTP` → **URL**: `backend:8000`
7. **Save hostname**. Your public URL is now `https://hooks.yourdomain.com/hooks/verkada`.

### 2. Add the token to `.env`

```bash
cd ~/vfusion
echo "CF_TUNNEL_TOKEN=<paste-token-here>" >> .env
```

### 3. Start the stack

```bash
docker compose --profile cloudflared up --build -d
```

Verify the tunnel connected:

```bash
docker compose logs cloudflared | grep -i "registered tunnel connection"
```

You should see 2–4 lines (Cloudflare connects to multiple POPs for redundancy).

### 4. Configure the webhook in Verkada Command

1. **vFusion → Connections** → open the Verkada org form → click **Generate** next to "Webhook signing secret" → click **Copy**. (Don't save yet — keep the form open.)
2. **Verkada Command** → **All Products** → **Settings** → **Webhooks** → **Create webhook**:
   - **Endpoint URL**: `https://hooks.yourdomain.com/hooks/verkada`
   - **Shared secret**: paste the string from step 1
   - **Events**: pick the notification types you want, or "all events"
   - **Save**
3. Click **Send test webhook**.

### 5. Finish setup in vFusion

The test webhook lands in the inbox within a couple seconds. vFusion auto-detects the org. Back in the Connection form you left open in step 1:

- Your **Verkada API key** (generate in Command → My Account → API Keys)
- The **webhook signing secret** field already has the value from step 1 — leave it as-is

Save. The test webhook in the inbox should now show a green **✓ verified** badge.

---

## Updating

```bash
cd ~/vfusion
git pull
docker compose --profile <quick|cloudflared> up --build -d
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
