import { tuning as T } from 'tk/tuning.js';
import { DEG, RAD, deltaAngle, moveTowards, lerp } from 'tk/mathx.js';
import { P } from 'tk/body.js';

// Движение и разворот. Теперь это намерение, а не результат.
//
// Раньше здесь двигался сам трансформ бойца, и куда его поставили — там он
// и оказывался. Теперь тело физическое: локомоция задаёт ядру желаемую
// скорость и крутит целевой разворот, а доедет ли туда тело и как оно при
// этом завалится — решают мышцы и связи.
//
// Корень при этом остаётся авторитетным: ввод меняет намерение мгновенно.
// Именно это удерживает управление от вязкости, из-за которой мы ушли
// от физического тела в Unity-версии, — отстаёт картинка, а не реакция.

export class Locomotion {
  constructor(fighter, arena) {
    this.f = fighter;
    this.arena = arena;
    this.grounded = false;
    this.planarSpeed = 0;
    /** Заказанная вводом скорость в мире. Её читает походка. */
    this.wantX = 0;
    this.wantZ = 0;
    /** Скорость кинематического корня. */
    this.velX = 0;
    this.velZ = 0;
    /** Градусов в секунду. Хранится отдельно, чтобы у разворота был разгон. */
    this.yawSpeed = 0;
  }

  tick(dt, controlEnabled) {
    this.probeGround();
    if (this.kinematic) this.moveRoot(dt, controlEnabled);
    else {
      this.measureSpeed(dt);
      this.applyMovement(dt, controlEnabled);
    }
    this.applyFacing(dt, controlEnabled);
  }

  /** Правда ли боец сейчас ходит кинематически. */
  get kinematic() {
    // Не «частично оправился», а ПОЛНОСТЬЮ. Порог управления ниже единицы,
    // и на нём кинематика включалась, пока тело ещё лежало: поза мгновенно
    // становилась стойкой, и боец телепортировался на два метра. Дожидаемся,
    // пока мышцы поднимут его сами, — тогда переход почти незаметен.
    return T.bodyMode <= 1 && this.f.body.strength >= 0.999;
  }

  /**
   * Кинематический ход: двигается сам корень, а тело едет за ним.
   *
   * Разгон и торможение те же, что у физического хода, — они и отвечают
   * за вес в управлении. Разница в том, что скорость здесь получается
   * ровно заказанной, а не тем, что вышло у ног: на предсказуемость
   * этот режим и меняли.
   */
  moveRoot(dt, controlEnabled) {
    const f = this.f;
    const want = this.desiredVelocity(controlEnabled);
    const rate = this.grounded
      ? (want.moving ? T.moveAccel : T.moveBrake)
      : T.airControl;
    this.velX = moveTowards(this.velX, want.x, rate * dt);
    this.velZ = moveTowards(this.velZ, want.z, rate * dt);
    f.position.x += this.velX * dt;
    f.position.z += this.velZ * dt;
    this.planarSpeed = Math.hypot(this.velX, this.velZ);
    this.wantX = want.x;
    this.wantZ = want.z;
  }

  /**
   * Опора есть, если хотя бы одна стопа стоит на настиле. Проверять по тазу,
   * как раньше, больше нельзя: таз живёт своей жизнью и на шаге подпрыгивает.
   */
  probeGround() {
    const p = this.f.body.pos;
    this.grounded = this.footDown(p[P.FootL]) || this.footDown(p[P.FootR]);
  }

  footDown(foot) {
    return foot.y < 0.22 && this.arena.isOverDeck(foot.x, foot.z, -0.05);
  }

  /** Скорость меряется по тазу: это честная скорость тела, а не заказанная. */
  measureSpeed(dt) {
    const p = this.f.body.pos[P.Hips];
    const q = this.f.body.prev[P.Hips];
    this.planarSpeed = Math.hypot(p.x - q.x, p.z - q.z) / Math.max(1e-5, dt);
  }

