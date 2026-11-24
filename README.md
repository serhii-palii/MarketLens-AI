<!-- FILE: README.md -->
<!-- Product overview, current state, and setup instructions for MarketLens AI. -->

# MarketLens AI

MarketLens AI monitors publicly available competitor and market information, detects meaningful changes, and turns them into evidence-backed business insights that a person reviews before they are trusted.

> **Status:** early development (foundation phase). Only the items listed under "Current features" exist today.

## Current features

- API Worker with a health endpoint that checks both database connections.
- Single-origin design: one Worker serves both the frontend and the API, and grants no cross-origin access.
- Frontend shell (React) that calls the API and displays connection status.
- Automated tests for the health endpoint, cross-origin behavior, and error responses.
- Initial database schema (migration) with automated tests for constraints, cascades, and immutable review history.
- Owner login with a signed session cookie, and an owner-only API for managing competitors and monitored pages, with input validation.
- Safe page collection (URL and DNS checks, robots.txt, size and redirect limits), content extraction, and snapshot storage, runnable on demand through the owner API.

## Limitations

- No data collection, change detection, AI analysis, authentication, or review workflow yet.
- The application is not deployed.
- The database schema exists as a migration, but the API does not read or write it yet.

## Planned scope

- **Marketing intelligence:** positioning, messaging, pricing, offers, content, and campaign signals.
- **Product intelligence:** features, releases, integrations, plans, and packaging.
- Deterministic change detection before any AI interpretation.
- A bounded AI workflow that produces structured, evidence-linked findings.
- Human review (approve, reject, annotate) with decisions that AI runs never overwrite.
- A public demo with sample data and a private owner workspace, kept in separate databases.
- Operation within free-tier limits, with graceful handling of exhausted quotas.

Only collection of ordinary, publicly accessible HTML pages is planned. Pages that need browser rendering, logins, or bot-protection bypass are out of scope.

## Technology overview

| Area           | Technology                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------ |
| Frontend       | React, TypeScript, Vite, Tailwind CSS, Lucide icons                                              |
| Backend        | Cloudflare Worker with Hono, exposing a REST API and serving the built frontend as static assets |
| Database       | Cloudflare D1 (SQLite-compatible): one database for the private workspace and one for the demo   |
| AI             | Cloudflare Workers AI, with the model chosen through server configuration (planned)              |
| Scheduling     | Cron Triggers (planned)                                                                          |
| Tests          | Vitest, with Playwright added when screens warrant browser tests                                 |
| Source control | Git and GitHub                                                                                   |

Exact dependency versions are declared in the `package.json` files.

## Architecture overview

```
Public sources → Collection → Extraction and normalization → Change detection and deduplication
      → Database → AI analysis → Evidence validation → Human review → Dashboard
```

The collection and change-detection stages run without AI, so snapshots and detected changes stay available when AI is unavailable. The frontend and the API ship as one Worker deployment: requests to `/api/*` run the API code, and every other path is served from the built frontend. During development the frontend dev server forwards `/api` calls to the local Worker.

```
api/   Worker (API routes, collection, analysis, scheduling) and deployment configuration
web/   Frontend application (built into web/dist and served by the Worker)
```

## Local setup

Requirements: Node.js 22 or newer and npm.

```bash
npm install
```

`npm install` also generates the API's binding types (`api/worker-configuration.d.ts`, which is not tracked in Git).

## Development commands

| Command                | Purpose                                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------- |
| `npm run dev:api`      | Start the Worker locally at http://localhost:8787 (API, plus the frontend from the last `npm run build`) |
| `npm run dev:web`      | Start the frontend dev server at http://localhost:5173, forwarding `/api` to the Worker                  |
| `npm test`             | Run the API tests                                                                                        |
| `npm run typecheck`    | Type-check both workspaces                                                                               |
| `npm run build`        | Build the frontend                                                                                       |
| `npm run types -w api` | Regenerate API binding types after changing `api/wrangler.jsonc`                                         |

Run `npm run dev:api` and `npm run dev:web` in separate terminals, then open the frontend URL to see the connection status.

## Deployment

Deployment is not configured yet. Instructions will be added when the application is first deployed.
