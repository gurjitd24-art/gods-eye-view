/**
 * FleetIntelX bridge contract (v1) — normalizers from God's Eye provider
 * records to the event shape FleetIntelX ingests.
 *
 * Contract owner: FleetIntelX
 *   packages/shared/src/entities/live-intelligence.ts (GodsEyeBridge*Schema)
 *   backend/api/src/live-intelligence/gods-eye-http.ts (adapter)
 *
 * Rules carried from FleetIntelX:
 * - unknown stays unknown: a missing confidence/radius/delay is null, never
 *   0, never a neutral guess;
 * - a record without a trustworthy timestamp or position is dropped, not
 *   back-filled;
 * - no credential (API key, token, signed URL) may appear in any field;
 * - provider status is AVAILABLE | DEGRADED | UNAVAILABLE only.
 */

import { acquisitionMsUtc } from '../../src/data/firmsCsv.js';

export const CONTRACT_VERSION = 1;
export const EVENTS_PATH = '/api/v1/live-intelligence/events';
export const HEALTH_PATH = '/api/v1/live-intelligence/health';

const SENSITIVE_QUERY_KEY =
  /^(?:token|access_token|id_token|api_?key|apikey|key|secret|client_secret|signature|sig|auth|authorization|credentials?|password|map_key|jwt|sas|x-amz-.*|x-goog-.*)$/i;

/** A public http(s) URL without userinfo, fragment or secret query params; else null. */
export function publicUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 2000) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  url.username = '';
  url.password = '';
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_QUERY_KEY.test(key)) url.searchParams.delete(key);
  }
  return url.toString();
}

const finite = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const validLatLng = (lat, lng) =>
  finite(lat) !== null &&
  finite(lng) !== null &&
  Math.abs(lat) <= 90 &&
  Math.abs(lng) <= 180;
const iso = (ms) =>
  Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
const clip = (text, max) =>
  typeof text === 'string' && text.length > max ? text.slice(0, max) : text;

// ---------------------------------------------------------------------------
// USGS earthquakes (rows from src/layers/earthquakes/records.js)
// ---------------------------------------------------------------------------

export function earthquakeSeverity(mag) {
  if (mag >= 6) return 'CRITICAL';
  if (mag >= 5) return 'HIGH';
  if (mag >= 4) return 'MEDIUM';
  return 'LOW';
}

export function earthquakeToEvent(row) {
  if (!row || !validLatLng(row.lat, row.lon) || finite(row.mag) === null)
    return null;
  const observedAt = iso(row.time);
  if (!observedAt) return null; // no trustworthy time → not an event
  const id = typeof row.usgsId === 'string' ? row.usgsId : null;
  const safeId = id && /^[a-z0-9]{2,40}$/i.test(id) ? id : null;
  return {
    source: 'usgs-earthquakes',
    sourceEventId: safeId ?? `${row.stableId}`.slice(0, 200),
    eventType: 'EARTHQUAKE',
    observedAt,
    expiresAt: null,
    location: { lat: row.lat, lng: row.lon },
    radiusMeters: null,
    severity: earthquakeSeverity(row.mag),
    confidence: null,
    sourceUrl: safeId
      ? `https://earthquake.usgs.gov/earthquakes/eventpage/${safeId}`
      : null,
    rawEvidenceReference: safeId ? `usgs:${safeId}` : null,
    normalizedPayload: {
      title: clip(
        `M${row.mag.toFixed(1)} earthquake${row.place ? ` - ${row.place}` : ''}`,
        240,
      ),
      description: null,
      delayMinutes: null,
      additionalMiles: null,
      roadClosed: null,
      details: { magnitude: row.mag, depthKm: finite(row.depthKm) },
    },
  };
}

// ---------------------------------------------------------------------------
// NASA FIRMS active fires (records from src/data/firmsCsv.js)
// ---------------------------------------------------------------------------

/**
 * FIRMS fire radiative power (MW). parseFirmsCsv turns a missing FRP into 0,
 * so 0 is treated as "not measured" and gets the lowest severity, INFO.
 */
export function fireSeverity(frp) {
  if (!(frp > 0)) return 'INFO';
  if (frp >= 100) return 'HIGH';
  if (frp >= 20) return 'MEDIUM';
  return 'LOW';
}

/** MODIS numeric 0-100 confidence maps to 0-1; VIIRS l/n/h stays null (categorical). */
export function firmsConfidence(raw) {
  const text = String(raw ?? '').trim();
  if (/^\d{1,3}$/.test(text)) {
    const n = Number(text);
    return n >= 0 && n <= 100 ? n / 100 : null;
  }
  return null;
}

