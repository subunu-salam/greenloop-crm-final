// Offline transmission queue — AsyncStorage-backed, 60 s auto-retry (PRD §2.3)
import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_BASE } from './config';

const KEY = 'gl_queue';

export async function getQueue() {
  return JSON.parse((await AsyncStorage.getItem(KEY)) || '[]');
}
async function setQueue(q) {
  await AsyncStorage.setItem(KEY, JSON.stringify(q));
}

export async function transmit(p, token) {
  if (p.kind === 'complete') {
    const fd = new FormData();
    fd.append('photo', { uri: p.photoUri, name: 'proof.jpg', type: 'image/jpeg' });
    fd.append('lat', p.lat ?? '');
    fd.append('lng', p.lng ?? '');
    fd.append('client_ts', p.client_ts);
    const res = await fetch(`${API_BASE}/pickups/${p.pickupId}/complete`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd,
    });
    return res.ok || res.status === 409; // 409 = already recorded (dedupe)
  }
  const res = await fetch(`${API_BASE}/pickups/${p.pickupId}/cancel`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: p.reason, lat: p.lat, lng: p.lng }),
  });
  return res.ok || res.status === 409;
}

// Returns true if sent live, false if parked in the offline queue
export async function sendOrQueue(payload, token) {
  try {
    if (await transmit(payload, token)) return true;
    throw new Error('send failed');
  } catch {
    const q = await getQueue();
    q.push(payload);
    await setQueue(q);
    return false;
  }
}

export function startRetryLoop(getToken, onDrain) {
  return setInterval(async () => {
    const token = getToken();
    if (!token) return;
    const q = await getQueue();
    if (!q.length) return;
    const remaining = [];
    for (const p of q) {
      try { if (!(await transmit(p, token))) remaining.push(p); }
      catch { remaining.push(p); }
    }
    await setQueue(remaining);
    if (onDrain) onDrain(remaining.length);
  }, 60_000);
}
