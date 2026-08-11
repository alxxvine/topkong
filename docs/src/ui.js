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
const QUICK = [
  {
    label: 'Ходьба',
    min: 0.3, max: 3.5, step: 0.05, unit: ' м/с',
    get: () => T.maxRunSpeed,
    set: (v) => { T.maxRunSpeed = v; },
  },
  {
    // Ход вбок и назад — ДОЛЯ от ходьбы, и ползунок выше её уже
    // масштабирует: замерено, при потолке 0.9 выходит 0.87 вперёд,
    // 0.48 назад и 0.45 вбок, при 2.4 — 2.32 / 1.27 / 1.18. Но доли эти
    // зажаты в половину, и потому кажется, что потолок на них не влияет.
    // Здесь они правятся напрямую. Назад чуть свободнее вбок, как и было.
    label: 'Вбок и назад',
    min: 0.15, max: 1, step: 0.05, unit: '×',
    get: () => T.strafeSpeed,
    set: (v) => { T.strafeSpeed = v; T.backSpeed = Math.min(1, v * 1.1); },
  },
  {
    label: 'Поворот',
    min: 60, max: 700, step: 10, unit: '°/с',
    get: () => T.turnSpeed,
    set: (v) => { T.turnSpeed = v; },
  },
  {
    label: 'Удар',
    min: 0.3, max: 3, step: 0.05, unit: '×',
    get: () => T.swingSpeed,
    set: (v) => { T.swingSpeed = v; },
  },
  {
    label: 'Возврат удара',
    min: 1, max: 12, step: 0.2, unit: '×',
    get: () => 1 / Math.max(0.02, T.swingRecoverTime),
    set: (v) => { T.swingRecoverTime = 1 / Math.max(0.02, v); },
  },
  {
    // Темп, а не откат: ползунок обязан ехать вправо = быстрее, как все
    // остальные. Чтобы удары нельзя было спамить, эту ручку тянут ВЛЕВО.
    label: 'Темп ударов',
    min: 0.5, max: 14, step: 0.2, unit: '/с',
    get: () => 1 / Math.max(0.02, T.swingCooldown),
    set: (v) => { T.swingCooldown = 1 / Math.max(0.02, v); },
  },
  {
    label: 'Вставание',
    min: 0.3, max: 6, step: 0.1, unit: '×',
    // Хранится время подъёма, показывается скорость.
    get: () => 1 / Math.max(0.05, T.standUpTime),
    set: (v) => { T.standUpTime = 1 / Math.max(0.05, v); },
  },
  {
    // Наклон в сторону хода. Он и делает походку походкой: без него
    // боец едет стоймя, и это читается роботом, сколько ни качай его
    // случайным шумом.
    label: 'Наклон',
    min: 0, max: 3, step: 0.05, unit: '×',
    get: () => T.leanAmount,
    set: (v) => { T.leanAmount = v; },
  },
  {
    label: 'Шаткость',
    min: 0, max: 1, step: 0.02, unit: '',
    get: () => T.drunk,
    set: (v) => { T.drunk = v; },
  },
  {
    // Единственный выключатель среди ручек. Оружие меняет игру целиком —
    // с ним бой про удар, без него про толчок телом, — и переключать это
    // надо на ходу, а не искать в отладочной панели.
    label: 'Оружие',
    bool: true,
    get: () => !!T.withClub,
    set: (v) => { T.withClub = v; },
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

    this.buildPanel();
    this.buildQuick();
    this.bindFold();
    this.bindPause();
  }

  buildQuick() {
    if (!this.quickBody) return;
    for (const item of QUICK) this.addQuickRow(item);

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
    });

    row.append(label, input);
    this.quickBody.appendChild(row);
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
    });

    row.appendChild(label);
    this.quickBody.appendChild(row);
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
    // Номер сборки показывается только на паузе: в бою он не нужен,
    // а свериться, доехало ли обновление, надо уметь всегда.
    const tag = document.getElementById('buildTag');
    if (tag && on) tag.textContent = 'сборка ' + (window.TK_BUILD || '?');
    if (this.pauseButton) {
      this.pauseButton.textContent = on ? '▶' : '❙❙';
      this.pauseButton.setAttribute('aria-label', on ? 'Продолжить' : 'Пауза');
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
    reset.textContent = 'Сбросить';
    reset.addEventListener('click', () => {
      resetTuning();
      this.refresh();
    });

    const copy = document.createElement('button');
    copy.textContent = 'Скопировать JSON';
    copy.addEventListener('click', async () => {
      const text = JSON.stringify(T, null, 2);
      try {
        await navigator.clipboard.writeText(text);
        copy.textContent = 'скопировано';
      } catch (e) {
        // Буфер обмена без https недоступен — тогда просто в консоль.
        console.log(text);
        copy.textContent = 'см. консоль';
      }
      setTimeout(() => { copy.textContent = 'Скопировать JSON'; }, 1400);
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
    title.textContent = 'Телосложение';
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
