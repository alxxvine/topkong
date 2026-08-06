import * as THREE from '../vendor/three.module.js';
import { tuning as T } from './tuning.js';

// Арена: диск, по краю которого всё и решается.
//
// Форма выбрана та же, что в Unity-версии: круг без перил, без укрытий
// и без единой детали, за которую можно зацепиться. Вся игра — это край,
// и он должен читаться с первого взгляда.
//
// Радиус меняется ползунком на ходу, поэтому геометрия не строится
// намертво: диск и кромка живут в масштабируемой группе.

export const VOID_COLOR = new THREE.Color(0x05070c);
const DECK_COLOR = new THREE.Color(0x3a3f4d);
const RIM_COLOR = new THREE.Color(0xffb347);

export class Arena {
  constructor(scene) {
    this.scene = scene;
    this.radius = T.arenaRadius;

    this.group = new THREE.Group();
    scene.add(this.group);

    // Диск строится радиусом 1 и масштабируется: менять радиус ползунком
    // нужно каждую секунду, пересобирать геометрию ради этого — расточительно.
    const deck = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 0.93, 1, 96, 1),
      new THREE.MeshStandardMaterial({ color: DECK_COLOR, roughness: 0.92, metalness: 0.04 })
    );
    deck.receiveShadow = true;
    deck.castShadow = false;
    this.deck = deck;
    this.group.add(deck);

    // Светящаяся кромка. Единственная подсказка «дальше пусто» —
    // сама пустота на тёмном фоне не читается вовсе. Тонкая намеренно:
    // это должна быть черта, а не золотой обод во весь кадр.
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(1, 0.005, 6, 128),
      new THREE.MeshBasicMaterial({ color: RIM_COLOR })
    );
    rim.rotation.x = -Math.PI / 2;
    this.rim = rim;
    this.group.add(rim);

    // Круги на настиле: без них ощущение расстояния до края пропадает,
    // диск выглядит бесконечным.
    this.rings = [];
    for (const frac of [0.33, 0.62, 0.85]) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(frac - 0.004, frac + 0.004, 96),
        new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: frac > 0.8 ? 0.16 : 0.07,
        })
      );
      ring.rotation.x = -Math.PI / 2;
      this.rings.push(ring);
      this.group.add(ring);
    }

    // Свет ставится раньше геометрии: тень подгоняется под радиус арены,
    // а значит источник должен уже существовать.
    this.addLights(scene);
    this.applyRadius(this.radius);

    scene.background = VOID_COLOR;
    // Туман скрывает, что под ареной ничего нет: улетевший боец растворяется,
    // а не зависает над пустым чёрным ничем.
    scene.fog = new THREE.Fog(VOID_COLOR, 26, 62);
  }

  addLights(scene) {
    // Небо холодное, отражённый от настила свет тёплый — так объём тела
    // читается даже в тени.
    scene.add(new THREE.HemisphereLight(0x8fa6d8, 0x2b2118, 0.85));

    const key = new THREE.DirectionalLight(0xfff0d8, 2.1);
    key.position.set(6, 14, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0008;
    key.shadow.normalBias = 0.02;
    const s = key.shadow.camera;
    s.near = 1;
    s.far = 50;
    s.left = -14; s.right = 14; s.top = 14; s.bottom = -14;
    scene.add(key);
    this.key = key;

    // Контровой: очерчивает силуэт со стороны камеры-фона. Сверху-сбоку
    // фигура иначе сливается с настилом.
    const rimLight = new THREE.DirectionalLight(0x6f8cff, 0.75);
    rimLight.position.set(-8, 6, -9);
    scene.add(rimLight);
  }

  /** Радиус меняется ползунком — вся геометрия подстраивается масштабом. */
  applyRadius(radius) {
    this.radius = radius;
    const t = T.arenaThickness;

    this.deck.scale.set(radius, t, radius);
    // Верх настила — ровно y = 0: вся поза бойца считается от этой плоскости.
    this.deck.position.y = -t * 0.5;

    this.rim.scale.setScalar(radius);
    this.rim.position.y = -0.002;

    for (const ring of this.rings) {
      ring.scale.setScalar(radius);
      ring.position.y = 0.006;
    }

    const shadow = this.key.shadow.camera;
    const span = radius * 1.9;
    shadow.left = -span; shadow.right = span; shadow.top = span; shadow.bottom = -span;
    shadow.updateProjectionMatrix();
  }

  tick() {
    if (Math.abs(this.radius - T.arenaRadius) > 1e-4) this.applyRadius(T.arenaRadius);
  }

  /** Есть ли под этой точкой настил. Единственная проверка опоры во всей игре. */
  isOverDeck(x, z, margin = 0) {
    return x * x + z * z <= (this.radius + margin) * (this.radius + margin);
  }

  /** Насколько точка близка к краю: 0 в центре, 1 на кромке. */
  edgeFactor(x, z) {
    return Math.min(1, Math.sqrt(x * x + z * z) / Math.max(0.001, this.radius));
  }
}
