import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  aggregateStatus,
  cycloneToEvent,
  earthquakeSeverity,
  earthquakeToEvent,
  filterEvents,
  fireSeverity,
  fireToEvent,
  firmsConfidence,
  publicUrl,
} from '../../server/fleetintelx/contract.js';
import {
  createBridgeServer,
  createBridgeState,
} from '../../server/fleetintelx/bridge.js';

const NOW = Date.parse('2026-10-11T18:00:00Z');

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const usgsFeed = {
  features: [
    {
      id: 'ci40123456',
      geometry: { type: 'Point', coordinates: [-118.25, 34.05, 10] },
      properties: {
        mag: 4.6,
        place: '5 km N of Los Angeles',
        time: NOW - 60_000,
      },
    },
    {
      id: 'tiny1',
      geometry: { type: 'Point', coordinates: [-118, 34, 1] },
      properties: { mag: 1.2, place: 'small', time: NOW - 60_000 },
    },
  ],
};

test('earthquake normalizer keeps unknowns null and maps severity', () => {
  const event = earthquakeToEvent({
    stableId: 'ci1',
    usgsId: 'ci1',
    lat: 34,
    lon: -118,
    depthKm: null,
    mag: 5.2,
    place: null,
    time: NOW,
  });
  assert.equal(event.eventType, 'EARTHQUAKE');
  assert.equal(event.severity, 'HIGH');
  assert.equal(event.confidence, null);
  assert.equal(event.radiusMeters, null);
  assert.equal(event.normalizedPayload.delayMinutes, null);
  assert.equal(event.normalizedPayload.details.depthKm, null);
  assert.equal(
    event.sourceUrl,
    'https://earthquake.usgs.gov/earthquakes/eventpage/ci1',
  );
  assert.deepEqual([3, 4, 5, 6].map(earthquakeSeverity), [
    'LOW',
    'MEDIUM',
    'HIGH',
    'CRITICAL',
  ]);
});

test('earthquake without a timestamp is dropped, not back-filled', () => {
  assert.equal(
    earthquakeToEvent({
      stableId: 'x',
      usgsId: 'x',
      lat: 1,
      lon: 1,
      mag: 5,
      time: null,
    }),
    null,
  );
});

test('fire normalizer: unmeasured FRP is INFO, categorical confidence stays null', () => {
  const event = fireToEvent({
    lat: 38.5,
    lon: -121.4,
    frp: 0,
    confidence: 'n',
    acqDate: '2026-10-11',
    acqTime: '930',
    satellite: 'N20',
    instrument: 'VIIRS',
    daynight: 'D',
  });
  assert.equal(event.severity, 'INFO');
  assert.equal(event.confidence, null);
  assert.equal(event.normalizedPayload.details.frpMw, null);
  assert.equal(event.observedAt, '2026-10-11T09:30:00.000Z');
  assert.equal(
    event.sourceUrl,
    null,
    'FIRMS URLs embed the key and are never exposed',
  );
  assert.equal(firmsConfidence('85'), 0.85);
  assert.equal(firmsConfidence('h'), null);
  assert.deepEqual([0, 5, 20, 100].map(fireSeverity), [
    'INFO',
    'LOW',
    'MEDIUM',
    'HIGH',
  ]);
  assert.equal(
    fireToEvent({
      lat: 1,
      lon: 1,
      frp: 50,
      confidence: 'l',
      acqDate: '2026-10-11',
      acqTime: '1',
    }),
    null,
  );
});

