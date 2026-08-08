import * as THREE from 'three';

// Единая бесшовная оболочка тела.
//
// Приставленные друг к другу капсулы бесшовными не бывают в принципе: на
// пересечении двух выпуклых тел всегда остаётся складка, и чем сильнее согнут
// сустав, тем она заметнее. Шар в суставе прячет щель, но стык всё равно виден.
//
// Поэтому оболочка здесь одна на всё тело и строится из поля расстояний.
// Каждая кость даёт капсульное поле, поля складываются СГЛАЖЕННЫМ минимумом —
// он и создаёт плавные перетекания вместо стыков, — а поверхность нулевого
// уровня вытаскивается алгоритмом surface nets.
//
// Surface nets выбран вместо marching cubes намеренно: он даёт замкнутую
// поверхность без таблиц на 256 случаев, которые надо помнить наизусть и
// в которых ошибка выражается дырами в модели. Здесь вся логика — «в ячейке
// со сменой знака ставим одну вершину, соседние вершины соединяем».
//
// Сетка строится ОДИН РАЗ на всю игру в опорной стойке и потом гнётся
// скиннингом: вершина привязана к четырём ближайшим костям с весами
// по расстоянию.

/** Плавное объединение: k задаёт ширину перетекания, метры. */
function smin(a, b, k) {
  const h = Math.max(0, Math.min(1, 0.5 + 0.5 * (b - a) / k));
  return b * (1 - h) + a * h - k * h * (1 - h);
}

/** Расстояние до отрезка с толщиной. */
function capsuleDistance(px, py, pz, a, b, r) {
  const bax = b.x - a.x, bay = b.y - a.y, baz = b.z - a.z;
  const pax = px - a.x, pay = py - a.y, paz = pz - a.z;
  const len2 = bax * bax + bay * bay + baz * baz;
  let h = len2 > 1e-9 ? (pax * bax + pay * bay + paz * baz) / len2 : 0;
  h = h < 0 ? 0 : h > 1 ? 1 : h;
  const dx = pax - bax * h, dy = pay - bay * h, dz = paz - baz * h;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - r;
}

/**
 * Построить оболочку по набору капсул.
 *
 * @param {Array} parts  {a, b, r, bone} — отрезок, толщина и кость, к которой
 *                       эта часть тела относится
 * @param {number} cell  размер ячейки сетки, метры
 * @param {number} blend ширина перетекания между частями
 */
