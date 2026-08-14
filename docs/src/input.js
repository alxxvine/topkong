import * as THREE from 'three';

// Ввод: клавиатура, мышь и тач — три источника, один набор полей на выходе.
//
// Прицел принципиально мировой, а не экранный: игра — про то, куда полетит
// соперник, и «мышь вправо» обязано означать «удар вправо» независимо от
// того, где сейчас стоит камера. Поэтому курсор каждый кадр проецируется
// лучом на плоскость настила, и дальше вся игра работает с точкой на арене.

const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

export class Input {
  constructor(canvas) {
    this.canvas = canvas;

    this.move = new THREE.Vector2();     // -1..1 по осям экрана
    this.aim = new THREE.Vector3(0, 0, 1); // точка прицела на настиле
    this.swingHeld = false;
    this.resetPressed = false;
    this.slowMotion = false;
    /** Блок: держится, пока зажата ПКМ. */
    this.blockHeld = false;
    /** Разовый рывок (пробел): съедается consumeDash. */
    this.dashPressed = false;
    /** Разовый удар колесом: 'overhead' | 'rising', съедается consume. */
    this.wheelStrike = null;

    this.keys = new Set();
    this.pointer = new THREE.Vector2(0, 0);
    this.hasPointer = false;

    this.touchMode = false;
    this.stickVector = new THREE.Vector2();
    /** Направление прицела с правого стика, в экранных осях. */
    this.aimVector = new THREE.Vector2();
    /** Правый стик держат прямо сейчас — прицел ведёт он, а не курсор. */
    this.aimStickHeld = false;

    this.bindKeyboard();
    this.bindMouse();
    this.bindTouch();
  }

  bindKeyboard() {
    addEventListener('keydown', (e) => {
      // Пробел и стрелки скроллят страницу — на весь экран это заметно.
      if ([' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
      }
      this.keys.add(e.code);
      if (e.code === 'KeyR') this.resetPressed = true;
      if (e.code === 'KeyF') this.slowMotion = !this.slowMotion;
      // Служебный слой — счётчики, подсказка, панель — по умолчанию спрятан:
      // в кадре должна быть игра, а не приборная доска. Возвращается по H.
      if (e.code === 'KeyH') document.body.classList.toggle('bare');
      // Пробел — рывок по направлению хода. Ударом он был, пока удар
      // был один; теперь удары живут на мыши целиком.
      if (e.code === 'Space') this.dashPressed = true;
    });

    addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
    });

    // Уход со вкладки не должен оставлять зажатыми клавиши.
    addEventListener('blur', () => {
      this.keys.clear();
      this.swingHeld = false;
      this.blockHeld = false;
      this.stickVector.set(0, 0);
    });
  }

  bindMouse() {
    const onMove = (e) => {
      const rect = this.canvas.getBoundingClientRect();
      this.pointer.set(e.clientX - rect.left, e.clientY - rect.top);
      this.hasPointer = true;
    };

    this.canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      onMove(e);
    });

    this.canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') return;
      onMove(e);
      if (e.button === 0) this.swingHeld = true;
      if (e.button === 2) this.blockHeld = true;
    });

    addEventListener('pointerup', (e) => {
      if (e.pointerType === 'touch') return;
      if (e.button === 0) this.swingHeld = false;
      if (e.button === 2) this.blockHeld = false;
    });

    // Правая кнопка на арене — это не контекстное меню, это блок.
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // Колесо — выбор удара: вверх — рубящий сверху, вниз — черпающий снизу.
    // Один тик колеса — один удар; между тиками ничего не копится.
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (Math.abs(e.deltaY) < 1) return;
      this.wheelStrike = e.deltaY < 0 ? 'overhead' : 'rising';
    }, { passive: false });
  }

  bindTouch() {
    const stick = document.getElementById('stick');
    const aim = document.getElementById('aim');
    const swing = document.getElementById('swing');
    if (!stick || !aim || !swing) return;

    // Виджеты показываются только на устройстве без мыши: на ноутбуке
    // они закрывали бы арену без всякой пользы.
    if (matchMedia('(pointer: coarse)').matches) {
      document.body.classList.add('touch');
      this.touchMode = true;
    }

    // Оба стика устроены одинаково, поэтому и собираются одной функцией.
    // Прицельный отличается лишь тем, что не отпускает направление,
    // когда палец убрали: боец должен остаться смотреть, куда навели.
    this.bindStick(stick, 'stickKnob', this.stickVector, false);
    this.bindStick(aim, 'aimKnob', this.aimVector, true);

    swing.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.swingHeld = true;
      swing.classList.add('on');
    });
    const swingEnd = () => {
      this.swingHeld = false;
      swing.classList.remove('on');
    };
    swing.addEventListener('pointerup', swingEnd);
    swing.addEventListener('pointercancel', swingEnd);

    // Тыканья в арену ради разворота больше нет: палец закрывал ровно то
    // место, куда целишься, и прицеливаться приходилось вслепую.
  }

  /**
   * Один стик. keepDirection означает, что после отпускания направление
   * сохраняется — так ведёт себя прицел: убрал палец, а боец продолжает
   * смотреть туда же.
   */
  bindStick(el, knobId, out, keepDirection) {
    const knob = document.getElementById(knobId);
    const radius = 44;
    let id = null;

    const at = (e) => {
      const rect = el.getBoundingClientRect();
      const dx = e.clientX - (rect.left + rect.width / 2);
      const dy = e.clientY - (rect.top + rect.height / 2);
      const len = Math.hypot(dx, dy);
      const k = len > radius ? radius / len : 1;
      knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
      out.set(dx / radius, -dy / radius);
      if (out.length() > 1) out.normalize();
      if (keepDirection) this.aimStickHeld = true;
    };

    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      id = e.pointerId;
      // Захват указателя — оптимизация, а не обязательство: он позволяет
      // вести палец за пределами кружка. Если браузер откажет, исключение
      // из обработчика убило бы стик целиком, поэтому отказ просто
      // проглатывается.
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* см. выше */ }
      at(e);
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerId === id) at(e);
    });
    const end = (e) => {
      if (e.pointerId !== id) return;
      id = null;
      knob.style.transform = '';
      // Направление хода отпускается, направление прицела — нет.
      if (!keepDirection) out.set(0, 0);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  /** Собрать направление хода из клавиш и стика. */
  updateMove() {
    let x = 0, y = 0;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) y -= 1;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) y += 1;

    if (x === 0 && y === 0) {
      this.move.copy(this.stickVector);
    } else {
      this.move.set(x, y);
      if (this.move.length() > 1) this.move.normalize();
    }
    return this.move;
  }

  /**
   * Точка прицела на плоскости настила. Возвращает false, если луч ушёл
   * в небо — тогда прицел просто остаётся прежним, а не улетает в бесконечность.
   */
  updateAim(camera, width, height) {
    if (!this.hasPointer) return false;
    _ndc.set((this.pointer.x / width) * 2 - 1, -(this.pointer.y / height) * 2 + 1);
    _ray.setFromCamera(_ndc, camera);
    return _ray.ray.intersectPlane(PLANE, this.aim) !== null;
  }

  consumeReset() {
    const r = this.resetPressed;
    this.resetPressed = false;
    return r;
  }

  consumeDash() {
    const d = this.dashPressed;
    this.dashPressed = false;
    return d;
  }

  consumeWheelStrike() {
    const w = this.wheelStrike;
    this.wheelStrike = null;
    return w;
  }
}
