using System;
using UnityEngine;

namespace TopKong
{
    public enum BodyState
    {
        /// <summary>Тела кинематические, позу считает PoseDriver, движется капсула-персонаж.</summary>
        Controlled,
        /// <summary>Тела динамические, работают суставы. Так боец получает удар и улетает.</summary>
        Ragdoll,
        /// <summary>Возврат из тряпки в стойку — гарантированный, не физический.</summary>
        StandingUp
    }

    /// <summary>
    /// Боец. Управление снаружи сводится к трём полям — MoveInput, FacingTarget
    /// и SwingHeld; их одинаково выставляют PlayerController и BotBrain, так что бот
    /// дерётся ровно теми же мышцами, что и игрок.
    ///
    /// Тело живёт в двух режимах. Под управлением оно кинематическое: движется
    /// капсула-персонаж на корне, а позу тел считает код. В момент попадания тела
    /// становятся динамическими и продолжают с той же позы уже настоящей физикой —
    /// и весь ragdoll достаётся тому, ради чего он и нужен: полёту с арены.
    ///
    /// Прежняя схема держала тело физическим всё время. Она пришла из VR-идеи, где
    /// у игрока есть настоящая рука с настоящей скоростью; на мыши и клавиатуре
    /// управление в итоге всё время боролось с физикой, и предсказать результат
    /// было нельзя.
    /// </summary>
    public class Fighter : MonoBehaviour
    {
        public class Rig
        {
            public Rigidbody RootBody;
            public Collider RootCollider;
            public Rigidbody Hips;
            public Rigidbody Chest;
            public Rigidbody Head;
            public Rigidbody LegLUpper;
            public Rigidbody LegLFoot;
            public Rigidbody LegRUpper;
            public Rigidbody LegRFoot;
            public Rigidbody ArmR;
            public Rigidbody ArmL;
            public Rigidbody Club;
            public Collider ClubCollider;
            public Rigidbody[] Bodies;
            public Collider[] Colliders;
            public ConfigurableJoint[] Joints;
            public LineRenderer Marker;
            public ClubImpact Impact;
        }

        Rig _rig;
        GameTuning _t;
        Arena _arena;
        GameFx _fx;

        Locomotion _locomotion;
        PoseDriver _pose;
        SwingAction _swing;

        Rigidbody[] _ordered;
        Vector3[] _startPositions;
        Quaternion[] _startRotations;
        Vector3 _lastClubHead;

        float _settleTimer;
        float _standUpTimer;
        float _stateTimer;

        public event Action<Fighter> Eliminated;

        public Rig RigRef => _rig;
        public Rigidbody RootBody => _rig.RootBody;
        public Rigidbody Hips => _rig.Hips;
        public Rigidbody Chest => _rig.Chest;
        public Rigidbody Club => _rig.Club;
        public SwingAction Swing => _swing;

        public BodyState State { get; private set; } = BodyState.Controlled;
        public string DisplayName { get; private set; }
        public Color TeamColor { get; private set; }
        public bool IsPlayer { get; private set; }
        public bool IsAlive { get; private set; }

        public bool Grounded => _locomotion != null && _locomotion.Grounded;
        public bool Ragdolled => State != BodyState.Controlled;

        public Vector2 MoveInput { get; set; }
        public Vector3 FacingTarget { get; set; }
        public bool ControlEnabled { get; set; }

        public bool SwingHeld
        {
            get => _swing != null && _swing.Held;
            // Пока боец летит тряпкой, замахнуться он не может.
            set { if (_swing != null) _swing.Held = value && State == BodyState.Controlled; }
        }

        public bool Swinging => _swing != null && _swing.Striking;
        public float SwingCharge => _swing != null ? _swing.Charge : 0f;
        public float SwingPower => _swing != null ? _swing.Power : 1f;

        /// <summary>Скорость набалдашника — из неё считается сила попадания.</summary>
        public float SwingSpeed { get; private set; }
        public float SwingPeakSpeed { get; private set; }

        public float LastHitSpeed { get; private set; }
        public float LastHitStrength { get; private set; }
        public float LastHitTime { get; private set; } = -99f;

        public void RecordHit(float speed, float strength)
        {
            LastHitSpeed = speed;
            LastHitStrength = strength;
            LastHitTime = Time.time;
        }

        /// <summary>Позиция бойца: капсула под управлением, таз — когда он тряпка.</summary>
        public Vector3 Position
        {
            get
            {
                if (_rig == null) return transform.position;
                return State == BodyState.Controlled && _rig.RootBody != null
                    ? _rig.RootBody.position
                    : _rig.Hips.position;
            }
        }

        /// <summary>Положение в плоскости арены относительно центра. Длина — расстояние до края.</summary>
        public Vector3 GroundPosition
        {
            get
            {
                var p = Position;
                return _arena != null ? _arena.Flatten(p) : new Vector3(p.x, 0f, p.z);
            }
        }

