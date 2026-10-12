# FleetIntelX live-intelligence bridge

`server/fleetintelx/bridge.js` is a small standalone Node server, separate from
the Vite app. It serves normalized, freight-relevant events to FleetIntelX's
Live Intelligence layer. FleetIntelX owns the contract:
`packages/shared/src/entities/live-intelligence.ts` (`GodsEyeBridge*Schema`).

```sh
npm run bridge:fleetintelx   # http://127.0.0.1:4180 (GEV_BRIDGE_PORT)
```

| Endpoint                                                                  | Returns                  |
| ------------------------------------------------------------------------- | ------------------------ |
| `GET /api/v1/live-intelligence/events[?since=&north=&south=&east=&west=]` | contract v1 envelope     |
| `GET /api/v1/live-intelligence/health`                                    | same envelope, no events |

Anything else returns 404; any method other than GET returns 405.

## Sources

Each source reuses an existing God's Eye parser:

| Source             | Credential      | Parser                                                                                  |
| ------------------ | --------------- | --------------------------------------------------------------------------------------- |
| `usgs-earthquakes` | none            | `src/layers/earthquakes/records.js` (M2.5+, last 24 h)                                  |
| `nasa-firms`       | `FIRMS_MAP_KEY` | `src/data/firmsCsv.js` (VIIRS NOAA-20, `GEV_FIRMS_BBOX`, low-confidence pixels dropped) |
| `nhc-cyclones`     | none            | `server/providers/cyclones.js` `parseCycloneStatus`                                     |
| `dev-fixture`      | none            | TEST/DEV ONLY: `GEV_BRIDGE_DEV_FIXTURES_FILE`; refused when `NODE_ENV=production`       |

These God's Eye providers are deliberately **not** bridged yet, and why:

- **TomTom.** God's Eye only implements flow _map tiles_, not incidents.
- **AISStream.** It needs a key, and vessel positions are not events without port analysis.
- **Google Places / 3D tiles, Cesium, Mapillary, OpenSky, Launch Library 2, OpenAI voice.** Not freight events.
- **CCTV.** Camera feeds need explicit ownership and privacy scoping first.

## Rules

- **No credential, no data.** A source without its credential reports `UNAVAILABLE` / `MISSING_CREDENTIAL` and contributes no events.
- **Upstream failures:**
  - If there is a last good snapshot, the source serves it as `DEGRADED` / `STALE_CACHE`.
  - Otherwise it is `UNAVAILABLE`.
  - There is never an empty-good response.
- **Overall status:**
  - `AVAILABLE` only when every source is available.
  - `UNAVAILABLE` only when none is.
  - `DEGRADED` otherwise.
- **Unknown stays null.** Confidence, radius, delay and similar fields are never 0 or a neutral guess. A record without a trustworthy time or position is dropped.
- **Keys never leave the process.**
  - The FIRMS key is embedded in its request URL. That URL is never logged or returned, so FIRMS events have no `sourceUrl`.
  - Returned URLs pass `publicUrl()`, which strips userinfo, fragments and secret query keys.
- **Network exposure:**
  - The bridge binds to `127.0.0.1` by default.
  - Any other `GEV_BRIDGE_HOST` requires `GEV_BRIDGE_TOKEN`. FleetIntelX sends it as `GODS_EYE_BEARER_TOKEN`, and it is compared in constant time.
- **Upstream fetches:**
  - Redirects are refused.
  - Bodies are capped at 20 MB.
  - Requests time out after 20 s.
  - At most 2000 events per source; when that cap is hit, the most severe and most recent are kept and the source is marked `DEGRADED` / `TRUNCATED`.

The tests live in `src/fleetintelx/bridge.test.mjs` and run as part of `npm test`.
