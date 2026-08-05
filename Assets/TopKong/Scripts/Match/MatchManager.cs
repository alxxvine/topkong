using System.Collections.Generic;
using UnityEngine;

namespace TopKong
{
    public enum MatchState
    {
        Intro,
        Fighting,
        RoundOver
    }

    /// <summary>
    /// Раунд: расставить бойцов, дождаться пока останется один, перезапустить.
    /// Никакого счёта жизней и урона — единственное событие, которое здесь вообще
    /// обрабатывается, это "кто-то улетел с арены".
    /// </summary>
    public class MatchManager : MonoBehaviour
    {
        static readonly Color PlayerColor = new Color(1f, 0.62f, 0.16f);
        static readonly Color[] BotColors =
        {
            new Color(0.35f, 0.72f, 1f),
            new Color(0.45f, 0.85f, 0.45f),
            new Color(0.90f, 0.35f, 0.55f),
            new Color(0.75f, 0.55f, 1f),
            new Color(0.35f, 0.85f, 0.80f),
            new Color(0.95f, 0.85f, 0.35f),
            new Color(0.95f, 0.45f, 0.30f)
        };

        GameTuning _t;
        Arena _arena;
        ArenaCamera _camera;
        AimCursor _aim;
        Sfx _sfx;
        GameFx _fx;
        Transform _container;

        /// <summary>Манекен в песочнице: боец без мозга, который стоит и получает.</summary>
        class Dummy
        {
            public Fighter Fighter;
            public Vector3 Offset;
            public Color Color;
            public string Name;
            public float RespawnAt;
        }

        readonly List<Fighter> _fighters = new List<Fighter>();
        readonly List<Dummy> _dummies = new List<Dummy>();
        float _timer;
        float _hitStopUntil;
        bool _slowMotion;

        public bool Sandbox => _t != null && _t.sandboxMode;
        public bool SlowMotion => _slowMotion;

        public IReadOnlyList<Fighter> Fighters => _fighters;
        public MatchState State { get; private set; }
        public int Round { get; private set; }
        public Fighter Player { get; private set; }
        public bool PlayerWon { get; private set; }
        public float StateTimer => _timer;

        public int AliveCount
        {
            get
            {
                int n = 0;
                for (int i = 0; i < _fighters.Count; i++)
                {
                    if (_fighters[i] != null && _fighters[i].IsAlive) n++;
                }
                return n;
            }
        }

        public void Init(GameTuning tuning, Arena arena, ArenaCamera cam, AimCursor aim, Sfx sfx, GameFx fx)
        {
            _t = tuning;
            _arena = arena;
            _camera = cam;
            _aim = aim;
            _sfx = sfx;
            _fx = fx;
            _fx.HitStop = TriggerHitStop;

            _container = new GameObject("Fighters").transform;
            _container.SetParent(transform, false);
        }

        public void StartRound()
        {
            ClearFighters();
            Round++;

            if (_t.sandboxMode)
            {
                StartSandbox();
                return;
            }

            int total = Mathf.Max(2, _t.botCount + 1);
            float spawnRadius = _arena.Radius * _t.spawnRadiusFactor;

            for (int i = 0; i < total; i++)
            {
                float angle = i / (float)total * Mathf.PI * 2f;
                Vector3 offset = new Vector3(Mathf.Cos(angle), 0f, Mathf.Sin(angle)) * spawnRadius;

                bool isPlayer = i == 0;
                Color color = isPlayer ? PlayerColor : BotColors[(i - 1) % BotColors.Length];
                string name = isPlayer ? "Ты" : "Бот " + i;

                // Все смотрят в центр — иначе первые секунды раунда уходят на разворот.
                var fighter = Spawn(offset, FaceCenterYaw(offset), color, name, isPlayer);

                if (isPlayer)
                {
                    Player = fighter;
                    var pc = fighter.gameObject.AddComponent<PlayerController>();
                    pc.Init(_t, _camera, _aim);
                }
                else
                {
                    var bot = fighter.gameObject.AddComponent<BotBrain>();
                    bot.Init(_t, _arena, this);
                }
            }

            if (Player != null)
            {
                _camera.SetTarget(Player.Hips.transform);
                _aim.SetOwner(Player.Hips.transform);
            }

            SetControlEnabled(false);
            State = MatchState.Intro;
            _timer = _t.introTime;
        }