test('cyclone normalizer maps wind to severity and keeps the advisory link', () => {
  const event = cycloneToEvent({
    id: 'al052026',
    name: 'Ernesto',
    classification: 'HU',
    basin: 'AL',
    position: { latitude: 25.1, longitude: -80.2 },
    positionAt: '2026-10-11T15:00:00.000Z',
    advisoryNumber: '12',
    windKt: 100,
    pressureHpa: 960,
    movement: { directionDegrees: 315, speedKt: 12 },
    advisoryUrl: 'https://www.nhc.noaa.gov/text/MIATCPAT5.shtml',
  });
  assert.equal(event.eventType, 'NATURAL_HAZARD');
  assert.equal(event.severity, 'CRITICAL');
  assert.equal(
    event.sourceUrl,
    'https://www.nhc.noaa.gov/text/MIATCPAT5.shtml',
  );
  assert.equal(event.confidence, null);
});

test('publicUrl strips credentials and secret query keys', () => {
  assert.equal(
    publicUrl(
      'https://u:p@x.example.com/a?map_key=SECRET&api_key=S2&ok=1#frag',
    ),
    'https://x.example.com/a?ok=1',
  );
  assert.equal(publicUrl('ftp://x.example.com'), null);
});

test('aggregate status never reports healthy when a source is missing', () => {
  const s = (status) => ({ status });
  assert.equal(aggregateStatus([]), 'UNAVAILABLE');
  assert.equal(aggregateStatus([s('AVAILABLE'), s('AVAILABLE')]), 'AVAILABLE');
  assert.equal(aggregateStatus([s('AVAILABLE'), s('UNAVAILABLE')]), 'DEGRADED');
  assert.equal(
    aggregateStatus([s('UNAVAILABLE'), s('UNAVAILABLE')]),
    'UNAVAILABLE',
  );
});

test('filterEvents applies since and bbox', () => {
  const e = (lat, lng, observedAt) => ({ location: { lat, lng }, observedAt });
  const events = [
    e(34, -118, '2026-10-11T10:00:00Z'),
    e(51, 0, '2026-10-11T17:00:00Z'),
  ];
  assert.equal(
    filterEvents(events, { north: 40, south: 30, east: -110, west: -120 })
      .length,
    1,
  );
  assert.equal(
    filterEvents(events, { since: '2026-10-11T12:00:00Z' }).length,
    1,
  );
});

test('missing FIRMS credential is UNAVAILABLE with no events; keyless sources still work', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes('earthquake.usgs.gov'))
      return jsonResponse(usgsFeed);
    if (String(url).includes('nhc.noaa.gov'))
      return jsonResponse({ activeStorms: [] });
    throw new Error('unexpected upstream');
  };
  const bridge = createBridgeState({ env: {}, fetchImpl, now: () => NOW });
  const envelope = await bridge.collect();
  const byId = Object.fromEntries(envelope.providers.map((p) => [p.source, p]));
  assert.equal(byId['nasa-firms'].status, 'UNAVAILABLE');
  assert.equal(byId['nasa-firms'].errorCode, 'MISSING_CREDENTIAL');
  assert.equal(byId['usgs-earthquakes'].status, 'AVAILABLE');
  assert.equal(byId['nhc-cyclones'].status, 'AVAILABLE');
  assert.equal(envelope.providerStatus, 'DEGRADED');
  assert.equal(envelope.events.length, 1, 'only the M2.5+ quake');
  assert.equal(envelope.events[0].source, 'usgs-earthquakes');
  assert.ok(
    !calls.some((u) => u.includes('firms')),
    'FIRMS never called without a key',
  );
});