        public Vector3 Facing
        {
            get
            {
                Vector3 f = transform.forward;
                f.y = 0f;
                return f.sqrMagnitude < 1e-4f ? Vector3.forward : f.normalized;
            }
        }

        public Vector3 AimDirection
        {
            get
            {
                Vector3 d = FacingTarget;
                d.y = 0f;
                return d.sqrMagnitude < 1e-4f ? Facing : d.normalized;
            }
        }

        public void Setup(Rig rig, GameTuning t, Arena arena, GameFx fx,
            Color teamColor, string displayName, bool isPlayer)
        {
            _rig = rig;
            _t = t;
            _arena = arena;
            _fx = fx;
            TeamColor = teamColor;
            DisplayName = displayName;
            IsPlayer = isPlayer;
            IsAlive = true;
            ControlEnabled = false;

            _swing = new SwingAction(t);
            _locomotion = new Locomotion(this, t, arena);
            _pose = new PoseDriver(this, t);
            _ordered = _pose.OrderedBodies();
            _startPositions = new Vector3[_ordered.Length];
            _startRotations = new Quaternion[_ordered.Length];

            rig.Impact.Init(this, t, fx);

            FacingTarget = Facing;
            EnterControlled();
            _pose.SnapToRest();
            _lastClubHead = ClubHead();
        }

        void FixedUpdate()
        {
            if (!IsAlive || _rig == null) return;
            float dt = Time.fixedDeltaTime;
            _stateTimer += dt;

            TrackSwingSpeed(dt);

            switch (State)
            {
                case BodyState.Controlled:
                    _swing.Tick(dt);
                    _locomotion.Tick(dt, ControlEnabled);
                    _pose.Tick(dt, _locomotion.PlanarSpeed, _locomotion.Grounded);
                    break;

                case BodyState.Ragdoll:
                    UpdateRagdoll(dt);
                    break;

                case BodyState.StandingUp:
                    UpdateStandUp(dt);
                    break;
            }

            if (Position.y < _t.killY) Eliminate();
        }

        Vector3 ClubHead()
        {
            return _rig.Club != null
                ? _rig.Club.transform.TransformPoint(FighterRig.ClubHeadLocal)
                : transform.position;
        }

        void TrackSwingSpeed(float dt)
        {
            // У кинематического тела velocity нулевая, поэтому скорость набалдашника
            // считаем сами по смещению за кадр. Именно она определяет силу попадания.
            Vector3 head = ClubHead();
            SwingSpeed = (head - _lastClubHead).magnitude / Mathf.Max(1e-5f, dt);
            _lastClubHead = head;

            if (_swing.Striking) SwingPeakSpeed = Mathf.Max(SwingPeakSpeed, SwingSpeed);
            else if (_swing.State == SwingState.WindUp) SwingPeakSpeed = 0f;
        }

        void UpdateRagdoll(float dt)
        {
            // Ждём, пока тело успокоится, и только потом поднимаем: иначе боец
            // начинал бы вставать прямо в полёте.
            float speed = RB.Vel(_rig.Hips).magnitude;
            bool onArena = GroundPosition.magnitude < _arena.Radius
                           && _rig.Hips.position.y > _arena.TopY - 1f;

            if (speed < 1.2f && onArena) _settleTimer += dt;
            else _settleTimer = 0f;

            // Верхняя граница по времени — страховка: встать боец обязан всегда,
            // а не только если физика удачно улеглась.
            if (_settleTimer >= _t.standUpSettle || (onArena && _stateTimer > _t.standUpTimeout))
            {
                BeginStandUp();
            }
        }

        /// <summary>
        /// Переход из тряпки в стойку. Делается интерполяцией, а не физикой:
        /// «встаёт всегда» должно быть гарантией, а прежний физический подъём был
        /// надеждой на удачно подобранные коэффициенты.
        /// </summary>
        void BeginStandUp()
        {
            Vector3 hips = _rig.Hips.position;
            Vector3 flat = _rig.Hips.transform.up;
            flat.y = 0f;
            Quaternion yaw = flat.sqrMagnitude > 1e-4f
                ? Quaternion.LookRotation(flat.normalized, Vector3.up)
                : transform.rotation;

            // Тела — дети корня, поэтому переставить корень значит утащить их за собой.
            // Запоминаем мировые позы, двигаем корень, возвращаем тела на место —
            // только после этого их локальные координаты осмысленны.
            var worldPos = new Vector3[_ordered.Length];
            var worldRot = new Quaternion[_ordered.Length];
            for (int i = 0; i < _ordered.Length; i++)
            {
                if (_ordered[i] == null) continue;
                worldPos[i] = _ordered[i].transform.position;
                worldRot[i] = _ordered[i].transform.rotation;
            }

            SetBodiesKinematic(true);
            transform.SetPositionAndRotation(new Vector3(hips.x, _arena.TopY, hips.z), yaw);

            for (int i = 0; i < _ordered.Length; i++)
            {
                if (_ordered[i] == null) continue;
                _ordered[i].transform.SetPositionAndRotation(worldPos[i], worldRot[i]);
                _startPositions[i] = _ordered[i].transform.localPosition;
                _startRotations[i] = _ordered[i].transform.localRotation;
            }

            _pose.StartLocalPositions = _startPositions;
            _pose.StartLocalRotations = _startRotations;
            _pose.BlendFromStart = 0f;

            EnableRootBody(true);
            RB.SetVel(_rig.RootBody, Vector3.zero);
            FacingTarget = Facing;

            State = BodyState.StandingUp;
            _standUpTimer = 0f;
            _stateTimer = 0f;
        }

