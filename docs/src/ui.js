import { tuning as T, tuneGroups, saveTuning, resetTuning } from 'tk/tuning.js';
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
    for (const [group, list] of Object.entries(PRESETS)) {
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
      try { picked = localStorage.getItem('tk-preset-' + group); } catch { /* private */ }
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
          for (const [k, v] of Object.entries(preset.set)) T[k] = v;
          saveTuning();
          try { localStorage.setItem('tk-preset-' + group, preset.name); } catch { /* private */ }
          for (const other of section.children) other.classList.remove('sel');
          b.classList.add('sel');
          // The big panel's sliders must re-read the values just written.
          for (const r of this.rows) r.show();
          this.onTuned?.();
        });
        section.appendChild(b);
      }
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
