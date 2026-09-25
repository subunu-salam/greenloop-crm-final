// ─────────────────────────────────────────────────────────────
// GreenLoop Driver — native app (Expo / React Native)
// Same finite-state machine as the PWA:
// LOGIN → JOBS → JOB → (PHOTO | REASONS) → DONE → JOBS
// Zero text inputs · silent GPS + timestamp · offline queue
// ─────────────────────────────────────────────────────────────
import React, { useEffect, useRef, useState } from 'react';
import {
  SafeAreaView, View, Text, Pressable, ScrollView, StyleSheet, StatusBar,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import { API_BASE } from './src/config';
import { sendOrQueue, startRetryLoop, getQueue } from './src/queue';

const C = {
  green: '#16a34a', red: '#e11d48', amber: '#f59e0b',
  bg: '#f4f6f5', dark: '#10241f', teal: '#0f766e',
};
const STATUS_ICON = { pending: '🟡', collected: '✅', canceled: '❌', overdue: '⏰' };

export default function App() {
  const [screen, setScreen] = useState('login'); // login|jobs|job|reasons|done
  const [pin, setPin] = useState('');
  const [err, setErr] = useState(false);
  const [token, setToken] = useState(null);
  const [driver, setDriver] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [job, setJob] = useState(null);
  const [done, setDone] = useState({ icon: '✔', msg: '', bad: false });
  const [queued, setQueued] = useState(0);
  const tokenRef = useRef(null);
  tokenRef.current = token;

  // restore session + start offline retry loop
  useEffect(() => {
    (async () => {
      const t = await AsyncStorage.getItem('gl_token');
      const u = await AsyncStorage.getItem('gl_user');
      setQueued((await getQueue()).length);
      if (t && u) { setToken(t); setDriver(JSON.parse(u)); setScreen('jobs'); }
    })();
    const h = startRetryLoop(() => tokenRef.current, n => setQueued(n));
    return () => clearInterval(h);
  }, []);

  useEffect(() => { if (screen === 'jobs' && token) loadJobs(token); }, [screen, token]);

  // ── auth ───────────────────────────────────────────────────
  async function tryLogin(fullPin) {
    try {
      const res = await fetch(API_BASE + '/auth/driver-login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: fullPin }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      await AsyncStorage.setItem('gl_token', data.token);
      await AsyncStorage.setItem('gl_user', JSON.stringify(data.user));
      setToken(data.token); setDriver(data.user); setPin(''); setScreen('jobs');
    } catch {
      setPin(''); setErr(true); setTimeout(() => setErr(false), 1400);
    }
  }
  function key(n) {
    if (pin.length >= 4) return;
    const p = pin + n;
    setPin(p);
    if (p.length === 4) tryLogin(p);
  }
  async function logout() {
    await AsyncStorage.multiRemove(['gl_token', 'gl_user']);
    setToken(null); setDriver(null); setScreen('login');
  }

  // ── jobs ───────────────────────────────────────────────────
  async function loadJobs(t) {
    try {
      const res = await fetch(API_BASE + '/driver/jobs', { headers: { Authorization: 'Bearer ' + t } });
      if (res.status === 401) return logout();
      const data = await res.json();
      setJobs(data.jobs);
    } catch { /* offline — keep last list */ }
  }

  // ── telemetry ──────────────────────────────────────────────
  async function getGPS() {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return { lat: null, lng: null };
      const p = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      return { lat: p.coords.latitude, lng: p.coords.longitude };
    } catch { return { lat: null, lng: null }; }
  }

  // ── Action Alpha: photo + complete ─────────────────────────
  async function takePhoto() {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return;
    const shot = await ImagePicker.launchCameraAsync({ quality: 0.6 });
    if (shot.canceled || !job) return;
    const gps = await getGPS();
    const ok = await sendOrQueue({
      kind: 'complete', pickupId: job.id, photoUri: shot.assets[0].uri,
      lat: gps.lat, lng: gps.lng, client_ts: new Date().toISOString(),
    }, token);
    if (!ok) setQueued(q => q + 1);
    setJobs(js => js.map(x => x.id === job.id ? { ...x, status: 'collected' } : x));
    flashDone('✔', ok ? 'SENT!' : 'SAVED — WILL SEND', false);
  }

  // ── Action Beta: no pickup ─────────────────────────────────
  async function cancelJob(reason) {
    if (!job) return;
    const gps = await getGPS();
    const ok = await sendOrQueue({
      kind: 'cancel', pickupId: job.id, reason,
      lat: gps.lat, lng: gps.lng, client_ts: new Date().toISOString(),
    }, token);
    if (!ok) setQueued(q => q + 1);
    setJobs(js => js.map(x => x.id === job.id ? { ...x, status: 'canceled' } : x));
    flashDone('✖', ok ? 'REPORTED!' : 'SAVED — WILL SEND', true);
  }

  function flashDone(icon, msg, bad) {
    setDone({ icon, msg, bad });
    setScreen('done');
    setTimeout(() => setScreen('jobs'), 1400);
  }

  // ── screens ────────────────────────────────────────────────
  return (
    <SafeAreaView style={s.root}>
      <StatusBar barStyle="dark-content" />

      {screen === 'login' && (
        <View style={s.center}>
          <Text style={s.brand}>♻</Text>
          <View style={s.dots}>
            {[0, 1, 2, 3].map(i => (
              <View key={i} style={[s.dot, i < pin.length && s.dotOn]} />
            ))}
          </View>
          <View style={s.pad}>
            {[1, 2, 3, 4, 5, 6, 7, 8, 9, null, 0, 'del'].map((k, i) =>
              k === null ? <View key={i} style={s.key} /> :
              <Pressable key={i} style={({ pressed }) => [s.key, s.keyBtn, pressed && s.pressed]}
                onPress={() => (k === 'del' ? setPin(p => p.slice(0, -1)) : key(k))}>
                <Text style={[s.keyText, k === 'del' && { color: C.red }]}>{k === 'del' ? '⌫' : k}</Text>
              </Pressable>
            )}
          </View>
          <Text style={s.bigMsg}>{err ? '❌' : ' '}</Text>
        </View>
      )}

      {screen === 'jobs' && (
        <View style={{ flex: 1 }}>
          <View style={s.topbar}>
            <Text style={s.topText}>
              👷 {driver?.name?.split(' ')[0]}{driver?.vehicle ? `  ·  🚛 ${driver.vehicle.fleet_number}` : ''}
            </Text>
            <Pressable style={s.logout} onPress={logout}><Text style={{ fontSize: 18 }}>✕</Text></Pressable>
          </View>
          <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
            {jobs.length === 0 && <Text style={[s.bigMsg, { marginTop: 120 }]}>🎉{'\n'}ALL DONE</Text>}
            {jobs.map((jb, i) => {
              const active = jb.status === 'pending' || jb.status === 'overdue';
              return (
                <Pressable key={jb.id} disabled={!active}
                  onPress={() => { setJob(jb); setScreen('job'); }}
                  style={({ pressed }) => [s.jobCard,
                    { borderLeftColor: active ? C.amber : jb.status === 'collected' ? C.green : C.red },
                    !active && { opacity: 0.45 }, pressed && s.pressed]}>
                  <View style={s.num}><Text style={s.numText}>{jb.seq || i + 1}</Text></View>
                  <View style={{ flex: 1 }}>
                    <Text style={[s.jobName, jb.status === 'canceled' && { textDecorationLine: 'line-through' }]}>{jb.name}</Text>
                    <Text style={s.jobSub}>{jb.branch} · {jb.zone}</Text>
                  </View>
                  <Text style={{ fontSize: 28 }}>{STATUS_ICON[jb.status] || ''}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      )}

      {screen === 'job' && job && (
        <View style={{ flex: 1, padding: 18, gap: 14 }}>
          <Pressable style={s.back} onPress={() => setScreen('jobs')}><Text style={{ fontSize: 24 }}>←</Text></Pressable>
          <Text style={s.title}>{job.name}</Text>
          <Text style={[s.jobSub, { textAlign: 'center', marginBottom: 20 }]}>{job.branch}</Text>
          <Pressable style={({ pressed }) => [s.giant, { backgroundColor: C.green }, pressed && s.pressed]} onPress={takePhoto}>
            <Text style={{ fontSize: 44 }}>📷</Text>
            <Text style={s.giantText}>TAKE PICKUP PHOTO</Text>
          </Pressable>
          <Pressable style={({ pressed }) => [s.giant, { backgroundColor: C.red, minHeight: 110 }, pressed && s.pressed]}
            onPress={() => setScreen('reasons')}>
            <Text style={{ fontSize: 36 }}>🚫</Text>
            <Text style={[s.giantText, { fontSize: 20 }]}>NO PICKUP TODAY</Text>
          </Pressable>
        </View>
      )}

      {screen === 'reasons' && (
        <View style={{ flex: 1, padding: 18, gap: 14 }}>
          <Pressable style={s.back} onPress={() => setScreen('job')}><Text style={{ fontSize: 24 }}>←</Text></Pressable>
          <Text style={s.title}>WHY NO PICKUP?</Text>
          {[['🗑️', 'BIN EMPTY', 'BIN_EMPTY'], ['🚧', 'ACCESS BLOCKED', 'ACCESS_BLOCKED'], ['🙅', 'MANAGER SAID NO', 'MANAGER_REFUSED']]
            .map(([ic, label, code]) => (
              <Pressable key={code} style={({ pressed }) => [s.reason, pressed && s.pressed]} onPress={() => cancelJob(code)}>
                <Text style={{ fontSize: 42 }}>{ic}</Text>
                <Text style={s.reasonText}>{label}</Text>
              </Pressable>
            ))}
        </View>
      )}

      {screen === 'done' && (
        <View style={s.center}>
          <Text style={[s.doneIcon, done.bad && { color: C.red }]}>{done.icon}</Text>
          <Text style={s.bigMsg}>{done.msg}</Text>
        </View>
      )}

      {queued > 0 && (
        <View style={s.syncBanner}>
          <Text style={s.syncText}>⇪ {queued} saved offline — will send automatically</Text>
        </View>
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 },
  pressed: { transform: [{ scale: 0.96 }] },
  brand: { fontSize: 64 },
  dots: { flexDirection: 'row', gap: 16, marginVertical: 10 },
  dot: { width: 20, height: 20, borderRadius: 10, borderWidth: 3, borderColor: C.teal },
  dotOn: { backgroundColor: C.teal },
  pad: { flexDirection: 'row', flexWrap: 'wrap', width: 3 * 84 + 2 * 14, gap: 14, justifyContent: 'center' },
  key: { width: 84, height: 84 },
  keyBtn: { borderRadius: 20, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', elevation: 3, shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } },
  keyText: { fontSize: 34, fontWeight: '700', color: C.dark },
  bigMsg: { fontSize: 22, fontWeight: '700', textAlign: 'center', color: C.dark, minHeight: 30 },
  topbar: { flexDirection: 'row', alignItems: 'center', padding: 16, gap: 10 },
  topText: { fontSize: 18, fontWeight: '700', color: C.dark, flex: 1 },
  logout: { backgroundColor: '#e5e7eb', borderRadius: 12, width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  jobCard: { flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: '#fff', borderRadius: 18, padding: 18, minHeight: 84, borderLeftWidth: 10, elevation: 2, shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 5, shadowOffset: { width: 0, height: 2 } },
  num: { backgroundColor: C.teal, minWidth: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  numText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  jobName: { fontSize: 19, fontWeight: '700', color: C.dark },
  jobSub: { fontSize: 13, color: '#6b7280' },
  back: { alignSelf: 'flex-start', backgroundColor: '#e5e7eb', borderRadius: 12, paddingVertical: 8, paddingHorizontal: 20 },
  title: { fontSize: 26, fontWeight: '800', textAlign: 'center', color: C.dark, marginTop: 20 },
  giant: { width: '100%', minHeight: 150, borderRadius: 24, alignItems: 'center', justifyContent: 'center', gap: 8, elevation: 4, shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } },
  giantText: { color: '#fff', fontSize: 24, fontWeight: '800' },
  reason: { width: '100%', minHeight: 110, borderRadius: 20, backgroundColor: '#fff', flexDirection: 'row', alignItems: 'center', gap: 18, paddingHorizontal: 24, elevation: 3, shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 8, shadowOffset: { width: 0, height: 2 } },
  reasonText: { fontSize: 22, fontWeight: '800', color: C.dark },
  doneIcon: { fontSize: 110, color: C.green },
  syncBanner: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: C.amber, padding: 12 },
  syncText: { color: '#422006', fontWeight: '700', textAlign: 'center', fontSize: 15 },
});
