using System;
using UnityEngine;

namespace TopKong
{
    /// <summary>
    /// Держит бойца на ногах и двигает его микро-прыжками.
    ///
    /// Ходьбы здесь нет вовсе, и это не упрощение, а следствие анатомии: опора одна —
    /// рука-нога. Вместо шагов таз висит на виртуальной пружине над ареной (рейкаст вниз
    /// плюс демпфер), а вертикаль держит момент, доворачивающий тело к мировому "вверх".
    /// Рука-нога при этом честно болтается на суставе и получает импульс вниз в момент
    /// толчка — то есть отталкивание видно, но баланс на неё не завязан. Иначе боец
    /// падал бы каждый раз, когда единственная опора оказывается не под центром масс.
    /// </summary>
    public class BalanceController
    {
        readonly Fighter _f;
        readonly GameTuning _t;
        readonly Arena _arena;

        float _hopTimer;
        float _suspensionMute;
        float _getUpTimer;
        bool _recovering;
        bool _kickRightFoot;

        public bool Grounded { get; private set; }

        /// <summary>Боец сейчас поднимается с земли — управление на это время отобрано.</summary>
        public bool Recovering => _recovering;

        public event Action Hopped;

        public BalanceController(Fighter fighter, GameTuning tuning, Arena arena)
        {
            _f = fighter;
            _t = tuning;
            _arena = arena;
        }

        public void Tick(float dt, bool controlEnabled)
        {
            var hips = _f.Hips;
            if (hips == null) return;

            ProbeGround(hips, out float groundDistance);

            _suspensionMute -= dt;
            _hopTimer -= dt;

            UpdateRecovery(hips, dt);

            ApplySuspension(hips, groundDistance);
            ApplyUpright(hips);
            ApplyFacing(hips);
            ApplyMovement(hips, dt, controlEnabled);
            ApplyAngularDamping(hips);
        }

        /// <summary>
        /// Определяет, лежит ли боец, и держит режим подъёма.
        ///
        /// Порог со гистерезисом: входим в режим при одном наклоне, выходим при заметно
        /// меньшем. Без этого на самой границе боец бесконечно дёргался бы между
        /// "встаю" и "стою".
        /// </summary>
        void UpdateRecovery(Rigidbody hips, float dt)
        {
            float upright = Vector3.Dot(hips.transform.up, Vector3.up);

            if (_recovering)
            {
                if (upright > _t.getUpTiltThreshold + _t.getUpHysteresis)
                {
                    _recovering = false;
                    _getUpTimer = 0f;
                }
            }
            else if (upright < _t.getUpTiltThreshold)
            {
                _recovering = true;
                _getUpTimer = 0f;
            }

            if (_recovering) _getUpTimer += dt;
        }

        /// <summary>
        /// Во сколько раз усилить возврат в стойку.
        ///
        /// После getUpTimeout множитель растёт линейно и без потолка. Это страховка:
        /// "боец всегда встаёт" должно быть гарантией, а не следствием удачно
        /// подобранных коэффициентов — рано или поздно найдётся поза, из которой
        /// фиксированного усилия не хватит, и он останется лежать навсегда.
        /// </summary>
        float RecoveryBoost
        {
            get
            {
                if (!_recovering) return 1f;
                float overtime = Mathf.Max(0f, _getUpTimer - _t.getUpTimeout);
                return _t.getUpBoost * (1f + overtime * 2f);
            }
        }

        /// <summary>
        /// Луч проверяется только против коллайдера арены. Так не нужны ни слои
        /// (они живут в ProjectSettings, которые мы не коммитим), ни фильтрация
        /// собственных коллайдеров бойца, в которые обычный Physics.Raycast упирался бы первым.
        /// </summary>
        void ProbeGround(Rigidbody hips, out float distance)
        {
            distance = float.MaxValue;
            Grounded = false;
            if (_arena.Ground == null) return;

            var ray = new Ray(hips.position, Vector3.down);
            if (_arena.Ground.Raycast(ray, out RaycastHit hit, _t.standHeight * 2.2f))
            {
                distance = hit.distance;
                Grounded = distance <= _t.standHeight * 1.35f;
            }
        }

