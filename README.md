# Sportmonks Middleware (Node.js Express)

This server sits between your Swift iOS app and Sportmonks.

- Keeps `SPORTMONKS_TOKEN` server-side only
- Proxies Sportmonks JSON responses unchanged
- Caches high-frequency endpoints with endpoint-specific TTLs

## Local setup

1. Create env file:

   ```bash
   cp .env.example .env
   ```

2. Set your token in `.env`:

   ```bash
   SPORTMONKS_TOKEN=your_real_token
   ```

3. Install and run:

   ```bash
   npm install
   npm start
   ```

4. Health check:

   ```bash
   curl http://localhost:3000/health
   ```

## Endpoints and curl examples

Use `http://localhost:3000` as the base URL locally.

- `GET /fixtures/date/:date` (cache: 30m)

  ```bash
  curl "http://localhost:3000/fixtures/date/2026-04-27"
  ```

- `GET /fixtures/multi/:ids` (cache: 12h, max 50 IDs)

  ```bash
  curl "http://localhost:3000/fixtures/multi/12345,67890"
  ```

- `GET /fixtures/between/:from/:to` (cache: 30m)

  ```bash
  curl "http://localhost:3000/fixtures/between/2026-04-27/2026-04-29"
  ```

- `GET /schedules/teams/:teamId` (cache: 24h)

  ```bash
  curl "http://localhost:3000/schedules/teams/85"
  ```

- `GET /h2h/:homeId/:awayId` (cache: 24h)

  ```bash
  curl "http://localhost:3000/h2h/85/53"
  ```

- `GET /results/:date` (cache: 3m)

  ```bash
  curl "http://localhost:3000/results/2026-04-27"
  ```

`X-Cache` response header shows `HIT` or `MISS`.

## Railway deployment

1. Push this repo to GitHub.
2. In Railway, create a new project and select the repo.
3. Add environment variables:
   - `SPORTMONKS_TOKEN` = your real Sportmonks API token
   - Optional: `PORT` (Railway usually injects this automatically)
   - Optional: `SPORTMONKS_BASE_URL` (default is already correct)
4. Railway uses the included `Procfile`:

   ```txt
   web: node server.js
   ```

5. Deploy, then test:

   ```bash
   curl "https://your-railway-domain.up.railway.app/health"
   ```
