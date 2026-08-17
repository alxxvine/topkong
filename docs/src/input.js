import * as THREE from 'three';

// Input: keyboard, mouse and touch — three sources, one set of output
// fields.
//
// The aim is world-space by principle, not screen-space: the game is about
// where the opponent will fly, and "mouse right" must mean "strike right"
// regardless of where the camera stands. So every frame the cursor is
// projected by a ray onto the deck plane, and from there the whole game
// works with a point on the arena.

const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

export class Input {
  constructor(canvas) {
    this.canvas = canvas;

    this.move = new THREE.Vector2();     // -1..1 in screen axes
    this.aim = new THREE.Vector3(0, 0, 1); // aim point on the deck
    this.swingHeld = false;
    this.resetPressed = false;
    this.slowMotion = false;
    /** Block: held while RMB is down. */
    this.blockHeld = false;
    /** One-shot dash (Space): consumed by consumeDash. */
    this.dashPressed = false;
    /** One-shot wheel strike: 'overhead' | 'rising', consumed once. */
    this.wheelStrike = null;

    this.keys = new Set();
    this.pointer = new THREE.Vector2(0, 0);
    this.hasPointer = false;
    /** Window-level cursor position: unlike `pointer` it also updates
     *  over UI overlays. The character menu reads it for the gaze. */
    this.screenX = 0;
    this.screenY = 0;
    this.hasScreen = false;

    this.touchMode = false;
    this.stickVector = new THREE.Vector2();
    /** Aim direction from the right stick, in screen axes. */
    this.aimVector = new THREE.Vector2();
    /** The right stick is held right now — it drives the aim, not the cursor. */
    this.aimStickHeld = false;

    this.bindKeyboard();
    this.bindMouse();
    this.bindTouch();
  }

  bindKeyboard() {
    addEventListener('keydown', (e) => {
      // Space and the arrows scroll the page — very visible in fullscreen.
      if ([' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
      }
      this.keys.add(e.code);
      if (e.code === 'KeyR') this.resetPressed = true;
      if (e.code === 'KeyF') this.slowMotion = !this.slowMotion;
      // The service layer — counters, hints, the settings panel — is hidden
      // by default: the frame should show the game, not a dashboard.
      // H brings it back.
      if (e.code === 'KeyH') document.body.classList.toggle('bare');
      // Space is a dash along the move direction. It used to be a strike,
      // back when there was one strike; strikes live on the mouse now.
      if (e.code === 'Space') this.dashPressed = true;
    });

    addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
    });

    // Leaving the tab must not leave keys stuck down.
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

    // The window-level tracker: overlays swallow canvas events, but the
    // menu gaze must follow the cursor over the UI too.
    addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      this.screenX = e.clientX;
      this.screenY = e.clientY;
      this.hasScreen = true;
      // Self-healing buttons. A button released OUTSIDE the window sends
      // no pointerup, and the stuck RMB read as "my fighter raises the
      // block by itself". Every mouse move re-syncs with the REAL state.
      if (this.blockHeld && !(e.buttons & 2)) this.blockHeld = false;
      if (this.swingHeld && !(e.buttons & 1)) this.swingHeld = false;
    });
    addEventListener('pointercancel', () => {
      this.swingHeld = false;
      this.blockHeld = false;
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

    // The right button is not a context menu ANYWHERE on the page — it
    // is a block. Window-wide: a right-release over a UI card used to
    // pop the menu and could eat the pointerup.
    addEventListener('contextmenu', (e) => e.preventDefault());

    // The wheel picks a strike: up — the overhead slam, down — the rising
    // scoop. One wheel tick, one strike; nothing accumulates between ticks.
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

    // The widgets only show on a device without a mouse: on a laptop they
    // would cover the arena for no benefit.
    if (matchMedia('(pointer: coarse)').matches) {
      document.body.classList.add('touch');
      this.touchMode = true;
    }

    // Both sticks are built the same, hence one function. The aim stick
    // differs only in keeping its direction when the finger lifts: the
    // fighter must keep facing where he was pointed.
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

    // The rest of the combat verbs. Tap buttons flash for a beat; the
    // block button is a true hold, like RMB on the mouse.
    const tap = (id, fire) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        fire();
        el.classList.add('on');
        setTimeout(() => el.classList.remove('on'), 160);
      });
    };
    tap('ovr', () => { this.wheelStrike = 'overhead'; });
    tap('rise', () => { this.wheelStrike = 'rising'; });
    tap('dashBtn', () => { this.dashPressed = true; });

    const blockBtn = document.getElementById('blockBtn');
    if (blockBtn) {
      blockBtn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.blockHeld = true;
        blockBtn.classList.add('on');
      });
      const blockEnd = () => {
        this.blockHeld = false;
        blockBtn.classList.remove('on');
      };
      blockBtn.addEventListener('pointerup', blockEnd);
      blockBtn.addEventListener('pointercancel', blockEnd);
    }

    // There is no tapping the arena to turn anymore: the finger covered
    // exactly the spot being aimed at, and aiming went blind.
  }

  /**
   * One stick. keepDirection means the direction survives release — that
   * is how the aim behaves: lift the finger and the fighter keeps facing
   * the same way.
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
      // Pointer capture is an optimization, not an obligation: it lets the
      // finger travel outside the circle. If the browser refuses, an
      // exception out of the handler would kill the whole stick, so the
      // refusal is simply swallowed.
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* see above */ }
      at(e);
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerId === id) at(e);
    });
    const end = (e) => {
      if (e.pointerId !== id) return;
      id = null;
      knob.style.transform = '';
      // The move direction is released; the aim direction is not.
      if (!keepDirection) out.set(0, 0);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  /** Assemble the move direction from keys and the stick. */
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
   * The aim point on the deck plane. Returns false when the ray went into
   * the sky — the aim then simply stays put instead of flying to infinity.
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