        void ApplySuspension(Rigidbody hips, float groundDistance)
        {
            if (!Grounded || _suspensionMute > 0f) return;

            // Компенсация веса. Без неё пружине пришлось бы держать всё тело собственной
            // жёсткостью: сила прикладывается в режиме Acceleration к одному тазу, а висят
            // на нём через суставы ещё сорок с лишним килограммов, и боец просто оседал бы
            // почти до земли, пока сжатие не станет огромным. С компенсацией равновесие
            // ровно на standHeight, а suspensionSpring отвечает только за жёсткость отклика.
            float weightHold = (_f.SupportedMass / Mathf.Max(0.01f, _f.HipsMass)) * (-Physics.gravity.y);

            // Плавное затухание к границе "на земле": резкое включение на пороге
            // заставляло бы бойца подпрыгивать на ровном месте.
            float support = 1f - Mathf.InverseLerp(_t.standHeight, _t.standHeight * 1.35f, groundDistance);
            support = Mathf.Clamp01(support);

            // Сжатие обязательно ограничить сверху. У лежащего бойца таз почти на земле,
            // сжатие получается огромным, и неограниченная пружина катапультировала бы
            // его вместо того, чтобы поднять.
            float compression = Mathf.Min(_t.standHeight - groundDistance, _t.standHeight * 0.4f);
            float verticalSpeed = RB.Vel(hips).y;
            float force = weightHold * support
                        + compression * _t.suspensionSpring
                        - verticalSpeed * _t.suspensionDamper;

            // Только вверх: подвеска подпирает, но не притягивает обратно к земле,
            // иначе она гасила бы собственные прыжки и чужие удары с подбросом.
            if (force > 0f) hips.AddForce(Vector3.up * force, ForceMode.Acceleration);
        }

        void ApplyUpright(Rigidbody hips)
        {
            var chest = _f.Chest;

            float boost = RecoveryBoost;
            // Демпфер растёт как корень из жёсткости — так коэффициент затухания
            // остаётся прежним. Разгонять одну только пружину значит получить
            // не подъём, а раскачку.
            float damperBoost = Mathf.Sqrt(boost);

            Vector3 axis = Vector3.Cross(hips.transform.up, Vector3.up);
            hips.AddTorque(axis * (_t.uprightSpring * boost)
                - TiltVelocity(hips) * (_t.uprightDamper * damperBoost),
                ForceMode.Acceleration);

            if (chest != null)
            {
                // Пока боец лежит, грудь тянут наравне с тазом: одного таза не хватает,
                // чтобы перевернуть тело, у которого сверху голова, а спереди тяжёлая дубина.
                float chestShare = _recovering ? 1f : 0.6f;
                Vector3 chestAxis = Vector3.Cross(chest.transform.up, Vector3.up);
                chest.AddTorque(chestAxis * (_t.uprightSpring * chestShare * boost)
                    - TiltVelocity(chest) * (_t.uprightDamper * chestShare * damperBoost),
                    ForceMode.Acceleration);
            }
        }

        /// <summary>
        /// Угловая скорость без составляющей рыскания.
        ///
        /// Демпферы вертикали обязаны гасить заваливание, но не разворот. Пока они
        /// работали по всем осям сразу, тот же коэффициент, что держит бойца на ногах,
        /// душил и поворот к прицелу — и поворот выглядел безнадёжно вялым.
        /// За рыскание отвечает отдельный демпфер в ApplyFacing.
        /// </summary>
        static Vector3 TiltVelocity(Rigidbody body)
        {
            Vector3 angular = body.angularVelocity;
            return angular - Vector3.up * angular.y;
        }

