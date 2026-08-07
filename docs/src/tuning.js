// Все числа игры в одном месте — прямой аналог GameTuning.cs из Unity-версии.
//
// Имена полей совпадают с Unity намеренно: веб здесь работает лабораторией.
// Когда ощущения сойдутся, значения переносятся обратно в GameTuning
// подстановкой, а не пересочиняются заново.
//
// Всё, что видно в панели настроек, читается контроллерами каждый кадр,
// поэтому ползунок меняет поведение сразу, без перезапуска.

export const tuning = {
  // --- Арена ---
  arenaRadius: 7.5,
  arenaThickness: 0.9,
  killY: -14,

  // --- Физика мира ---
  // Тяжелее реальной: падение с арены должно читаться быстро.
  gravity: -26,

  // --- Движение ---
  maxRunSpeed: 4.0,
  moveAccel: 16,
  moveBrake: 10,
  // Управление в воздухе малое намеренно: сбитый должен долетать до края,
  // а не выруливать обратно на арену.
  airControl: 4,
  turnSpeed: 420,
  // Насколько теряется управление во время проноса. Удар должен чего-то стоить.
  swingMoveLock: 0.2,

  // --- Шаг ---
  stepRate: 2.4,
  stepLength: 0.28,
  stepBob: 0.07,

  // --- Вес и шаткость ---
  wobbleAmount: 0.5,
  wobbleRate: 1.1,
  leanFromAccel: 0.06,
  // Отставание дубины при развороте: отсюда у неё берётся вес.
  limbLag: 0.12,

  // --- Желейность ---
  jellyAmount: 1,
  jellyStiffness: 120,
  jellyDamping: 8,

  // --- Удар ---
  // reach и drop теперь задают положение ХВАТА, а не центра дубины: кисти
  // обязаны оказаться там, куда руки дотягиваются. Прежние значения уводили
  // хват на 1.13 м от плеча при длине руки 0.68 — рука до дубины физически
  // не доставала и висела в воздухе отдельным обрубком.
  // Дубина в покое висит СБОКУ, а не за спиной по центру. Центр был
  // единственным местом, куда дотягивались обе руки, и держать её там
  // приходилось в обнимку перед собой. Теперь боец несёт её одной рукой,
  // как человек носит тяжёлое, а вторая приходит на рукоять на замахе.
  carryAngle: 100,
  carryReach: 0.30,
  carryDrop: -0.38,
  // Наклон дубины к земле в покое, градусов. Почти отвесно — она свисает
  // из опущенной руки и идёт набалдашником у самого настила.
  carryPitch: 72,
  chargeMoveSlow: 0.45,
  swingChargeTime: 0.5,
  swingStrikeTime: 0.18,
  swingRecoverTime: 0.16,
  swingCooldown: 0.12,
  swingArcDegrees: 150,
  windUpReach: 0.50,
  handMaxReach: 0.62,
  swingWeakestPower: 0.5,

  // --- Удары ---
  // Пределы выставлены по замеренной скорости набалдашника: на полном проносе
  // он идёт под 50 м/с, к концу дуги затухает почти до нуля. Прежние 4.5/24
  // из Unity-версии оказались ниже всего рабочего диапазона — любое касание
  // считалось максимальным, и разницы между началом и хвостом дуги не было.
  minImpactSpeed: 8,
  maxImpactSpeed: 42,
  // Замерено на стенде: незаряженный удар отбрасывает метра на четыре,
  // полный — метров на пять. С прежними числами любой удар в центре арены
  // выносил сразу за кромку, и край переставал быть местом, куда соперника
  // ещё надо подвести.
  minKnockback: 2.5,
  maxKnockback: 7,
  knockUpBias: 0.35,
  hitCooldown: 0.22,
  hitStopMax: 0.055,
  shakeMul: 0.9,

  // --- Ragdoll ---
  // Доля скорости, теряемая за секунду. 0 — идеальный вакуум, тело кувыркается вечно.
  ragdollDrag: 0.25,
  // Трение о настил, тоже за секунду. Низкое — тряпку несёт по арене и она
  // вылетает за край; высокое — прилипает там, где упала.
  ragdollFriction: 0.99,
  // Упругость отскока от настила.
  ragdollBounce: 0.12,
  // Сколько проходов решателя ограничений за шаг. Больше — жёстче скелет.
  ragdollIterations: 6,

  // --- Подъём после падения ---
  standUpSettle: 0.45,
  standUpTimeout: 3,
  standUpTime: 0.5,

  // --- Прицел ---
  aimMaxRadiusFactor: 1.35,
  showAimLink: true,

  // --- Камера ---
  camPitch: 55,
  camYaw: 0,
  camDistance: 21,
  camFov: 42,
  camFollowWeight: 0.45,
  camSmooth: 0.18,
  camLookAhead: 0.35,

  // --- Песочница ---
  dummyCount: 3,
  dummyRespawnDelay: 1.5,
  showClubTrail: true,
  // Замедление по клавише F: видно форму дуги и момент касания.
  slowMotion: 0.25,
};

