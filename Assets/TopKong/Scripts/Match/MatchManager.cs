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
        Sfx _sfx;
        GameFx _fx;
        Transform _container;

        readonly List<Fighter> _fighters = new List<Fighter>();
        float _timer;
        float _hitStopUntil;

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

        public void Init(GameTuning tuning, Arena arena, ArenaCamera cam, Sfx sfx, GameFx fx)
        {
            _t = tuning;
            _arena = arena;
            _camera = cam;
            _sfx = sfx;
            _fx = fx;
            _fx.HitStop = TriggerHitStop;

            _container = new GameObject("Fighters").transform;
            _container.SetParent(transform, false);
        }

        public void StartRound()
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
            Player = null;
            PlayerWon = false;

            Round++;

            int total = Mathf.Max(2, _t.botCount + 1);
            float spawnRadius = _arena.Radius * _t.spawnRadiusFactor;

            for (int i = 0; i < total; i++)
            {
                float angle = i / (float)total * Mathf.PI * 2f;
                Vector3 offset = new Vector3(Mathf.Cos(angle), 0f, Mathf.Sin(angle)) * spawnRadius;
                Vector3 pos = _arena.Center + offset + Vector3.up * (_arena.TopY - _arena.Center.y);
                // Все смотрят в центр — иначе первые секунды раунда уходят на разворот.
                float yaw = Mathf.Atan2(-offset.x, -offset.z) * Mathf.Rad2Deg;

                bool isPlayer = i == 0;
                Color color = isPlayer ? PlayerColor : BotColors[(i - 1) % BotColors.Length];
                string name = isPlayer ? "Ты" : "Бот " + i;

                var fighter = FighterBuilder.Build(_container, pos, yaw, color, name, isPlayer, _t, _arena, _fx);
                fighter.Eliminated += OnFighterEliminated;
                _fighters.Add(fighter);

                if (isPlayer)
                {
                    Player = fighter;
                    var pc = fighter.gameObject.AddComponent<PlayerController>();
                    pc.Init(_t, _camera);
                }
                else
                {
                    var bot = fighter.gameObject.AddComponent<BotBrain>();
                    bot.Init(_t, _arena, this);
                }
            }

            if (Player != null) _camera.SetTarget(Player.Hips.transform);

            SetControlEnabled(false);
            State = MatchState.Intro;
            _timer = _t.introTime;
        }

        void OnFighterEliminated(Fighter fighter)
        {
            if (fighter == Player) FollowSomeoneElse();
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
                    if (AliveCount <= 1) EndRound();
                    break;

                case MatchState.RoundOver:
                    _timer -= dt;
                    if (_timer <= 0f) StartRound();
                    break;
            }

            if (Player != null && Player.IsAlive && _camera != null)
            {
                _camera.SetLookAhead(Player.AimDirection * Player.HandOffset.magnitude);
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
            Time.timeScale = Time.unscaledTime < _hitStopUntil ? 0.2f : 1f;
        }

        void OnDisable()
        {
            Time.timeScale = 1f;
        }
    }
}
