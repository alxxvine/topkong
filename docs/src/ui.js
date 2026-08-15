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
// The tuning stage is CLOSING: the playtest winners are baked in as
// defaults and their tabs are gone — Movement runs Drunk (slow, swaying,
// lazy dash), Strike runs Heavy with an extra-long side swing (the fast
// blow clashed with the drunk walk), the overhead is the Executioner cut,
// Stamina is the tight middle grade, clubs are on for EVERYONE (the
// bare-fist mode is hidden — equal footing). The one thing still being
// tested is the Rising animation.
//
// BAKED overrides the saved tuning on every boot: the testing builds wrote
// preset experiments into localStorage, and without the force any stale
// pick would shadow the new defaults forever.
const BAKED = {
  // Movement: Drunk.
  maxRunSpeed: 1.0, strafeSpeed: 0.45, backSpeed: 0.5, turnSpeed: 160,
  dashPower: 1.4, dashCooldown: 1.1, leanAmount: 1.3, drunk: 0.25,
  // Strike pacing: Heavy, with the side swing slowed to match the walk.
  swingSpeed: 0.85, swingChargeTime: 0.6, swingRecoverTime: 0.22, swingCooldown: 0.18,
  sideWind: 3.2, sideTime: 1.2,
  // Overhead pacing: the Executioner variant's own beat.
  overheadWind: 6, overheadTime: 0.85,
  // Stamina: the tight middle grade — every swing is a real spend.
  staminaOn: true, staminaRegen: 0.35, staminaDelay: 0.7,
  staminaClubCost: 0.42, staminaPunchCost: 0.15,
  staminaDashCost: 0.55, staminaBlockDrain: 0.3,
  // One weapon culture: everyone swings a club, fists are hidden.
  withClub: true, botsArmed: true, botsActive: true,
};

// Animation VARIANTS for the rising strike: these rewrite the strike's
// GEOMETRY — where the club chambers, what arc it travels, how it
// finishes — plus its own pacing. Applying one mutates the style object
// in SWING_STYLES (shared with the bots) and mirrors wind/time into the
// tuning keys. The picked name persists and is re-applied on boot,
// because style fields live in code, not in the saved tuning.
//
// The first cut of this list was five nudges around one diagonal rip and
// read as five copies. This one spreads the MOVES: the arcs start a body
// apart, the sweeps run 0.6..1.15 of the base beat, the finishes range
// from a flat push to a straight-overhead launch.
const STRIKE_VARIANTS = {
  Rising: {
    index: 2,
    list: [
      { name: 'Classic', hint: 'dip back-down, diagonal rip',
        style: { aFrom: [0.55, 5], aTo: [0, -10], wH: -0.38, wP: 76, hF: -0.38, hT: 0.55,
                 pF: 76, pT: -60, up: 3.2, pow: 1.15, time: 0.85, wind: 6.5, windMin: 0.3 } },
      { name: 'Golf', hint: 'wide lazy sweep from way outside',
        style: { aFrom: [1.1, 12], aTo: [-0.25, -4], wH: -0.26, wP: 55, hF: -0.26, hT: 0.32,
                 pF: 55, pT: -30, up: 2.2, pow: 1.35, time: 1.0, wind: 5, windMin: 0.28 } },
      { name: 'Piston', hint: 'long pull, instant vertical punch',
        style: { aFrom: [0.15, 4], aTo: [0, -6], wH: -0.5, wP: 88, hF: -0.5, hT: 0.78,
                 pF: 88, pT: -85, up: 4.4, pow: 1.0, time: 0.6, wind: 7.5, windMin: 0.38 } },
      { name: 'Shovel', hint: 'deepest dig, heavy flat push',
        style: { aFrom: [0.5, 6], aTo: [0.05, -14], wH: -0.55, wP: 82, hF: -0.55, hT: 0.22,
                 pF: 82, pT: -20, up: 2.4, pow: 1.45, time: 1.1, wind: 5.5, windMin: 0.36 } },
      { name: 'Moonshot', hint: 'slow ceremony, sky launch',
        style: { aFrom: [0.7, 8], aTo: [0, -8], wH: -0.44, wP: 80, hF: -0.44, hT: 0.85,
                 pF: 80, pT: -90, up: 5.5, pow: 1.0, time: 1.15, wind: 8.5, windMin: 0.45 } },
    ],
  },
};

// The Match switches (clubs / bots fight / bots armed / sound) retired
// with the rest of the settled settings: one weapon culture, live bots,
// sound on. The raw toggles live on in the big debug panel.
const QUICK = [];

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
    const applyVariant = (group) => (preset) => {
      Object.assign(SWING_STYLES[STRIKE_VARIANTS[group].index], preset.style);
      // Pacing rides in the same variant; mirror it into the live keys.
      T[group.toLowerCase() + 'Wind'] = preset.style.wind;
      T[group.toLowerCase() + 'Time'] = preset.style.time;
      saveTuning();
    };

    // The baked winners win over whatever the testing builds stored.
    for (const [k, v] of Object.entries(BAKED)) T[k] = v;
    // The retired tabs' bookmarks would otherwise linger forever.
    try {
      localStorage.removeItem('tk-preset-Movement');
      localStorage.removeItem('tk-preset-Strike');
      localStorage.removeItem('tk-preset-Stamina');
      localStorage.removeItem('tk-variant-Overhead');
    } catch { /* private mode */ }
    saveTuning();

    for (const group of Object.keys(STRIKE_VARIANTS)) {
      const picked = makeGroup(group, STRIKE_VARIANTS[group].list,
        'tk-variant-' + group, applyVariant(group));
      // Geometry lives in code, not in saved tuning: the stored variant
      // must be re-applied on every boot (Classic is the code default,
      // but applying it anyway keeps one path). applyVariant also mirrors
      // the variant's pacing over the baked keys.
      const v = STRIKE_VARIANTS[group].list.find((x) => x.name === picked);
      if (v) applyVariant(group)(v);
    }

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
    // Any stale tab name falls back to the first live section inside.
    this.showQuickTab(saved || '');

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