// Значения по умолчанию — для кнопки «сброс». Копия снимается до того,
// как localStorage успеет что-то перезаписать.
export const defaults = { ...tuning };

// Описание панели. Порядок и заголовки повторяют [Header] из GameTuning.
export const tuneGroups = [
  {
    title: 'Движение',
    items: [
      ['maxRunSpeed', 1, 9, 0.1],
      ['moveAccel', 2, 60, 0.5],
      ['moveBrake', 2, 60, 0.5],
      ['turnSpeed', 90, 1080, 10],
      ['swingMoveLock', 0, 1, 0.05],
      ['chargeMoveSlow', 0.1, 1, 0.05],
    ],
  },
  {
    title: 'Шаг',
    items: [
      ['stepRate', 0.5, 6, 0.1],
      ['stepLength', 0, 0.8, 0.01],
      ['stepBob', 0, 0.3, 0.005],
    ],
  },
  {
    title: 'Вес и шаткость',
    items: [
      ['wobbleAmount', 0, 2, 0.05],
      ['wobbleRate', 0.1, 4, 0.05],
      ['leanFromAccel', 0, 0.3, 0.005],
      ['limbLag', 0, 0.5, 0.01],
    ],
  },
  {
    title: 'Желейность',
    items: [
      ['jellyAmount', 0, 1, 0.05],
      ['jellyStiffness', 20, 400, 5],
      ['jellyDamping', 1, 30, 0.5],
    ],
  },
  {
    title: 'Замах',
    items: [
      ['carryAngle', 90, 180, 1],
      ['carryReach', 0, 0.6, 0.02],
      ['carryDrop', -0.7, 0.2, 0.02],
      ['carryPitch', -30, 90, 2],
      ['swingChargeTime', 0.1, 1.5, 0.02],
      ['swingStrikeTime', 0.06, 0.5, 0.01],
      ['swingRecoverTime', 0.05, 0.6, 0.01],
      ['swingArcDegrees', 60, 260, 5],
      ['windUpReach', 0.1, 0.8, 0.02],
      ['handMaxReach', 0.3, 0.9, 0.02],
    ],
  },
  {
    title: 'Сила ударов',
    items: [
      ['minImpactSpeed', 0.5, 30, 0.5],
      ['maxImpactSpeed', 10, 70, 1],
      ['minKnockback', 0, 20, 0.5],
      ['maxKnockback', 3, 45, 0.5],
      ['knockUpBias', 0, 1.2, 0.05],
    ],
  },
  {
    title: 'Тряпка',
    items: [
      ['ragdollDrag', 0, 0.95, 0.05],
      ['ragdollFriction', 0.5, 0.999, 0.005],
      ['ragdollBounce', 0, 0.6, 0.02],
      ['standUpSettle', 0, 2, 0.05],
      ['standUpTime', 0.1, 2, 0.05],
    ],
  },
  {
    title: 'Мир и камера',
    items: [
      ['gravity', -60, -6, 1],
      ['arenaRadius', 3, 16, 0.25],
      ['camPitch', 25, 85, 1],
      ['camDistance', 10, 40, 0.5],
      ['camFov', 20, 80, 1],
      ['camFollowWeight', 0, 1, 0.05],
      ['dummyCount', 0, 6, 1],
    ],
  },
  {
    title: 'Показывать',
    items: [
      ['showClubTrail', 'bool'],
      ['showAimLink', 'bool'],
    ],
  },
];

// Версия в ключе — не формальность. carryReach и carryDrop теперь задают
// положение хвата, а не центра дубины, и старые сохранённые значения
// снова растащили бы руки. Меняем ключ вместе со смыслом полей.
const STORAGE_KEY = 'topkong.tuning.v2';

/** Подтянуть сохранённые значения. Настройки переживают перезагрузку —
 *  иначе подбирать ощущения с телефона невозможно. */
export function loadTuning() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    for (const key of Object.keys(defaults)) {
      if (key in saved && typeof saved[key] === typeof defaults[key]) {
        tuning[key] = saved[key];
      }
    }
  } catch (e) {
    // Приватный режим и заблокированное хранилище — не повод не запускать игру.
  }
}

export function saveTuning() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tuning));
  } catch (e) { /* см. выше */ }
}

export function resetTuning() {
  Object.assign(tuning, defaults);
  saveTuning();
}
