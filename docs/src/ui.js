import { tuning as T, tuneGroups, saveTuning, resetTuning } from 'tk/tuning.js';
import { SWING_STYLES } from 'tk/swingAction.js';
import { BODIES, bodyNames, currentBody, chooseBody } from 'tk/skeleton.js';

// Интерфейс: строка состояния и панель ползунков.
//
// Панель — главная причина, ради которой веб-версия вообще делается.
// Подкрутить желейность или силу удара и увидеть результат можно за секунду,
// в том числе с телефона, без Unity и без пересборки. Значения сохраняются
// в localStorage, поэтому подобранное не теряется при перезагрузке.

// Ручки, которые крутят прямо по ходу боя.
//
// Отдельно от большой панели не ради красоты: та скрыта в игре целиком
// и показывает полсотни служебных чисел под их же именами из кода. Здесь
// имена человеческие, и каждая ручка едет ВПРАВО = БЫСТРЕЕ (сильнее).
// Последнее пришлось делать руками: вставание и удар хранятся временем,
// то есть ползунок «скорость», сползающий влево при ускорении, читался бы
// сломанным. Поэтому у каждой строки своё чтение и своя запись.
// Presets. The tuning stage is over for the player-facing panel: instead
// of two dozen sliders there are five flavors per system, tap and feel.
// Each preset is a complete bundle — applying one overwrites every knob
// it owns, so presets never half-mix. The raw sliders live on in the big
// Settings panel for surgery; the winners get baked in as defaults.
const PRESETS = {
  Movement: [
    { name: 'Drunk', hint: 'slow, swaying, lazy dash',
      set: { maxRunSpeed: 1.0, strafeSpeed: 0.45, backSpeed: 0.5, turnSpeed: 160,
             dashPower: 1.4, dashCooldown: 1.1, leanAmount: 1.3, drunk: 0.25 } },
    { name: 'Classic', hint: 'the build you know',
      set: { maxRunSpeed: 1.3, strafeSpeed: 0.5, backSpeed: 0.55, turnSpeed: 220,
             dashPower: 1.9, dashCooldown: 0.9, leanAmount: 1.0, drunk: 0 } },
    { name: 'Brisk', hint: 'a step quicker everywhere',
      set: { maxRunSpeed: 1.6, strafeSpeed: 0.55, backSpeed: 0.6, turnSpeed: 280,
             dashPower: 2.2, dashCooldown: 0.8, leanAmount: 1.1, drunk: 0 } },
    { name: 'Nimble', hint: 'fast feet, sharp turns',
      set: { maxRunSpeed: 1.9, strafeSpeed: 0.65, backSpeed: 0.7, turnSpeed: 340,
             dashPower: 2.6, dashCooldown: 0.7, leanAmount: 1.2, drunk: 0 } },
    { name: 'Turbo', hint: 'arcade speed',
      set: { maxRunSpeed: 2.3, strafeSpeed: 0.7, backSpeed: 0.75, turnSpeed: 420,
             dashPower: 3.2, dashCooldown: 0.6, leanAmount: 1.3, drunk: 0 } },
  ],
  Strike: [
    // Every flavor keeps the same formula — a LONG readable windup and a
    // FAST blow (the pick from playtesting); they differ in how far that
    // contrast is pushed and how quickly strikes chain.
    { name: 'Heavy', hint: 'slowest chain, biggest weight',
      set: { swingSpeed: 0.85, swingChargeTime: 0.6, swingRecoverTime: 0.22, swingCooldown: 0.18,
             sideWind: 2.2, sideTime: 0.9, overheadWind: 6.5, overheadTime: 0.85,
             risingWind: 6.5, risingTime: 0.85 } },
    { name: 'Classic', hint: 'the baseline: wind up, snap',
      set: { swingSpeed: 1, swingChargeTime: 0.5, swingRecoverTime: 0.16, swingCooldown: 0.12,
             sideWind: 1.8, sideTime: 0.85, overheadWind: 5.5, overheadTime: 0.8,
             risingWind: 5.5, risingTime: 0.8 } },
    { name: 'Snappy', hint: 'same formula, brisker chain',
      set: { swingSpeed: 1.1, swingChargeTime: 0.45, swingRecoverTime: 0.13, swingCooldown: 0.1,
             sideWind: 1.5, sideTime: 0.78, overheadWind: 4.5, overheadTime: 0.75,
             risingWind: 4.5, risingTime: 0.75 } },
    { name: 'Frenzy', hint: 'shortest raises that still read',
      set: { swingSpeed: 1.2, swingChargeTime: 0.4, swingRecoverTime: 0.11, swingCooldown: 0.08,
             sideWind: 1.2, sideTime: 0.72, overheadWind: 3.6, overheadTime: 0.7,
             risingWind: 3.6, risingTime: 0.7 } },
    { name: 'Telegraph', hint: 'duel pace: huge raises, hard punishes',
      set: { swingSpeed: 0.95, swingChargeTime: 0.55, swingRecoverTime: 0.18, swingCooldown: 0.15,
             sideWind: 2.8, sideTime: 0.8, overheadWind: 7, overheadTime: 0.75,
             risingWind: 7, risingTime: 0.75 } },
  ],
  Stamina: [
    { name: 'Off', hint: 'infinite everything',
      set: { staminaOn: false } },
    { name: 'Light', hint: 'barely noticeable',
      set: { staminaOn: true, staminaRegen: 0.7, staminaClubCost: 0.22,
             staminaPunchCost: 0.08, staminaDashCost: 0.3, staminaBlockDrain: 0.15 } },
    { name: 'Classic', hint: 'the build you know',
      set: { staminaOn: true, staminaRegen: 0.45, staminaClubCost: 0.32,
             staminaPunchCost: 0.11, staminaDashCost: 0.42, staminaBlockDrain: 0.22 } },
    { name: 'Strict', hint: 'every swing counts',
      set: { staminaOn: true, staminaRegen: 0.35, staminaClubCost: 0.42,
             staminaPunchCost: 0.15, staminaDashCost: 0.55, staminaBlockDrain: 0.3 } },
    { name: 'Hardcore', hint: 'two swings and a nap',
      set: { staminaOn: true, staminaRegen: 0.25, staminaClubCost: 0.5,
             staminaPunchCost: 0.18, staminaDashCost: 0.7, staminaBlockDrain: 0.4 } },
  ],
};

