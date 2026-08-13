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
// Рука всегда правая, и все манеры начинаются у правого бока, где дубина
// и так висит: бэкхенд с левой стороны пробовали (и даже связку через
// него) — из стойки он появлялся неестественно, а комбо оказалось
// сложнее, чем просит темп игры. Смысл манер не только в картинке:
// по замаху видно, ОТКУДА прилетит, и от рубящего сверху уклоняются
// иначе, чем от бокового.
export const SWING_STYLES = [
  { name: 'сбоку',  aFrom: [1, 25],    aTo: [-1, 0],     wH: 0.14,  wP: -22, hF: 0,     hT: 0,     pF: 0,   pT: 0 },
  { name: 'сверху', aFrom: [0, 15],    aTo: [0, -12],    wH: 0.6,   wP: -75, hF: 0.55,  hT: -0.08, pF: -70, pT: 28 },
  // Снизу — черпающий: дубина опускается к колену остриём вниз
  // и выгребает вверх-влево, к концу проноса глядя остриём вверх.
  { name: 'снизу',  aFrom: [0.8, 10],  aTo: [-0.35, 0],  wH: -0.12, wP: 35,  hF: -0.12, hT: 0.5,   pF: 30,  pT: -40 },
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

    /** Поза в момент отпускания: пронос стартует из неё, а не из
     *  канонической точки манеры. См. комментарий на переходе в Strike. */
    this.strikeFrom = { angle: 0, reach: 0, lean: 0, height: 0, pitch: 0 };

    /** Доля проноса, уходящая на подхват недобранного замаха (0 — замах
     *  был полным и подхватывать нечего). Ставится на переходе в Strike. */
    this.pullFrac = 0;
  }

  /** Идёт пронос — только в это время дубина считается бьющей. Подхват
   *  недобранного замаха в начале проноса не в счёт: дубина там летит
   *  НАЗАД, в точку замаха, и попадание ею толкало бы соперника
   *  в обратную сторону. */
  get striking() {
    if (this.state !== SwingState.Strike) return false;
    return this.timer / Math.max(0.01, T.swingStrikeTime) >= this.pullFrac;
  }

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
          // Пронос стартует из ФАКТИЧЕСКОЙ позы, а не из канонической
          // точки манеры: иначе на отпускании рука телепортировалась бы
          // в точку полного замаха — скачок до 150° одним кадром,
          // удар «из ниоткуда».
          this.strikeFrom.angle = this.angle;
          this.strikeFrom.reach = this.reach;
          this.strikeFrom.lean = this.lean;
          this.strikeFrom.height = this.height;
          this.strikeFrom.pitch = this.pitch;
          // Недобранный замах докручивается ВНУТРИ удара: первая доля
          // проноса — стремительный подхват в стартовую точку манеры,
          // дальше полная дуга. Так простой клик бьёт всеми манерами
          // целиком (игрок не обязан зажимать кнопку ради разнообразия),
          // а подхват остаётся непрерывным движением, не скачком.
          // Доля подхвата — от расстояния, которое руке осталось пройти;
          // при полном замахе она нулевая и удар идёт как раньше.
          const st = SWING_STYLES[this.styleIndex] || SWING_STYLES[0];
          const half = T.swingArcDegrees * 0.5;
          const gapA = Math.abs(this.angle - (half * st.aFrom[0] + st.aFrom[1])) / 320;
          const gapH = Math.abs(this.height - st.hF) / 1.4;
          const gapP = Math.abs(this.pitch - st.pF) / 320;
          this.pullFrac = Math.min(0.35, Math.max(gapA, gapH, gapP));
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
        const eased = 1 - (1 - phase) * (1 - phase);
        const from = this.strikeFrom;
        const pull = this.pullFrac;
        if (pull > 0.01 && phase < pull) {
          // Подхват: рука стремительно, но непрерывно доезжает из позы
          // отпускания в стартовую точку манеры. Быстрый клик получает
          // молниеносный замах внутри самого удара — манера читается
          // и без зажатой кнопки.
          const t = phase / pull;
          const s = t * t * (3 - 2 * t);
          targetAngle = lerpUnclamped(from.angle, arc(st.aFrom), s);
          targetHeight = lerpUnclamped(from.height, st.hF, s);
          targetPitch = lerpUnclamped(from.pitch, st.pF, s);
        } else {
          // Пронос. Ease-out: резкий в начале, доводится к концу — линейная
          // развёртка выглядела бы равномерным вращением манипулятора.
          // Дуга — из стартовой точки манеры (подхват уже довёл до неё;
          // при полном замахе это же и поза отпускания) в конечную.
          // Рука всегда правая: обратная дуга — бэкхенд, а не
          // перекладывание оружия. У горизонтальных манер пронос плоский,
          // у рубящих высота и наклон дубины падают — удар приходит сверху.
          const p2 = clamp01((phase - pull) / Math.max(0.01, 1 - pull));
          const e2 = 1 - (1 - p2) * (1 - p2);
          const fromA = pull > 0.01 ? arc(st.aFrom) : from.angle;
          const fromH = pull > 0.01 ? st.hF : from.height;
          const fromP = pull > 0.01 ? st.pF : from.pitch;
          targetAngle = lerpUnclamped(fromA, arc(st.aTo), e2);
          targetHeight = lerpUnclamped(fromH, st.hT, e2);
          targetPitch = lerpUnclamped(fromP, st.pT, e2);
        }
        // Вынос и наклон корпуса продолжаются из позы отпускания по всему
        // удару: стартуй они с константы, на отпускании полного замаха
        // корпус щёлкал бы из отклона назад в ноль.
        targetReach = lerp(lerp(from.reach, ClubRestReach, eased),
                           T.handMaxReach, Math.sin(phase * Math.PI));
        targetLean = from.lean * (1 - eased) + Math.sin(phase * Math.PI);
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
