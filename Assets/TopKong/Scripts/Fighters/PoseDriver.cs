using UnityEngine;

namespace TopKong
{
    /// <summary>
    /// Расставляет тела бойца, пока он под управлением.
    ///
    /// Анимаций в проекте нет ни одной, поэтому поза считается формулами: стойка,
    /// шаг с подскоком по скорости и дуга удара из SwingAction. Тела в это время
    /// кинематические, так что поза получается ровно такой, какой задумана —
    /// ни физика, ни суставы в неё не вмешиваются.
    ///
    /// Это и есть главное отличие от прежней схемы: раньше поза была результатом
    /// борьбы приводов с инерцией, и предсказать её было нельзя.
    ///
    /// Тот же код используется для вставания: Fighter запоминает позу, в которой
    /// боец дошатался на земле, и просит подмешивать её к стойке с убывающим весом.
    /// </summary>
    public class PoseDriver
    {
        readonly Fighter _f;
        readonly GameTuning _t;

        float _stepPhase;
        float _bob;
        float _stride;
        float _lean;
        float _sway;
        float _clubLag;
        float _lastYaw;
        float _lastSpeed;
        readonly float _noiseSeed = Random.value * 100f;
        int _writeIndex;

        /// <summary>1 — чистая вычисленная поза, 0 — поза, запомненная при вставании.</summary>
        public float BlendFromStart { get; set; } = 1f;
        public Vector3[] StartLocalPositions { get; set; }
        public Quaternion[] StartLocalRotations { get; set; }

        public PoseDriver(Fighter fighter, GameTuning tuning)
        {
            _f = fighter;
            _t = tuning;
        }

        /// <summary>Тела в том же порядке, в каком их пишет Apply. По нему запоминается поза старта.</summary>
        public Rigidbody[] OrderedBodies()
        {
            var rig = _f.RigRef;
            return new[]
            {
                rig.Hips, rig.Chest, rig.Head, rig.Club,
                rig.LegLUpper, rig.LegLFoot, rig.LegRUpper, rig.LegRFoot,
                rig.ArmR, rig.ArmL
            };
        }

        public void Tick(float dt, float planarSpeed, bool grounded)
        {
            var swing = _f.Swing;

            // Шаг крутится тем быстрее, чем быстрее боец едет. В покое фаза
            // подтягивается к целому, чтобы ноги вставали ровно.
            float normalized = Mathf.Clamp01(planarSpeed / Mathf.Max(0.1f, _t.maxRunSpeed));
            float targetStride = normalized * _t.stepLength;
            _stride = Mathf.MoveTowards(_stride, grounded ? targetStride : 0f, dt * 3f);

            if (normalized > 0.05f && grounded)
            {
                _stepPhase += dt * _t.stepRate * normalized;
                _stepPhase -= Mathf.Floor(_stepPhase);
            }
            else
            {
                _stepPhase = Mathf.MoveTowards(_stepPhase, Mathf.Round(_stepPhase), dt * 2f);
            }

            // Подскок вдвое чаще шага: две ноги — два толчка за цикл.
            float targetBob = grounded
                ? Mathf.Abs(Mathf.Sin(_stepPhase * Mathf.PI * 2f)) * _t.stepBob * normalized
                : 0f;
            _bob = Mathf.Lerp(_bob, targetBob, Mathf.Clamp01(12f * dt));

            UpdateWobble(dt, planarSpeed, normalized);

            var pose = FighterRig.Compute(_bob, _stepPhase, _stride,
                swing.ClubAngle + _clubLag, swing.ClubReach, swing.Lean + _lean, _sway);

            Apply(pose);
        }

