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

    // Арена — не диск, а КОЛОДЕЦ: труба, уходящая вниз и растворяющаяся
    // в пустоте. Плоский диск толщиной в метр читался столешницей, и падение
    // с него выглядело падением со стола. У колодца дна не видно, и край
    // становится настоящим краем.
    //
    // Строится радиусом 1 и масштабируется: менять радиус ползунком нужно
    // каждую секунду, пересобирать геометрию ради этого расточительно.
    // Материалов три — CylinderGeometry разбита на группы «бок, верх, низ»,
    // и стенке нужен свой, с растворением.
    const deck = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 0.86, 1, 160, 1),
      [
        this.wellMaterial(),
        new THREE.MeshStandardMaterial({ color: DECK_COLOR, roughness: 0.78, metalness: 0 }),
        new THREE.MeshBasicMaterial({ color: VOID_COLOR }),
      ]
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

    // Кругов на настиле больше нет. Они были подпоркой: на плоском диске
    // без них терялось ощущение расстояния до края. У колодца эту работу
    // делает сама стенка — по тому, насколько она видна, глаз и читает,
    // далеко ли до обрыва.

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

  /**
   * Стенка колодца: сверху видна, ниже растворяется в пустоте.
   *
   * Делается подменой во фрагментном шейдере обычного материала, а не
   * отдельным шейдером: так стенка остаётся освещённой и с тенями,
   * а растворение ложится последним слоем.
   *
   * Растворение по МИРОВОЙ высоте, а не по расстоянию от камеры. Туман
   * считает от камеры и на виде сверху красил бы одинаково и близкий край,
   * и дальний, а нужно наоборот: чем глубже, тем хуже видно, откуда бы
   * ни смотрел.
   */
  wellMaterial() {
    const m = new THREE.MeshStandardMaterial({
      color: DECK_COLOR.clone().multiplyScalar(0.97),
      roughness: 0.85,
      metalness: 0,
    });
    this.wellFade = { value: T.arenaFade };
    m.onBeforeCompile = (shader) => {
      shader.uniforms.wellFade = this.wellFade;
      // Цвет пустоты подмешивается ПОСЛЕ преобразования в sRGB, значит
      // и сам обязан быть в sRGB. Отдать сюда рабочий линейный цвет —
      // и стенка гаснет не в фон, а в заметно более тёмный серый: в кадре
      // остаётся клин, хотя по смыслу там уже ничего нет.
      shader.uniforms.voidColor = {
        value: VOID_COLOR.clone().convertLinearToSRGB(),
      };
      shader.vertexShader = 'varying float vWellY;\n' + shader.vertexShader.replace(
        '#include <worldpos_vertex>',
        '#include <worldpos_vertex>\n  vWellY = (modelMatrix * vec4(transformed, 1.0)).y;'
      );
      shader.fragmentShader = 'uniform float wellFade;\nuniform vec3 voidColor;\nvarying float vWellY;\n'
        + shader.fragmentShader.replace(
          '#include <dithering_fragment>',
          `#include <dithering_fragment>
  // Растворение съедает стенку за несколько метров от кромки, а не за всю
  // глубину трубы. Иначе в кадре остаётся плотный серый клин с резким
  // нижним обрезом — видно ровно геометрию, а не обрыв.
  float wellT = smoothstep(0.0, 1.0, clamp(-vWellY / max(0.001, wellFade), 0.0, 1.0));
  gl_FragColor.rgb = mix(gl_FragColor.rgb, voidColor, wellT);`
        );
    };
    return m;
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
    // Глубина растворения — своя настройка, не высота трубы: труба уходит
    // далеко вниз, а исчезнуть стенка должна у самой кромки.
    if (this.wellFade) this.wellFade.value = Math.max(0.5, T.arenaFade);

    this.rim.scale.setScalar(radius);
    this.rim.position.y = -0.002;

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