// Animation VARIANTS for the two vertical strikes: unlike the pacing
// presets these rewrite the strike's GEOMETRY — where the club chambers,
// what arc it travels, how it finishes — plus its own pacing. Applying
// one mutates the style object in SWING_STYLES (shared with the bots)
// and mirrors wind/time into the tuning keys. The picked name persists
// and is re-applied on boot, because style fields live in code, not in
// the saved tuning.
const STRIKE_VARIANTS = {
  Overhead: {
    index: 1,
    list: [
      { name: 'Classic', hint: 'raise high, chop past the knee',
        style: { aFrom: [0, 15], aTo: [0, -12], wH: 0.6, wP: -75, hF: 0.55, hT: -0.08,
                 pF: -70, pT: 28, up: 0.7, pow: 1.8, time: 0.8, wind: 5.5, windMin: 0.24 } },
      { name: 'Executioner', hint: 'dead vertical, deep finish',
        style: { aFrom: [0, 10], aTo: [0, -10], wH: 0.72, wP: -88, hF: 0.7, hT: -0.15,
                 pF: -85, pT: 35, up: 0.6, pow: 1.9, time: 0.85, wind: 6, windMin: 0.3 } },
      { name: 'Hammer', hint: 'compact raise, quick chop',
        style: { aFrom: [0, 15], aTo: [0, -12], wH: 0.45, wP: -55, hF: 0.42, hT: -0.02,
                 pF: -55, pT: 22, up: 0.7, pow: 1.6, time: 0.7, wind: 4, windMin: 0.18 } },
      { name: 'Diagonal', hint: 'comes down at a slant',
        style: { aFrom: [0.3, 12], aTo: [-0.18, -4], wH: 0.55, wP: -65, hF: 0.5, hT: -0.05,
                 pF: -62, pT: 20, up: 0.75, pow: 1.7, time: 0.8, wind: 5, windMin: 0.24 } },
      { name: 'Smash', hint: 'highest raise, hardest drop',
        style: { aFrom: [0, 18], aTo: [0, -14], wH: 0.66, wP: -80, hF: 0.62, hT: -0.12,
                 pF: -75, pT: 40, up: 0.65, pow: 2, time: 0.75, wind: 6.5, windMin: 0.3 } },
    ],
  },
  Rising: {
    index: 2,
    list: [
      { name: 'Classic', hint: 'dip back-down, diagonal rip',
        style: { aFrom: [0.55, 5], aTo: [0, -10], wH: -0.38, wP: 76, hF: -0.38, hT: 0.55,
                 pF: 76, pT: -60, up: 3.2, pow: 1.15, time: 0.8, wind: 5.5, windMin: 0.3 } },
      { name: 'Golf', hint: 'wider arc from the hip',
        style: { aFrom: [0.85, 8], aTo: [-0.12, -2], wH: -0.3, wP: 65, hF: -0.3, hT: 0.5,
                 pF: 65, pT: -50, up: 2.8, pow: 1.2, time: 0.85, wind: 4.5, windMin: 0.26 } },
      { name: 'Uppercut', hint: 'straight up the front',
        style: { aFrom: [0.2, 8], aTo: [0, -8], wH: -0.32, wP: 68, hF: -0.32, hT: 0.6,
                 pF: 68, pT: -75, up: 3.6, pow: 1.05, time: 0.75, wind: 6, windMin: 0.32 } },
      { name: 'Scoop', hint: 'deepest dip, flatter finish',
        style: { aFrom: [0.5, 5], aTo: [0, -12], wH: -0.44, wP: 82, hF: -0.44, hT: 0.42,
                 pF: 82, pT: -40, up: 3, pow: 1.25, time: 0.8, wind: 5, windMin: 0.34 } },
      { name: 'Launcher', hint: 'same path, harder lift',
        style: { aFrom: [0.55, 5], aTo: [0, -10], wH: -0.38, wP: 76, hF: -0.38, hT: 0.58,
                 pF: 76, pT: -65, up: 4.2, pow: 1.1, time: 0.75, wind: 5.5, windMin: 0.3 } },
    ],
  },
};

