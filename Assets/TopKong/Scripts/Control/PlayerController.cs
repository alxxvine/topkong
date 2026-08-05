using UnityEngine;

namespace TopKong
{
    /// <summary>
    /// Ввод игрока.
    ///
    /// Наведение абсолютное: мышь задаёт точку на арене, боец разворачивается к ней.
    /// Прежняя схема копила дельты мыши в угол, и играть в неё было нельзя — угол
    /// нигде не показывался, так что куда повернёшься, узнавалось только постфактум.
    ///
    /// Левая кнопка решает, что делает мышь с рукой:
    /// - не зажата: дубина прижата к телу, мышь только целится;
    /// - зажата: цель дубины — сама точка прицела. Замах превращается в пронос
    ///   курсора сквозь соперника, и скорость проноса становится скоростью удара.
    ///
    /// Заморозки поворота на время замаха здесь больше нет. Она была нужна, пока
    /// поворот вычислялся из положения руки и требовалось разорвать петлю «тело
    /// за рукой, рука за телом». Прицел — внешний вход, петли нет, а замерший
    /// разворот при видимо движущемся курсоре читался бы как поломка.
    /// </summary>
    [RequireComponent(typeof(Fighter))]
    public class PlayerController : MonoBehaviour
    {
        Fighter _fighter;
        GameTuning _t;
        ArenaCamera _camera;
        AimCursor _aim;

        Vector3 _hand;

        public void Init(GameTuning tuning, ArenaCamera cam, AimCursor aim)
        {
            _fighter = GetComponent<Fighter>();
            _t = tuning;
            _camera = cam;
            _aim = aim;
            _hand = _fighter.Facing * _t.handRestReachIdle;
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

            bool swinging = controls && Inp.SwingHeld();
            _fighter.Swinging = swinging;

            Vector2 move = controls ? Inp.Move() : Vector2.zero;
            // Ходьба привязана к осям камеры: камера неподвижна, поэтому "вперёд" —
            // это всегда вверх по экрану, независимо от того, куда боец смотрит.
            Vector3 moveWorld = _camera.GroundYaw * new Vector3(move.x, 0f, move.y);
            _fighter.MoveInput = new Vector2(moveWorld.x, moveWorld.z);

            UpdateHand(swinging, aimPoint);
        }

        void UpdateHand(bool swinging, Vector3 aimPoint)
        {
            float dt = Time.deltaTime;
            Vector3 desired;
            float rate;

            if (swinging)
            {
                // Цель дубины — точка прицела, обрезанная по длине руки. Дальше
                // тянуть некуда: рука упрётся в пределы суставов, и замах станет вязким.
                Vector3 fromChest = aimPoint - _fighter.Chest.position;
                fromChest.y = 0f;
                float length = fromChest.magnitude;
                desired = length < 0.0001f
                    ? _fighter.Facing * _t.handMinReach
                    : fromChest / length * Mathf.Clamp(length, _t.handMinReach, _t.handMaxReach);
                rate = _t.handFollowRate;
            }
            else
            {
                // В стойке рука прижата к телу и смотрит туда же, куда боец.
                desired = _fighter.FacingTarget * _t.handRestReachIdle;
                rate = _t.handReturnRate * 2.5f;
            }

            _hand = Vector3.Lerp(_hand, desired, Mathf.Clamp01(rate * dt));
            _hand.y = 0f;

            _fighter.HandOffset = _hand + Vector3.up * _t.clubHeightOffset;
        }
    }
}
