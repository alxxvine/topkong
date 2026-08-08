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
  }

  reset() {
    this.target = null;
    this.wantSwing = false;
    this.rest = 0;
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

    const edge = Math.hypot(f.position.x, f.position.z) / Math.max(0.1, this.arena.radius);

    // 1. Спасаться. У самого края всё остальное не имеет значения: боец,
    // который упорно идёт бить, стоя пяткой над обрывом, просто уходит вниз
    // и никакого боя не показывает.
    if (edge > T.botEdgeFear) {
      _away.set(-f.position.x, 0, -f.position.z).normalize();
      f.moveInput.set(_away.x, _away.z);
      f.facingTarget.copy(_away);
      f.swing.held = false;
      return;
    }

    const victim = this.target;
    if (!victim) {
      f.moveInput.set(0, 0);
      f.swing.held = false;
      // Без соперника разворачивается к центру: так он хотя бы не стоит
      // спиной к арене.
      f.facingTarget.set(-f.position.x, 0, -f.position.z);
      return;
    }

    _to.copy(victim.position).sub(f.position);
    _to.y = 0;
    const dist = _to.length();
    if (dist > 1e-4) _to.divideScalar(dist);
    f.facingTarget.copy(_to);

    // 2. Держать дистанцию. Ближе, чем нужно для удара, подходить незачем:
    // там начинается толкотня вплотную, из которой ни один не выходит.
    const hit = T.botStrikeRange;
    let drive = 0;
    if (dist > hit) drive = 1;
    else if (dist < hit * 0.72) drive = -1;

    // На отходе после своего удара пятится: пауза, за которую соперник
    // успевает ответить, и по ней бой читается обменом, а не свалкой.
    if (this.rest > 0) drive = -1;

    f.moveInput.set(_to.x * drive, _to.z * drive);

    // 3. Бить. Заряд копится, пока соперник в досягаемости; отпускается,
    // когда набрано задуманное. Отпускать надо ЗАРАНЕЕ — пронос занимает
    // время, и удар в упор всегда опаздывает.
    if (!T.withClub) { f.swing.held = false; return; }

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