        /// <summary>
        /// Гасит заваливание таза на земле. Отдельно от uprightDamper специально: тот
        /// участвует в возврате к вертикали, и поднимать его ради устойчивости
        /// означало бы заодно сделать подъём деревянным.
        /// </summary>
        void ApplyAngularDamping(Rigidbody hips)
        {
            if (!Grounded) return;
            hips.AddTorque(-TiltVelocity(hips) * _t.groundedAngularDamping, ForceMode.Acceleration);
        }

        /// <summary>Доворачивает тело к заданному направлению. У игрока им правит мышь, у бота — цель.</summary>
        void ApplyFacing(Rigidbody hips)
        {
            Vector3 want = _f.FacingTarget;
            want.y = 0f;
            if (want.sqrMagnitude < 0.01f) return;
            want.Normalize();

            float errorDeg = Vector3.SignedAngle(_f.Facing, want, Vector3.up);
            float torque = errorDeg * Mathf.Deg2Rad * _t.facingSpring
                         - hips.angularVelocity.y * _t.facingDamper;
            hips.AddTorque(Vector3.up * torque, ForceMode.Acceleration);
        }

        void ApplyMovement(Rigidbody hips, float dt, bool controlEnabled)
        {
            // Пока поднимается — не прыгает. Прыжок из лежачего положения только
            // отбрасывал бы тело дальше и мешал ему собраться в стойку.
            if (_recovering)
            {
                // Строго на земле. Сбитый боец летит к обрыву тоже в перевёрнутом виде,
                // и торможение в воздухе спасало бы его от падения — то есть ломало бы
                // ровно ту механику, ради которой игра существует.
                if (Grounded) DampHorizontal(hips, dt);
                return;
            }

            Vector2 mv = controlEnabled ? _f.MoveInput : Vector2.zero;
            Vector3 dir = new Vector3(mv.x, 0f, mv.y);
            if (dir.sqrMagnitude > 1f) dir.Normalize();
            bool wantsMove = dir.sqrMagnitude > 0.01f;

            if (!Grounded)
            {
                if (wantsMove) hips.AddForce(dir.normalized * _t.airControl, ForceMode.Acceleration);
                return;
            }

            if (wantsMove && _hopTimer <= 0f)
            {
                Hop(hips, dir.normalized);
                return;
            }

            // Без этого боец бесконечно скользит после последнего прыжка.
            if (!wantsMove) DampHorizontal(hips, dt);
        }

        void DampHorizontal(Rigidbody hips, float dt)
        {
            Vector3 v = RB.Vel(hips);
            Vector3 horizontal = new Vector3(v.x, 0f, v.z);
            horizontal = Vector3.MoveTowards(horizontal, Vector3.zero, _t.groundFriction * dt);
            RB.SetVel(hips, new Vector3(horizontal.x, v.y, horizontal.z));
        }

        void Hop(Rigidbody hips, Vector3 dir)
        {
            Vector3 v = RB.Vel(hips);
            Vector3 horizontal = new Vector3(v.x, 0f, v.z);
            horizontal = Vector3.MoveTowards(horizontal, dir * _t.maxRunSpeed, _t.hopAccel);

            // Скорость задаётся напрямую, а не импульсом: прыжки должны быть одинаковыми
            // независимо от того, сколько их уже было подряд.
            RB.SetVel(hips, new Vector3(horizontal.x, _t.hopUp, horizontal.z));

            // Толчок уходит в ноги поочерёдно. Отдельной анимации ходьбы нет, но
            // чередование само по себе читается как походка — бесплатно и убедительно.
            _kickRightFoot = !_kickRightFoot;
            var foot = _kickRightFoot ? _f.LegFootRight : _f.LegFootLeft;
            if (foot != null)
            {
                foot.AddForce(Vector3.down * _t.legKick - dir * (_t.legKick * 0.35f),
                    ForceMode.VelocityChange);
            }

            _hopTimer = _t.hopInterval;
            // Подвеска на мгновение выключается, иначе она погасит собственный прыжок.
            _suspensionMute = 0.12f;
            Hopped?.Invoke();
        }
    }
}
