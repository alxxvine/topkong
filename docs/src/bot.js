import * as THREE from 'three';
import { tuning as T } from 'tk/tuning.js';
import { clamp01, lerp } from 'tk/mathx.js';

// Соперник.
//
// Своей физики и своей позы у него нет вовсе: он пишет ровно те же три поля,
// что и живой игрок, — куда идти, куда смотреть, держать ли замах. Всё
// остальное делают те же локомоция, походка и удар. Это не экономия,
// а проверка: если бы боту понадобилось что-то своё, значит управление
// игрока устроено неправильно.
//
// Умения у него три, и он выбирает между ними по расстоянию до соперника
// и до края. Никакого дерева поведения: на арене без укрытий выбирать
// особо не из чего, а лишний слой только скрыл бы, почему бот сделал то,
// что сделал.

const _to = new THREE.Vector3();
const _away = new THREE.Vector3();

export class Bot {
  constructor(fighter, arena) {
    this.f = fighter;
    this.arena = arena;
    /** Своя задержка реакции: одинаковые боты выглядят одним ботом в трёх лицах. */
    this.lag = 0.12 + Math.random() * 0.18;
    this.think = Math.random() * this.lag;
    this.target = null;
    this.wantSwing = false;
    /** После своего удара выжидает — иначе долбит без остановки. */
    this.rest = 0;
    /** Сколько времени упираемся в соперника без хода. */
    this.clinch = 0;
    /** Сколько ещё отходить после клинча и в какую сторону заходить. */
    this.backoff = 0;
    this.side = 1;
    this.clinchLimit = 0.5 + Math.random() * 0.8;
  }

  reset() {
    this.target = null;
    this.wantSwing = false;
    this.rest = 0;
    this.clinch = 0;
    this.backoff = 0;
  }

