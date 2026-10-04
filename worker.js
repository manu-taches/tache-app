// Serveur de rappels pour l'appli Tâche (Cloudflare Workers + KV).
// Envoie une notification à l'heure d'une tâche, puis toutes les heures tant qu'elle n'est pas cochée.
const ORIGIN = 'https://manuelbotelho37-commits.github.io';
const enc = new TextEncoder();

const b64u = buf => { const b = new Uint8Array(buf); let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const cors = (extra) => Object.assign({ 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Vary': 'Origin' }, extra || {});
const json = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: cors({ 'Content-Type': 'application/json' }) });

async function sha256hex(s) { const d = await crypto.subtle.digest('SHA-256', enc.encode(s)); return Array.from(new Uint8Array(d)).map(x => x.toString(16).padStart(2, '0')).join(''); }

async function getVapid(env) {
  const stored = await env.KV.get('vapid');
  if (stored) return JSON.parse(stored);
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = b64u(await crypto.subtle.exportKey('raw', kp.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const v = { pub, jwk };
  await env.KV.put('vapid', JSON.stringify(v));
  return v;
}
async function vapidAuth(endpoint, v) {
  const header = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:rappels@tache.invalid' })));
  const key = await crypto.subtle.importKey('jwk', v.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(header + '.' + payload));
  return 'vapid t=' + header + '.' + payload + '.' + b64u(sig) + ', k=' + v.pub;
}
async function sendPush(sub, v) {
  const res = await fetch(sub.endpoint, { method: 'POST', headers: { Authorization: await vapidAuth(sub.endpoint, v), TTL: '3600', Urgency: 'high' } });
  return res.status;
}

/* heure locale d'un fuseau */
function localParts(ms, tz) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const o = {}; f.formatToParts(new Date(ms)).forEach(p => { o[p.type] = p.value; });
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour, mi: +o.minute };
}
function zonedToMs(date, time, tz) {
  const a = date.split('-').map(Number), t = (time || '09:00').split(':').map(Number);
  const guess = Date.UTC(a[0], a[1] - 1, a[2], t[0] || 0, t[1] || 0);
  let ms = guess;
  for (let i = 0; i < 2; i++) { const p = localParts(ms, tz); ms += guess - Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi); }
  return ms;
}

/* quelles tâches doivent sonner maintenant ? */
export function pendingNow(user, now) {
  const tz = user.tz || 'Europe/Paris';
  const hour = localParts(now, tz).h;
  const inWindow = hour >= (user.from == null ? 8 : user.from) && hour < (user.to == null ? 22 : user.to);
  const last = user.last || {};
  const keep = {}; const fire = [];
  for (const t of (user.tasks || [])) {
    if (t.done || t.paused || !t.date) continue;
    const key = t.id + '|' + t.date + '|' + (t.time || '');
    if (last[key]) keep[key] = last[key];
    if (now < zonedToMs(t.date, t.time || '09:00', tz)) continue;
    if (inWindow && (!last[key] || now - last[key] >= 59 * 60000)) fire.push(key);
  }
  return { fire, keep };
}

async function tick(env, now) {
  now = now || Date.now();
  const v = await getVapid(env);
  const list = await env.KV.list({ prefix: 'u:' });
  for (const k of list.keys) {
    const raw = await env.KV.get(k.name); if (!raw) continue;
    const user = JSON.parse(raw);
    const { fire, keep } = pendingNow(user, now);
    if (!fire.length) { if (JSON.stringify(keep) !== JSON.stringify(user.last || {})) { user.last = keep; await env.KV.put(k.name, JSON.stringify(user)); } continue; }
    let status = 0;
    try { status = await sendPush(user.sub, v); } catch (e) { status = 0; }
    if (status === 404 || status === 410) { await env.KV.delete(k.name); continue; }
    if (status >= 200 && status < 300) fire.forEach(key => { keep[key] = now; });
    user.last = keep; await env.KV.put(k.name, JSON.stringify(user));
  }
}

async function handle(req, env) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
  const url = new URL(req.url);
  try {
    if (req.method === 'GET' && url.pathname === '/config') { const v = await getVapid(env); return json({ publicKey: v.pub }); }
    if (req.method === 'GET' && url.pathname === '/') return new Response('Serveur de rappels Tâche : en marche.', { headers: cors({ 'Content-Type': 'text/plain; charset=utf-8' }) });
    if (req.method === 'POST' && url.pathname === '/sync') {
      const b = await req.json();
      if (!b || !b.sub || !/^https:\/\//.test(b.sub.endpoint || '')) return json({ error: 'abonnement invalide' }, 400);
      const key = 'u:' + await sha256hex(b.sub.endpoint);
      const prev = await env.KV.get(key); const old = prev ? JSON.parse(prev) : {};
      const tasks = (Array.isArray(b.tasks) ? b.tasks : []).slice(0, 500).map(t => ({ id: String(t.id).slice(0, 40), date: String(t.date), time: String(t.time || ''), done: !!t.done, paused: !!t.paused }));
      await env.KV.put(key, JSON.stringify({ sub: b.sub, tasks, from: Math.max(0, Math.min(23, +b.from || 8)), to: Math.max(1, Math.min(24, +b.to || 22)), tz: String(b.tz || 'Europe/Paris'), last: old.last || {}, updated: Date.now() }));
      return json({ ok: true, count: tasks.length });
    }
    if (req.method === 'POST' && url.pathname === '/test') {
      const b = await req.json(); if (!b || !b.sub || !/^https:\/\//.test(b.sub.endpoint || '')) return json({ error: 'abonnement invalide' }, 400);
      const v = await getVapid(env); const status = await sendPush(b.sub, v);
      return json({ ok: status >= 200 && status < 300, status });
    }
    return json({ error: 'introuvable' }, 404);
  } catch (e) { return json({ error: 'erreur' }, 500); }
}

export default {
  fetch(req, env) { return handle(req, env); },
  scheduled(event, env, ctx) { ctx.waitUntil(tick(env)); }
};
export { tick, zonedToMs, localParts };