        void ClearFighters()
        {
            for (int i = 0; i < _fighters.Count; i++)
            {
                if (_fighters[i] == null) continue;
                // Destroy отложен до конца кадра, а до тех пор старые тела ещё лежат
                // в физике и успели бы столкнуться с только что заспавненными.
                _fighters[i].gameObject.SetActive(false);
                Destroy(_fighters[i].gameObject);
            }
            _fighters.Clear();
            _dummies.Clear();
            Player = null;
            PlayerWon = false;
        }

        Fighter Spawn(Vector3 offset, float yaw, Color color, string name, bool isPlayer)
        {
            Vector3 pos = _arena.Center + offset + Vector3.up * (_arena.TopY - _arena.Center.y);
            var fighter = FighterBuilder.Build(_container, pos, yaw, color, name, isPlayer, _t, _arena, _fx);
            fighter.Eliminated += OnFighterEliminated;
            _fighters.Add(fighter);
            return fighter;
        }

        static float FaceCenterYaw(Vector3 offset)
        {
            return Mathf.Atan2(-offset.x, -offset.z) * Mathf.Rad2Deg;
        }

        // --- песочница ---

        /// <summary>
        /// Отладочный режим: игрок один в центре, вокруг манекены, раунд не кончается
        /// и выбыть нельзя. Нужен, чтобы разбираться с ощущениями от маха, не отвлекаясь
        /// на ботов, которые в это время пытаются тебя убить.
        /// </summary>
        void StartSandbox()
        {
            Player = Spawn(Vector3.zero, 0f, PlayerColor, "Ты", true);
            Player.ControlEnabled = true;
            var pc = Player.gameObject.AddComponent<PlayerController>();
            pc.Init(_t, _camera, _aim);
            _camera.SetTarget(Player.Hips.transform);
            _aim.SetOwner(Player.Hips.transform);

            int count = Mathf.Clamp(_t.dummyCount, 0, 6);
            float radius = _arena.Radius * 0.5f;
            for (int i = 0; i < count; i++)
            {
                float angle = i / (float)Mathf.Max(1, count) * Mathf.PI * 2f;
                var dummy = new Dummy
                {
                    Offset = new Vector3(Mathf.Cos(angle), 0f, Mathf.Sin(angle)) * radius,
                    Color = BotColors[i % BotColors.Length],
                    Name = "Манекен " + (i + 1)
                };
                _dummies.Add(dummy);
                SpawnDummy(dummy);
            }

            State = MatchState.Fighting;
            _timer = 0f;
        }

        void SpawnDummy(Dummy dummy)
        {
            // Манекен — это обычный боец, которому просто не выдали контроллер.
            // Балансирует, получает удары, встаёт и улетает с арены как настоящий,
            // но сам не ходит и не бьёт. Отдельный класс для этого не нужен.
            dummy.Fighter = Spawn(dummy.Offset, FaceCenterYaw(dummy.Offset), dummy.Color, dummy.Name, false);
            dummy.Fighter.ControlEnabled = false;
            dummy.RespawnAt = 0f;
        }

        void UpdateSandbox()
        {
            if (Inp.SlowMotionPressed()) _slowMotion = !_slowMotion;
            if (Inp.RespawnPressed()) RespawnPlayer();

            _fighters.RemoveAll(f => f == null || !f.IsAlive);

            // Не ждём падения до killY: это несколько секунд полёта в пустоту,
            // а в лаборатории каждая такая пауза — потерянная попытка.
            bool fellOff = Player != null && Player.IsAlive
                           && Player.Position.y < _arena.TopY - 3f;

            if (Player == null || !Player.IsAlive || fellOff) RespawnPlayer();

            for (int i = 0; i < _dummies.Count; i++)
            {
                var dummy = _dummies[i];
                if (dummy.Fighter != null && dummy.Fighter.IsAlive)
                {
                    // Манекен всегда лицом к игроку: бить в затылок неинформативно,
                    // отлетает совсем не так, как при ударе в грудь.
                    if (Player != null && Player.IsAlive)
                    {
                        Vector3 toPlayer = Player.GroundPosition - dummy.Fighter.GroundPosition;
                        if (toPlayer.sqrMagnitude > 0.0001f) dummy.Fighter.FacingTarget = toPlayer.normalized;
                    }
                    continue;
                }

                if (dummy.RespawnAt <= 0f) dummy.RespawnAt = Time.unscaledTime + _t.dummyRespawnDelay;
                else if (Time.unscaledTime >= dummy.RespawnAt) SpawnDummy(dummy);
            }
        }