  tick(dt, fighters) {
    const f = this.f;
    if (!f.alive) {
      f.moveInput.set(0, 0);
      f.swing.held = false;
      return;
    }

    this.rest = Math.max(0, this.rest - dt);
    this.think -= dt;
    if (this.think <= 0) {
      this.think = this.lag;
      this.target = this.pickTarget(fighters);
    }

    const myEdge = Math.hypot(f.position.x, f.position.z) / Math.max(0.1, this.arena.radius);
    const victim = this.target;
    const victimEdge = victim
      ? Math.hypot(victim.position.x, victim.position.z) / Math.max(0.1, this.arena.radius)
      : 0;
    const victimDown = victim && victim.body.strength < T.controlStrength;

    // 1. Спасаться. У самого края всё остальное не имеет значения: боец,
    // который упорно идёт бить, стоя пяткой над обрывом, просто уходит вниз
    // и никакого боя не показывает.
    //
    // НО страх отступает, когда бот сам толкает: жертва лежит или стоит
    // ДАЛЬШЕ от центра, чем он, — значит между ним и обрывом её тело,
    // и довести её до кромки безопаснее, чем кажется. Без этой поправки
    // бот бросал добычу на подходе к краю, и та спокойно вставала:
    // замерено, докатывал до радиуса 5.6 из 7.5 и разворачивался.
    const pushingOut = victim && (victimDown || !(T.withClub && T.botsArmed)) && victimEdge > myEdge + 0.03;
    const fearAt = pushingOut ? 0.93 : T.botEdgeFear;
    if (myEdge > fearAt) {
      _away.set(-f.position.x, 0, -f.position.z).normalize();
      f.moveInput.set(_away.x, _away.z);
      f.facingTarget.copy(_away);
      f.swing.held = false;
      return;
    }

    if (!victim) {
      f.moveInput.set(0, 0);
      f.swing.held = false;
      // Без соперника разворачивается к центру: так он хотя бы не стоит
      // спиной к арене.
      f.facingTarget.set(-f.position.x, 0, -f.position.z);
      return;
    }

    // Вооружён ли ЭТОТ бот: общая ручка оружия плюс отдельная для ботов.
    const armed = T.withClub && T.botsArmed;

    _to.copy(victim.position).sub(f.position);
    _to.y = 0;
    const dist = _to.length();
    if (dist > 1e-4) _to.divideScalar(dist);
    f.facingTarget.copy(_to);

    // 2. Держать дистанцию. Ближе, чем нужно для удара, подходить незачем:
    // там начинается толкотня вплотную, из которой ни один не выходит.
    //
    // С ЛЕЖАЧИМ наоборот: к нему идут вплотную и катят к краю телом.
    // Пока правило было общим, бот вставал в метре от упавшего и топтался
    // там — снаружи это выглядело упором в невидимую стену, тем более
    // что тела тогда вообще не сталкивались и стены не было никакой.
    const hit = T.botStrikeRange;

    // Лежачего КАТЯТ К КРАЮ, а не идут «к нему». Курс на самого лежачего
    // кончался топтанием у тела: дошёл — цель под ногами — стоит. Цель
    // ставится ЗА жертвой, наружу от центра арены, и бот проходит сквозь,
    // толкая тело перед собой. У кромки его развернёт страх края выше.
    if (victimDown) {
      const vlen = Math.hypot(victim.position.x, victim.position.z);
      const ox = vlen > 0.3 ? victim.position.x / vlen : _to.x;
      const oz = vlen > 0.3 ? victim.position.z / vlen : _to.z;
      _away.set(victim.position.x + ox * 1.6 - f.position.x, 0,
                victim.position.z + oz * 1.6 - f.position.z).normalize();
      f.moveInput.set(_away.x, _away.z);
      f.facingTarget.copy(_away);
      f.swing.held = false;
      return;
    }

    // Клинч. Встречный таран — сумо: обоих никуда не везёт, расшатка
    // не копится, и это физически честно. Поэтому лоб в лоб не решает —
    // бот, простояв в упоре секунду, отходит и заходит СБОКУ: жертву,
    // которую везут вбок, её собственный ход не спасает.
    if (!armed) {
      const gap = dist - T.bodyRadius * 2;
      if (gap < 0.15 && f.locomotion.planarSpeed < 0.35) this.clinch += dt;
      else this.clinch = Math.max(0, this.clinch - dt * 2);
      // Порог у каждого клинча свой. Два одинаковых бота с одинаковым
      // порогом отходили СИНХРОННО и танцевали так вечно: симметрию
      // некому было разбить.
      if (this.clinch > this.clinchLimit) {
        this.clinch = 0;
        this.clinchLimit = 0.5 + Math.random() * 0.8;
        this.backoff = 0.8 + Math.random() * 0.5;
        this.side = Math.random() < 0.5 ? -1 : 1;
      }
      if (this.backoff > 0) {
        this.backoff -= dt;
        // Назад и вбок разом: выход из клинча по дуге, а не отскок.
        f.moveInput.set(
          -_to.x * 0.7 + _to.z * this.side * 0.7,
          -_to.z * 0.7 - _to.x * this.side * 0.7);
        f.swing.held = false;
        return;
      }
    }

    let drive = 0;
    // Без оружия дистанция бессмысленна: бить нечем, и весь бой — таран.
    if (!armed) drive = 1;
    else if (dist > hit) drive = 1;
    else if (dist < hit * 0.72) drive = -1;

    // На отходе после своего удара пятится: пауза, за которую соперник
    // успевает ответить, и по ней бой читается обменом, а не свалкой.
    if (this.rest > 0) drive = -1;

    f.moveInput.set(_to.x * drive, _to.z * drive);

    // 3. Бить. Заряд копится, пока соперник в досягаемости; отпускается,
    // когда набрано задуманное. Отпускать надо ЗАРАНЕЕ — пронос занимает
    // время, и удар в упор всегда опаздывает.
    if (!armed) { f.swing.held = false; return; }

    const inRange = dist < hit * 1.25 && this.rest <= 0;
    if (!inRange) {
      if (f.swing.held) f.swing.held = false;
      this.wantSwing = false;
      return;
    }

    if (!f.swing.held && f.swing.state === 'guard') {
      f.swing.held = true;
      // Сколько копить в этот раз. Разброс намеренный: бот с постоянным
      // зарядом читается как метроном.
      this.wantSwing = lerp(T.botChargeMin, T.botChargeMax, Math.random());
    }

    if (f.swing.held && f.swing.charge >= this.wantSwing) {
      f.swing.held = false;
      this.rest = T.botRest;
    }
  }

  /** Ближайший живой, кроме себя. */
  pickTarget(fighters) {
    let best = null;
    let bestDist = Infinity;
    for (const other of fighters) {
      if (other === this.f || !other.alive) continue;
      const d = other.position.distanceToSquared(this.f.position);
      if (d < bestDist) { bestDist = d; best = other; }
    }
    return best;
  }
}
