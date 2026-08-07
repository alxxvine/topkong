import { tuning as T } from './tuning.js';
import { clamp01, lerp, lerpAngle, lerpUnclamped } from './mathx.js';
import { ClubRestReach } from './fighterRig.js';

// Удар как сценарий, а не как физика. Порт SwingAction.cs.
//
// Раньше дубину вёл PD-регулятор, а замах возникал из того, как игрок водит
// мышью. Идея пришла из VR, где у игрока есть настоящая рука с настоящей
// скоростью; на мыши такой руки нет, и всё сводилось к угадыванию намерения
// по двумерному курсору — отсюда вязкость, раскачка и бесконечная подкрутка
// коэффициентов.
//
// Теперь это чистый таймлайн: класс не трогает физику вовсе, а лишь выдаёт
// четыре числа — куда развёрнута дубина, насколько вынесена, на какой высоте
// и как наклонён корпус. Разворачивает их в позу PoseDriver. Физика остаётся
// там, где она хороша: в том, как соперник получает импульс и улетает.

export const SwingState = {
  Guard: 'guard',
  WindUp: 'windup',
  Strike: 'strike',
  Recover: 'recover',
};

export class SwingAction {
  constructor() {
    this.state = SwingState.Guard;
    this.held = false;

    this.timer = 0;
    this.cooldown = 0;
    this.charge = 0;
    // Сторона дуги чередуется: слева-направо, потом обратно.
    this.side = 1;

    this.angle = T.carryAngle * -this.side;
    this.reach = T.carryReach;
    this.lean = 0;
    this.height = T.carryDrop;
    // Наклон дубины к земле. В покое почти отвесный: только так «волочится
    // за спиной» читается как волочится, а не как парящий на уровне колен шар.
    this.pitch = T.carryPitch;
    // 0 — несёт одной рукой, 1 — обе кисти на рукояти. Вторая рука
    // приходит на замахе: по ней состояние читается ещё до того,
    // как дубина начала подниматься.
    this.twoHanded = 0;

    /** Сила удара 0..1: во столько раз он весомее незаряженного. */
    this.power = 1;
  }

  /** Идёт пронос — только в это время дубина считается бьющей. */
  get striking() { return this.state === SwingState.Strike; }

  tick(dt) {
    this.cooldown -= dt;

    switch (this.state) {
      case SwingState.Guard:
        this.charge = 0;
        if (this.held && this.cooldown <= 0) {
          this.state = SwingState.WindUp;
          this.timer = 0;
        }
        break;

      case SwingState.WindUp:
        this.timer += dt;
        this.charge = Math.min(1, this.timer / Math.max(0.01, T.swingChargeTime));
        if (!this.held) {
          this.state = SwingState.Strike;
          this.timer = 0;
          this.power = lerp(T.swingWeakestPower, 1, this.charge);
        }
        break;

      case SwingState.Strike:
        this.timer += dt;
        if (this.timer >= T.swingStrikeTime) {
          this.state = SwingState.Recover;
          this.timer = 0;
          this.side = -this.side;
          this.cooldown = T.swingCooldown;
        }
        break;

      case SwingState.Recover:
        this.timer += dt;
        if (this.timer >= T.swingRecoverTime) {
          this.state = SwingState.Guard;
          this.timer = 0;
        }
        break;
    }

    this.updatePose(dt);
  }

  updatePose(dt) {
    const half = T.swingArcDegrees * 0.5;
    let targetAngle, targetReach, targetLean, targetHeight, targetPitch, blend;

    switch (this.state) {
      case SwingState.WindUp:
        // Замах обязан читаться до того, как что-то полетит: дубина
        // поднимается из-за спины тем выше, чем больше заряд, корпус
        // отклоняется назад. Состояние видно по одной позе, без интерфейса.
        targetAngle = lerp(T.carryAngle * -this.side, -this.side * (half + 25), this.charge);
        targetReach = lerp(T.carryReach, T.windUpReach, this.charge);
        targetLean = -0.5 * this.charge;
        targetHeight = lerp(T.carryDrop, 0.14, this.charge);
        // Из-за спины к плечу: набалдашник задирается вверх, и по одному
        // этому видно, что сейчас прилетит.
        targetPitch = lerp(T.carryPitch, -22, this.charge);
        blend = 10 * dt;
        break;

      case SwingState.Strike: {
        const phase = clamp01(this.timer / Math.max(0.01, T.swingStrikeTime));
        // Ease-out: пронос резкий в начале и доводится к концу. Линейная
        // развёртка выглядит как равномерное вращение манипулятора, а не как удар.
        const eased = 1 - (1 - phase) * (1 - phase);
        targetAngle = lerpUnclamped(-(half + 25), half, eased) * this.side;
        targetReach = lerp(ClubRestReach, T.handMaxReach, Math.sin(phase * Math.PI));
        targetLean = Math.sin(phase * Math.PI);
        targetHeight = 0;
        // Пронос идёт плоско: удар должен приходиться в корпус, а не в настил.
        targetPitch = 0;
        // Во время удара поза ставится напрямую: любое сглаживание здесь
        // размазало бы тайминг, ради которого сценарный удар и делался.
        blend = 1;
        break;
      }

      case SwingState.Recover:
        targetAngle = T.carryAngle * -this.side;
        targetReach = T.carryReach;
        targetLean = 0;
        targetHeight = T.carryDrop;
        targetPitch = T.carryPitch;
        blend = 7 * dt;
        break;

      default:
        // Покой: дубина волочится за спиной. Отдельного «состояния готовности»
        // рисовать не нужно — разница между «несу» и «замахиваюсь» видна сама.
        targetAngle = T.carryAngle * -this.side;
        targetReach = T.carryReach;
        targetLean = 0;
        targetHeight = T.carryDrop;
        targetPitch = T.carryPitch;
        blend = 5 * dt;
        break;
    }

    blend = clamp01(blend);
    this.angle = lerpAngle(this.angle, targetAngle, blend);
    this.reach = lerp(this.reach, targetReach, blend);
    this.lean = lerp(this.lean, targetLean, blend);
    this.height = lerp(this.height, targetHeight, blend);
    this.pitch = lerp(this.pitch, targetPitch, blend);

    // Хват сглаживается своей скоростью, а не общим blend: на проносе тот
    // равен единице, и вторая рука прыгала бы на рукоять рывком.
    const wantTwoHanded = this.state === SwingState.Guard ? 0
      : this.state === SwingState.WindUp ? Math.min(1, this.charge * 3)
        : this.state === SwingState.Strike ? 1 : 0;
    this.twoHanded = lerp(this.twoHanded, wantTwoHanded, clamp01(14 * dt));
  }

  reset() {
    this.state = SwingState.Guard;
    this.held = false;
    this.timer = 0;
    this.cooldown = 0;
    this.charge = 0;
    this.angle = T.carryAngle * -this.side;
    this.reach = T.carryReach;
    this.lean = 0;
    this.height = T.carryDrop;
    this.pitch = T.carryPitch;
    this.twoHanded = 0;
  }
}
