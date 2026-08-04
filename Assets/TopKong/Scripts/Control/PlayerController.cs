using UnityEngine;

namespace TopKong
{
    /// <summary>
    /// Ввод игрока.
    ///
    /// Мышь делает две разные вещи, и какую именно — решает левая кнопка:
    ///
    /// - **кнопка не зажата**: горизонтальные движения мыши разворачивают бойца.
    ///   Рука в это время прижата к телу и никуда не идёт.
    /// - **ЛКМ зажата**: мышь перестаёт крутить тело и начинает водить дубиной.
    ///   Разворот на время замаха заморожен намеренно: иначе мах разворачивал бы
    ///   бойца следом за рукой, и получилась бы ровно та каша, из-за которой
    ///   удар раньше не читался.
    ///
    /// Точка прицела считается в системе координат тела и переводится в мир через
    /// накопленный угол `_aimYaw`, а не через фактический поворот таза. Таз — часть
    /// ragdoll'а, он постоянно качается, и рука, привязанная к нему напрямую,
    /// дрожала бы вместе с ним.
    /// </summary>
    [RequireComponent(typeof(Fighter))]
    public class PlayerController : MonoBehaviour
    {
        Fighter _fighter;
        GameTuning _t;
        ArenaCamera _camera;

        float _aimYaw;
        Vector3 _handLocal;

        public void Init(GameTuning tuning, ArenaCamera cam)
        {
            _fighter = GetComponent<Fighter>();
            _t = tuning;
            _camera = cam;

            Vector3 facing = _fighter.Facing;
            _aimYaw = Mathf.Atan2(facing.x, facing.z) * Mathf.Rad2Deg;
            _handLocal = new Vector3(0f, 0f, _t.handRestReachIdle);
        }

        void Update()
        {
            if (_fighter == null || !_fighter.IsAlive) return;

            // Курсор отпущен — это пауза управления целиком. Заодно клик, которым
            // курсор возвращают в игру, не превращается в удар.
            bool controls = _fighter.ControlEnabled && Cursor.lockState == CursorLockMode.Locked;
            bool swinging = controls && Inp.SwingHeld();
            _fighter.Swinging = swinging;

            // Дельта уже посчитана за кадр — умножать её на deltaTime нельзя,
            // иначе чувствительность поедет вслед за частотой кадров.
            Vector2 delta = controls ? Inp.MouseDelta() : Vector2.zero;

            if (!swinging) _aimYaw += delta.x * _t.turnSensitivity;

            Quaternion aim = Quaternion.Euler(0f, _aimYaw, 0f);
            _fighter.FacingTarget = aim * Vector3.forward;

            Vector2 move = controls ? Inp.Move() : Vector2.zero;
            // Ходьба привязана к осям камеры, а не к повороту тела: камера неподвижна,
            // поэтому "вперёд" — это всегда вверх по экрану, независимо от того,
            // куда боец сейчас смотрит.
            Vector3 moveWorld = _camera.GroundYaw * new Vector3(move.x, 0f, move.y);
            _fighter.MoveInput = new Vector2(moveWorld.x, moveWorld.z);

            UpdateHand(swinging, delta, aim);
        }

        void UpdateHand(bool swinging, Vector2 delta, Quaternion aim)
        {
            float dt = Time.deltaTime;

            if (swinging)
            {
                _handLocal += new Vector3(delta.x, 0f, delta.y) * _t.mouseSensitivity;
            }

            // В стойке рука прижата к телу, в замахе — разрешён полный размах.
            // Разница между "несу дубину" и "бью" должна быть видна глазом.
            float restReach = swinging ? _t.handRestReach : _t.handRestReachIdle;
            float maxReach = swinging ? _t.handMaxReach : _t.handRestReachIdle * 1.15f;

            // Отпустил кнопку — рука собирается в стойку заметно быстрее, чем ходит
            // во время замаха, иначе после удара она долго болтается.
            float returnRate = swinging ? _t.handReturnRate : _t.handReturnRate * 2.5f;

            _handLocal = Vector3.Lerp(_handLocal, new Vector3(0f, 0f, restReach),
                Mathf.Clamp01(returnRate * dt));

            _handLocal.y = 0f;
            float len = _handLocal.magnitude;
            if (len < 0.0001f)
            {
                _handLocal = new Vector3(0f, 0f, _t.handMinReach);
            }
            else
            {
                _handLocal = _handLocal / len * Mathf.Clamp(len, _t.handMinReach, maxReach);
            }

            _fighter.HandOffset = aim * _handLocal + Vector3.up * _t.clubHeightOffset;
        }
    }
}