export function buildSkin(parts, cell = 0.028, blend = 0.055) {
  // Границы с запасом на толщину и на перетекание.
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (const p of parts) {
    const pad = p.r + blend + cell * 2;
    for (const v of [p.a, p.b]) {
      min.x = Math.min(min.x, v.x - pad); max.x = Math.max(max.x, v.x + pad);
      min.y = Math.min(min.y, v.y - pad); max.y = Math.max(max.y, v.y + pad);
      min.z = Math.min(min.z, v.z - pad); max.z = Math.max(max.z, v.z + pad);
    }
  }

  const nx = Math.ceil((max.x - min.x) / cell) + 1;
  const ny = Math.ceil((max.y - min.y) / cell) + 1;
  const nz = Math.ceil((max.z - min.z) / cell) + 1;

  const field = new Float32Array(nx * ny * nz);
  const at = (x, y, z) => (z * ny + y) * nx + x;

  for (let z = 0; z < nz; z++) {
    const pz = min.z + z * cell;
    for (let y = 0; y < ny; y++) {
      const py = min.y + y * cell;
      for (let x = 0; x < nx; x++) {
        const px = min.x + x * cell;
        let d = Infinity;
        for (let i = 0; i < parts.length; i++) {
          const p = parts[i];
          const di = capsuleDistance(px, py, pz, p.a, p.b, p.r);
          d = i === 0 ? di : smin(d, di, blend);
        }
        field[at(x, y, z)] = d;
      }
    }
  }

  // --- surface nets: по вершине в каждой ячейке, где поле меняет знак

  // Двенадцать рёбер куба как пары углов; угол i это (i&1, i>>1&1, i>>2&1).
  const EDGES = [
    [0, 1], [2, 3], [4, 5], [6, 7],
    [0, 2], [1, 3], [4, 6], [5, 7],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];

  const cellVertex = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const cellAt = (x, y, z) => (z * (ny - 1) + y) * (nx - 1) + x;
  const positions = [];
  const corner = new Float64Array(8);

  for (let z = 0; z < nz - 1; z++) {
    for (let y = 0; y < ny - 1; y++) {
      for (let x = 0; x < nx - 1; x++) {
        let inside = 0;
        for (let i = 0; i < 8; i++) {
          const v = field[at(x + (i & 1), y + ((i >> 1) & 1), z + ((i >> 2) & 1))];
          corner[i] = v;
          if (v < 0) inside++;
        }
        if (inside === 0 || inside === 8) continue;

        // Вершина — среднее точек, где поле пересекает ноль на рёбрах ячейки.
        let sx = 0, sy = 0, sz = 0, n = 0;
        for (const [ea, eb] of EDGES) {
          const va = corner[ea];
          const vb = corner[eb];
          if ((va < 0) === (vb < 0)) continue;
          const t = va / (va - vb);
          const ax = ea & 1, ay = (ea >> 1) & 1, az = (ea >> 2) & 1;
          const bx = eb & 1, by = (eb >> 1) & 1, bz = (eb >> 2) & 1;
          sx += ax + (bx - ax) * t;
          sy += ay + (by - ay) * t;
          sz += az + (bz - az) * t;
          n++;
        }
        if (n === 0) continue;

        cellVertex[cellAt(x, y, z)] = positions.length / 3;
        positions.push(
          min.x + (x + sx / n) * cell,
          min.y + (y + sy / n) * cell,
          min.z + (z + sz / n) * cell
        );
      }
    }
  }

  // --- грани: каждое ребро сетки со сменой знака даёт четырёхугольник
  // из вершин четырёх ячеек, которые это ребро делят.

  const indices = [];
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) indices.push(a, b, c, a, c, d);
    else indices.push(a, c, b, a, d, c);
  };

  for (let z = 0; z < nz - 1; z++) {
    for (let y = 0; y < ny - 1; y++) {
      for (let x = 0; x < nx - 1; x++) {
        const v0 = field[at(x, y, z)];
        const inside0 = v0 < 0;

        if (x < nx - 1 && y > 0 && z > 0) {
          const v1 = field[at(x + 1, y, z)];
          if (inside0 !== (v1 < 0)) {
            quad(
              cellVertex[cellAt(x, y - 1, z - 1)],
              cellVertex[cellAt(x, y, z - 1)],
              cellVertex[cellAt(x, y, z)],
              cellVertex[cellAt(x, y - 1, z)],
              inside0);
          }
        }
        if (y < ny - 1 && x > 0 && z > 0) {
          const v1 = field[at(x, y + 1, z)];
          if (inside0 !== (v1 < 0)) {
            quad(
              cellVertex[cellAt(x - 1, y, z - 1)],
              cellVertex[cellAt(x, y, z - 1)],
              cellVertex[cellAt(x, y, z)],
              cellVertex[cellAt(x - 1, y, z)],
              !inside0);
          }
        }
        if (z < nz - 1 && x > 0 && y > 0) {
          const v1 = field[at(x, y, z + 1)];
          if (inside0 !== (v1 < 0)) {
            quad(
              cellVertex[cellAt(x - 1, y - 1, z)],
              cellVertex[cellAt(x, y - 1, z)],
              cellVertex[cellAt(x, y, z)],
              cellVertex[cellAt(x - 1, y, z)],
              inside0);
          }
        }
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  attachSkinning(geometry, parts);
  return geometry;
}

/**
 * Привязать вершины к костям.
 *
 * Вес считается по расстоянию до отрезка кости, а не до её начала: у длинной
 * кости начало может оказаться дальше, чем чужой сустав, и локоть тогда
 * привязался бы к корпусу.
 */
const BONES_PER_VERTEX = 4;

function attachSkinning(geometry, parts) {
  const pos = geometry.getAttribute('position');
  const count = pos.count;
  const skinIndex = new Uint16Array(count * 4);
  const skinWeight = new Float32Array(count * 4);
  const scored = [];

  for (let v = 0; v < count; v++) {
    const px = pos.getX(v);
    const py = pos.getY(v);
    const pz = pos.getZ(v);

    scored.length = 0;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      // Расстояние до оси кости, без вычитания толщины: важно, какая кость
      // ближе, а не насколько вершина внутри неё.
      const d = capsuleDistance(px, py, pz, p.a, p.b, 0);
      scored.push({ bone: p.bone, d });
    }
    scored.sort((a, b) => a.d - b.d);

    let sum = 0;
    const w = [];
    // Дальние кости отсекаются совсем. Оставь им хоть пару процентов — и на
    // сильно согнутом суставе вершину растянет в шип к далёкой кости.
    const nearest = scored[0].d;
    for (let i = 0; i < BONES_PER_VERTEX; i++) {
      const s = scored[Math.min(i, scored.length - 1)];
      if (i > 0 && s.d > nearest + 0.22) {
        w.push({ bone: w[0].bone, weight: 0 });
        continue;
      }
      // Резкость спада: чем больше степень, тем меньше кость тянет чужие
      // вершины. Слишком резко — на сгибе появляется излом, слишком мягко —
      // конечность таскает за собой половину корпуса.
      const weight = 1 / Math.pow(Math.max(0.02, s.d), 6);
      w.push({ bone: s.bone, weight });
      sum += weight;
    }
    for (let i = 0; i < BONES_PER_VERTEX; i++) {
      skinIndex[v * 4 + i] = w[i].bone;
      skinWeight[v * 4 + i] = w[i].weight / sum;
    }
  }

  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));
}
