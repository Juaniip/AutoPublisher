// Encabezados de seguridad y protección contra pedidos de otros sitios (CSRF).
import fs from 'node:fs';

const isHttps = (req) => req.headers['x-forwarded-proto'] === 'https' || !!req.headers['cf-connecting-ip'];

// CSP: solo código propio, más lo que necesita la ventana de Google Drive (Picker) y las miniaturas de YouTube
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://apis.google.com https://*.gstatic.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  "media-src 'self' blob:",
  "connect-src 'self' https://*.googleapis.com https://*.google.com",
  'frame-src https://docs.google.com https://*.google.com',
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

export function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
}

// Cualquier pedido que cambia algo (POST/PUT/PATCH/DELETE) tiene que venir del propio panel
export function sameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin || req.headers.referer;
  if (!origin) return next(); // curl/script local (sin navegador): lo controla el login
  try {
    if (new URL(origin).host === req.headers.host) return next();
  } catch { /* origen inválido */ }
  return res.status(403).json({ error: 'Pedido bloqueado: no viene del panel de AutoPublisher.' });
}

// IP del host Docker (gateway), para reconocer los pedidos que se hacen desde la propia Pi
export function dockerGateway() {
  try {
    const line = fs.readFileSync('/proc/net/route', 'utf8').split('\n').find((l) => l.split('\t')[1] === '00000000');
    const hex = line.split('\t')[2];
    return [3, 2, 1, 0].map((i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16)).join('.');
  } catch {
    return null;
  }
}
