/**
 * God's Eye -> FleetIntelX live-intelligence bridge.
 *
 * A small standalone Node HTTP server (no Vite, no browser code) that serves
 * normalized, freight-relevant events to FleetIntelX:
 *
 *   GET /api/v1/live-intelligence/events  -> contract v1 envelope
 *   GET /api/v1/live-intelligence/health  -> envelope without events
 *
 * Sources reuse the existing God's Eye provider parsers:
 *   usgs-earthquakes  keyless   src/layers/earthquakes/records.js
 *   nasa-firms        FIRMS_MAP_KEY   src/data/firmsCsv.js
 *   nhc-cyclones      keyless   server/providers/cyclones.js
 *   dev-fixture       TEST/DEV ONLY - GEV_BRIDGE_DEV_FIXTURES_FILE, never in production
 *
 * A source without its credential reports UNAVAILABLE / MISSING_CREDENTIAL and
 * contributes no events — never empty-good data. Upstream failures serve the
 * last good snapshot as DEGRADED / STALE_CACHE, or UNAVAILABLE when there is
 * none. Provider keys never leave this process: they are not logged, not put in
 * any URL that is returned, and never forwarded.
 *
 * Security: binds to 127.0.0.1 by default. Binding anywhere else requires
 * GEV_BRIDGE_TOKEN, which callers must present as a bearer token.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readResponseTextCapped } from '../providers/common/http.js';
import { parseCycloneStatus } from '../providers/cyclones.js';
import { normalizeEarthquakeSnapshot } from '../../src/layers/earthquakes/records.js';
import { parseFirmsCsv, filterTrailing24h } from '../../src/data/firmsCsv.js';
import {
  EVENTS_PATH,
  HEALTH_PATH,
  buildEnvelope,
  cycloneToEvent,
  earthquakeToEvent,
  filterEvents,
  fireToEvent,
} from './contract.js';

const USGS_URL =
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson';
const NHC_URL = 'https://www.nhc.noaa.gov/CurrentStorms.json';
const FIRMS_SOURCE = 'VIIRS_NOAA20_NRT';
/** North America by default; FIRMS area bbox is west,south,east,north. */
const DEFAULT_FIRMS_BBOX = '-170,15,-50,72';
const MAX_UPSTREAM_BYTES = 20 * 1024 * 1024;
const MAX_EVENTS_PER_SOURCE = 2000;
const UPSTREAM_TIMEOUT_MS = 20_000;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

function upstreamError(code) {
  return Object.assign(new Error(code), { code });
}

async function fetchText(fetchImpl, url, signal) {
  const res = await fetchImpl(url, {
    redirect: 'error',
    signal: AbortSignal.any([
      signal ?? new AbortController().signal,
      AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    ]),
    headers: { accept: 'application/json, text/csv, */*' },
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw upstreamError(`HTTP_${res.status}`);
  }
  return readResponseTextCapped(res, MAX_UPSTREAM_BYTES, signal);
}

function limitEvents(events) {
  if (events.length <= MAX_EVENTS_PER_SOURCE)
    return { events, truncated: false };
  const order = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, INFO: 0 };
  const sorted = [...events].sort(
    (a, b) =>
      order[b.severity] - order[a.severity] ||
      Date.parse(b.observedAt) - Date.parse(a.observedAt),
  );
  return { events: sorted.slice(0, MAX_EVENTS_PER_SOURCE), truncated: true };
}

