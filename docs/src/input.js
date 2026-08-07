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

    this.keys = new Set();
    this.pointer = new THREE.Vector2(0, 0);
    this.hasPointer = false;

    this.touchMode = false;
    this.stickVector = new THREE.Vector2();
    this.touchAim = null;

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
      if (e.code === 'Space') this.swingHeld = true;
    });

    addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (e.code === 'Space') this.swingHeld = false;
    });

    // Уход со вкладки не должен оставлять зажатыми клавиши.
    addEventListener('blur', () => {
      this.keys.clear();
      this.swingHeld = false;
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
    });

    addEventListener('pointerup', (e) => {
      if (e.pointerType === 'touch') return;
      if (e.button === 0) this.swingHeld = false;
    });

    // Правая кнопка на арене — это не контекстное меню.
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  bindTouch() {
    const stick = document.getElementById('stick');
    const knob = document.getElementById('stickKnob');
    const swing = document.getElementById('swing');
    if (!stick || !swing) return;

    // Виджеты показываются только на устройстве без мыши: на ноутбуке
    // они закрывали бы арену без всякой пользы.
    if (matchMedia('(pointer: coarse)').matches) {
      document.body.classList.add('touch');
      this.touchMode = true;
    }

    let stickId = null;
    const radius = 50;

    const stickAt = (e) => {
      const rect = stick.getBoundingClientRect();
      const dx = e.clientX - (rect.left + rect.width / 2);
      const dy = e.clientY - (rect.top + rect.height / 2);
      const len = Math.hypot(dx, dy);
      const k = len > radius ? radius / len : 1;
      knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
      this.stickVector.set(dx / radius, -dy / radius);
      if (this.stickVector.length() > 1) this.stickVector.normalize();
    };

    stick.addEventListener('pointerdown', (e) => {
      stickId = e.pointerId;
      stick.setPointerCapture(e.pointerId);
      stickAt(e);
    });
    stick.addEventListener('pointermove', (e) => {
      if (e.pointerId === stickId) stickAt(e);
    });
    const stickEnd = (e) => {
      if (e.pointerId !== stickId) return;
      stickId = null;
      knob.style.transform = '';
      this.stickVector.set(0, 0);
    };
    stick.addEventListener('pointerup', stickEnd);
    stick.addEventListener('pointercancel', stickEnd);

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

    // Касание по самой арене задаёт прицел: без этого на телефоне
    // повернуться некуда.
    this.canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      this.setTouchAim(e);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'touch') return;
      this.setTouchAim(e);
    });
  }

  setTouchAim(e) {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(e.clientX - rect.left, e.clientY - rect.top);
    this.hasPointer = true;
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
}
