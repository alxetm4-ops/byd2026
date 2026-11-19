/**
 * BYD Colombia — servidor local del tablero.
 *
 * - Sirve la PWA desde /public
 * - Expone /api/state para el tablero (datos demo o en vivo)
 * - Recibe telemetría de BYDMate en POST /api/webhook
 * - Hace de proxy para la lista de emisoras colombianas (Radio Browser)
 *
 * Sin dependencias externas: solo Node.js >= 20.
 */
import http from 'node:http';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import initSqlJs from 'sql.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '0.0.0.0';
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || '';
const DASHBOARD_USER = process.env.DASHBOARD_USER || 'byd';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || randomBytes(32).toString('hex');
const SESSION_COOKIE = 'byd_session';
const SESSION_MAX_AGE = 7 * 24 * 3600;

const require = createRequire(import.meta.url);
const SQL = await initSqlJs({
  locateFile: (file) => require.resolve(`sql.js/dist/${file}`),
});

await mkdir(DATA_DIR, { recursive: true });

/* ------------------------------------------------------------------ */
/* Configuración                                                       */
/* ------------------------------------------------------------------ */

const DEFAULT_CONFIG = {
  carName: 'BYD Yuan Plus 2026',
  capacityKwh: 60.5,
  tariffCop: 750,
  currency: 'COP',
  avgConsumption: 23.9,
  demo: true,
};

let config = { ...DEFAULT_CONFIG };
try {
  const saved = JSON.parse(await readFile(path.join(DATA_DIR, 'config.json'), 'utf8'));
  config = { ...config, ...saved };
} catch {
  /* primera ejecución */
}

async function saveConfig() {
  await writeFile(path.join(DATA_DIR, 'config.json'), JSON.stringify(config, null, 2));
}

/* Viajes y cargas importados del backup de BYDMate */
let imported = { importedAt: null, trips: [], charges: [] };
try {
  const importedRaw = JSON.parse(await readFile(path.join(DATA_DIR, 'imported.json'), 'utf8'));
  if (Array.isArray(importedRaw.trips) && Array.isArray(importedRaw.charges)) {
    imported = importedRaw;
  }
} catch {
  /* sin importación todavía */
}

async function saveImported() {
  await writeFile(path.join(DATA_DIR, 'imported.json'), JSON.stringify(imported, null, 2));
}

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type, x-webhook-token',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  });
  res.end(body);
}

/* ------------------------------------------------------------------ */
/* Sesión del tablero (formulario, no prompt Basic)                    */
/* ------------------------------------------------------------------ */

