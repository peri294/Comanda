// Sesiones del personal y freno de intentos de login. Sin dependencias de Express ni
// sockets; el freno recibe el reloj (now) para probarlo sin esperas (ver auth.test.js).
import crypto from 'node:crypto';

// Compara contraseñas en tiempo constante: un !== corta en el primer carácter distinto,
// y el tiempo de respuesta filtraría cuántos caracteres del principio son correctos.
// Se comparan hashes para que el largo distinto no corte antes (timingSafeEqual exige
// buffers del mismo tamaño).
export const passwordMatches = (input, expected) => {
  if (typeof input !== 'string') return false;
  const hash = (s) => crypto.createHash('sha256').update(s).digest();
  return crypto.timingSafeEqual(hash(input), hash(expected));
};

// Tokens de sesión por rol. No vencen solos: las tablets de cocina y mostrador quedan
// logueadas mientras el local funciona, sin cortes en pleno servicio ni contraseñas
// tipeadas a diario (que terminan en un post-it pegado a la tablet). Un token deja de
// valer cuando se hace logout, cuando el Mostrador cierra las demás sesiones (tablet
// perdida, alguien que dejó de trabajar) o al reiniciar el server, que es también lo
// que pasa al cambiar las contraseñas. Viven en memoria a propósito: guardarlos en
// disco sería un riesgo innecesario.
//
// Tope de sesiones por rol (maxPerRole): sin él, cada login sumaba una entrada para
// siempre, y en la demo (contraseñas públicas) un script podía crecer la memoria hasta
// tirar el server. Al pasarlo se revoca la sesión más vieja de ese rol; un local real
// no tiene ni cerca de 50 pantallas por rol.
export const createSessionStore = ({ maxPerRole = 50 } = {}) => {
  const sessions = new Map(); // token -> role, en orden de creación

  return {
    // Si hubo que hacer lugar, la sesión revocada deja de valer al instante; server.js
    // corta la pantalla que la usaba con expelStaleStaff.
    create(role) {
      const token = crypto.randomUUID();
      const ofRole = [...sessions].filter(([, r]) => r === role);
      if (ofRole.length >= maxPerRole) sessions.delete(ofRole[0][0]);
      sessions.set(token, role);
      return token;
    },
    // Rol de un token vigente, o null (inexistente o revocado).
    roleOf(token) {
      return (typeof token === 'string' && sessions.get(token)) || null;
    },
    revoke(token) {
      sessions.delete(token);
    },
    // Revoca todas las sesiones salvo la indicada. Devuelve cuántas revocó.
    revokeAllExcept(keepToken) {
      let revoked = 0;
      for (const token of sessions.keys()) {
        if (token !== keepToken) {
          sessions.delete(token);
          revoked++;
        }
      }
      return revoked;
    },
    get size() {
      return sessions.size;
    }
  };
};

// Clave del freno de login para una IP. Una IPv6 se agrupa por su /64: un proveedor le da
// a cada cliente un bloque /64 entero, así que sin agrupar un atacante tendría una IP
// distinta (y un contador nuevo) para cada intento. Las IPv4 mapeadas a IPv6
// (::ffff:1.2.3.4) cuentan como su IPv4.
export const throttleKeyForIp = (ip) => {
  if (typeof ip !== 'string' || ip === '') return 'unknown';
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1];
  if (!ip.includes(':')) return ip;
  // Expande "::" para tomar los primeros cuatro grupos.
  const [head, tail = ''] = ip.toLowerCase().split('%')[0].split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = ip.includes('::') && tail ? tail.split(':') : [];
  const groups = [...headGroups, ...Array(Math.max(0, 8 - headGroups.length - tailGroups.length)).fill('0'), ...tailGroups];
  return `${groups.slice(0, 4).map(g => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
};

// Freno de fuerza bruta: después de maxFailures intentos fallidos desde la misma clave
// (la IP), se rechaza todo login hasta que pasa windowMs desde el primer fallo. Antes
// se podían probar contraseñas sin límite. Un login correcto limpia el contador.
//
// Limitación: con la IP como clave, un atacante en la misma red que las tablets
// (o detrás del mismo proxy si TRUST_PROXY no está bien configurado) puede bloquear
// el login del personal por windowMs. Las sesiones ya abiertas siguen funcionando.
export const createLoginThrottle = ({ maxFailures, windowMs, now = Date.now }) => {
  const failures = new Map(); // key -> { count, firstAt }

  const current = (key) => {
    const entry = failures.get(key);
    if (entry && now() - entry.firstAt >= windowMs) {
      failures.delete(key);
      return undefined;
    }
    return entry;
  };

  return {
    // { allowed: true } o { allowed: false, retryAfterMs }
    check(key) {
      const entry = current(key);
      if (!entry || entry.count < maxFailures) return { allowed: true };
      return { allowed: false, retryAfterMs: entry.firstAt + windowMs - now() };
    },
    fail(key) {
      const entry = current(key);
      if (entry) entry.count++;
      else failures.set(key, { count: 1, firstAt: now() });
    },
    succeed(key) {
      failures.delete(key);
    },
    // Borra las ventanas vencidas, para que el Map no crezca sin límite. Antes se hacía en
    // cada fail(), y con muchas IP distintas cada intento recorría todo el Map; ahora
    // server.js la llama cada un minuto.
    sweep() {
      for (const k of failures.keys()) current(k);
    },
    get size() {
      return failures.size;
    }
  };
};