export function fireToEvent(record) {
  if (!record || !validLatLng(record.lat, record.lon)) return null;
  const observedAt = iso(acquisitionMsUtc(record.acqDate, record.acqTime));
  if (!observedAt) return null;
  const category = String(record.confidence ?? '')
    .trim()
    .toLowerCase();
  if (category === 'l' || category === 'low') return null; // low-confidence pixels are noise for freight
  const sat = String(record.satellite ?? 'x').replace(/[^A-Za-z0-9-]/g, '');
  const sourceEventId =
    `${sat}:${record.acqDate}:${record.acqTime}:${record.lat.toFixed(4)},${record.lon.toFixed(4)}`.slice(
      0,
      200,
    );
  return {
    source: 'nasa-firms',
    sourceEventId,
    eventType: 'FIRE',
    observedAt,
    expiresAt: null,
    location: { lat: record.lat, lng: record.lon },
    radiusMeters: null,
    severity: fireSeverity(record.frp),
    confidence: firmsConfidence(record.confidence),
    // The FIRMS API URL embeds the MAP_KEY, so no upstream URL is exposed.
    sourceUrl: null,
    rawEvidenceReference: `firms:${sourceEventId}`,
    normalizedPayload: {
      title: 'Satellite active-fire detection',
      description: null,
      delayMinutes: null,
      additionalMiles: null,
      roadClosed: null,
      details: {
        frpMw: record.frp > 0 ? record.frp : null,
        firmsConfidence: category || null,
        satellite: sat || null,
        instrument:
          typeof record.instrument === 'string' ? record.instrument : null,
        daynight: typeof record.daynight === 'string' ? record.daynight : null,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// NHC tropical cyclones (storms from server/providers/cyclones.js)
// ---------------------------------------------------------------------------

export function cycloneSeverity(classification, windKt) {
  if (finite(windKt) !== null) {
    if (windKt >= 96) return 'CRITICAL';
    if (windKt >= 64) return 'HIGH';
    if (windKt >= 34) return 'MEDIUM';
    return 'LOW';
  }
  const c = String(classification ?? '').toUpperCase();
  if (c === 'HU' || c === 'MH') return 'HIGH';
  if (c === 'TS' || c === 'STS') return 'MEDIUM';
  return 'LOW';
}

export function cycloneToEvent(storm) {
  const lat = storm?.position?.latitude;
  const lng = storm?.position?.longitude;
  if (!storm || !validLatLng(lat, lng) || typeof storm.positionAt !== 'string')
    return null;
  return {
    source: 'nhc-cyclones',
    // One record per advisory position: a newer advisory supersedes it.
    sourceEventId: String(storm.id).slice(0, 200),
    eventType: 'NATURAL_HAZARD',
    observedAt: storm.positionAt,
    expiresAt: null,
    location: { lat, lng },
    radiusMeters: null,
    severity: cycloneSeverity(storm.classification, storm.windKt),
    confidence: null,
    sourceUrl: publicUrl(storm.advisoryUrl),
    rawEvidenceReference: `nhc:${storm.id}:${storm.advisoryNumber}`,
    normalizedPayload: {
      title: clip(`${storm.classification} ${storm.name}`, 240),
      description: null,
      delayMinutes: null,
      additionalMiles: null,
      roadClosed: null,
      details: {
        windKt: finite(storm.windKt),
        pressureHpa: finite(storm.pressureHpa),
        basin: storm.basin ?? null,
        advisoryNumber: storm.advisoryNumber ?? null,
        movementDirectionDegrees: finite(storm.movement?.directionDegrees),
        movementSpeedKt: finite(storm.movement?.speedKt),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/** AVAILABLE only when every source is; UNAVAILABLE only when none can answer. */
export function aggregateStatus(providers) {
  if (!providers.length) return 'UNAVAILABLE';
  if (providers.every((p) => p.status === 'AVAILABLE')) return 'AVAILABLE';
  if (providers.every((p) => p.status === 'UNAVAILABLE')) return 'UNAVAILABLE';
  return 'DEGRADED';
}

/** Optional scope filter (bbox + since) applied at serve time. */
export function filterEvents(events, scope) {
  const { since, north, south, east, west } = scope;
  const sinceMs = since ? Date.parse(since) : NaN;
  const bbox = [north, south, east, west].every((n) => Number.isFinite(n));
  return events.filter((e) => {
    if (Number.isFinite(sinceMs) && Date.parse(e.observedAt) < sinceMs)
      return false;
    if (!bbox) return true;
    const { lat, lng } = e.location;
    if (lat > north || lat < south) return false;
    return west <= east
      ? lng >= west && lng <= east
      : lng >= west || lng <= east;
  });
}

export function buildEnvelope(providers, events, now = new Date()) {
  return {
    contractVersion: CONTRACT_VERSION,
    providerStatus: aggregateStatus(providers),
    checkedAt: now.toISOString(),
    providers,
    events,
  };
}