const QUICK = [
  // The fight-test switches stay raw: they help testing, not tuning.
  {
    // Оружие меняет игру целиком — с ним бой про удар, без него про толчок
    // телом, — и переключать это надо на ходу, а не искать в отладочной
    // панели.
    group: 'Match',
    label: 'Clubs',
    bool: true,
    get: () => !!T.withClub,
    set: (v) => { T.withClub = v; },
  },
  {
    // Стоящие манекены: спокойно пробовать управление, удары и толчки.
    label: 'Bots fight',
    bool: true,
    get: () => !!T.botsActive,
    set: (v) => { T.botsActive = v; },
  },
  {
    // Игрок с дубиной против безоружных — легитимный способ играть.
    label: 'Bots armed',
    bool: true,
    get: () => !!T.botsArmed,
    set: (v) => { T.botsArmed = v; },
  },
  {
    label: 'Sound',
    bool: true,
    get: () => !!T.sound,
    set: (v) => { T.sound = v; },
  },
];

export class Ui {
  constructor() {
    this.hud = document.getElementById('hud');
    // Кнопка удара исчезает вместе с оружием: живая на вид, но мёртвая
    // на нажатие кнопка сбивает с толку сильнее, чем её отсутствие.
    this.swingButton = document.getElementById('swing');
    this.banner = document.getElementById('banner');
    this.bannerBig = document.getElementById('bannerBig');
    this.bannerSmall = document.getElementById('bannerSmall');
    this.bannerText = null;
    this.panel = document.getElementById('tune');
    this.body = document.getElementById('tuneBody');
    this.rows = [];

    this.quick = document.getElementById('quick');
    this.quickBody = document.getElementById('quickBody');
    this.pauseButton = document.getElementById('pause');
    this.pauseVeil = document.getElementById('paused');
    /** Ставит main: ему принадлежит сам флаг паузы. */
    this.onPauseToggle = null;

    // Номер сборки пишется один раз и висит внизу экрана постоянно:
    // сверяться, доехало ли обновление, нужно без похода в паузу.
    const tag = document.getElementById('buildTag');
    if (tag) tag.textContent = 'build ' + (window.TK_BUILD || '?');

    this.buildPanel();
    this.buildQuick();
    this.bindFold();
    this.bindPause();
  }

