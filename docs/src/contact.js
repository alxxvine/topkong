import * as THREE from 'three';
import { tuning as T } from 'tk/tuning.js';
import { P } from 'tk/body.js';
import { clamp, lerp } from 'tk/mathx.js';

// Бойцы наконец занимают место.
//
// До сих пор тела проходили друг сквозь друга насквозь, и «невидимая стена»,
// в которую упирались соперники, была ровно этим: стены не было вовсе.
// Бот держит дистанцию сам (bot.js), и со стороны это читалось как упор
// в пустоту — подходит, останавливается, дальше не идёт.
//
// Правил здесь три, и они разные не для красоты, а потому что стоящий
// и лежащий — разные препятствия:
//
//   стоящий ↔ стоящий   расталкиваются и обмениваются ходом. Отсюда толчок
//                       плечом: идёшь в соперника — двигаешь его перед собой,
//                       и до кромки доводится телом, без всякого оружия.
//   стоящий → лежачий   НЕ упирается. Тряпку он катит перед собой: подошёл,
//                       поддел, спихнул. Будь тут стена, лежачий превратился
//                       бы в столб посреди арены — а жаловались как раз
//                       на невозможность через него пройти.
//   лежачий ↔ лежачий   ничего. Две тряпки, которые толкают друг друга,
//                       умеют только дрожать вдвоём.
//
// Считается это ДО тика бойцов: тик ставит таз туда, куда указывает корень,
// и правку положения обязан увидеть он, а не следующий кадр.

const _n = new THREE.Vector3();

export function resolveContacts(fighters, dt) {
  for (let i = 0; i < fighters.length; i++) {
    for (let j = i + 1; j < fighters.length; j++) {
      pair(fighters[i], fighters[j], dt);
    }
  }
}

/** Лежачий ли: тот же порог, по которому боец теряет управление. */
function isDown(f) {
  return f.body.strength < T.controlStrength;
}

function pair(a, b, dt) {
  if (!a.alive || !b.alive) return;
  const aDown = isDown(a);
  const bDown = isDown(b);
  if (aDown && bDown) return;
  if (aDown) return roll(b, a, dt);
  if (bDown) return roll(a, b, dt);
  block(a, b, dt);
}

/**
 * Двое на ногах: расталкивание плюс обмен ходом вдоль нормали.
 *
 * Обмен именно неупругий, к общей скорости. Упругий отскок читался бы
 * бильярдом, а нужно противоположное: боец, который идёт вперёд, ДАВИТ,
 * и соперник едет перед ним ровно пока тот идёт. Ручка shoveTransfer —
 * доля этого обмена: на нуле тела просто не проходят сквозь друг друга.
 */
/**
 * Напор: жертву ВЕЗУТ быстрее, чем она сама хочет ехать.
 *
 * Именно так отличается таран от совместного бега. Скорость бойца вдоль
 * линии от соперника сравнивается с его же ЗАКАЗАННОЙ скоростью в ту же
 * сторону: кто бежит сам — тому ничего, кого везут против воли — тот
 * расшатывается. Ниже порога скорости напор не считается вовсе, поэтому
 * подпереть соперника плечом можно, а уронить шагом — нет.
 *
 * Дошедшая до предела расшатка отпускает мышцы: боец падает ПО ХОДУ
 * тарана. Это и есть «таранить до конца».
 */
function ramPressure(f, attacker, nx, nz, dt) {
  const l = f.locomotion;
  const v = l.velX * nx + l.velZ * nz;
  const want = Math.max(0, l.wantX * nx + l.wantZ * nz);
  const press = v - want - T.shoveStaggerAt;
  if (press <= 0) return;
  f.stagger = Math.min(1, f.stagger + press * T.shoveStaggerRate * dt);
  // Куда валит — запоминается для позы: жертва наклоняется ТУДА, куда
  // её толкают, и падает уже из наклона, а не из ровной стойки.
  const k = Math.min(1, 10 * dt);
  f.staggerDirX += (nx - f.staggerDirX) * k;
  f.staggerDirZ += (nz - f.staggerDirZ) * k;
  if (f.stagger >= 1) {
    // Толчок скромный. Тело к этому моменту уже наклонено по ходу тарана,
    // и ему достаточно отпустить мышцы: большой импульс читался
    // «отлетел», а нужен «подкосился».
    _n.set(nx * T.shoveTopple, T.shoveTopple * 0.35, nz * T.shoveTopple);
    f.takeHit(_n, dt);
    f.credit(attacker);
    f.stagger = 0;
  }
}

