using UnityEngine;

namespace TopKong
{
    /// <summary>
    /// Бот. Пользуется ровно теми же рычагами, что и игрок — MoveInput, FacingTarget
    /// и SwingHeld, — поэтому у него нет ни телепортов, ни бесплатных ударов: он так же
    /// прыгает, так же разворачивается к цели и так же копит замах, просто кнопку
    /// за него жмёт таймер.
    ///
    /// Приоритет поведения жёсткий: сначала не упасть самому, и только потом драться.
    /// Без этого боты сносят друг друга в первые пять секунд и раунд заканчивается
    /// раньше, чем игрок успеет вмешаться.
    /// </summary>
    [RequireComponent(typeof(Fighter))]
    public class BotBrain : MonoBehaviour
    {
        Fighter _f;
        GameTuning _t;
        Arena _arena;
        MatchManager _match;

        Fighter _target;
        float _retargetTimer;

        float _strafeSign = 1f;
        float _strafeTimer;

        bool _holding;
        float _holdUntil;
        float _nextSwingAt;
        float _reaction;

        float _skill;

        public void Init(GameTuning tuning, Arena arena, MatchManager match)
        {
            _f = GetComponent<Fighter>();
            _t = tuning;
            _arena = arena;
            _match = match;
            // Небольшой разброс, чтобы боты не действовали как один организм.
            _skill = Mathf.Clamp01(_t.botSkill + Random.Range(-0.15f, 0.15f));
            _reaction = _t.botReaction;
        }

        void Update()
        {
            if (_f == null || !_f.IsAlive || _t == null) return;

            float dt = Time.deltaTime;
            Retarget(dt);

            if (!_f.ControlEnabled || _f.Ragdolled)
            {
                _f.MoveInput = Vector2.zero;
                _f.SwingHeld = false;
                _holding = false;
                return;
            }

            UpdateFacing();
            UpdateMovement(dt);
            UpdateSwing(dt);
        }

        void Retarget(float dt)
        {
            _retargetTimer -= dt;
            if (_target != null && _target.IsAlive && _retargetTimer > 0f) return;

            _retargetTimer = 0.5f;
            _target = null;
            float best = float.MaxValue;

            var all = _match.Fighters;
            for (int i = 0; i < all.Count; i++)
            {
                var other = all[i];
                if (other == null || other == _f || !other.IsAlive) continue;
                float d = (other.GroundPosition - _f.GroundPosition).sqrMagnitude;
                // Игрока предпочитаем при прочих равных — драться с ботами скучно смотреть.
                if (other.IsPlayer) d *= 0.7f;
                if (d < best)
                {
                    best = d;
                    _target = other;
                }
            }
        }

        /// <summary>
        /// Бот держит соперника перед собой. Тот же вход, которым у игрока правит мышь, —
        /// у бота нет привилегии бить в спину, не поворачиваясь.
        /// </summary>
        void UpdateFacing()
        {
            Vector3 want;
            if (_target != null)
            {
                want = _target.GroundPosition - _f.GroundPosition;
            }
            else
            {
                want = new Vector3(_f.MoveInput.x, 0f, _f.MoveInput.y);
            }

            if (want.sqrMagnitude > 0.0001f) _f.FacingTarget = want.normalized;
        }

        void UpdateMovement(float dt)
        {
            _strafeTimer -= dt;
            if (_strafeTimer <= 0f)
            {
                _strafeTimer = Random.Range(1.1f, 2.4f);
                _strafeSign = Random.value < 0.5f ? -1f : 1f;
            }

            Vector3 me = _f.GroundPosition;
            float distanceFromCenter = me.magnitude;
            float safeRadius = _arena.Radius * _t.botEdgeCaution;

            Vector3 dir;

            if (distanceFromCenter > safeRadius)
            {
                // Край. Всё остальное подождёт.
                dir = -me.normalized;
            }
            else if (_target != null)
            {
                Vector3 toTarget = _target.GroundPosition - me;
                float distance = toTarget.magnitude;
                Vector3 forward = distance > 0.001f ? toTarget / distance : _f.Facing;

                if (distance > _t.botEngageRange)
                {
                    dir = forward;
                }
                else
                {
                    // На дистанции удара — кружим и подтравливаем, чтобы не залипать вплотную.
                    Vector3 side = Vector3.Cross(Vector3.up, forward) * _strafeSign;
                    float radial = distance < _t.botEngageRange * 0.65f ? -0.6f : 0.25f;
                    dir = (side * 0.85f + forward * radial).normalized;
                }
            }
            else
            {
                dir = Vector3.zero;
            }

            _f.MoveInput = new Vector2(dir.x, dir.z);
        }

        /// <summary>
        /// Замах у бота — это удержание кнопки на время. Дугу, тайминги и накопление
        /// считает тот же SwingAction, что и у игрока; здесь только решение,
        /// когда нажать и когда отпустить.
        /// </summary>
        void UpdateSwing(float dt)
        {
            if (_holding)
            {
                if (Time.time >= _holdUntil)
                {
                    _f.SwingHeld = false;
                    _holding = false;
                    _nextSwingAt = Time.time + Mathf.Lerp(1.2f, 0.4f, _skill);
                    _reaction = _t.botReaction * Mathf.Lerp(1.6f, 0.5f, _skill);
                }
                return;
            }

            _f.SwingHeld = false;

            float distance = _target != null
                ? (_target.GroundPosition - _f.GroundPosition).magnitude
                : float.MaxValue;

            if (distance > _t.botSwingRange || Time.time < _nextSwingAt)
            {
                _reaction = _t.botReaction * Mathf.Lerp(1.6f, 0.5f, _skill);
                return;
            }

            _reaction -= dt;
            if (_reaction > 0f) return;

            // Чем выше мастерство, тем полнее бот заряжает удар.
            _holding = true;
            _f.SwingHeld = true;
            _holdUntil = Time.time + Mathf.Lerp(0.15f, _t.swingChargeTime, _skill);
        }
    }
}
