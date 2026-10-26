// Login local (usuario y contraseña en SQLite), al estilo Portainer:
// el primer acceso crea el usuario administrador; después siempre se pide login.
import crypto from 'node:crypto';
import { db } from './db.js';
import { dockerGateway } from './security.js';

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);`);

const COOKIE = 'ap_session';
const SESSION_DAYS = 30;
const SCRYPT = { N: 16384, r: 8, p: 1 };

// ---------- Contraseñas (scrypt con sal) ----------

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, SCRYPT);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [, saltHex, hashHex] = String(stored).split('$');
  const hash = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64, SCRYPT);
  const expected = Buffer.from(hashHex, 'hex');
  return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
}

const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex')); // iguala tiempos si el usuario no existe

function validateCredentials(username, password) {
  if (!/^[a-zA-Z0-9._-]{3,40}$/.test(username || '')) throw new Error('El usuario debe tener entre 3 y 40 caracteres (letras, números, punto, guion o guion bajo).');
  if (typeof password !== 'string' || password.length < 10) throw new Error('La contraseña debe tener al menos 10 caracteres.');
  if (password.length > 200) throw new Error('La contraseña es demasiado larga.');
}

// ---------- Usuarios ----------

export const hasUsers = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;

export function createFirstUser(username, password) {
  if (hasUsers()) throw new Error('El administrador ya fue creado.');
  validateCredentials(username, password);
  const res = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hashPassword(password));
  return Number(res.lastInsertRowid);
}

export function checkLogin(username, password) {
  const row = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(String(username || ''));
  const ok = verifyPassword(String(password || ''), row ? row.password_hash : DUMMY_HASH);
  return row && ok ? row : null;
}

export function changePassword(userId, current, next, keepSessionId) {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!row || !verifyPassword(String(current || ''), row.password_hash)) throw new Error('La contraseña actual no es correcta.');
  validateCredentials(row.username, next);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), userId);
  // Cierra todas las demás sesiones abiertas con la contraseña vieja
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(userId, keepSessionId || '');
}

export const sessionId = (req) => readCookie(req);

// ---------- Sesiones ----------

function readCookie(req) {
  const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{64})`));
  return m ? m[1] : null;
}

const isHttps = (req) => req.headers['x-forwarded-proto'] === 'https' || !!req.headers['cf-connecting-ip'];

export function startSession(req, res, userId) {
  const id = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(id, userId, Date.now() + SESSION_DAYS * 86400_000);
  res.setHeader('Set-Cookie', `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${isHttps(req) ? '; Secure' : ''}`);
}

export function endSession(req, res) {
  const id = readCookie(req);
  if (id) db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isHttps(req) ? '; Secure' : ''}`);
}

export function sessionUser(req) {
  const id = readCookie(req);
  if (!id) return null;
  return db.prepare('SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?').get(id, Date.now()) || null;
}

// ---------- Freno a intentos fallidos ----------

const failures = new Map(); // ip -> { n, until }
export const clientIp = (req) => String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '');

export function loginBlocked(ip) {
  const f = failures.get(ip);
  return f && f.n >= 5 && Date.now() < f.until ? Math.ceil((f.until - Date.now()) / 60000) : 0;
}
export function registerFailure(ip) {
  const f = failures.get(ip);
  const n = f && Date.now() < f.until ? f.n + 1 : 1;
  failures.set(ip, { n, until: Date.now() + 15 * 60_000 });
}
export const clearFailures = (ip) => failures.delete(ip);

// ---------- Middleware ----------

const PUBLIC = new Set(['/login', '/login.js', '/api/auth/login', '/api/auth/setup', '/favicon.ico']);

// Pedidos hechos desde la propia Pi (curl del script de actualización): llegan por loopback o desde el host Docker
// y sin el encabezado de Cloudflare. Desde internet siempre se entra por el túnel, que agrega cf-connecting-ip.
const LOCAL = new Set(['127.0.0.1', '::1', dockerGateway()].filter(Boolean).flatMap((ip) => [ip, `::ffff:${ip}`]));
const isLocal = (req) => !req.headers['cf-connecting-ip'] && LOCAL.has(req.socket.remoteAddress);

export function authMiddleware(req, res, next) {
  if (isLocal(req)) return next();
  if (PUBLIC.has(req.path)) return next();
  const user = sessionUser(req);
  if (user) { req.user = user; return next(); }
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Tu sesión venció. Iniciá sesión de nuevo.' });
  return res.redirect('/login');
}
