// In-memory live positions (phase 1). Redis can replace this later.
const positions = new Map(); // key: driver_id → { lat, lng, speed, heading, at, vehicle_id, name, fleet_number }

const MIN_MOVE_M = 12;
const STALE_MS = 5 * 60 * 1000;

function haversineM(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function etaMinutes(from, to, speedKmh = 25) {
  if (!from || !to || from.lat == null || to.lat == null) return null;
  const m = haversineM(from, to);
  const hours = m / 1000 / Math.max(speedKmh, 5);
  return Math.max(1, Math.round(hours * 60));
}

function setPosition(driverId, data) {
  const prev = positions.get(driverId);
  if (prev && data.lat != null && data.lng != null) {
    const dist = haversineM(
      { lat: prev.lat, lng: prev.lng },
      { lat: data.lat, lng: data.lng }
    );
    // Always accept first point or meaningful move or forced heartbeat
    if (!data.force && dist < MIN_MOVE_M && Date.now() - prev.at < 20000) {
      return { skipped: true, position: prev };
    }
  }
  const row = {
    driver_id: driverId,
    lat: data.lat,
    lng: data.lng,
    speed: data.speed ?? null,
    heading: data.heading ?? null,
    at: Date.now(),
    vehicle_id: data.vehicle_id ?? null,
    name: data.name ?? null,
    fleet_number: data.fleet_number ?? null,
  };
  positions.set(driverId, row);
  return { skipped: false, position: row };
}

function getAll() {
  const now = Date.now();
  const out = [];
  for (const p of positions.values()) {
    if (now - p.at > STALE_MS) continue;
    out.push({ ...p, age_s: Math.round((now - p.at) / 1000) });
  }
  return out;
}

function getByDriver(driverId) {
  const p = positions.get(driverId);
  if (!p || Date.now() - p.at > STALE_MS) return null;
  return { ...p, age_s: Math.round((Date.now() - p.at) / 1000) };
}

function getByVehicle(vehicleId) {
  for (const p of positions.values()) {
    if (p.vehicle_id === vehicleId && Date.now() - p.at <= STALE_MS) {
      return { ...p, age_s: Math.round((Date.now() - p.at) / 1000) };
    }
  }
  return null;
}

module.exports = {
  setPosition,
  getAll,
  getByDriver,
  getByVehicle,
  haversineM,
  etaMinutes,
};