function parseCookies(req) {
  const cookies = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function signSession(payload) {
  return createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
}

function createSession(user) {
  const exp = Date.now() + SESSION_MAX_AGE * 1000;
  const payload = `${user}|${exp}`;
  return `${payload}|${signSession(payload)}`;
}

function verifySession(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('|');
  if (parts.length !== 3) return false;
  const [user, expRaw, sig] = parts;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = signSession(`${user}|${expRaw}`);
  if (sig.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

function isAuthenticated(req) {
  if (!DASHBOARD_PASSWORD) return true;
  return verifySession(parseCookies(req)[SESSION_COOKIE]);
}

function setSessionCookie(res, token, req) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_MAX_AGE}`,
  ];
  if (req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function renderLoginPage(error) {
  return `<!doctype html>
<html lang="es-CO">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Entrar · BYD Colombia</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 20px;
    background: radial-gradient(900px 480px at 15% -10%, rgba(0,209,178,.08), transparent 60%),
                radial-gradient(800px 420px at 100% 0%, rgba(59,130,246,.08), transparent 55%), #0b0f14;
    color: #e8eef7; font-family: "Segoe UI", system-ui, -apple-system, Roboto, sans-serif;
  }
  .card {
    width: min(92vw, 380px); background: linear-gradient(180deg, #16202e, #111823);
    border: 1px solid #1f2c3d; border-radius: 20px; padding: 28px;
    box-shadow: 0 24px 60px rgba(0,0,0,.45);
  }
  .logo {
    width: 52px; height: 52px; border-radius: 14px; display: grid; place-items: center;
    background: linear-gradient(145deg, #00e0bf, #00a98f); color: #04100d;
    font-weight: 800; font-size: 15px; margin-bottom: 18px;
  }
  h1 { font-size: 20px; margin: 0 0 6px; letter-spacing: .2px; }
  p { color: #8fa3bd; font-size: 13px; margin: 0 0 18px; line-height: 1.5; }
  label { display: block; font-size: 12px; color: #8fa3bd; margin: 14px 0 6px; }
  input {
    width: 100%; padding: 12px 13px; border-radius: 11px; border: 1px solid #1f2c3d;
    background: #0b0f14; color: #e8eef7; font: inherit; outline: none;
  }
  input:focus { border-color: rgba(0,209,178,.55); }
  button {
    width: 100%; margin-top: 20px; padding: 12px; border: 0; border-radius: 11px;
    background: linear-gradient(145deg, #00e0bf, #00a98f); color: #04100d;
    font-weight: 700; font-size: 14px; cursor: pointer;
  }
  button:active { transform: scale(.99); }
  .error {
    background: rgba(255,92,92,.1); border: 1px solid rgba(255,92,92,.3);
    color: #ff8f8f; font-size: 12.5px; padding: 9px 12px; border-radius: 10px; margin-bottom: 6px;
  }
  .hint { margin-top: 16px; font-size: 11.5px; color: #6f8199; text-align: center; }
</style>
</head>
<body>
<form class="card" method="post" action="/login">
  <div class="logo">BYD</div>
  <h1>Tablero del carro</h1>
  <p>Ingresa para ver la telemetría del Yuan Plus.</p>
  ${error ? '<div class="error">Usuario o contraseña incorrectos. Intenta de nuevo.</div>' : ''}
  <label for="user">Usuario</label>
  <input id="user" name="user" value="byd" autocomplete="username" autocapitalize="none" spellcheck="false">
  <label for="password">Contraseña</label>
  <input id="password" name="password" type="password" autocomplete="current-password" autofocus>
  <button type="submit">Entrar</button>
  <div class="hint">Acceso privado · BYD Colombia</div>
</form>
</body>
</html>`;
}

function renderBydMatePage() {
  return `<!doctype html>
<html lang="es-CO">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Instalar BYDMate · BYD Colombia</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100dvh; padding: 24px 16px 40px;
    background: radial-gradient(900px 480px at 15% -10%, rgba(0,209,178,.08), transparent 60%),
                radial-gradient(800px 420px at 100% 0%, rgba(59,130,246,.08), transparent 55%), #0b0f14;
    color: #e8eef7; font-family: "Segoe UI", system-ui, -apple-system, Roboto, sans-serif;
  }
  .wrap { max-width: 720px; margin: 0 auto; }
  .back { color: #8fa3bd; text-decoration: none; font-size: 13px; display: inline-block; margin-bottom: 14px; }
  .back:hover { color: #00d1b2; }
  .card {
    background: linear-gradient(180deg, #16202e, #111823); border: 1px solid #1f2c3d;
    border-radius: 20px; padding: 28px; box-shadow: 0 24px 60px rgba(0,0,0,.45);
  }
  .logo {
    width: 52px; height: 52px; border-radius: 14px; display: grid; place-items: center;
    background: linear-gradient(145deg, #00e0bf, #00a98f); color: #04100d;
    font-weight: 800; font-size: 15px; margin-bottom: 18px;
  }
  h1 { font-size: 24px; margin: 0 0 8px; letter-spacing: .2px; }
  h2 { font-size: 16px; margin: 26px 0 10px; }
  p { color: #8fa3bd; font-size: 14px; line-height: 1.6; margin: 0 0 14px; }
  ol { margin: 0 0 16px; padding-left: 22px; color: #c8d4e4; font-size: 14px; line-height: 1.8; }
  li strong { color: #e8eef7; }
  .btn {
    display: block; text-align: center; text-decoration: none; padding: 14px 18px;
    border-radius: 12px; background: linear-gradient(145deg, #00e0bf, #00a98f);
    color: #04100d; font-weight: 700; font-size: 15px; margin: 18px 0 10px;
  }
  .btn:active { transform: scale(.99); }
  .btn.secondary {
    background: transparent; border: 1px solid #1f2c3d; color: #cfe0ff; font-weight: 600;
    font-size: 13px; padding: 11px 16px; margin-top: 0;
  }
  .warn {
    background: rgba(255,176,32,.08); border: 1px solid rgba(255,176,32,.28);
    color: #ffcf7a; font-size: 13px; line-height: 1.6; padding: 13px 15px;
    border-radius: 12px; margin: 18px 0;
  }
  .hint { color: #6f8199; font-size: 12.5px; line-height: 1.6; }
</style>
</head>
<body>
<main class="wrap">
  <a class="back" href="/">← Volver al tablero</a>
  <div class="card">
    <div class="logo">BYD</div>
    <h1>Instalar BYDMate en el carro</h1>
    <p>BYDMate es la app que lee la batería, el consumo y las llantas, y envía esos datos al tablero. Es gratis y la desarrolla un programador independiente; no es de BYD.</p>

    <a class="btn" href="/bydmate/apk">Descargar BYDMate (APK)</a>
    <a class="btn secondary" href="https://github.com/AndyShaman/BYDMate/releases/latest" target="_blank" rel="noopener">Ver versiones en GitHub</a>

    <h2>Pasos para instalarlo</h2>
    <ol>
      <li>Toca <strong>Descargar BYDMate (APK)</strong> desde el navegador del carro.</li>
      <li>Cuando termine la descarga, abre el archivo y toca <strong>Instalar</strong>.</li>
      <li>Si pregunta, permite instalar apps de esta fuente.</li>
      <li>Abre BYDMate y elige <strong>English</strong>.</li>
      <li>Capacidad de batería: <strong>60.5 kWh</strong>.</li>
      <li>Si aparece <strong>“Allow ADB debugging”</strong>, marca <strong>Always allow</strong> y toca Allow.</li>
    </ol>

    <div class="warn">
      <strong>Ojo:</strong> para ver datos en vivo, el carro necesita <strong>ADB abierto</strong>.
      Sin ADB, BYDMate solo funciona como diario de viajes. Si no lo tienes, primero hay que
      abrirlo con un servicio de localización o un desbloqueo remoto.
    </div>

    <p class="hint">
      El archivo se descarga desde el GitHub oficial de BYDMate. Si el navegador del carro no
      descarga el APK, descárgalo en el PC y pásalo por USB (FAT32) al puerto de datos.
    </p>
  </div>
</main>
</body>
</html>`;
}


function renderMapsPage() {
  return `<!doctype html>
<html lang="es-CO">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mapas gratis · BYD Colombia</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100dvh; padding: 24px 16px 40px;
    background: radial-gradient(900px 480px at 15% -10%, rgba(0,229,255,.08), transparent 60%),
                radial-gradient(800px 420px at 100% 0%, rgba(124,92,255,.08), transparent 55%), #0b0f14;
    color: #e8eef7; font-family: "Segoe UI", system-ui, -apple-system, Roboto, sans-serif;
  }
  .wrap { max-width: 720px; margin: 0 auto; }
  .back { color: #8fa3bd; text-decoration: none; font-size: 13px; display: inline-block; margin-bottom: 14px; }
  .back:hover { color: #00d1b2; }
  .card {
    background: linear-gradient(180deg, #16202e, #111823); border: 1px solid #1f2c3d;
    border-radius: 20px; padding: 28px; box-shadow: 0 24px 60px rgba(0,0,0,.45);
  }
  .logo {
    width: 52px; height: 52px; border-radius: 14px; display: grid; place-items: center;
    background: linear-gradient(145deg, #00e0bf, #00a98f); color: #04100d;
    font-weight: 800; font-size: 15px; margin-bottom: 18px;
  }
  h1 { font-size: 25px; margin: 0 0 8px; letter-spacing: .2px; }
  h2 { font-size: 16px; margin: 24px 0 10px; }
  p { color: #8fa3bd; font-size: 14px; line-height: 1.6; margin: 0 0 14px; }
  ol { margin: 0 0 16px; padding-left: 22px; color: #c8d4e4; font-size: 14px; line-height: 1.8; }
  li strong { color: #e8eef7; }
  .btn {
    display: block; text-align: center; text-decoration: none; padding: 14px 18px;
    border-radius: 12px; background: linear-gradient(145deg, #00e0bf, #00a98f);
    color: #04100d; font-weight: 700; font-size: 15px; margin: 18px 0 10px;
  }
  .btn.secondary {
    background: transparent; border: 1px solid #1f2c3d; color: #cfe0ff; font-weight: 600;
    font-size: 13px; padding: 11px 16px; margin-top: 0;
  }
  .warn {
    background: rgba(255,176,32,.08); border: 1px solid rgba(255,176,32,.28);
    color: #ffcf7a; font-size: 13px; line-height: 1.6; padding: 13px 15px;
    border-radius: 12px; margin: 18px 0;
  }
  .hint { color: #6f8199; font-size: 12.5px; line-height: 1.6; }
</style>
</head>
<body>
<main class="wrap">
  <a class="back" href="/">← Volver al tablero</a>
  <div class="card">
    <div class="logo">BYD</div>
    <h1>Mapas gratis para el carro</h1>
    <p>La pantalla china no trae mapas de Colombia. La mejor opción gratuita, sin Google, sin cuenta y que funciona sin internet es <strong>Organic Maps</strong>.</p>

    <a class="btn" href="/maps/organic.apk">Descargar Organic Maps (APK)</a>
    <a class="btn secondary" href="https://github.com/organicmaps/organicmaps/releases/latest" target="_blank" rel="noopener">Ver versiones en GitHub</a>

    <h2>Pasos</h2>
    <ol>
      <li>Toca <strong>Descargar Organic Maps (APK)</strong> desde el navegador del carro.</li>
      <li>Cuando termine, abre el archivo y toca <strong>Instalar</strong>.</li>
      <li>Permite instalar apps de esta fuente.</li>
      <li>Abre Organic Maps → menú → <strong>Download maps</strong> → <strong>South America</strong> → <strong>Colombia</strong>.</li>
      <li>Descarga el mapa y úsalo sin datos. El GPS funciona aunque no tengas internet.</li>
    </ol>

    <div class="warn">
      Si el navegador del carro no descarga el APK, descárgalo en el PC y pásalo por USB (FAT32) al puerto de datos.
      Organic Maps no necesita Google Play Services.
    </div>

    <h2>Alternativas</h2>
    <p><strong>Google Maps / Waze:</strong> tienen tráfico en vivo, pero necesitan MicroG o Play Services instalados en el DiLink. Si el servicio de localización los instaló, puedes usarlos.</p>
    <p><strong>OsmAnd:</strong> también es gratis y offline, pero más pesado y complejo. Organic Maps es más simple para el carro.</p>

    <p class="hint">
      Nuestra app ya tiene un mapa de estado con OpenStreetMap para ver dónde está el carro.
      Para navegación giro a giro en Colombia, Organic Maps es la mejor opción gratuita.
    </p>
  </div>
</main>
</body>
</html>`;
}

function readBody(req, limit = 262144) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) {
        reject(new Error('payload demasiado grande'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function readBinaryBody(req, limit = 120 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('archivo demasiado grande'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ */
/* Estado de demostración                                              */
/* ------------------------------------------------------------------ */

const demo = {
  soc: 68,
  rangeKm: 278,
  speedKmh: 0,
  powerKw: 0,
  odometerKm: 12480.4,
  batteryTempC: 27.5,
  cabinTempC: 23,
  outsideTempC: 19,
  voltage12v: 12.6,
  soh: 99.1,
  tireFl: 2.4,
  tireFr: 2.4,
  tireRl: 2.4,
  tireRr: 2.4,
  charging: false,
  consumption: 14.8,
  lat: 6.2442,
  lon: -75.5812,
  climate: true,
  locked: true,
};

let tick = 0;

function simulate() {
  tick += 1;

  // Ciclo lento: casi siempre parqueado, a veces cargando, a veces en marcha.
  const phase = tick % 300;
  demo.charging = phase > 250;
  const driving = !demo.charging && phase > 40 && phase < 150;

  if (driving) {
    demo.speedKmh = clamp(38 + 22 * Math.sin(tick / 9), 5, 75);
    demo.powerKw = clamp(8 + 12 * Math.sin(tick / 6), 2, 30);
    demo.soc -= 0.018;
    if (demo.powerKw > 0) demo.consumption = clamp(demo.consumption + (Math.random() - 0.5) * 0.08, 12.5, 18.5);
  } else if (demo.charging) {
    demo.speedKmh = 0;
    demo.powerKw = -7.2;
    demo.soc += 0.06;
  } else {
    demo.speedKmh = 0;
    demo.powerKw = 0.3;
    demo.soc -= 0.0015;
  }

  if (demo.soc < 18) demo.soc = 86;
  if (demo.soc > 97) demo.soc = 97;

  demo.odometerKm += (demo.speedKmh * 3) / 3600;
  demo.rangeKm = (demo.soc / 100) * config.capacityKwh / (demo.consumption / 100);

  demo.batteryTempC = clamp(demo.batteryTempC + (Math.random() - 0.5) * 0.06, 24, 34);
  demo.cabinTempC = clamp(demo.cabinTempC + (Math.random() - 0.5) * 0.08, 20, 26);
  demo.outsideTempC = clamp(demo.outsideTempC + (Math.random() - 0.5) * 0.05, 12, 24);
  demo.voltage12v = clamp(demo.voltage12v + (Math.random() - 0.5) * 0.02, 12.2, 13.1);
  demo.tireFl = clamp(demo.tireFl + (Math.random() - 0.5) * 0.005, 2.2, 2.6);
  demo.tireFr = clamp(demo.tireFr + (Math.random() - 0.5) * 0.005, 2.2, 2.6);
  demo.tireRl = clamp(demo.tireRl + (Math.random() - 0.5) * 0.005, 2.2, 2.6);
  demo.tireRr = clamp(demo.tireRr + (Math.random() - 0.5) * 0.005, 2.2, 2.6);

  // Recorrido suave alrededor de Bogotá.
  if (driving) {
    demo.lat += Math.cos(tick / 25) * 0.00012;
    demo.lon += Math.sin(tick / 25) * 0.00012;
  }

  pushHistory(demo);
}

/* ------------------------------------------------------------------ */
/* Historial y telemetría en vivo                                      */
/* ------------------------------------------------------------------ */

const history = [];

function pushHistory(v) {
  history.push({
    t: Date.now(),
    soc: v.soc ?? null,
    powerKw: v.powerKw ?? null,
    speedKmh: v.speedKmh ?? null,
    consumption: v.consumption ?? null,
  });
  if (history.length > 240) history.shift();
}

let live = null; // { at: number, vehicle: object }
let webhookCount = 0;
const STALE_MS = 120000;

function currentMode() {
  if (live && Date.now() - live.at < STALE_MS) return 'live';
  // Si ya hubo datos reales, conservamos el último estado en vez de saltar a Demo.
  if (live) return 'stale';
  return config.demo ? 'demo' : 'stale';
}

function pickNumber(src, keys) {
  for (const key of keys) {
    const raw = src[key];
    if (raw === undefined || raw === null || raw === '') continue;
    const n = Number(String(raw).replace(',', '.'));
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function pickBool(src, keys) {
  for (const key of keys) {
    const raw = src[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw === 'boolean') return raw;
    const s = String(raw).toLowerCase();
    if (['true', '1', 'yes', 'si', 'sí', 'on', 'charging', 'active'].includes(s)) return true;
    if (['false', '0', 'no', 'off', 'idle', 'stopped'].includes(s)) return false;
  }
  return undefined;
}

function pickString(src, keys) {
  for (const key of keys) {
    const raw = src[key];
    if (raw === undefined || raw === null) continue;
    const value = String(raw).trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * Acepta payloads planos o anidados (data / vehicle / state / telemetry)
 * y varios alias de campo. Así funciona con el webhook de BYDMate y con
 * cualquier puente propio.
 */
function normalize(body) {
  const src = {};
  const sources = [body, body?.data, body?.vehicle, body?.state, body?.telemetry, body?.payload];
  for (const s of sources) {
    if (s && typeof s === 'object' && !Array.isArray(s)) Object.assign(src, s);
  }

  const base = live?.vehicle || {};
  const v = { ...base };

  const soc = pickNumber(src, ['soc', 'SOC', 'stateOfCharge', 'batteryLevel', 'batterySoc', 'bmsSoc', 'level']);
  if (soc !== undefined) v.soc = soc > 0 && soc <= 1 ? soc * 100 : soc;

  const range = pickNumber(src, ['rangeKm', 'range', 'remainingRange', 'evRange', 'batteryRange', 'autonomyKm']);
  if (range !== undefined) v.rangeKm = range;

  const speed = pickNumber(src, ['speedKmh', 'speed', 'vehicleSpeed', 'velocity']);
  if (speed !== undefined) v.speedKmh = speed;

  const power = pickNumber(src, ['powerKw', 'power', 'batteryPower', 'motorPower', 'powerKwH']);
  if (power !== undefined) v.powerKw = power;

  const odo = pickNumber(src, ['odometerKm', 'odometer', 'totalDistance', 'mileage', 'odometerValue']);
  if (odo !== undefined) v.odometerKm = odo;

  const bTemp = pickNumber(src, ['batteryTempC', 'batteryTemp', 'batteryTemperature', 'bmsTemp', 'packTemp', 'batt_temp', 'battTemp']);
  if (bTemp !== undefined) v.batteryTempC = bTemp;

  const cTemp = pickNumber(src, ['cabinTempC', 'cabinTemp', 'insideTemp', 'interiorTemp', 'cabin_temp']);
  if (cTemp !== undefined) v.cabinTempC = cTemp;

  const oTemp = pickNumber(src, ['outsideTempC', 'outsideTemp', 'ambientTemp', 'exteriorTemp', 'ext_temp', 'extTemp']);
  if (oTemp !== undefined) v.outsideTempC = oTemp;

  const v12 = pickNumber(src, ['voltage12v', 'v12', 'auxVoltage', 'lvVoltage', '12v']);
  if (v12 !== undefined) v.voltage12v = v12;

  const hvVoltage = pickNumber(src, ['hvVoltage', 'voltage', 'packVoltage', 'hv_voltage']);
  if (hvVoltage !== undefined) v.hvVoltage = hvVoltage;

  const hvCurrent = pickNumber(src, ['hvCurrent', 'current', 'packCurrent', 'hv_current']);
  if (hvCurrent !== undefined) v.hvCurrent = hvCurrent;

  const hvacSetpoint = pickNumber(src, ['hvacSetpoint', 'hvac_setpoint', 'acTemp', 'climateSetpoint']);
  if (hvacSetpoint !== undefined) v.hvacSetpoint = hvacSetpoint;

  const capacity = pickNumber(src, ['capacity', 'capacityKwh', 'nominalCapacityKwh', 'batteryCapacity']);
  if (capacity !== undefined && capacity > 10) v.capacityKwh = capacity;

  const sampleUtc = pickNumber(src, ['utc', 'timestamp', 'sampleUtc', 'time']);
  if (sampleUtc !== undefined) v.sampleUtc = sampleUtc;

  const soh = pickNumber(src, ['soh', 'SOH', 'stateOfHealth', 'batteryHealth']);
  if (soh !== undefined) v.soh = soh;

  const cons = pickNumber(src, ['consumption', 'avgConsumption', 'kwhPer100km', 'consumptionKwh100', 'averageConsumption']);
  if (cons !== undefined) v.consumption = cons;

  const tires = src.tires || src.tpms || {};
  const tireFl = pickNumber(src, ['tireFl', 'tireFrontLeft', 'tpmsFl', 'tirePressureFl', 'tyreFl', 'tire_pressure_fl']) ?? pickNumber(tires, ['fl', 'frontLeft']);
  const tireFr = pickNumber(src, ['tireFr', 'tireFrontRight', 'tpmsFr', 'tirePressureFr', 'tyreFr', 'tire_pressure_fr']) ?? pickNumber(tires, ['fr', 'frontRight']);
  const tireRl = pickNumber(src, ['tireRl', 'tireRearLeft', 'tpmsRl', 'tirePressureRl', 'tyreRl', 'tire_pressure_rl']) ?? pickNumber(tires, ['rl', 'rearLeft']);
  const tireRr = pickNumber(src, ['tireRr', 'tireRearRight', 'tpmsRr', 'tirePressureRr', 'tyreRr', 'tire_pressure_rr']) ?? pickNumber(tires, ['rr', 'rearRight']);
  if (tireFl !== undefined) v.tireFl = tireFl;
  if (tireFr !== undefined) v.tireFr = tireFr;
  if (tireRl !== undefined) v.tireRl = tireRl;
  if (tireRr !== undefined) v.tireRr = tireRr;

  const charging = pickBool(src, ['charging', 'isCharging', 'is_charging', 'chargeState', 'plugged', 'chargingActive']);
  if (charging !== undefined) v.charging = charging;

  const isDcfc = pickBool(src, ['isDcfc', 'is_dcfc', 'dcFastCharging']);
  if (isDcfc !== undefined) v.isDcfc = isDcfc;

  const kwhCharged = pickNumber(src, ['kwhCharged', 'kwh_charged', 'chargedKwh', 'sessionKwh']);
  if (kwhCharged !== undefined) v.kwhCharged = kwhCharged;

  const isParked = pickBool(src, ['isParked', 'is_parked', 'parked']);
  if (isParked !== undefined) v.isParked = isParked;

  const carModel = pickString(src, ['carModel', 'car_model', 'model']);
  if (carModel !== undefined) v.carModel = carModel;

  const climate = pickBool(src, ['climate', 'acOn', 'climateOn', 'hvac']);
  if (climate !== undefined) v.climate = climate;

  const lat = pickNumber(src, ['lat', 'latitude', 'gpsLat']) ?? pickNumber(src.location || {}, ['lat', 'latitude']);
  const lon = pickNumber(src, ['lon', 'lng', 'longitude', 'gpsLon']) ?? pickNumber(src.location || {}, ['lon', 'lng', 'longitude']);
  if (lat !== undefined && lon !== undefined) {
    v.lat = lat;
    v.lon = lon;
  }

  return v;
}

/* Viaje en curso calculado con la telemetría en vivo */
let session = null;

function updateSession(v) {
  const now = Date.now();
  if (!session) {
    session = { start: now, lastAt: now, distanceKm: 0, energyKwh: 0, points: [] };
  }
  const dtH = Math.max(0, (now - session.lastAt) / 3600000);
  if ((v.speedKmh || 0) > 0.5) {
    session.distanceKm += (v.speedKmh || 0) * dtH;
    if ((v.powerKw || 0) > 0) session.energyKwh += (v.powerKw || 0) * dtH;
  }
  if (v.lat !== undefined && v.lon !== undefined) {
    session.points.push([round(v.lat, 5), round(v.lon, 5)]);
    if (session.points.length > 600) session.points.shift();
  }
  session.lastAt = now;
}

function currentTrip() {
  if (!session || session.distanceKm < 0.05) return null;
  const consumption = session.distanceKm > 0 ? (session.energyKwh / session.distanceKm) * 100 : 0;
  return {
    start: new Date(session.start).toISOString(),
    distanceKm: round(session.distanceKm, 2),
    consumption: round(consumption, 1),
    costCop: Math.round((session.energyKwh || 0) * config.tariffCop),
    points: session.points.slice(-200),
  };
}

/* ------------------------------------------------------------------ */
/* Viajes de demostración                                              */
/* ------------------------------------------------------------------ */

const DEMO_PATHS = [
  {
    from: 'Chapinero',
    to: 'Usaquén',
    path: [
      [4.6486, -74.0624],
      [4.6552, -74.0588],
      [4.6621, -74.0541],
      [4.6702, -74.0498],
      [4.6794, -74.0452],
      [4.6901, -74.0401],
      [4.7012, -74.0355],
    ],
  },
  {
    from: 'Zona Rosa',
    to: 'Aeropuerto El Dorado',
    path: [
      [4.6672, -74.0521],
      [4.6741, -74.0612],
      [4.6824, -74.0755],
      [4.6893, -74.0921],
      [4.6951, -74.1088],
      [4.7002, -74.1244],
    ],
  },
  {
    from: 'Centro',
    to: 'Restrepo',
    path: [
      [4.5981, -74.0758],
      [4.5912, -74.0812],
      [4.5834, -74.0871],
      [4.5751, -74.0932],
      [4.5662, -74.0998],
    ],
  },
  {
    from: 'Calle 80',
    to: 'Suba',
    path: [
      [4.6811, -74.0862],
      [4.6902, -74.0815],
      [4.7011, -74.0771],
      [4.7124, -74.0732],
      [4.7243, -74.0691],
    ],
  },
];

function demoTrips() {
  const now = Date.now();
  return DEMO_PATHS.map((t, i) => {
    const distanceKm = round(6 + i * 2.7 + (i % 2) * 1.4, 1);
    const consumption = round(13.9 + i * 0.6, 1);
    return {
      id: `demo-${i}`,
      start: new Date(now - (i + 1) * 86400000 - (i + 1) * 3600000).toISOString(),
      from: t.from,
      to: t.to,
      distanceKm,
      consumption,
      costCop: Math.round((distanceKm / 100) * consumption * config.tariffCop),
      durationMin: Math.round(18 + i * 7),
      points: t.path,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Estado que consume la PWA                                           */
/* ------------------------------------------------------------------ */

function sampleTimeIso(vehicle) {
  const raw = Number(vehicle && vehicle.sampleUtc);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const ms = raw > 1e12 ? raw : raw * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * BYDMate no manda `range` ni `consumption` en el webhook (manda SOC,
 * capacidad, potencia y velocidad). Los calculamos para que el tablero
 * muestre autonomía y consumo reales.
 */
function enrichVehicle(vehicle) {
  if (!vehicle) return vehicle;
  const v = { ...vehicle };
  const capacity = Number(v.capacityKwh) > 10 ? Number(v.capacityKwh) : config.capacityKwh;

  let consumption;
  if (session && session.distanceKm > 1) {
    consumption = (session.energyKwh / session.distanceKm) * 100;
  } else {
    consumption = Number(config.avgConsumption) > 0 ? Number(config.avgConsumption) : 20;
  }

  if (Number.isFinite(consumption) && consumption > 0) {
    v.consumption = round(consumption, 1);
    if (v.soc != null) {
      v.rangeKm = round(((Number(v.soc) / 100) * capacity) / (v.consumption / 100), 0);
    }
  }

  return v;
}

function tsToIso(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n > 1e12 ? n : n * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function numOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sqlRows(db, sql) {
  const result = db.exec(sql);
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]])));
}

function mapImportedTrips(rows) {
  return rows.map((row, index) => {
    const distanceKm = numOrNull(row.distance_km) ?? 0;
    const kwh = numOrNull(row.kwh_consumed);
    let consumption = numOrNull(row.kwh_per_100km);
    if (consumption == null && kwh != null && distanceKm > 0) consumption = (kwh / distanceKm) * 100;
    return {
      id: `byd-trip-${row.id ?? index}`,
      source: 'bydmate',
      start: tsToIso(row.start_ts),
      end: tsToIso(row.end_ts),
      distanceKm: round(distanceKm, 2),
      kwh: kwh != null ? round(kwh, 2) : null,
      consumption: consumption != null ? round(consumption, 1) : null,
      costCop: kwh != null ? Math.round(kwh * config.tariffCop) : null,
      socStart: numOrNull(row.soc_start),
      socEnd: numOrNull(row.soc_end),
      avgSpeedKmh: numOrNull(row.avg_speed_kmh),
      batteryTempC: numOrNull(row.bat_temp_avg),
      outsideTempC: numOrNull(row.exterior_temp),
      odometerStartKm: numOrNull(row.odometer_start_km),
      odometerEndKm: numOrNull(row.odometer_end_km),
    };
  });
}

function mapImportedCharges(rows) {
  return rows.map((row, index) => {
    const kwh = numOrNull(row.kwh_charged);
    return {
      id: `byd-charge-${row.id ?? index}`,
      source: 'bydmate',
      start: tsToIso(row.start_ts),
      end: tsToIso(row.end_ts),
      kwh: kwh != null ? round(kwh, 2) : null,
      costCop: kwh != null ? Math.round(kwh * config.tariffCop) : null,
      socStart: numOrNull(row.soc_start),
      socEnd: numOrNull(row.soc_end),
      type: row.type || null,
      maxPowerKw: numOrNull(row.max_power_kw),
      avgPowerKw: numOrNull(row.avg_power_kw),
      status: row.status || 'COMPLETED',
      lat: numOrNull(row.lat),
      lon: numOrNull(row.lon),
      batteryTempC: numOrNull(row.bat_temp_avg),
    };
  });
}

async function importBackupZip(buffer) {
  const files = unzipSync(new Uint8Array(buffer));
  const dbName = ['bydmate.db', 'bydmate.part.db'].find((name) => files[name]);
  if (!dbName) {
    throw new Error('El ZIP no contiene bydmate.db. Exporta el backup completo desde BYDMate.');
  }

  const db = new SQL.Database(files[dbName]);
  try {
    const tables = new Set(
      sqlRows(db, "SELECT name FROM sqlite_master WHERE type='table'").map((row) => row.name)
    );
    const trips = tables.has('trips')
      ? mapImportedTrips(sqlRows(db, 'SELECT * FROM trips ORDER BY start_ts DESC LIMIT 5000'))
      : [];
    const charges = tables.has('charges')
      ? mapImportedCharges(sqlRows(db, 'SELECT * FROM charges ORDER BY start_ts DESC LIMIT 2000'))
      : [];
    if (!trips.length && !charges.length) {
      throw new Error('El backup no trae viajes ni cargas. Exporta incluyendo las tablas (Tables).');
    }
    return { trips, charges };
  } finally {
    db.close();
  }
}

function buildState() {
  const mode = currentMode();
  let vehicle = null;
  if (mode === 'live') vehicle = enrichVehicle(live.vehicle);
  else if (mode === 'demo') vehicle = { ...demo };
  else if (live) vehicle = enrichVehicle(live.vehicle);

  const importedTrips = imported.trips || [];
  const importedCharges = imported.charges || [];

  return {
    mode,
    updatedAt:
      mode === 'demo'
        ? new Date().toISOString()
        : sampleTimeIso(vehicle) || (live ? new Date(live.at).toISOString() : new Date().toISOString()),
    vehicle,
    history: history.slice(-90),
    trips: imported.importedAt ? importedTrips : mode === 'demo' ? demoTrips() : [],
    charges: importedCharges,
    importedAt: imported.importedAt,
    currentTrip: mode === 'live' ? currentTrip() : null,
    config,
    webhook: {
      count: webhookCount,
      lastAt: live ? new Date(live.at).toISOString() : null,
    },
    webhookUrl: `/api/webhook${WEBHOOK_TOKEN ? `?token=${encodeURIComponent(WEBHOOK_TOKEN)}` : ''}`,
  };
}

/* ------------------------------------------------------------------ */
/* Radio (proxy a Radio Browser)                                       */
/* ------------------------------------------------------------------ */

const FALLBACK_STATIONS = [
  { name: 'Caracol Radio', url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/CARACOL_SC', tags: 'noticias' },
  { name: 'W Radio', url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/WRADIO_SC', tags: 'noticias' },
  { name: 'La Mega', url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/LA_MEGA_SC', tags: 'pop latino' },
  { name: 'Blu Radio', url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/BLURADIO_SC', tags: 'noticias' },
  { name: 'Tropicana', url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/TROPICANA_SC', tags: 'salsa' },
  { name: 'Radioacktiva', url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/RADIOACKTIVA_SC', tags: 'rock' },
  { name: 'Olímpica', url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/OLIMPICA_SC', tags: 'vallenato' },
  { name: 'La FM', url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/LA_FM_SC', tags: 'noticias' },
];

let radioCache = { at: 0, stations: [] };

async function getStations() {
  if (radioCache.stations.length && Date.now() - radioCache.at < 3600000) return radioCache.stations;

  try {
    const res = await fetch(
      'https://de1.api.radio-browser.info/json/stations/bycountrycodeexact/CO?limit=120&order=clickcount&reverse=true&hidebroken=true',
      {
        headers: { 'User-Agent': 'BYDColombia/0.1 (tablero local)' },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!res.ok) throw new Error(`radio-browser ${res.status}`);
    const raw = await res.json();
    const stations = raw
      .filter((s) => s && s.name && s.url_resolved && !/\.m3u8(\?|$)/i.test(s.url_resolved))
      .map((s) => ({
        id: s.stationuuid,
        name: String(s.name).trim(),
        url: s.url_resolved,
        favicon: s.favicon || '',
        tags: s.tags || '',
        bitrate: s.bitrate || 0,
        codec: s.codec || '',
      }))
      .filter((s, i, arr) => arr.findIndex((x) => x.name.toLowerCase() === s.name.toLowerCase()) === i)
      .slice(0, 80);

    if (stations.length) {
      radioCache = { at: Date.now(), stations };
      return stations;
    }
  } catch (err) {
    console.warn('[radio] no se pudo consultar Radio Browser:', err.message);
  }

  if (!radioCache.stations.length) {
    radioCache = {
      at: Date.now(),
      stations: FALLBACK_STATIONS.map((s, i) => ({ id: `fallback-${i}`, favicon: '', bitrate: 0, codec: 'MP3', ...s })),
    };
  }
  return radioCache.stations;
}

/* ------------------------------------------------------------------ */
/* Descarga de BYDMate (redirige al APK oficial más reciente)          */
/* ------------------------------------------------------------------ */

let bydmateCache = { at: 0, url: '' };

async function getBydMateApkUrl() {
  if (bydmateCache.url && Date.now() - bydmateCache.at < 3600000) return bydmateCache.url;

  try {
    const res = await fetch('https://api.github.com/repos/AndyShaman/BYDMate/releases/latest', {
      headers: {
        'User-Agent': 'BYDColombia/0.1 (tablero local)',
        Accept: 'application/vnd.github+json',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    const release = await res.json();
    const asset = (release.assets || []).find((item) => item.name.toLowerCase().endsWith('.apk'));
    if (!asset) throw new Error('la versión no trae APK');
    bydmateCache = { at: Date.now(), url: asset.browser_download_url };
    return bydmateCache.url;
  } catch (err) {
    console.warn('[bydmate] no se pudo obtener el APK:', err.message);
    return 'https://github.com/AndyShaman/BYDMate/releases/latest';
  }
}

/* ------------------------------------------------------------------ */
/* Descarga de Organic Maps (mapa offline gratuito)                    */
/* ------------------------------------------------------------------ */

let organicCache = { at: 0, url: '' };

async function getOrganicMapsApkUrl() {
  if (organicCache.url && Date.now() - organicCache.at < 3600000) return organicCache.url;

  try {
    const res = await fetch('https://api.github.com/repos/organicmaps/organicmaps/releases/latest', {
      headers: {
        'User-Agent': 'BYDColombia/0.1 (tablero local)',
        Accept: 'application/vnd.github+json',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    const release = await res.json();
    const asset = (release.assets || []).find((item) => item.name.toLowerCase().endsWith('.apk'));
    if (!asset) throw new Error('la versión no trae APK');
    organicCache = { at: Date.now(), url: asset.browser_download_url };
    return organicCache.url;
  } catch (err) {
    console.warn('[organic] no se pudo obtener el APK:', err.message);
    return 'https://github.com/organicmaps/organicmaps/releases/latest';
  }
}

/* ------------------------------------------------------------------ */
/* Servidor HTTP                                                       */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(decodeURIComponent(rel)));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Prohibido');
    return;
  }

  try {
    const info = await stat(filePath);
    if (info.isDirectory()) throw new Error('directorio');
    const ext = path.extname(filePath).toLowerCase();
    const data = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('No encontrado');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'content-type, x-webhook-token',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      });
      res.end();
      return;
    }

    // Login por formulario (más compatible que el prompt Basic en celulares).
    const publica =
      pathname === '/login' ||
      pathname === '/logout' ||
      pathname === '/bydmate' ||
      pathname === '/bydmate/apk' ||
      pathname === '/maps' ||
      pathname === '/maps/organic.apk' ||
      pathname === '/api/webhook' ||
      pathname === '/api/health' ||
      pathname === '/styles.css' ||
      pathname === '/app.js' ||
      pathname === '/sw.js' ||
      pathname === '/manifest.webmanifest' ||
      pathname === '/favicon.ico' ||
      pathname.startsWith('/icons/') ||
      pathname.startsWith('/vendor/') ||
      pathname.startsWith('/assets/');

    if (!publica && !isAuthenticated(req)) {
      if (pathname.startsWith('/api/')) return sendJson(res, 401, { error: 'no autenticado' });
      res.writeHead(302, { Location: '/login' });
      res.end();
      return;
    }

    if (pathname === '/login' && req.method === 'GET') {
      if (isAuthenticated(req)) {
        res.writeHead(302, { Location: '/?v=14' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(renderLoginPage(url.searchParams.get('error') === '1'));
      return;
    }

    if (pathname === '/login' && req.method === 'POST') {
      const raw = await readBody(req);
      const form = new URLSearchParams(raw);
      const user = form.get('user') || '';
      const pass = form.get('password') || '';
      if (user === DASHBOARD_USER && pass === DASHBOARD_PASSWORD) {
        setSessionCookie(res, createSession(user), req);
        res.writeHead(302, { Location: '/?v=14' });
        res.end();
      } else {
        res.writeHead(302, { Location: '/login?error=1' });
        res.end();
      }
      return;
    }

    if (pathname === '/logout') {
      clearSessionCookie(res);
      res.writeHead(302, { Location: '/login' });
      res.end();
      return;
    }

    if (pathname === '/bydmate' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(renderBydMatePage());
      return;
    }

    if (pathname === '/bydmate/apk' && req.method === 'GET') {
      const target = await getBydMateApkUrl();
      res.writeHead(302, { Location: target, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }

    if (pathname === '/maps' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(renderMapsPage());
      return;
    }

    if (pathname === '/maps/organic.apk' && req.method === 'GET') {
      const target = await getOrganicMapsApkUrl();
      res.writeHead(302, { Location: target, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }

    if (pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, mode: currentMode(), uptime: process.uptime() });
    }

    if (pathname === '/api/state' && req.method === 'GET') {
      return sendJson(res, 200, buildState());
    }

    if (pathname === '/api/config' && req.method === 'GET') {
      return sendJson(res, 200, config);
    }

    if (pathname === '/api/config' && req.method === 'PUT') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (Number.isFinite(Number(body.capacityKwh))) config.capacityKwh = clamp(Number(body.capacityKwh), 20, 150);
      if (Number.isFinite(Number(body.tariffCop))) config.tariffCop = clamp(Number(body.tariffCop), 0, 100000);
      if (Number.isFinite(Number(body.avgConsumption))) config.avgConsumption = clamp(Number(body.avgConsumption), 5, 50);
      if (typeof body.demo === 'boolean') config.demo = body.demo;
      if (typeof body.currency === 'string' && body.currency.length <= 5) config.currency = body.currency;
      await saveConfig();
      return sendJson(res, 200, config);
    }

    if (pathname === '/api/import' && req.method === 'POST') {
      try {
        const buffer = await readBinaryBody(req);
        const result = await importBackupZip(buffer);
        imported = {
          importedAt: new Date().toISOString(),
          trips: result.trips,
          charges: result.charges,
        };
        await saveImported();
        return sendJson(res, 200, {
          ok: true,
          trips: imported.trips.length,
          charges: imported.charges.length,
          importedAt: imported.importedAt,
        });
      } catch (err) {
        console.error('[import]', err);
        return sendJson(res, 400, { error: err.message || 'No se pudo leer el backup de BYDMate.' });
      }
    }

    if (pathname === '/api/import' && req.method === 'DELETE') {
      imported = { importedAt: null, trips: [], charges: [] };
      await saveImported();
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/webhook' && req.method === 'POST') {
      if (WEBHOOK_TOKEN) {
        const token = url.searchParams.get('token') || req.headers['x-webhook-token'];
        if (token !== WEBHOOK_TOKEN) return sendJson(res, 401, { error: 'token inválido' });
      }
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return sendJson(res, 400, { error: 'JSON inválido' });
      }
      const vehicle = normalize(body);
      updateSession(vehicle);
      const enriched = enrichVehicle(vehicle);
      live = { at: Date.now(), vehicle: enriched };
      webhookCount += 1;
      pushHistory(enriched);
      writeFile(path.join(DATA_DIR, 'last-webhook.json'), JSON.stringify({ at: new Date().toISOString(), body }, null, 2)).catch(() => {});
      return sendJson(res, 200, { ok: true, campos: Object.keys(enriched).length });
    }

    if (pathname === '/api/radio' && req.method === 'GET') {
      const stations = await getStations();
      return sendJson(res, 200, { stations, source: radioCache.at === 0 ? 'fallback' : 'radio-browser' });
    }

    if (pathname.startsWith('/api/')) {
      return sendJson(res, 404, { error: 'ruta no encontrada' });
    }

    return serveStatic(req, res, pathname);
  } catch (err) {
    console.error('[server]', err);
    if (!res.headersSent) sendJson(res, 500, { error: 'error interno' });
  }
});

/* Arranque */
for (let i = 0; i < 40; i += 1) pushHistory(demo);
setInterval(simulate, 3000);

server.listen(PORT, HOST, () => {
  console.log(`BYD Colombia escuchando en http://localhost:${PORT}`);
  console.log(`Webhook BYDMate: http://<IP-de-este-PC>:${PORT}/api/webhook`);
  if (WEBHOOK_TOKEN) console.log('Webhook protegido con token.');
  else console.warn('Aviso: WEBHOOK_TOKEN vacío. Cualquiera con la URL podría enviar datos.');
  if (DASHBOARD_PASSWORD) console.log(`Tablero protegido. Usuario: ${DASHBOARD_USER} (login en /login)`);
  else console.warn('Aviso: tablero sin contraseña. Si lo publicas en internet, configura DASHBOARD_PASSWORD.');
});