  /** Куда и как быстро боец хочет ехать. Общее для обоих режимов. */
  desiredVelocity(controlEnabled) {
    const f = this.f;
    let wx = 0;
    let wz = 0;
    if (controlEnabled) {
      wx = f.moveInput.x;
      wz = f.moveInput.y;
      const len = Math.hypot(wx, wz);
      if (len > 1) { wx /= len; wz /= len; }
    }

    // Пронос забирает управление: удар должен чего-то стоить.
    let scale = 1;
    if (f.swing.striking) scale = T.swingMoveLock;
    else if (f.swing.held) scale = T.chargeMoveSlow;

    // Вбок и назад боец идёт медленнее, и это не условность жанра, а прямое
    // следствие устройства ног. Приставным шагом стопа уходит вбок недалеко:
    // наружу мешает досягаемость, внутрь — вторая нога. Замерено, что на
    // полной скорости вбок обе ноги хотят оторваться разом, одна ждёт
    // очереди, и её опору успевает утащить на 97 см — вдвое дальше,
    // чем нога вообще достаёт.
    const moving = wx !== 0 || wz !== 0;
    let dirScale = 1;
    if (moving) {
      const sin = Math.sin(f.yaw);
      const cos = Math.cos(f.yaw);
      const along = (wx * sin + wz * cos) / Math.max(1e-6, Math.hypot(wx, wz));
      dirScale = along >= 0
        ? lerp(T.strafeSpeed, 1, along)
        : lerp(T.strafeSpeed, T.backSpeed, -along);
    }

    const speed = T.maxRunSpeed * scale * dirScale;
    return { x: wx * speed, z: wz * speed, moving };
  }

  applyMovement(dt, controlEnabled) {
    const f = this.f;

    // Сбитого тела локомоция не касается ВООБЩЕ.
    //
    // Раньше касалась, и дорого: drive продолжал работать с нулевой целью,
    // то есть тормозил летящее тело, а поверх него шла доводка от равновесия.
    // Лежащий боец от неё уползал — замерено, метр с четвертью за полторы
    // секунды, — а потом вставал и уходил дальше сам по себе. Заодно
    // торможение съедало отбрасывание: сбитому полагается долетать до края,
    // а не останавливаться в воздухе.
    if (!controlEnabled) return;

    const want = this.desiredVelocity(controlEnabled);
    // Заказанная скорость нужна походке отдельно от настоящей. Пока обе
    // стопы на настиле, цельные ноги держат таз намертво: настоящая
    // скорость там ноль, и по ней шаг не начнётся никогда.
    this.wantX = want.x;
    this.wantZ = want.z;
    // В воздухе управление слабое: сбитый должен долетать до края,
    // а не выруливать обратно на арену.
    const rate = this.grounded
      ? (want.moving ? T.moveAccel : T.moveBrake)
      : T.airControl;

    // Доводка корпусом от равновесия идёт ПОВЕРХ заказанного хода: боец
    // одновременно идёт куда хотел и подрабатывает под собой. Без неё
    // стоящий на месте не подправляется вовсе — он просто висит на мышцах.
    const bal = f.balance;
    const bx = bal ? bal.pushX : 0;
    const bz = bal ? bal.pushZ : 0;
    f.body.drive(want.x + bx, want.z + bz, rate, dt);
  }

  /**
   * Разворот к прицелу — с разгоном и торможением.
   *
   * Плоская скорость в 420 градусов в секунду читалась как мгновенный
   * доворот детали. Здесь у разворота есть угловое ускорение, а перед целью
   * он тормозит ровно настолько, чтобы успеть остановиться: без этого
   * инерция даёт вечное рыскание вокруг прицела.
   */
  applyFacing(dt, controlEnabled) {
    const f = this.f;
    const want = f.facingTarget;
    const hasTarget = controlEnabled && (want.x * want.x + want.z * want.z > 1e-8);

    let desired = 0;
    if (hasTarget) {
      const target = Math.atan2(want.x, want.z) * RAD;
      const error = deltaAngle(f.yaw * RAD, target);
      // Скорость, с которой ещё успеваем остановиться к цели.
      const brakeSpeed = Math.sqrt(2 * T.turnAccel * Math.abs(error));
      desired = Math.sign(error) * Math.min(T.turnSpeed, brakeSpeed);
    }

    this.yawSpeed = moveTowards(this.yawSpeed, desired, T.turnAccel * dt);
    f.yaw += this.yawSpeed * dt * DEG;
  }

  reset() {
    this.yawSpeed = 0;
    this.planarSpeed = 0;
    this.wantX = 0;
    this.wantZ = 0;
    this.velX = 0;
    this.velZ = 0;
    this.grounded = false;
  }
}
