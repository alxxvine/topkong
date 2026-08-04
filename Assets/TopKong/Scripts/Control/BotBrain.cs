using UnityEngine;

namespace TopKong
{
    /// <summary>
    /// Бот. Пользуется ровно теми же двумя рычагами, что и игрок — MoveInput и HandOffset,
    /// поэтому у него нет ни телепортов, ни бесплатных ударов: он так же прыгает
    /// на одной руке-ноге и так же разгоняет дубину, просто "мышью" ему работает
    /// синусоида, а не рука.
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

        bool _swinging;
        float _swingPhase;
        float _swingDir = 1f;
        float _swingAimDeg;
        float _swingTime = 0.3f;
        float _swingCooldown;
        float _reaction;

        Vector3 _hand;
        float _skill;

        public void Init(GameTuning tuning, Arena arena, MatchManager match)
        {
            _f = GetComponent<Fighter>();
            _t = tuning;
            _arena = arena;
            _match = match;
            // Небольшой разброс, чтобы боты не действовали как один организм.
            _skill = Mathf.Clamp01(_t.botSkill + Random.Range(-0.15f, 0.15f));
            _hand = _f.Facing * _t.handRestReach;
            _reaction = _t.botReaction;
        }

        void Update()
        {
            if (_f == null || !_f.IsAlive || _t == null) return;

            float dt = Time.deltaTime;
            Retarget(dt);

            if (!_f.ControlEnabled || _f.Stunned)
            {
                _f.MoveInput = Vector2.zero;
                return;
            }

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

        void UpdateSwing(float dt)
        {
            _swingCooldown -= dt;

            Vector3 me = _f.GroundPosition;
            Vector3 toTarget = _target != null ? _target.GroundPosition - me : Vector3.zero;
            float distance = toTarget.magnitude;

            if (!_swinging)
            {
                bool inRange = _target != null && distance < _t.botSwingRange;
                if (inRange && _swingCooldown <= 0f)
                {
                    _reaction -= dt;
                    if (_reaction <= 0f) StartSwing(toTarget);
                }
                else
                {
                    _reaction = _t.botReaction * Mathf.Lerp(1.6f, 0.5f, _skill);
                }

                // Дубина держится в сторону цели и медленно возвращается — как у игрока.
                Vector3 rest = (_target != null && distance > 0.001f ? toTarget / distance : _f.Facing)
                               * _t.handRestReach;
                _hand = Vector3.Lerp(_hand, rest, Mathf.Clamp01(_t.handReturnRate * 0.6f * dt));
            }
            else
            {
                _swingPhase += dt / _swingTime;
                if (_swingPhase >= 1f)
                {
                    _swinging = false;
                    _swingPhase = 0f;
                    _swingDir = -_swingDir;
                    _swingCooldown = Mathf.Lerp(1.15f, 0.35f, _skill);
                    _reaction = _t.botReaction * Mathf.Lerp(1.6f, 0.5f, _skill);
                }
                else
                {
                    // Проносим руку дугой сквозь цель. Скорость проноса — это и есть
                    // "как быстро бот двигает мышью", то есть сила удара.
                    const float sweep = 75f;
                    float angle = _swingAimDeg + Mathf.Lerp(-sweep, sweep, _swingPhase) * _swingDir;
                    // Рука выпрямляется к середине замаха.
                    float reach = Mathf.Lerp(_t.handRestReach, _t.handMaxReach,
                        Mathf.Sin(_swingPhase * Mathf.PI));
                    _hand = Quaternion.Euler(0f, angle, 0f) * Vector3.forward * reach;
                }
            }

            _f.HandOffset = _hand + Vector3.up * _t.clubHeightOffset;
        }

        void StartSwing(Vector3 toTarget)
        {
            _swinging = true;
            _swingPhase = 0f;
            // Чем ниже мастерство, тем быстрее промахивается и тем медленнее машет.
            _swingTime = Mathf.Lerp(0.42f, 0.17f, _skill);
            float error = Random.Range(-1f, 1f) * Mathf.Lerp(24f, 5f, _skill);
            Vector3 aim = toTarget.sqrMagnitude > 0.0001f ? toTarget.normalized : _f.Facing;
            _swingAimDeg = Mathf.Atan2(aim.x, aim.z) * Mathf.Rad2Deg + error;
        }
    }
}