        void UpdateStandUp(float dt)
        {
            _standUpTimer += dt;
            float k = Mathf.Clamp01(_standUpTimer / Mathf.Max(0.05f, _t.standUpTime));
            // Сглаживание на концах: без него подъём начинается и кончается рывком.
            _pose.BlendFromStart = k * k * (3f - 2f * k);

            _locomotion.Tick(dt, false);
            _pose.Tick(dt, 0f, _locomotion.Grounded);

            if (k >= 1f) EnterControlled();
        }

        void EnterControlled()
        {
            SetBodiesKinematic(true);
            EnableRootBody(true);
            _pose.BlendFromStart = 1f;
            _swing.Reset();
            State = BodyState.Controlled;
            _stateTimer = 0f;
            _settleTimer = 0f;
        }

        /// <summary>
        /// Перевести бойца в тряпку и придать импульс. Единственный способ сюда попасть —
        /// получить удар: собственные действия тело не роняют.
        /// </summary>
        public void Ragdoll(Vector3 impulse)
        {
            if (!IsAlive || State == BodyState.Ragdoll) return;

            Vector3 inherited = _rig.RootBody != null && !_rig.RootBody.isKinematic
                ? RB.Vel(_rig.RootBody)
                : Vector3.zero;

            _swing.Reset();
            EnableRootBody(false);
            SetBodiesKinematic(false);

            // Тела наследуют скорость капсулы, иначе тряпка появлялась бы из ниоткуда
            // с нулевым импульсом и удар в бегущего выглядел бы слабее, чем он есть.
            foreach (var body in _rig.Bodies)
            {
                if (body != null) RB.SetVel(body, inherited);
            }

            _rig.Hips.AddForce(impulse, ForceMode.VelocityChange);
            _rig.Chest.AddForce(impulse * 0.6f, ForceMode.VelocityChange);

            State = BodyState.Ragdoll;
            _stateTimer = 0f;
            _settleTimer = 0f;
        }

        void SetBodiesKinematic(bool kinematic)
        {
            foreach (var body in _rig.Bodies)
            {
                if (body == null) continue;
                body.isKinematic = kinematic;
                // Интерполяция нужна только динамическим телам. У кинематических,
                // чей трансформ пишется напрямую, она даёт дрожание на кадр.
                body.interpolation = kinematic
                    ? RigidbodyInterpolation.None
                    : RigidbodyInterpolation.Interpolate;
            }

            // Под управлением тело представлено одной капсулой: коллайдеры ragdoll'а
            // выключены, чтобы объём был ровно один. Дубина — исключение, ей бьют.
            foreach (var col in _rig.Colliders)
            {
                if (col == null || col == _rig.ClubCollider) continue;
                col.enabled = !kinematic;
            }
        }

        void EnableRootBody(bool on)
        {
            if (_rig.RootBody != null) _rig.RootBody.isKinematic = !on;
            if (_rig.RootCollider != null) _rig.RootCollider.enabled = on;
        }

        void LateUpdate()
        {
            if (_rig == null || _rig.Marker == null) return;
            if (!IsAlive || State != BodyState.Controlled)
            {
                _rig.Marker.enabled = false;
                return;
            }
            _rig.Marker.enabled = true;
            var p = Position;
            _rig.Marker.transform.SetPositionAndRotation(
                new Vector3(p.x, _arena.TopY + 0.02f, p.z), Quaternion.identity);
        }

        public void Eliminate()
        {
            if (!IsAlive) return;

            // Улетать с арены надо тряпкой — так падение читается.
            if (State == BodyState.Controlled) Ragdoll(Vector3.zero);

            IsAlive = false;
            ControlEnabled = false;
            State = BodyState.Ragdoll;

            if (_rig.Impact != null) _rig.Impact.enabled = false;
            if (_rig.Marker != null) _rig.Marker.enabled = false;

            if (_fx != null && _fx.Sound != null) _fx.Sound.PlayFall();

            Eliminated?.Invoke(this);
            Destroy(gameObject, _t.despawnDelay);
        }
    }
}
