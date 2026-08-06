// Мелкая математика, которой в Unity занимался Mathf.
//
// Отдельный модуль нужен ровно затем, чтобы порты остальных файлов читались
// как оригиналы: там, где в C# было Mathf.MoveTowards, здесь moveTowards —
// и сравнивать две версии можно построчно.

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * clamp01(t);
export const lerpUnclamped = (a, b, t) => a + (b - a) * t;
export const inverseLerp = (a, b, v) => (a === b ? 0 : clamp01((v - a) / (b - a)));

export function moveTowards(current, target, maxDelta) {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

/** Разница углов в градусах, приведённая к -180..180. */
export function deltaAngle(a, b) {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

/** Интерполяция углов по короткой дуге — иначе дубина на переходе через 180°
 *  прокручивалась бы через всё тело. */
export function lerpAngle(a, b, t) {
  return a + deltaAngle(a, b) * clamp01(t);
}

/** Экспоненциальное сглаживание, не зависящее от частоты кадров.
 *  Прямой аналог Lerp(a, b, Clamp01(k * dt)) при разумных dt,
 *  но не разваливающийся, когда кадр просел. */
export function damp(current, target, rate, dt) {
  return target + (current - target) * Math.exp(-rate * dt);
}

// --- Шум ---
// Заменяет Mathf.PerlinNoise. Значение-шум с плавной интерполяцией:
// для покачивания корпуса и тряски камеры этого достаточно, а честный
// градиентный Перлин здесь ничего бы не добавил, кроме кода.

function hash2(ix, iy) {
  let h = ix * 374761393 + iy * 668265263;
  h = (h ^ (h >> 13)) * 1274126177;
  h = h ^ (h >> 16);
  // >>> 0 приводит к беззнаковому: в JS битовые операции работают со знаком.
  return ((h >>> 0) % 100000) / 100000;
}

const smooth = (t) => t * t * (3 - 2 * t);

/** Гладкий шум 0..1. seed задаёт «дорожку», по x идёт время. */
export function noise(seed, x) {
  const ix = Math.floor(x);
  const fx = smooth(x - ix);
  const iy = Math.floor(seed * 977) | 0;
  return lerpUnclamped(hash2(ix, iy), hash2(ix + 1, iy), fx);
}

/** Шум -1..1 — так он используется почти везде. */
export const noiseSigned = (seed, x) => noise(seed, x) * 2 - 1;