test('upstream failure without cache is UNAVAILABLE; with cache it serves stale as DEGRADED', async () => {
  let fail = false;
  let clock = NOW;
  const fetchImpl = async (url) => {
    if (fail) throw new Error('network down');
    if (String(url).includes('earthquake.usgs.gov'))
      return jsonResponse(usgsFeed);
    return jsonResponse({ activeStorms: [] });
  };
  const bridge = createBridgeState({ env: {}, fetchImpl, now: () => clock });
  await bridge.collect();
  fail = true;
  clock += 60 * 60_000; // past every TTL
  const envelope = await bridge.collect();
  const usgs = envelope.providers.find((p) => p.source === 'usgs-earthquakes');
  assert.equal(usgs.status, 'DEGRADED');
  assert.equal(usgs.errorCode, 'STALE_CACHE');
  assert.equal(envelope.events.length, 1);

  const cold = createBridgeState({ env: {}, fetchImpl, now: () => clock });
  const coldEnvelope = await cold.collect();
  for (const id of ['usgs-earthquakes', 'nhc-cyclones']) {
    const p = coldEnvelope.providers.find((x) => x.source === id);
    assert.equal(p.status, 'UNAVAILABLE');
    assert.equal(
      p.errorCode,
      'FETCH_FAILED',
      `${id}: a network failure is not a parse failure`,
    );
  }
  assert.equal(coldEnvelope.events.length, 0);
  assert.equal(coldEnvelope.providerStatus, 'UNAVAILABLE');
});

test('the FIRMS key never appears in output even when the upstream fails', async () => {
  const key = 'FIRMS-SECRET-KEY-123';
  const fetchImpl = async (url) => {
    if (String(url).includes('firms'))
      return new Response('bad', { status: 500 });
    if (String(url).includes('earthquake.usgs.gov'))
      return jsonResponse(usgsFeed);
    return jsonResponse({ activeStorms: [] });
  };
  const bridge = createBridgeState({
    env: { FIRMS_MAP_KEY: key },
    fetchImpl,
    now: () => NOW,
  });
  const envelope = await bridge.collect();
  assert.ok(!JSON.stringify(envelope).includes(key));
  const firms = envelope.providers.find((p) => p.source === 'nasa-firms');
  assert.equal(firms.status, 'UNAVAILABLE');
  assert.equal(firms.errorCode, 'HTTP_500');
});

test('dev fixture source is refused in production', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gev-fixture-'));
  try {
    const file = path.join(dir, 'fixture.json');
    await writeFile(file, JSON.stringify({ events: [] }));
    const dev = createBridgeState({
      env: { GEV_BRIDGE_DEV_FIXTURES_FILE: file },
      fetchImpl: async () => jsonResponse({}),
    });
    const prod = createBridgeState({
      env: { GEV_BRIDGE_DEV_FIXTURES_FILE: file, NODE_ENV: 'production' },
      fetchImpl: async () => jsonResponse({}),
    });
    assert.ok(dev.sourceIds.includes('dev-fixture'));
    assert.ok(!prod.sourceIds.includes('dev-fixture'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('server: requires a token off loopback, enforces it when set, serves only GET contract paths', async () => {
  assert.throws(
    () => createBridgeServer({ env: { GEV_BRIDGE_HOST: '0.0.0.0' } }),
    /GEV_BRIDGE_TOKEN/,
  );
  const fetchImpl = async (url) =>
    String(url).includes('earthquake.usgs.gov')
      ? jsonResponse(usgsFeed)
      : jsonResponse({ activeStorms: [] });
  const { server } = createBridgeServer({
    env: { GEV_BRIDGE_TOKEN: 'bridge-test-token' },
    fetchImpl,
    now: () => NOW,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(
      (await fetch(`${base}/api/v1/live-intelligence/events`)).status,
      401,
    );
    const auth = { authorization: 'Bearer bridge-test-token' };
    const res = await fetch(
      `${base}/api/v1/live-intelligence/events?north=40&south=30&east=-110&west=-120`,
      { headers: auth },
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    const body = await res.json();
    assert.equal(body.contractVersion, 1);
    assert.equal(body.events.length, 1);
    const health = await (
      await fetch(`${base}/api/v1/live-intelligence/health`, { headers: auth })
    ).json();
    assert.deepEqual(health.events, []);
    assert.equal(
      (await fetch(`${base}/api/v1/other`, { headers: auth })).status,
      404,
    );
    assert.equal(
      (
        await fetch(`${base}/api/v1/live-intelligence/events`, {
          method: 'POST',
          headers: auth,
        })
      ).status,
      405,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
