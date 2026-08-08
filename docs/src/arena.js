import * as THREE from 'three';
import { tuning as T } from 'tk/tuning.js';

// Арена: диск, по краю которого всё и решается.
//
// Форма выбрана та же, что в Unity-версии: круг без перил, без укрытий
// и без единой детали, за которую можно зацепиться. Вся игра — это край,
// и он должен читаться с первого взгляда.
//
// Радиус меняется ползунком на ходу, поэтому геометрия не строится
// намертво: диск и кромка живут в масштабируемой группе.

// Палитра светлая и почти бесцветная.
//
// Тёмная сцена с оранжевой кромкой читалась аркадным автоматом. Здесь другой
// приём: почти белое всё, разница между поверхностями — полтона, а цветом
// говорят только фигуры. Тогда взгляд ловит не декорацию, а силуэт бойца
// и линию края, то есть ровно то, из чего игра и состоит.
//
// Пустота вокруг светлее настила, а не темнее. Это важнее, чем кажется:
// на тёмном фоне край читался светящейся полосой, то есть подсказкой,
// а на светлом он читается обрывом — тем, чем и является.
export const VOID_COLOR = new THREE.Color(0xdfe3ea);
const DECK_COLOR = new THREE.Color(0xfdfdff);
const RIM_COLOR = new THREE.Color(0x1d2330);
const RING_COLOR = new THREE.Color(0x2c3242);

export class Arena {
  constructor(scene) {
    this.scene = scene;
    this.radius = T.arenaRadius;

    this.group = new THREE.Group();
    scene.add(this.group);

    // Диск строится радиусом 1 и масштабируется: менять радиус ползунком
    // нужно каждую секунду, пересобирать геометрию ради этого — расточительно.
    const deck = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 0.985, 1, 128, 1),
      new THREE.MeshStandardMaterial({ color: DECK_COLOR, roughness: 0.78, metalness: 0 })
    );
    deck.receiveShadow = true;
    deck.castShadow = false;
    this.deck = deck;
    this.group.add(deck);

    // Кромка — тонкая тёмная черта по светлому. Раньше она светилась
    // оранжевым и была самым ярким в кадре; на светлом настиле ярче быть
    // незачем, достаточно контраста.
    //
    // Но одной черты мало. Пустота вокруг сделана заметно темнее настила
    // не для красоты: когда они были в полтона, диск читался рисунком
    // на столе, а не площадкой над обрывом. Вся игра — про край,
    // и он обязан читаться первым.
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(1, 0.0035, 8, 192),
      new THREE.MeshBasicMaterial({ color: RIM_COLOR, transparent: true, opacity: 0.7 })
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
          color: RING_COLOR,
          transparent: true,
          opacity: frac > 0.8 ? 0.13 : 0.07,
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
    // Дымка того же тона, что и фон: улетевший боец не проваливается
    // в чёрное ничто, а растворяется в белом.
    scene.fog = new THREE.Fog(VOID_COLOR, 22, 58);
  }

  addLights(scene) {
    // Свет мягкий и почти со всех сторон — как в световом кубе на съёмке
    // предметки. Заливка делает почти всю работу, направленный добавляет
    // только тень, по которой понятно, где тело относительно настила.
    //
    // Прежняя схема была обратной: слабая заливка и жёсткий ключ в две
    // единицы. Контраст получался резкий, тени чёрные, и картонная кукла
    // выглядела не игрушкой на столе, а фигурой в подворотне.
    // Заливка сильная, но не настолько, чтобы съесть тень: она здесь
    // единственное, что связывает фигуру с настилом. Перебор с небом —
    // и боец начинает висеть над ареной, ни к чему не привязанный.
    scene.add(new THREE.HemisphereLight(0xffffff, 0xdfe3ea, 1.45));

    const key = new THREE.DirectionalLight(0xffffff, 2.0);
    key.position.set(5, 13, 7);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0006;
    key.shadow.normalBias = 0.02;
    // Мягкий край тени. Резкая тень от точечного солнца — главное, что
    // выдаёт «компьютерную картинку»; в жизни тень размывается всегда.
    key.shadow.radius = 3;
    const s = key.shadow.camera;
    s.near = 1;
    s.far = 50;
    s.left = -14; s.right = 14; s.top = 14; s.bottom = -14;
    scene.add(key);
    this.key = key;

    // Заполняющий с теневой стороны — без него провал в тень всё равно
    // остаётся, каким бы ярким ни было небо.
    const fill = new THREE.DirectionalLight(0xeef2fb, 0.45);
    fill.position.set(-7, 5, -8);
    scene.add(fill);
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
