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
// Besides the arc, each style carries its hit character: `up` scales the
// vertical share of the knockback, `pow` its force. The rising scoop
// LAUNCHES the victim — that is its whole identity (its shorter arc pushes
// less, so height is what it buys). The overhead slam hits flatter and
// harder: gravity did half the swing, the victim eats all of it.
//
// `time` stretches the sweep, `wind` stretches the pull-in windup — the
// vertical styles are HEAVIER, and a heavy strike must be visibly raised
// before it lands. When all three shared one clock, the overhead slam
// dropped before the raise even registered: the arm teleported up and the
// hit read as instant. The extra windup is also the counterplay window —
// a slam you cannot see coming cannot be dodged.
export const SWING_STYLES = [
  { name: 'side',     aFrom: [1, 25], aTo: [-1, 0],  wH: 0.14,  wP: -22, hF: 0,     hT: 0,     pF: 0,   pT: 0,   up: 1,   pow: 1 },
  { name: 'overhead', aFrom: [0, 15], aTo: [0, -12], wH: 0.6,   wP: -75, hF: 0.55,  hT: -0.08, pF: -70, pT: 28,  up: 0.7, pow: 1.8,  time: 1.35, wind: 2.3 },
  // The rising scoop is the overhead's mirror: the club dips to the knees
  // tip-down right in front of the fighter and rips straight up past the
  // face, finishing tip-up. It used to travel a wide horizontal arc from
  // the right side, which made it read as a slightly tilted side swing.
  { name: 'rising',   aFrom: [0, 14], aTo: [0, -12], wH: -0.28, wP: 65,  hF: -0.18, hT: 0.5,   pF: 55,  pT: -60, up: 3.2, pow: 1.15, time: 1.2,  wind: 1.7 },
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

    /** Заказанная манера следующего замаха. Игрок выбирает удар кнопкой
     *  (ЛКМ — боковой, колесо — сверху/снизу); null — случайная, как у ботов. */
    this.wantStyle = null;
    /** Мгновенный удар с колеса: замах не копится, отпускание в тот же тик. */
    this.castNow = false;
    /** Стойка блока: дубина поперёк, поза вместо походной. Ставит боец. */
    this.blockPose = false;

    /** Поза в момент отпускания: пронос стартует из неё, а не из
     *  канонической точки манеры. См. комментарий на переходе в Strike. */
    this.strikeFrom = { angle: 0, reach: 0, lean: 0, height: 0, pitch: 0 };

    /** Seconds the pull-back takes at the start of Strike (0 when the
     *  wind-up was full). The pull ADDS to the strike duration instead of
     *  eating into it: the sweep itself always gets the same time in every
     *  style and at every charge. When it borrowed from a fixed window,
     *  overhead taps kept only ~65% of it (the club has the longest way up)
     *  while side taps kept nearly all — and the strikes felt like
     *  animations with different frame counts, because they were. */
    this.pullTime = 0;
  }

  /** Идёт пронос — только в это время дубина считается бьющей. Подхват
   *  недобранного замаха в начале проноса не в счёт: дубина там летит
   *  НАЗАД, в точку замаха, и попадание ею толкало бы соперника
   *  в обратную сторону. */
  get striking() {
    if (this.state !== SwingState.Strike) return false;
    return this.timer >= this.pullTime;
  }

  /** Мгновенный удар выбранной манерой (колесо): войти в замах и отпустить
   *  в том же тике. Подхват внутри проноса дорисует молниеносный замах. */
  cast(styleIndex) {
    if (this.state !== SwingState.Guard || this.cooldown > 0) return false;
    this.wantStyle = styleIndex;
    this.castNow = true;
    this.held = true;
    return true;
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
          // Манера: у игрока — заказанная кнопкой, у ботов — случайная
          // и никогда не повторяющаяся дважды подряд: одинаковые удары
          // читаются анимацией по кругу, а разные — бойцом, который бьёт
          // как придётся.
          if (this.wantStyle !== null) {
            this.styleIndex = this.wantStyle;
            this.wantStyle = null;
          } else {
            const shift = 1 + Math.floor(Math.random() * (SWING_STYLES.length - 1));
            this.styleIndex = (this.styleIndex + shift) % SWING_STYLES.length;
          }
        }
        break;

      case SwingState.WindUp:
        this.timer += dt;
        this.charge = Math.min(1, this.timer / Math.max(0.01, T.swingChargeTime));
        if (!this.held || this.castNow) {
          this.castNow = false;
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
          // Длительность подхвата — от расстояния, которое руке осталось
          // пройти; при полном замахе она нулевая. Подхват — ДОБАВКА
          // к времени удара, сам пронос всегда одной длины (см. pullTime).
          const st = SWING_STYLES[this.styleIndex] || SWING_STYLES[0];
          const half = T.swingArcDegrees * 0.5;
          const gapA = Math.abs(this.angle - (half * st.aFrom[0] + st.aFrom[1])) / 320;
          const gapH = Math.abs(this.height - st.hF) / 1.4;
          const gapP = Math.abs(this.pitch - st.pF) / 320;
          // The style's `wind` stretches the pull: on a heavy vertical
          // strike the raise must READ as a windup, not flicker past.
          this.pullTime = Math.min(0.35, Math.max(gapA, gapH, gapP))
            * T.swingStrikeTime * (st.wind || 1);
          this.state = SwingState.Strike;
          this.timer = 0;
          this.power = lerp(T.swingWeakestPower, 1, this.charge);
        }
        break;

      case SwingState.Strike: {
        this.timer += dt;
        // The sweep length is per-style now (`time`): the vertical strikes
        // are deliberately slower than the side swing — weight over tempo.
        const st = SWING_STYLES[this.styleIndex] || SWING_STYLES[0];
        if (this.timer >= this.pullTime + T.swingStrikeTime * (st.time || 1)) {
          this.state = SwingState.Recover;
          this.timer = 0;
          this.cooldown = T.swingCooldown;
        }
        break;
      }

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
        const from = this.strikeFrom;
        const pull = this.pullTime;
        if (pull > 1e-4 && this.timer < pull) {
          // Подхват: рука стремительно, но непрерывно доезжает из позы
          // отпускания в стартовую точку манеры. Быстрый клик получает
          // молниеносный замах внутри самого удара — манера читается
          // и без зажатой кнопки. Это своё время, не время проноса.
          const t = this.timer / pull;
          const s = t * t * (3 - 2 * t);
          targetAngle = lerpUnclamped(from.angle, arc(st.aFrom), s);
          targetHeight = lerpUnclamped(from.height, st.hF, s);
          targetPitch = lerpUnclamped(from.pitch, st.pF, s);
          targetReach = lerp(from.reach, ClubRestReach, s);
          targetLean = from.lean;
        } else {
          // Пронос — всегда РОВНО swingStrikeTime, у всех манер и при
          // любом заряде. Разгон косинусом: пик скорости в СЕРЕДИНЕ дуги,
          // где стоит прицел, доводка после. Прежний ease-out давал
          // максимум скорости в первом же кадре — удар читался деревянным
          // рывком манипулятора, а не махом с замахом и проносом.
          // Дуга — из стартовой точки манеры (подхват уже довёл до неё;
          // при полном замахе это же и поза отпускания) в конечную.
          // Рука всегда правая: обратная дуга — бэкхенд, а не
          // перекладывание оружия. У горизонтальных манер пронос плоский,
          // у рубящих высота и наклон дубины падают — удар приходит сверху.
          const p2 = clamp01((this.timer - pull)
            / Math.max(0.01, T.swingStrikeTime * (st.time || 1)));
          const e2 = 0.5 - 0.5 * Math.cos(p2 * Math.PI);
          const pulled = pull > 1e-4;
          const fromA = pulled ? arc(st.aFrom) : from.angle;
          const fromH = pulled ? st.hF : from.height;
          const fromP = pulled ? st.pF : from.pitch;
          targetAngle = lerpUnclamped(fromA, arc(st.aTo), e2);
          targetHeight = lerpUnclamped(fromH, st.hT, e2);
          targetPitch = lerpUnclamped(fromP, st.pT, e2);
          // Вынос и наклон корпуса тоже продолжаются без щелчка: вынос
          // раскрывается к середине дуги, наклон отпускания растворяется
          // за пронос в наклон вперёд и обратно.
          const baseReach = pulled ? ClubRestReach : from.reach;
          targetReach = lerp(lerp(baseReach, ClubRestReach, e2),
                             T.handMaxReach, Math.sin(p2 * Math.PI));
          targetLean = from.lean * (1 - e2) + Math.sin(p2 * Math.PI);
        }
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
        // видна по самой позе. Блок — исключение: дубина поднимается поперёк
        // корпуса, и по стойке видно, что бить сейчас не будут — будут держать.
        if (this.blockPose) {
          // The block is a HOLD, not a threat: the club stands almost
          // vertical, hugged right against the chest, no backward lean.
          // The first version kept the reach and lean of a windup and read
          // as "about to strike" — the exact opposite of what a block says.
          targetAngle = 12;
          targetReach = 0.24;
          targetLean = 0;
          targetHeight = 0.18;
          targetPitch = -72;
          blend = 12 * dt;
        } else {
          targetAngle = T.carryAngle;
          targetReach = T.carryReach;
          targetLean = 0;
          targetHeight = T.carryDrop;
          targetPitch = T.carryPitch;
          blend = 5 * dt;
        }
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
    this.wantStyle = null;
    this.castNow = false;
    this.blockPose = false;
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