        /// <summary>
        /// Вторичная анимация: завал корпуса от разгона, покачивание и отставание дубины.
        ///
        /// Тело кинематическое и потому идеально ровное — из-за этого пропадало ощущение
        /// веса и риска. Возвращать ради этого физику нельзя, с ней управление
        /// уже воевало; вместо неё здесь три дешёвых источника неровности, каждый
        /// из которых полностью управляем.
        /// </summary>
        void UpdateWobble(float dt, float planarSpeed, float normalized)
        {
            // 1. Инерция: разгоняешься — корпус отстаёт назад, тормозишь — валится вперёд.
            float acceleration = (planarSpeed - _lastSpeed) / Mathf.Max(1e-5f, dt);
            _lastSpeed = planarSpeed;
            float leanTarget = Mathf.Clamp(-acceleration * _t.leanFromAccel, -1.2f, 1.2f);
            _lean = Mathf.Lerp(_lean, leanTarget, Mathf.Clamp01(8f * dt));

            // 2. Покачивание. У края арены усиливается — это единственный честный способ
            // показать риск, не отбирая у игрока контроль.
            float edge = _f.RigRef != null
                ? Mathf.InverseLerp(_edgeSafe, _edgeLimit, _f.GroundPosition.magnitude)
                : 0f;
            float amount = _t.wobbleAmount * (0.4f + normalized) * (1f + edge * 2f);
            float noise = Mathf.PerlinNoise(_noiseSeed, Time.time * _t.wobbleRate) * 2f - 1f;
            // Плюс раскачка в такт шагу: на каждый шаг тело кренится в свою сторону.
            float stepSway = Mathf.Sin(_stepPhase * Mathf.PI * 2f) * 0.5f * normalized;
            _sway = Mathf.Lerp(_sway, (noise + stepSway) * amount, Mathf.Clamp01(6f * dt));

            // 3. Дубина отстаёт от разворота — только так у неё читается вес.
            // На проносе отставание гасится: там важен точный тайминг, а не инерция.
            float yaw = _f.transform.eulerAngles.y;
            float yawRate = Mathf.DeltaAngle(_lastYaw, yaw) / Mathf.Max(1e-5f, dt);
            _lastYaw = yaw;

            float lagTarget = _f.Swing.Striking ? 0f : Mathf.Clamp(-yawRate * _t.limbLag, -60f, 60f);
            _clubLag = Mathf.Lerp(_clubLag, lagTarget, Mathf.Clamp01((_f.Swing.Striking ? 25f : 9f) * dt));
        }

        float _edgeSafe => _t.arenaRadius * 0.55f;
        float _edgeLimit => _t.arenaRadius;

        /// <summary>Поставить бойца в чистую стойку — используется при спавне.</summary>
        public void SnapToRest()
        {
            _stepPhase = 0f;
            _bob = 0f;
            _stride = 0f;
            _lean = 0f;
            _sway = 0f;
            _clubLag = 0f;
            _lastSpeed = 0f;
            _lastYaw = _f.transform.eulerAngles.y;
            BlendFromStart = 1f;
            Apply(FighterRig.RestPose());
        }

        void Apply(FighterRig.Pose pose)
        {
            var rig = _f.RigRef;
            _writeIndex = 0;

            Set(rig.Hips, pose.Hips, pose.HipsRotation);
            Set(rig.Chest, pose.Chest, pose.ChestRotation);
            Set(rig.Head, pose.Head, pose.HeadRotation);
            Set(rig.Club, pose.Club, pose.ClubRotation);

            PlaceLimb(rig.LegLUpper, FighterRig.HipJoint(false), Knee(pose.FootLeft, false));
            PlaceLimb(rig.LegLFoot, Knee(pose.FootLeft, false), pose.FootLeft);
            PlaceLimb(rig.LegRUpper, FighterRig.HipJoint(true), Knee(pose.FootRight, true));
            PlaceLimb(rig.LegRFoot, Knee(pose.FootRight, true), pose.FootRight);

            PlaceLimb(rig.ArmR, FighterRig.Shoulder(true), pose.HandRight);
            PlaceLimb(rig.ArmL, FighterRig.Shoulder(false), pose.HandLeft);
        }

        /// <summary>
        /// Колено — середина между бедром и стопой, чуть вынесенная вперёд.
        /// Настоящая двухзвенная IK тут не нужна: ноги короткие, камера далеко,
        /// а разницу видно, только если специально искать.
        /// </summary>
        static Vector3 Knee(Vector3 foot, bool right)
        {
            Vector3 hip = FighterRig.HipJoint(right);
            Vector3 mid = (hip + foot) * 0.5f;
            mid.z += 0.06f;
            return mid;
        }

        void PlaceLimb(Rigidbody body, Vector3 from, Vector3 to)
        {
            FighterRig.Limb(from, to, out Vector3 center, out Quaternion rotation);
            Set(body, center, rotation);
        }

        void Set(Rigidbody body, Vector3 localPos, Quaternion localRot)
        {
            int index = _writeIndex++;
            if (body == null) return;

            if (BlendFromStart < 1f
                && StartLocalPositions != null && index < StartLocalPositions.Length)
            {
                localPos = Vector3.Lerp(StartLocalPositions[index], localPos, BlendFromStart);
                localRot = Quaternion.Slerp(StartLocalRotations[index], localRot, BlendFromStart);
            }

            body.transform.localPosition = localPos;
            body.transform.localRotation = localRot;
        }
    }
}