/** Source definitions. `credential` is an env var NAME; its value is never exposed. */
export function createSources(env) {
  const sources = [
    {
      id: 'usgs-earthquakes',
      credential: null,
      ttlMs: 5 * 60_000,
      async load({ fetchImpl, signal }) {
        const text = await fetchText(fetchImpl, USGS_URL, signal);
        let rows;
        try {
          rows = normalizeEarthquakeSnapshot(JSON.parse(text));
        } catch {
          rows = null;
        }
        if (!rows) throw upstreamError('INVALID_UPSTREAM');
        return rows.map(earthquakeToEvent).filter(Boolean);
      },
    },
    {
      id: 'nasa-firms',
      credential: 'FIRMS_MAP_KEY',
      ttlMs: 30 * 60_000,
      async load({ fetchImpl, signal, now }) {
        const key = String(env.FIRMS_MAP_KEY || '').trim();
        const bbox = /^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$/.test(
          String(env.GEV_FIRMS_BBOX || ''),
        )
          ? env.GEV_FIRMS_BBOX
          : DEFAULT_FIRMS_BBOX;
        // The URL embeds the key: it is used for this one request and never
        // logged, cached, or returned.
        const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(key)}/${FIRMS_SOURCE}/${bbox}/1`;
        const records = parseFirmsCsv(await fetchText(fetchImpl, url, signal));
        if (records === null) throw upstreamError('INVALID_UPSTREAM');
        return filterTrailing24h(records, now())
          .map(fireToEvent)
          .filter(Boolean);
      },
    },
    {
      id: 'nhc-cyclones',
      credential: null,
      ttlMs: 10 * 60_000,
      async load({ fetchImpl, signal, now }) {
        const text = await fetchText(fetchImpl, NHC_URL, signal);
        let storms;
        try {
          storms = parseCycloneStatus(JSON.parse(text), now());
        } catch {
          throw upstreamError('INVALID_UPSTREAM');
        }
        return storms.map(cycloneToEvent).filter(Boolean);
      },
    },
  ];

  // TEST/DEV FIXTURE SOURCE. Off unless a fixture file is configured, and
  // refused outright in production. Events are read verbatim from the file on
  // every request so an end-to-end test can drive exact scenarios.
  const fixtureFile = String(env.GEV_BRIDGE_DEV_FIXTURES_FILE || '').trim();
  if (fixtureFile && env.NODE_ENV !== 'production') {
    sources.push({
      id: 'dev-fixture',
      credential: null,
      ttlMs: 0,
      async load() {
        const parsed = JSON.parse(await readFile(fixtureFile, 'utf8'));
        if (!Array.isArray(parsed?.events))
          throw upstreamError('INVALID_UPSTREAM');
        return parsed.events
          .filter((e) => e && e.source === 'dev-fixture')
          .map((e) => ({
            ...e,
            normalizedPayload: {
              ...e.normalizedPayload,
              details: {
                ...(e.normalizedPayload?.details ?? {}),
                fixture: true,
              },
            },
          }));
      },
    });
  }
  return sources;
}

/**
 * Per-source cache with single-flight refresh and serve-stale-on-failure.
 * Returns the contract envelope (all events; scope filtering happens later).
 */
export function createBridgeState({
  env = process.env,
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  const sources = createSources(env);
  const state = new Map(
    sources.map((s) => [
      s.id,
      {
        at: 0,
        events: null,
        lastSuccessAt: null,
        inflight: null,
        health: null,
      },
    ]),
  );

  async function refreshSource(source, signal) {
    const entry = state.get(source.id);
    const checkedAt = new Date(now()).toISOString();
    if (source.credential && !String(env[source.credential] || '').trim()) {
      entry.health = {
        source: source.id,
        status: 'UNAVAILABLE',
        checkedAt,
        lastSuccessAt: null,
        latencyMs: null,
        errorCode: 'MISSING_CREDENTIAL',
      };
      entry.events = null;
      return;
    }
    if (entry.events && source.ttlMs > 0 && now() - entry.at < source.ttlMs)
      return; // fresh cache: keep the health from that fetch
    if (!entry.inflight) {
      const started = now();
      entry.inflight = (async () => {
        try {
          const limited = limitEvents(
            await source.load({ fetchImpl, signal, now }),
          );
          entry.events = limited.events;
          entry.at = now();
          entry.lastSuccessAt = new Date(entry.at).toISOString();
          entry.health = {
            source: source.id,
            status: limited.truncated ? 'DEGRADED' : 'AVAILABLE',
            checkedAt,
            lastSuccessAt: entry.lastSuccessAt,
            latencyMs: Math.max(0, Math.round(now() - started)),
            errorCode: limited.truncated ? 'TRUNCATED' : null,
          };
        } catch (error) {
          const code =
            error?.name === 'TimeoutError'
              ? 'TIMEOUT'
              : error?.code === 'RESPONSE_TOO_LARGE'
                ? 'PAYLOAD_TOO_LARGE'
                : /^[A-Z][A-Z0-9_]{2,40}$/.test(String(error?.code ?? ''))
                  ? error.code
                  : 'FETCH_FAILED';
          // Message only — never the request URL, which may hold a key.
          console.warn(
            `[fleetintelx-bridge] ${source.id} refresh failed: ${code}`,
          );
          entry.health = {
            source: source.id,
            status: entry.events ? 'DEGRADED' : 'UNAVAILABLE',
            checkedAt,
            lastSuccessAt: entry.lastSuccessAt,
            latencyMs: Math.max(0, Math.round(now() - started)),
            errorCode: entry.events ? 'STALE_CACHE' : code,
          };
        } finally {
          entry.inflight = null;
        }
      })();
    }
    await entry.inflight;
  }

  return {
    sourceIds: sources.map((s) => s.id),
    async collect(signal) {
      await Promise.all(sources.map((s) => refreshSource(s, signal)));
      const providers = sources.map((s) => state.get(s.id).health);
      const events = sources.flatMap((s) => state.get(s.id).events ?? []);
      return buildEnvelope(providers, events, new Date(now()));
    },
    health() {
      const checkedAt = new Date(now()).toISOString();
      const providers = sources.map(
        (s) =>
          state.get(s.id).health ?? {
            source: s.id,
            status: 'UNAVAILABLE',
            checkedAt,
            lastSuccessAt: null,
            latencyMs: null,
            errorCode:
              s.credential && !String(env[s.credential] || '').trim()
                ? 'MISSING_CREDENTIAL'
                : 'NOT_YET_CHECKED',
          },
      );
      return buildEnvelope(providers, [], new Date(now()));
    },
  };
}

function tokenMatches(expected, header) {
  const match = /^Bearer\s+(.+)$/i.exec(String(header || ''));
  if (!match) return false;
  const a = Buffer.from(match[1].trim());
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseScope(searchParams) {
  const num = (k) => {
    const v = searchParams.get(k);
    if (v === null || v.trim() === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const since = searchParams.get('since');
  return {
    since: since && Number.isFinite(Date.parse(since)) ? since : undefined,
    north: num('north'),
    south: num('south'),
    east: num('east'),
    west: num('west'),
  };
}

export function createBridgeServer({ env = process.env, fetchImpl, now } = {}) {
  const host = String(env.GEV_BRIDGE_HOST || '127.0.0.1').trim();
  const token = String(env.GEV_BRIDGE_TOKEN || '').trim();
  if (!LOOPBACK.has(host) && !token) {
    throw new Error(
      'GEV_BRIDGE_TOKEN is required when GEV_BRIDGE_HOST is not a loopback address',
    );
  }
  const bridge = createBridgeState({ env, fetchImpl, now });

  const send = (res, status, body) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(JSON.stringify(body));
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://bridge.invalid');
      if (req.method !== 'GET')
        return send(res, 405, { error: 'method_not_allowed' });
      if (url.pathname !== EVENTS_PATH && url.pathname !== HEALTH_PATH)
        return send(res, 404, { error: 'not_found' });
      if (token && !tokenMatches(token, req.headers.authorization))
        return send(res, 401, { error: 'unauthorized' });
      if (url.pathname === HEALTH_PATH) return send(res, 200, bridge.health());
      const controller = new AbortController();
      req.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });
      const envelope = await bridge.collect(controller.signal);
      send(res, 200, {
        ...envelope,
        events: filterEvents(envelope.events, parseScope(url.searchParams)),
      });
    } catch {
      if (!res.headersSent) send(res, 500, { error: 'bridge_error' });
    }
  });
  return { server, host, bridge };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const { server, host, bridge } = createBridgeServer();
  const port = Number(process.env.GEV_BRIDGE_PORT || 4180);
  server.listen(port, host, () => {
    console.log(
      `[fleetintelx-bridge] listening on http://${host}:${port} sources=${bridge.sourceIds.join(',')}`,
    );
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
