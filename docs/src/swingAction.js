import { tuning as T } from 'tk/tuning.js';
import { clamp01, lerp, lerpAngle, lerpUnclamped } from 'tk/mathx.js';
import { ClubRestReach } from 'tk/fighterRig.js';

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

// Манеры удара. Одна и та же машина состояний, разные точки таймлайна:
// откуда замахиваться и куда вести. Углы дуги заданы парой [доля от half,
// прибавка в градусах], высота и наклон дубины — от и до за пронос.
//
// Рука всегда правая — обратный удар это бэкхенд, а не перекладывание
// оружия. Смысл разных манер не только в картинке: по замаху видно,
// ОТКУДА прилетит, и от рубящего сверху уклоняются иначе, чем от широкого.
export const SWING_STYLES = [
  { name: 'широкий',   aFrom: [1, 25],     aTo: [-1, 0],     wH: 0.14, wP: -22, hF: 0,    hT: 0,     pF: 0,   pT: 0 },
  { name: 'обратный',  aFrom: [-1, -25],   aTo: [1, 0],      wH: 0.14, wP: -22, hF: 0,    hT: 0,     pF: 0,   pT: 0 },
  { name: 'сверху',    aFrom: [0, 15],     aTo: [0, -12],    wH: 0.6,  wP: -75, hF: 0.55, hT: -0.08, pF: -70, pT: 28 },
  { name: 'диагональ', aFrom: [0.75, 20],  aTo: [-0.55, 0],  wH: 0.4,  wP: -50, hF: 0.36, hT: -0.05, pF: -45, pT: 12 },
];

export class SwingAction {
  constructor() {
    this.state = SwingState.Guard;
    this.held = false;

    this.timer = 0;
    this.cooldown = 0;
    this.charge = 0;

    this.angle = T.carryAngle;
    this.reach = T.carryReach;
    this.lean = 0;
    this.height = T.carryDrop;
    // Наклон дубины к земле. В покое почти отвесный: только так «висит
    // сбоку» читается как висит, а не как парящий на уровне колен шар.
    this.pitch = T.carryPitch;

    /** Сила удара 0..1: во столько раз он весомее незаряженного. */
    this.power = 1;

    /** Какой манерой бьём сейчас. Выбирается заново на каждом замахе. */
    this.styleIndex = 0;
  }

  /** Идёт пронос — только в это время дубина считается бьющей. */
  get striking() { return this.state === SwingState.Strike; }

  tick(dt) {
    // Скорость удара — одна ручка на весь приём, а не три отдельных времени.
    //
    // Проще всего ускорить не длительности, а само время удара: тогда
    // заряд, пронос, возврат, откат и скорость перетекания поз ускоряются
    // ровно в одинаковой мере и разъехаться не могут. Правь я четыре числа
    // по отдельности, любая настройка «побыстрее» первым делом ломала бы
    // согласование замаха с проносом.
    dt *= Math.max(0.05, T.swingSpeed);
    this.cooldown -= dt;

    switch (this.state) {
      case SwingState.Guard:
        this.charge = 0;
        if (this.held && this.cooldown <= 0) {
          this.state = SwingState.WindUp;
          this.timer = 0;
          // Манера выбирается на замахе и никогда не повторяется дважды
          // подряд: одинаковые удары читаются анимацией по кругу, а разные —
          // бойцом, который бьёт как придётся.
          const shift = 1 + Math.floor(Math.random() * (SWING_STYLES.length - 1));
          this.styleIndex = (this.styleIndex + shift) % SWING_STYLES.length;
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
    const st = SWING_STYLES[this.styleIndex] || SWING_STYLES[0];
    const arc = (a) => half * a[0] + a[1];
    let targetAngle, targetReach, targetLean, targetHeight, targetPitch, blend;

    switch (this.state) {
      case SwingState.WindUp:
        // Замах обязан читаться до того, как что-то полетит: дубина уходит
        // в стартовую точку СВОЕЙ манеры тем дальше, чем больше заряд,
        // корпус отклоняется назад. По позе видно не только «сейчас ударит»,
        // но и ОТКУДА прилетит: рубящий стоит с дубиной над головой,
        // обратный — с дубиной поперёк корпуса.
        targetAngle = lerp(T.carryAngle, arc(st.aFrom), this.charge);
        targetReach = lerp(T.carryReach, T.windUpReach, this.charge);
        targetLean = -0.5 * this.charge;
        targetHeight = lerp(T.carryDrop, st.wH, this.charge);
        targetPitch = lerp(T.carryPitch, st.wP, this.charge);
        blend = 10 * dt;
        break;

      case SwingState.Strike: {
        const phase = clamp01(this.timer / Math.max(0.01, T.swingStrikeTime));
        // Ease-out: пронос резкий в начале и доводится к концу. Линейная
        // развёртка выглядит как равномерное вращение манипулятора, а не как удар.
        const eased = 1 - (1 - phase) * (1 - phase);
        // Дуга — из стартовой точки манеры через прицел в её конечную.
        // Рука при этом всегда правая: обратная дуга — бэкхенд,
        // а не перекладывание оружия.
        targetAngle = lerpUnclamped(arc(st.aFrom), arc(st.aTo), eased);
        targetReach = lerp(ClubRestReach, T.handMaxReach, Math.sin(phase * Math.PI));
        targetLean = Math.sin(phase * Math.PI);
        // У горизонтальных манер пронос плоский; у рубящих высота и наклон
        // дубины падают за пронос — удар приходит сверху.
        targetHeight = lerpUnclamped(st.hF, st.hT, eased);
        targetPitch = lerpUnclamped(st.pF, st.pT, eased);
        // Во время удара поза ставится напрямую: любое сглаживание здесь
        // размазало бы тайминг, ради которого сценарный удар и делался.
        blend = 1;
        break;
      }

      case SwingState.Recover:
        targetAngle = T.carryAngle;
        targetReach = T.carryReach;
        targetLean = 0;
        targetHeight = T.carryDrop;
        targetPitch = T.carryPitch;
        blend = 7 * dt;
        break;

      default:
        // Покой: дубина висит сбоку в опущенной руке. Отдельного «состояния
        // готовности» рисовать не нужно — разница между «несу» и «замахиваюсь»
        // видна по самой позе.
        targetAngle = T.carryAngle;
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
  }

  reset() {
    this.state = SwingState.Guard;
    this.held = false;
    this.timer = 0;
    this.cooldown = 0;
    this.charge = 0;
    this.angle = T.carryAngle;
    this.reach = T.carryReach;
    this.lean = 0;
    this.height = T.carryDrop;
    this.pitch = T.carryPitch;
  }
}
