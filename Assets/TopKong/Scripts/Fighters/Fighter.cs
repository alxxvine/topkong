using System;
using UnityEngine;

namespace TopKong
{
    /// <summary>
    /// Боец: активный ragdoll с рукой-дубиной и рукой-ногой.
    ///
    /// Управление снаружи сводится к двум полям — MoveInput и HandOffset. Их одинаково
    /// выставляют и PlayerController, и BotBrain, поэтому бот дерётся ровно теми же
    /// мышцами, что и игрок, без отдельной "ИИ-физики".
    ///
    /// Контроллеры баланса и дубины намеренно не MonoBehaviour: тогда порядок их вызова
    /// внутри FixedUpdate задаётся здесь явно и не зависит от Script Execution Order.
    /// </summary>
    public class Fighter : MonoBehaviour
    {
        public class Rig
        {
            public Rigidbody Hips;
            public Rigidbody Chest;
            public Rigidbody Head;
            public Rigidbody LegUpper;
            public Rigidbody LegFoot;
            public Rigidbody ClubUpper;
            public Rigidbody Club;
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
        BalanceController _balance;
        ClubDriver _clubDriver;

        JointDrive[] _baseDrives;
        float _driveScale = 1f;
        float _appliedDriveScale = -1f;
        bool _wasSwinging;

        public event Action<Fighter> Eliminated;

        public Rigidbody Hips => _rig.Hips;
        public Rigidbody Chest => _rig.Chest;
        public Rigidbody Club => _rig.Club;
        public Rigidbody ClubUpper => _rig.ClubUpper;
        public Rigidbody LegFoot => _rig.LegFoot;

        /// <summary>
        /// Масса, которую подвеска обязана удержать: всё тело за вычетом руки-ноги —
        /// та стоит на арене и держит себя сама.
        /// </summary>
        public float SupportedMass { get; private set; }

        public float HipsMass => _rig.Hips.mass;

        public string DisplayName { get; private set; }
        public Color TeamColor { get; private set; }
        public bool IsPlayer { get; private set; }
        public bool IsAlive { get; private set; }
        public bool Grounded => _balance != null && _balance.Grounded;

        /// <summary>Боец сейчас поднимается с земли.</summary>
        public bool Recovering => _balance != null && _balance.Recovering;

        /// <summary>Насколько тело вертикально: 1 — стоит ровно, 0 — лежит плашмя.</summary>
        public float Uprightness =>
            _rig != null && _rig.Hips != null ? Vector3.Dot(_rig.Hips.transform.up, Vector3.up) : 1f;

        /// <summary>Куда игрок или бот хочет прыгать: x — вправо, y — вперёд, в осях камеры.</summary>
        public Vector2 MoveInput { get; set; }

        /// <summary>Смещение точки прицела дубины относительно груди, в мировых осях.</summary>
        public Vector3 HandOffset { get; set; }

        /// <summary>
        /// Куда боец должен быть развёрнут. Раньше поворот брался из направления на дубину,
        /// и получалась петля: тело гналось за рукой, а рука пружинила к телу. Она сходилась,
        /// но любое движение мышью разворачивало бойца целиком, и замах на этом фоне
        /// не читался вообще. Теперь поворот — отдельный вход, которым правит мышь.
        /// </summary>
        public Vector3 FacingTarget { get; set; }

        /// <summary>Идёт замах (у игрока — зажата ЛКМ). Корпус в это время помогает руке.</summary>
        public bool Swinging { get; set; }

        /// <summary>Пока false, боец стоит, но не двигается и не машет — используется во вступлении.</summary>
        public bool ControlEnabled { get; set; }

        public float StunTimer { get; private set; }
        public bool Stunned => StunTimer > 0f;

        /// <summary>Текущая скорость дубины — она же сила будущего удара.</summary>
        public float SwingSpeed => _rig != null && _rig.Club != null ? RB.Vel(_rig.Club).magnitude : 0f;

        /// <summary>Максимум скорости за текущий замах. Обнуляется в начале каждого нового.</summary>
        public float SwingPeakSpeed { get; private set; }

        // Данные последнего попадания — нужны панели диагностики в песочнице,
        // чтобы «удар получился слабым» можно было заменить конкретным числом.
        public float LastHitSpeed { get; private set; }
        public float LastHitStrength { get; private set; }
        public float LastHitTime { get; private set; } = -99f;

        public void RecordHit(float speed, float strength)
        {
            LastHitSpeed = speed;
            LastHitStrength = strength;
            LastHitTime = Time.time;
        }

        public Vector3 Position => _rig != null && _rig.Hips != null ? _rig.Hips.position : transform.position;

        /// <summary>Положение в плоскости арены относительно её центра. Длина вектора — расстояние до края.</summary>
        public Vector3 GroundPosition
        {
            get
            {
                var p = Position;
                return _arena != null ? _arena.Flatten(p) : new Vector3(p.x, 0f, p.z);
            }
        }

