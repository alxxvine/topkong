import { tuning as T, tuneGroups, saveTuning, resetTuning } from 'tk/tuning.js';

// Интерфейс: строка состояния и панель ползунков.
//
// Панель — главная причина, ради которой веб-версия вообще делается.
// Подкрутить желейность или силу удара и увидеть результат можно за секунду,
// в том числе с телефона, без Unity и без пересборки. Значения сохраняются
// в localStorage, поэтому подобранное не теряется при перезагрузке.

export class Ui {
  constructor() {
    this.hud = document.getElementById('hud');
    this.panel = document.getElementById('tune');
    this.body = document.getElementById('tuneBody');
    this.rows = [];

    this.buildPanel();
    this.bindFold();
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
      if (row.input.type === 'checkbox') row.input.checked = !!T[row.key];
      else row.input.value = T[row.key];
      row.show();
    }
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
