using UnityEngine;

namespace TopKong
{
    /// <summary>
    /// Ввод игрока.
    ///
    /// Мышь целится: её экранная позиция задаёт точку на арене, боец разворачивается
    /// к ней. Наведение абсолютное — ничего не копится, и куда повернёшься, видно
    /// заранее по кольцу прицела и линии от бойца.
    ///
    /// Левая кнопка — удар: зажал, боец отводит дубину и копит замах; отпустил —
    /// проносит её дугой сквозь прицел. Непрерывного ведения дубиной мышью больше нет:
    /// оно противоречит дискретному удару и как раз им рука уводилась за спину.
    /// </summary>
    [RequireComponent(typeof(Fighter))]
    public class PlayerController : MonoBehaviour
    {
        Fighter _fighter;
        GameTuning _t;
        ArenaCamera _camera;
        AimCursor _aim;

        public void Init(GameTuning tuning, ArenaCamera cam, AimCursor aim)
        {
            _fighter = GetComponent<Fighter>();
            _t = tuning;
            _camera = cam;
            _aim = aim;
        }

        void Update()
        {
            if (_fighter == null || !_fighter.IsAlive) return;

            // Курсор отпущен (Esc) — это пауза управления целиком. Заодно клик,
            // которым курсор возвращают в игру, не превращается в удар.
            bool controls = _fighter.ControlEnabled && Cursor.lockState != CursorLockMode.None;

            Vector3 aimPoint = _aim.Compute();

            Vector3 toAim = aimPoint - _fighter.Position;
            toAim.y = 0f;
            if (toAim.sqrMagnitude > 0.0004f) _fighter.FacingTarget = toAim.normalized;

            _fighter.SwingHeld = controls && Inp.SwingHeld();

            Vector2 move = controls ? Inp.Move() : Vector2.zero;
            // Ходьба привязана к осям камеры: камера неподвижна, поэтому "вперёд" —
            // это всегда вверх по экрану, независимо от того, куда боец смотрит.
            Vector3 moveWorld = _camera.GroundYaw * new Vector3(move.x, 0f, move.y);
            _fighter.MoveInput = new Vector2(moveWorld.x, moveWorld.z);
        }
    }
}
