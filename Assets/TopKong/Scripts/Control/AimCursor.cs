using UnityEngine;

namespace TopKong
{
    /// <summary>
    /// Точка прицела на арене и её отрисовка.
    ///
    /// Заменяет прежнюю схему, где поворот копился из дельт мыши. Та не работала
    /// по простой причине: накопленный угол нигде не показан. Игрок двигал мышь,
    /// боец как-то поворачивался, но куда он развёрнут прямо сейчас — узнать было
    /// неоткуда, и целиться приходилось вслепую.
    ///
    /// Здесь наведение абсолютное: экранная позиция курсора однозначно задаёт точку
    /// в мире. Ничего не копится, «ноль» не уезжает после серии ударов, и главное —
    /// точку видно.
    ///
    /// Линия от бойца к точке важнее самого кольца: кольцо показывает, где мышь,
    /// а линия — куда боец развернётся. Именно этого не хватало.
    /// </summary>
    public class AimCursor : MonoBehaviour
    {
        static readonly Color RingColor = new Color(1f, 0.85f, 0.35f);
        static readonly Color LinkColor = new Color(1f, 0.85f, 0.35f, 0.30f);

        Camera _cam;
        Arena _arena;
        GameTuning _t;

        LineRenderer _ring;
        LineRenderer _innerRing;
        LineRenderer _link;
        Transform _owner;

        public Vector3 AimPoint { get; private set; }

        public void Init(Camera cam, Arena arena, GameTuning tuning)
        {
            _cam = cam;
            _arena = arena;
            _t = tuning;
            AimPoint = arena.Center + Vector3.up * (arena.TopY - arena.Center.y);

            _ring = BuildRing("AimRing", 0.42f, 0.05f, RingColor);
            _innerRing = BuildRing("AimDot", 0.09f, 0.05f, RingColor);

            var linkGo = new GameObject("AimLink");
            linkGo.transform.SetParent(transform, false);
            _link = linkGo.AddComponent<LineRenderer>();
            _link.useWorldSpace = true;
            _link.positionCount = 2;
            _link.widthMultiplier = 0.035f;
            _link.sharedMaterial = MaterialFactory.Unlit(LinkColor);
            _link.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            _link.receiveShadows = false;
        }

        LineRenderer BuildRing(string name, float radius, float width, Color color)
        {
            var go = new GameObject(name);
            go.transform.SetParent(transform, false);

            var line = go.AddComponent<LineRenderer>();
            line.useWorldSpace = false;
            line.loop = true;
            line.widthMultiplier = width;
            var points = MeshUtils.CirclePoints(radius, 0f, 40);
            line.positionCount = points.Length;
            line.SetPositions(points);
            line.sharedMaterial = MaterialFactory.Unlit(color);
            line.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            line.receiveShadows = false;
            return line;
        }

        /// <summary>Кого соединять линией с прицелом. null — линия скрыта.</summary>
        public void SetOwner(Transform owner)
        {
            _owner = owner;
        }

        /// <summary>
        /// Пересчитывает точку прицела и возвращает её.
        ///
        /// Вызывается из PlayerController.Update, а не из собственного Update: порядок
        /// выполнения между MonoBehaviour не определён, и прицел мог бы отставать
        /// от тела на кадр. Рисование при этом остаётся в LateUpdate — там уже
        /// известны финальные позиции всех тел за кадр.
        /// </summary>
        public Vector3 Compute()
        {
            if (_cam == null || _arena == null) return AimPoint;

            var ray = _cam.ScreenPointToRay(Inp.MousePosition());

            // Луч почти параллелен арене или смотрит вверх — пересечения нет,
            // оставляем прошлую точку, чтобы прицел не прыгал в бесконечность.
            if (Mathf.Abs(ray.direction.y) < 1e-4f) return AimPoint;
            float distance = (_arena.TopY - ray.origin.y) / ray.direction.y;
            if (distance <= 0f) return AimPoint;

            Vector3 hit = ray.GetPoint(distance);

            // Ограничиваем чуть шире самой арены: целиться за край нужно — именно туда
            // соперника и сбивают, — но улетать прицелом в пустоту незачем.
            Vector3 flat = hit - _arena.Center;
            flat.y = 0f;
            float max = _arena.Radius * _t.aimMaxRadiusFactor;
            if (flat.sqrMagnitude > max * max) flat = flat.normalized * max;

            AimPoint = new Vector3(_arena.Center.x + flat.x, _arena.TopY, _arena.Center.z + flat.z);
            return AimPoint;
        }

        void LateUpdate()
        {
            if (_ring == null) return;

            transform.position = AimPoint + Vector3.up * 0.02f;

            bool showLink = _t.showAimLink && _owner != null;
            _link.enabled = showLink;
            if (showLink)
            {
                Vector3 from = _owner.position;
                from.y = _arena.TopY + 0.02f;
                _link.SetPosition(0, from);
                _link.SetPosition(1, AimPoint + Vector3.up * 0.02f);
            }
        }
    }
}