        /// <summary>Куда боец повёрнут, спроецировано на плоскость арены.</summary>
        public Vector3 Facing
        {
            get
            {
                Vector3 f = _rig.Hips.transform.forward;
                f.y = 0f;
                if (f.sqrMagnitude < 1e-4f)
                {
                    // Тело лежит горизонтально — берём запасную ось, чтобы не делить на ноль.
                    f = _rig.Hips.transform.up;
                    f.y = 0f;
                    if (f.sqrMagnitude < 1e-4f) return Vector3.forward;
                }
                return f.normalized;
            }
        }

        /// <summary>Направление на точку прицела дубины.</summary>
        public Vector3 AimDirection
        {
            get
            {
                Vector3 d = HandOffset;
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

            _baseDrives = new JointDrive[rig.Joints.Length];
            for (int i = 0; i < rig.Joints.Length; i++) _baseDrives[i] = rig.Joints[i].slerpDrive;

            float total = 0f;
            foreach (var b in rig.Bodies) total += b.mass;
            SupportedMass = total - rig.LegUpper.mass - rig.LegFoot.mass;

            _balance = new BalanceController(this, t, arena);
            _balance.Hopped += OnHopped;
            _clubDriver = new ClubDriver(this, t);

            rig.Impact.Init(this, t, fx);

            FacingTarget = Facing;
            HandOffset = Facing * t.handRestReachIdle + Vector3.up * t.clubHeightOffset;
        }

        void OnHopped()
        {
            if (_fx != null && _fx.Sound != null) _fx.Sound.PlayHop();
        }

        public void Stun(float seconds)
        {
            if (!IsAlive) return;
            StunTimer = Mathf.Max(StunTimer, seconds);
        }

        void FixedUpdate()
        {
            if (!IsAlive || _rig == null) return;

            float dt = Time.fixedDeltaTime;
            if (StunTimer > 0f) StunTimer = Mathf.Max(0f, StunTimer - dt);

            if (Swinging)
            {
                if (!_wasSwinging) SwingPeakSpeed = 0f;
                SwingPeakSpeed = Mathf.Max(SwingPeakSpeed, SwingSpeed);
            }
            _wasSwinging = Swinging;

            UpdateDrives(dt);

            if (!Stunned)
            {
                _balance.Tick(dt, ControlEnabled);
                _clubDriver.Tick();
            }

            if (Position.y < _t.killY) Eliminate();
        }

        /// <summary>
        /// Единственный переключатель между "стоит" и "обмяк": сила приводов суставов.
        /// Обмякает почти мгновенно — удар должен читаться сразу; собирается обратно
        /// медленно, за stunRecoverTime, поэтому после сильного попадания боец
        /// заметно шатается, прежде чем снова встать.
        /// </summary>
        void UpdateDrives(float dt)
        {
            float target = Stunned ? 0.05f : 1f;
            float rate = Stunned ? 0.06f : Mathf.Max(0.01f, _t.stunRecoverTime);
            _driveScale = Mathf.MoveTowards(_driveScale, target, dt / rate);

            if (Mathf.Abs(_driveScale - _appliedDriveScale) < 0.002f) return;
            _appliedDriveScale = _driveScale;
            ApplyDriveScale(_driveScale);
        }

        void ApplyDriveScale(float scale)
        {
            for (int i = 0; i < _rig.Joints.Length; i++)
            {
                var j = _rig.Joints[i];
                if (j == null) continue;
                var b = _baseDrives[i];
                j.slerpDrive = new JointDrive
                {
                    positionSpring = b.positionSpring * _t.driveSpringMul * scale,
                    positionDamper = b.positionDamper * _t.driveDamperMul * scale,
                    maximumForce = b.maximumForce
                };
            }
        }

        void LateUpdate()
        {
            if (_rig == null || _rig.Marker == null) return;
            if (!IsAlive)
            {
                _rig.Marker.enabled = false;
                return;
            }
            var p = Position;
            _rig.Marker.transform.SetPositionAndRotation(
                new Vector3(p.x, _arena.TopY + 0.02f, p.z), Quaternion.identity);
        }

        public void Eliminate()
        {
            if (!IsAlive) return;
            IsAlive = false;
            ControlEnabled = false;
            Swinging = false;

            // Дальше он просто падает: приводы в ноль, трение почти убрано.
            _driveScale = 0f;
            _appliedDriveScale = 0f;
            ApplyDriveScale(0f);
            foreach (var b in _rig.Bodies)
            {
                if (b != null) RB.SetDamping(b, 0.01f, 0.02f);
            }
            if (_rig.Impact != null) _rig.Impact.enabled = false;
            if (_rig.Marker != null) _rig.Marker.enabled = false;

            if (_fx != null && _fx.Sound != null) _fx.Sound.PlayFall();

            Eliminated?.Invoke(this);
            Destroy(gameObject, _t.despawnDelay);
        }
    }
}