  buildQuick() {
    if (!this.quickBody) return;
    // Tabs, one group at a time. Five groups in one column ran the panel
    // past the bottom of the screen with overflow:hidden on top — half
    // the sliders were simply unreachable. A tab bar keeps every group
    // short enough to fit, and the active tab survives reloads.
    this.quickTabs = document.createElement('div');
    this.quickTabs.id = 'quickTabs';
    this.quickBody.appendChild(this.quickTabs);
    this.quickSections = new Map();
    this.quickSection = null;

    // The preset tabs come first: five flavors per system, one tap each.
    // The vertical-strike ANIMATION variants slot in after the pacing.
    const makeGroup = (group, list, storeKey, apply) => {
      const section = document.createElement('div');
      section.className = 'qsec';
      this.quickBody.appendChild(section);
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.textContent = group;
      tab.addEventListener('click', () => this.showQuickTab(group));
      this.quickTabs.appendChild(tab);
      this.quickSections.set(group, { section, tab });

      let picked = null;
      try { picked = localStorage.getItem(storeKey); } catch { /* private */ }
      for (const preset of list) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'preset';
        const nm = document.createElement('b');
        nm.textContent = preset.name;
        const hint = document.createElement('small');
        hint.textContent = preset.hint;
        b.append(nm, hint);
        if (preset.name === (picked || 'Classic')) b.classList.add('sel');
        b.addEventListener('click', () => {
          apply(preset);
          try { localStorage.setItem(storeKey, preset.name); } catch { /* private */ }
          for (const other of section.children) other.classList.remove('sel');
          b.classList.add('sel');
          // The big panel's sliders must re-read the values just written.
          for (const r of this.rows) r.show();
          this.onTuned?.();
        });
        section.appendChild(b);
      }
      return picked;
    };
    const applySet = (preset) => {
      for (const [k, v] of Object.entries(preset.set)) T[k] = v;
      saveTuning();
    };
    const applyVariant = (group) => (preset) => {
      Object.assign(SWING_STYLES[STRIKE_VARIANTS[group].index], preset.style);
      // Pacing rides in the same variant; mirror it into the live keys.
      T[group.toLowerCase() + 'Wind'] = preset.style.wind;
      T[group.toLowerCase() + 'Time'] = preset.style.time;
      saveTuning();
    };

    makeGroup('Movement', PRESETS.Movement, 'tk-preset-Movement', applySet);
    makeGroup('Strike', PRESETS.Strike, 'tk-preset-Strike', applySet);
    for (const group of Object.keys(STRIKE_VARIANTS)) {
      const picked = makeGroup(group, STRIKE_VARIANTS[group].list,
        'tk-variant-' + group, applyVariant(group));
      // Geometry lives in code, not in saved tuning: the stored variant
      // must be re-applied on every boot (Classic is the code default,
      // but applying it anyway keeps one path).
      const v = STRIKE_VARIANTS[group].list.find((x) => x.name === picked);
      if (v) Object.assign(SWING_STYLES[STRIKE_VARIANTS[group].index], v.style);
    }
    makeGroup('Stamina', PRESETS.Stamina, 'tk-preset-Stamina', applySet);

    for (const item of QUICK) {
      if (item.group) {
        const section = document.createElement('div');
        section.className = 'qsec';
        this.quickBody.appendChild(section);
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.textContent = item.group;
        tab.addEventListener('click', () => this.showQuickTab(item.group));
        this.quickTabs.appendChild(tab);
        this.quickSections.set(item.group, { section, tab });
        this.quickSection = section;
      }
      this.addQuickRow(item);
    }
    let saved = null;
    try { saved = localStorage.getItem('tk-quicktab'); } catch { /* private mode */ }
    this.showQuickTab(saved || QUICK[0].group);