function block(a, b, dt) {
  const r = T.bodyRadius;
  let dx = b.position.x - a.position.x;
  let dz = b.position.z - a.position.z;
  let d = Math.hypot(dx, dz);
  const gap = r * 2;
  if (d >= gap) return;

  // Ровно друг в друге — расталкиваем в любую сторону, лишь бы разошлись.
  if (d < 1e-4) { dx = 1; dz = 0; d = 1; }
  const nx = dx / d;
  const nz = dz / d;
  const half = (gap - d) * 0.5;

  a.position.x -= nx * half;
  a.position.z -= nz * half;
  b.position.x += nx * half;
  b.position.z += nz * half;

  const la = a.locomotion;
  const lb = b.locomotion;
  const va = la.velX * nx + la.velZ * nz;
  const vb = lb.velX * nx + lb.velZ * nz;
  // Расходятся — цепляться не за что.
  if (va - vb <= 0) return;

  const shared = (va + vb) * 0.5;
  const ta = lerp(va, shared, T.shoveTransfer) - va;
  const tb = lerp(vb, shared, T.shoveTransfer) - vb;
  la.velX += nx * ta;
  la.velZ += nz * ta;
  lb.velX += nx * tb;
  lb.velZ += nz * tb;

  // После обмена оба едут почти вместе — и у каждого проверяется,
  // не везут ли его. Нормаль у каждого своя: «от соперника».
  ramPressure(a, b, -nx, -nz, dt);
  ramPressure(b, a, nx, nz, dt);

  // Задевание вскользь — реакция ТЕЛОМ, а не невидимым полем.
  //
  // Когда один проходит мимо и цепляет другого плечом, у столкновения
  // есть КАСАТЕЛЬНАЯ составляющая — скольжение контакта вбок. Она
  // проворачивает обоих вокруг точки касания (задетый стоя доворачивается
  // за проходящим) и коротко качает задетого. Ровно так читается
  // «задели плечом»: не стена, а человек, которого крутануло.
  const tx = -nz;
  const tz = nx;
  const relT = (la.velX - lb.velX) * tx + (la.velZ - lb.velZ) * tz;
  if (Math.abs(relT) > 0.15) {
    const spin = relT * T.grazeSpin * dt;
    a.yaw += spin;
    b.yaw += spin;
    // Корневой доворот контроллер взгляда выправит за доли секунды — и это
    // правильно, «пошатнулся и вернулся». А вот СКРУТ ПЛЕЧ живёт в позе:
    // плечи крутануло за проходящим, и они сами отыгрывают обратно.
    const jolt = relT * T.grazeTwist * dt;
    if (a.poseDriver) a.poseDriver.grazeJolt = clamp(a.poseDriver.grazeJolt + jolt, -40, 40);
    if (b.poseDriver) b.poseDriver.grazeJolt = clamp(b.poseDriver.grazeJolt + jolt, -40, 40);
    // Лёгкая встряска задетому — тому, кто движется МЕДЛЕННЕЕ: его качнуло.
    // Потолок ниже падения: от задевания шатает, но не роняет.
    const slower = Math.hypot(la.velX, la.velZ) < Math.hypot(lb.velX, lb.velZ) ? a : b;
    if (slower.stagger < 0.35) {
      slower.stagger = Math.min(0.35, slower.stagger + Math.abs(relT) * 0.6 * dt);
      const sn = slower === a ? -1 : 1;
      const k = Math.min(1, 10 * dt);
      slower.staggerDirX += (sn * nx - slower.staggerDirX) * k;
      slower.staggerDirZ += (sn * nz - slower.staggerDirZ) * k;
    }
  }

  // Обоюдного износа в клинче НЕТ, и это решение по игре, а не пропуск.
  // Пробовал: упор, в котором оба давят навстречу, изматывал обоих
  // поровну — и оба падали в один момент. Выглядело абсурдом: падать
  // должен только тот, кого везут, а лоб в лоб — честный тупик. Выход
  // из него — зайти сбоку, и боты так и делают.
}

/**
 * Стоящий катит лежачего.
 *
 * Толкается не таз, а ТА ЧАСТЬ ТЕЛА, до которой достали: наехал на ноги —
 * развернуло ноги. Иначе лежачий ездил бы плашмя, как коробка, и тряпки
 * в нём не осталось бы вовсе.
 *
 * Силы толчка хватает ровно на то, чтобы катить, — не на то, чтобы
 * запустить. Спихнуть с арены телом можно, но придётся дойти до края
 * вместе с ним, а это время, за которое успевают ответить.
 */
function roll(mover, downed, dt) {
  const speed = Math.hypot(mover.locomotion.velX, mover.locomotion.velZ);
  if (speed < T.shoveMinSpeed) return;

  const reach = T.bodyRadius + T.shoveReach;
  const body = downed.body;
  const power = (speed - T.shoveMinSpeed) * T.shovePower;
  let touched = false;

  for (let i = 0; i < body.pos.length; i++) {
    const p = body.pos[i];
    const dx = p.x - mover.position.x;
    const dz = p.z - mover.position.z;
    const d = Math.hypot(dx, dz);
    if (d >= reach) continue;
    // Толкаем ВДОЛЬ ХОДА толкающего, а не от него врозь: иначе лежачего
    // разбрасывает во все стороны и он крутится на месте вместо того,
    // чтобы ехать перед ногами.
    _n.set(mover.locomotion.velX / speed, 0, mover.locomotion.velZ / speed);
    // Ближе к толкающему — сильнее: так тело поворачивается вокруг
    // дальнего конца, а не едет плашмя.
    const bite = 1 - d / reach;
    body.push(i, _n.multiplyScalar(power * bite), dt);
    touched = true;
  }
  // Rolling a downed body toward the edge is «driving them to the fall»:
  // the credit refreshes for as long as the pushing actually lands.
  if (touched) downed.credit(mover);
}
