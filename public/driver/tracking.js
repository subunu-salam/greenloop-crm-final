// Live GPS tracking while on shift — loads after main app.js
(function () {
  const API = '/api/v1';
  let watchId = null;
  let lastSent = 0;
  let lastLat = null;
  let lastLng = null;

  function token() {
    return localStorage.getItem('gl_drv_token');
  }

  function distM(a, b) {
    if (a == null || b == null) return 9999;
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b - lastLat);
    const dLng = toRad(arguments[3] != null ? arguments[3] - lastLng : 0);
    // simplified: use haversine with lastLat/lastLng
    return 9999;
  }

  function haversine(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const x =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  async function send(lat, lng, speed, heading, force) {
    const t = token();
    if (!t) return;
    try {
      await fetch(API + '/driver/location', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + t,
        },
        body: JSON.stringify({ lat, lng, speed, heading, force: !!force }),
      });
      lastSent = Date.now();
      lastLat = lat;
      lastLng = lng;
    } catch {
      /* offline */
    }
  }

  function onPos(pos) {
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;
    const speed = pos.coords.speed;
    const heading = pos.coords.heading;
    const moved =
      lastLat == null || haversine(lastLat, lastLng, lat, lng) >= 15;
    const heartbeat = Date.now() - lastSent > 30000;
    if (moved || heartbeat) send(lat, lng, speed, heading, heartbeat && !moved);
  }

  function startTracking() {
    if (!navigator.geolocation || watchId != null) return;
    watchId = navigator.geolocation.watchPosition(onPos, () => {}, {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 15000,
    });
    // Initial fix
    navigator.geolocation.getCurrentPosition(
      (p) => send(p.coords.latitude, p.coords.longitude, p.coords.speed, p.coords.heading, true),
      () => {},
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }

  function stopTracking() {
    if (watchId != null && navigator.geolocation.clearWatch) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
  }

  // Hook after driver enters app
  const prevEnter = window.enterApp;
  if (typeof prevEnter === 'function') {
    window.enterApp = async function () {
      await prevEnter.apply(this, arguments);
      startTracking();
    };
  } else {
    // Poll until token exists
    const iv = setInterval(() => {
      if (token()) {
        clearInterval(iv);
        startTracking();
      }
    }, 2000);
  }

  const prevLogout = window.logout;
  if (typeof prevLogout === 'function') {
    window.logout = function () {
      stopTracking();
      return prevLogout.apply(this, arguments);
    };
  }

  window.glStartTracking = startTracking;
  window.glStopTracking = stopTracking;
})();