    const head = document.getElementById('quickHead');
    // На телефоне панель начинается свёрнутой: девять строк занимают
    // половину экрана, и арену за ними не видно. Заголовок при этом
    // на месте, разворачивается одним касанием.
    if (matchMedia('(max-width: 560px)').matches) {
      this.quick.classList.add('folded');
      head.querySelector('.chev').textContent = '▾';
    }
    head.addEventListener('click', () => {
      this.quick.classList.toggle('folded');
      head.querySelector('.chev').textContent =
        this.quick.classList.contains('folded') ? '▾' : '▴';
    });
  }

  showQuickTab(name) {
    if (!this.quickSections.has(name)) {
      name = this.quickSections.keys().next().value;
    }
    for (const [g, { section, tab }] of this.quickSections) {
      section.classList.toggle('on', g === name);
      tab.classList.toggle('on', g === name);
    }
    try { localStorage.setItem('tk-quicktab', name); } catch { /* private mode */ }
  }

  addQuickRow(item) {
    if (item.bool) return this.addQuickCheck(item);

    const row = document.createElement('div');
    row.className = 'row';

    const label = document.createElement('div');
    label.className = 'lbl';
    const name = document.createElement('span');
    name.textContent = item.label;
    const value = document.createElement('span');
    label.append(name, value);

    const input = document.createElement('input');
    input.type = 'range';
    input.min = item.min;
    input.max = item.max;
    input.step = item.step;

    const show = () => {
      const v = item.get();
      value.textContent = format(v, item.step) + (item.unit || '');
      // Ползунок не трогаем, пока его тянут: иначе палец спорит с обновлением.
      if (document.activeElement !== input) input.value = v;
    };

    input.addEventListener('input', () => {
      item.set(parseFloat(input.value));
      show();
      saveTuning();
      this.onTuned?.();
    });

    row.append(label, input);
    (this.quickSection || this.quickBody).appendChild(row);
    // В общий список тоже: после «Сбросить» эти обязаны перечитаться.
    this.rows.push({ key: item.label, input, show, quick: true });
    show();
  }

  addQuickCheck(item) {
    const row = document.createElement('div');
    row.className = 'row check';

    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    const span = document.createElement('span');
    span.textContent = item.label;
    label.append(input, span);

    const show = () => { input.checked = !!item.get(); };
    input.addEventListener('change', () => {
      item.set(input.checked);
      show();
      saveTuning();
      this.onTuned?.();
    });

    row.appendChild(label);
    (this.quickSection || this.quickBody).appendChild(row);
    this.rows.push({ key: item.label, input, show, quick: true });
    show();
  }

  /**
   * Пауза. Кнопка в углу, щелчок по затемнению и клавиши Esc и P —
   * три входа в одно и то же, потому что искать один-единственный
   * способ остановить игру никто не будет.
   */
  bindPause() {
    const toggle = () => { if (this.onPauseToggle) this.onPauseToggle(); };
    if (this.pauseButton) this.pauseButton.addEventListener('click', toggle);
    if (this.pauseVeil) this.pauseVeil.addEventListener('click', toggle);
    addEventListener('keydown', (e) => {
      if (e.code === 'Escape' || e.code === 'KeyP') { e.preventDefault(); toggle(); }
    });
  }

  setPaused(on) {
    document.body.classList.toggle('paused', on);
    if (this.pauseButton) {
      this.pauseButton.textContent = on ? '▶' : '❙❙';
      this.pauseButton.setAttribute('aria-label', on ? 'Resume' : 'Pause');
    }
  }

  bindFold() {
    const head = document.getElementById('tuneHead');
    head.addEventListener('click', () => {
      this.panel.classList.toggle('folded');
      head.querySelector('.chev').textContent =
        this.panel.classList.contains('folded') ? '▾' : '▴';
    });
  }

  buildPanel() {
    this.addBodyPicker();
    for (const group of tuneGroups) {
      const title = document.createElement('div');
      title.className = 'grp';
      title.textContent = group.title;
      this.body.appendChild(title);

      for (const item of group.items) {
        const key = item[0];
        if (item[1] === 'bool') this.addCheck(key);
        else this.addSlider(key, item[1], item[2], item[3]);
      }
    }

    const btns = document.createElement('div');
    btns.className = 'btns';

    const reset = document.createElement('button');
    reset.textContent = 'Reset';
    reset.addEventListener('click', () => {
      resetTuning();
      this.refresh();
    });

    const copy = document.createElement('button');
    copy.textContent = 'Copy JSON';
    copy.addEventListener('click', async () => {
      const text = JSON.stringify(T, null, 2);
      try {
        await navigator.clipboard.writeText(text);
        copy.textContent = 'copied';
      } catch (e) {
        // Буфер обмена без https недоступен — тогда просто в консоль.
        console.log(text);
        copy.textContent = 'see console';
      }
      setTimeout(() => { copy.textContent = 'Copy JSON'; }, 1400);
    });

    btns.append(reset, copy);
    this.body.appendChild(btns);
  }

  /**
   * Выбор телосложения.
   *
   * Кнопками, а не ползунком: тело меняет длины связей, массы и панели,
   * и подменять их посреди кадра значило бы пересобирать бойца на ходу
   * ради того, чтобы не нажимать перезагрузку. Перезагрузка честнее.
   */
  addBodyPicker() {
    const title = document.createElement('div');
    title.className = 'grp';
    title.textContent = 'Body type';
    this.body.appendChild(title);

    const row = document.createElement('div');
    row.className = 'btns';
    for (const name of bodyNames) {
      const b = document.createElement('button');
      b.textContent = BODIES[name].title || name;
      if (name === currentBody) {
        b.style.borderColor = 'var(--accent)';
        b.style.color = 'var(--accent)';
      }
      b.addEventListener('click', () => chooseBody(name));
      row.appendChild(b);
    }
    this.body.appendChild(row);
  }

  addSlider(key, min, max, step) {
    const row = document.createElement('div');
    row.className = 'row';

    const label = document.createElement('div');
    label.className = 'lbl';
    const name = document.createElement('span');
    name.textContent = key;
    const value = document.createElement('span');
    label.append(name, value);

    const input = document.createElement('input');
    input.type = 'range';
    input.min = min;
    input.max = max;
    input.step = step;
    input.value = T[key];

    const show = () => { value.textContent = format(T[key], step); };

    input.addEventListener('input', () => {
      T[key] = parseFloat(input.value);
      show();
      saveTuning();
      this.onTuned?.();
    });

    row.append(label, input);
    this.body.appendChild(row);
    this.rows.push({ key, input, show });
    show();
  }

  addCheck(key) {
    const row = document.createElement('div');
    row.className = 'row check';

    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!T[key];
    const span = document.createElement('span');
    span.textContent = key;
    label.append(input, span);

    input.addEventListener('change', () => {
      T[key] = input.checked;
      saveTuning();
      this.onTuned?.();
    });

    row.appendChild(label);
    this.body.appendChild(row);
    this.rows.push({ key, input, show: () => { input.checked = !!T[key]; } });
  }

  /** Перечитать значения в виджеты — после сброса. */
  refresh() {
    for (const row of this.rows) {
      // Быстрые ручки читают и пишут своё, по имени настройки их не найти.
      if (row.quick) { row.show(); continue; }
      if (row.input.type === 'checkbox') row.input.checked = !!T[row.key];
      else row.input.value = T[row.key];
      row.show();
    }
  }

  /**
   * Крупная надпись посреди экрана: отсчёт, победа, поражение.
   *
   * Текст переписывается только когда он ДЕЙСТВИТЕЛЬНО изменился —
   * иначе анимация появления перезапускается каждый кадр и надпись
   * мигает вместо того, чтобы всплыть один раз.
   */
  setBanner(b) {
    const key = b ? b.big + '|' + b.small : '';
    if (key === this.bannerText) return;
    this.bannerText = key;
    if (!this.banner) return;
    this.banner.classList.toggle('on', !!b);
    if (!b) return;
    this.bannerBig.textContent = b.big;
    this.bannerSmall.textContent = b.small;
    // Перезапуск анимации: без снятия класса второй раз она не проигрывается.
    this.banner.classList.remove('pop');
    void this.banner.offsetWidth;
    this.banner.classList.add('pop');
  }

  setHud(text) {
    if (this.hud.textContent !== text) this.hud.textContent = text;
  }
}

function format(value, step) {
  if (typeof value !== 'number') return String(value);
  const digits = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3;
  return value.toFixed(digits);
}
