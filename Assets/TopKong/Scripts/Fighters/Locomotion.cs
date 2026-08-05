using UnityEngine;

namespace TopKong
{
    /// <summary>
    /// Движение и разворот управляемого бойца.
    ///
    /// Заменил прежний BalanceController целиком. Тот держал тело на ногах пружинами
    /// и моментами: подвеска под тазом, PD-контроллер вертикали, отдельный режим
    /// подъёма с земли. Всё это было нужно только потому, что тело всё время было
    /// ragdoll'ом. Теперь под управлением тело кинематическое, стоять ему не надо
    /// помогать — и здесь остаётся ровно то, что и должно быть в контроллере
    /// персонажа: скорость по земле, разворот и проверка опоры.
    /// </summary>
    public class Locomotion
    {
        readonly Fighter _f;
        readonly GameTuning _t;
        readonly Arena _arena;

        public bool Grounded { get; private set; }
        public float PlanarSpeed { get; private set; }

        public Locomotion(Fighter fighter, GameTuning tuning, Arena arena)
        {
            _f = fighter;
            _t = tuning;
            _arena = arena;
        }

        public void Tick(float dt, bool controlEnabled)
        {
            var body = _f.RootBody;
            if (body == null) return;

            ProbeGround(body);
            ApplyMovement(body, dt, controlEnabled);
            ApplyFacing(body, dt);
        }

        void ProbeGround(Rigidbody body)
        {
            Grounded = false;
            if (_arena.Ground == null) return;

            // Луч проверяется только против коллайдера арены: так не нужны ни слои,
            // ни фильтрация собственных коллайдеров бойца.
            var ray = new Ray(body.position + Vector3.up * 0.4f, Vector3.down);
            Grounded = _arena.Ground.Raycast(ray, out _, 0.6f);
        }

        void ApplyMovement(Rigidbody body, float dt, bool controlEnabled)
        {
            Vector2 move = controlEnabled ? _f.MoveInput : Vector2.zero;
            Vector3 wish = new Vector3(move.x, 0f, move.y);
            if (wish.sqrMagnitude > 1f) wish.Normalize();

            Vector3 velocity = RB.Vel(body);
            Vector3 planar = new Vector3(velocity.x, 0f, velocity.z);

            if (Grounded)
            {
                Vector3 target = wish * _t.maxRunSpeed;
                float rate = wish.sqrMagnitude > 0.01f ? _t.moveAccel : _t.moveBrake;
                planar = Vector3.MoveTowards(planar, target, rate * dt);
            }
            else if (wish.sqrMagnitude > 0.01f)
            {
                // В воздухе управление слабое: сбитый боец должен долетать до края,
                // а не выруливать обратно на арену.
                planar = Vector3.MoveTowards(planar, wish * _t.maxRunSpeed, _t.airControl * dt);
            }

            PlanarSpeed = planar.magnitude;
            RB.SetVel(body, new Vector3(planar.x, velocity.y, planar.z));
        }

        /// <summary>
        /// Разворот к прицелу. Тело кинематическое, поэтому поворот задаётся напрямую
        /// поворотом корня — никакой инерции дубины, за которую цеплялась прошлая схема.
        /// </summary>
        void ApplyFacing(Rigidbody body, float dt)
        {
            Vector3 want = _f.FacingTarget;
            want.y = 0f;
            if (want.sqrMagnitude < 0.0001f) return;

            Quaternion target = Quaternion.LookRotation(want.normalized, Vector3.up);
            // Поворот пишется прямо в трансформ, а не через MoveRotation: у корня стоит
            // FreezeRotation, и физический поворот он бы попросту не пропустил.
            _f.transform.rotation = Quaternion.RotateTowards(
                _f.transform.rotation, target, _t.turnSpeed * dt);
        }
    }
}