        void RespawnPlayer()
        {
            if (Player != null)
            {
                Player.gameObject.SetActive(false);
                Destroy(Player.gameObject);
                _fighters.Remove(Player);
            }

            Player = Spawn(Vector3.zero, 0f, PlayerColor, "Ты", true);
            Player.ControlEnabled = true;
            var pc = Player.gameObject.AddComponent<PlayerController>();
            pc.Init(_t, _camera, _aim);
            _camera.SetTarget(Player.Hips.transform);
            _aim.SetOwner(Player.Hips.transform);
        }

        void OnFighterEliminated(Fighter fighter)
        {
            // В песочнице камеру перевешивать не надо: игрок возродится в центре
            // в этом же кадре, и переключение на манекен только моргнёт картинкой.
            if (Sandbox) return;
            if (fighter != Player) return;

            // Прицел принадлежит игроку. Пока он летит вниз, тянуть к нему линию незачем.
            _aim.SetOwner(null);
            FollowSomeoneElse();
        }

        void FollowSomeoneElse()
        {
            for (int i = 0; i < _fighters.Count; i++)
            {
                var f = _fighters[i];
                if (f != null && f.IsAlive)
                {
                    _camera.SetTarget(f.Hips.transform);
                    return;
                }
            }
            _camera.SetTarget(null);
        }

        void SetControlEnabled(bool enabled)
        {
            for (int i = 0; i < _fighters.Count; i++)
            {
                if (_fighters[i] != null) _fighters[i].ControlEnabled = enabled;
            }
        }

        void Update()
        {
            if (_t == null) return;

            UpdateHitStop();

            if (Inp.RestartPressed())
            {
                StartRound();
                return;
            }

            float dt = Time.unscaledDeltaTime;

            switch (State)
            {
                case MatchState.Intro:
                    _timer -= dt;
                    if (_timer <= 0f)
                    {
                        SetControlEnabled(true);
                        State = MatchState.Fighting;
                    }
                    break;

                case MatchState.Fighting:
                    // В песочнице раунд не заканчивается никогда — это её смысл.
                    if (_t.sandboxMode) UpdateSandbox();
                    else if (AliveCount <= 1) EndRound();
                    break;

                case MatchState.RoundOver:
                    _timer -= dt;
                    if (_timer <= 0f) StartRound();
                    break;
            }

            if (Player != null && Player.IsAlive && _camera != null)
            {
                _camera.SetLookAhead(Player.AimDirection * Player.HandOffset.magnitude);
                _camera.SetFollowFacing(Player.FacingTarget);
            }
        }

        void EndRound()
        {
            State = MatchState.RoundOver;
            _timer = _t.restartDelay;
            PlayerWon = Player != null && Player.IsAlive;
            SetControlEnabled(false);

            if (_sfx != null)
            {
                if (PlayerWon) _sfx.PlayWin();
                else _sfx.PlayLose();
            }
        }

        /// <summary>
        /// Замедление на несколько кадров в момент сильного попадания. Без него
        /// самые тяжёлые удары проскакивают незамеченными: соперник просто исчезает из кадра.
        /// </summary>
        void TriggerHitStop(float strength)
        {
            if (strength < 0.45f || _t.hitStopMax <= 0f) return;
            float duration = _t.hitStopMax * Mathf.InverseLerp(0.45f, 1f, strength);
            _hitStopUntil = Mathf.Max(_hitStopUntil, Time.unscaledTime + duration);
        }

        void UpdateHitStop()
        {
            float baseScale = _slowMotion ? _t.sandboxSlowMotion : 1f;
            // Хит-стоп не должен «ускорять» уже замедленное время.
            Time.timeScale = Time.unscaledTime < _hitStopUntil
                ? Mathf.Min(0.2f, baseScale)
                : baseScale;
        }

        void OnDisable()
        {
            Time.timeScale = 1f;
        }
    }
}
