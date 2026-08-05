using UnityEngine;
using UnityEngine.SceneManagement;

namespace TopKong
{
    /// <summary>
    /// Точка входа. Собирает всю игру кодом и запускается сама.
    ///
    /// Никакой подготовленной сцены не требуется: хук RuntimeInitializeOnLoadMethod
    /// поднимает игру после загрузки любой сцены, включая пустую SampleScene из
    /// свежего проекта. То есть достаточно открыть проект и нажать Play — ни префабов,
    /// ни расстановки объектов, ни настроек в инспекторе.
    ///
    /// Если объект TopKong положен в сцену вручную, его Awake успевает раньше хука
    /// (Awake сцены выполняется до AfterSceneLoad) и второй экземпляр не создаётся.
    /// </summary>
    public class GameBootstrap : MonoBehaviour
    {
        [Tooltip("Все настройки игры. Их можно менять прямо во время Play — эффект сразу.")]
        public GameTuning tuning = new GameTuning();

        static GameBootstrap _instance;

        Arena _arena;
        ArenaCamera _camera;
        AimCursor _aim;
        MatchManager _match;
        Sfx _sfx;
        Hud _hud;
        GameFx _fx;

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        static void ResetStatics()
        {
            // Нужно для режима Play без перезагрузки домена: иначе статик переживёт
            // остановку игры и следующий запуск решит, что игра уже поднята.
            _instance = null;
        }

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void AutoStart()
        {
            if (_instance != null) return;
            var go = new GameObject("TopKong");
            go.AddComponent<GameBootstrap>();
        }

        void Awake()
        {
            if (_instance != null && _instance != this)
            {
                Destroy(gameObject);
                return;
            }
            _instance = this;

            ApplyPhysicsSettings();
            SilenceExistingScene();
            BuildWorld();
        }

        void ApplyPhysicsSettings()
        {
            Physics.gravity = new Vector3(0f, tuning.gravity, 0f);
            Physics.defaultSolverIterations = tuning.solverIterations;
            Physics.defaultSolverVelocityIterations = 4;
            Time.fixedDeltaTime = tuning.fixedTimestep;
        }

        /// <summary>
        /// Гасит камеры, свет и аудиослушателей, уже стоящие в сцене. Игра приносит
        /// своё освещение и свою камеру, а Main Camera из SampleScene иначе перекрывала бы
        /// картинку и давала второй AudioListener.
        /// </summary>
        void SilenceExistingScene()
        {
            var scene = SceneManager.GetActiveScene();
            if (!scene.IsValid()) return;

            foreach (var root in scene.GetRootGameObjects())
            {
                if (root == gameObject) continue;

                foreach (var cam in root.GetComponentsInChildren<Camera>(true)) cam.enabled = false;
                foreach (var light in root.GetComponentsInChildren<Light>(true)) light.enabled = false;
                foreach (var listener in root.GetComponentsInChildren<AudioListener>(true)) listener.enabled = false;
            }
        }

        void BuildWorld()
        {
            _arena = ArenaBuilder.Build(transform, tuning);

            var camGo = new GameObject("ArenaCamera");
            camGo.transform.SetParent(transform, false);
            var cam = camGo.AddComponent<Camera>();
            camGo.AddComponent<AudioListener>();
            _camera = camGo.AddComponent<ArenaCamera>();
            _camera.Init(cam, tuning, _arena.Center);

            var aimGo = new GameObject("AimCursor");
            aimGo.transform.SetParent(transform, false);
            _aim = aimGo.AddComponent<AimCursor>();
            _aim.Init(cam, _arena, tuning);

            _sfx = gameObject.AddComponent<Sfx>();
            _sfx.Init(tuning);

            _fx = new GameFx { Camera = _camera, Sound = _sfx };

            _match = gameObject.AddComponent<MatchManager>();
            _match.Init(tuning, _arena, _camera, _aim, _sfx, _fx);

            _hud = gameObject.AddComponent<Hud>();
            _hud.Init(_match, tuning);

            _match.StartRound();
            SetCursorCaptured(true);
        }

        void Update()
        {
            if (Inp.EscapePressed())
            {
                SetCursorCaptured(false);
            }
            else if (Cursor.lockState == CursorLockMode.None && Inp.ClickPressed())
            {
                SetCursorCaptured(true);
            }
        }

        /// <summary>
        /// Confined, а не Locked. Захват отдаёт только дельты — экранной позиции при нём
        /// нет вообще, а прицел строится именно из неё. Confined позицию даёт и при этом
        /// не выпускает курсор за пределы окна. Системный курсор прячем: вместо него
        /// на арене рисуется собственное кольцо прицела.
        /// </summary>
        static void SetCursorCaptured(bool captured)
        {
            Cursor.lockState = captured ? CursorLockMode.Confined : CursorLockMode.None;
            Cursor.visible = !captured;
        }

        void OnDestroy()
        {
            if (_instance == this) _instance = null;
            Time.timeScale = 1f;
            SetCursorCaptured(false);
        }

        /// <summary>
        /// Разметка для Scene-вида. Мир строится кодом в момент Play, поэтому до запуска
        /// сцена пустая и непонятно, где вообще будет арена. Гизмо показывают её край,
        /// круг спавна и позиции бойцов — по тем же числам из tuning, по которым потом
        /// всё и построится.
        /// </summary>
        void OnDrawGizmos()
        {
            if (Application.isPlaying || tuning == null) return;

            Vector3 center = transform.position;
            float top = tuning.arenaThickness * 0.5f;

            Gizmos.color = new Color(1f, 0.72f, 0.25f);
            DrawCircle(center + Vector3.up * top, tuning.arenaRadius, 64);

            Gizmos.color = new Color(1f, 1f, 1f, 0.25f);
            float spawnRadius = tuning.arenaRadius * tuning.spawnRadiusFactor;
            DrawCircle(center + Vector3.up * top, spawnRadius, 48);

            int total = Mathf.Max(2, tuning.botCount + 1);
            for (int i = 0; i < total; i++)
            {
                float angle = i / (float)total * Mathf.PI * 2f;
                Vector3 pos = center
                    + new Vector3(Mathf.Cos(angle), 0f, Mathf.Sin(angle)) * spawnRadius
                    + Vector3.up * top;

                Gizmos.color = i == 0 ? new Color(1f, 0.62f, 0.16f) : new Color(0.35f, 0.72f, 1f);
                Gizmos.DrawWireSphere(pos + Vector3.up * 1f, 0.35f);
                Gizmos.DrawLine(pos, pos + Vector3.up * 2.1f);
            }

            // Отметка, ниже которой боец считается выбывшим.
            Gizmos.color = new Color(1f, 0.3f, 0.3f, 0.35f);
            DrawCircle(center + Vector3.up * tuning.killY, tuning.arenaRadius * 0.5f, 24);
        }

        static void DrawCircle(Vector3 center, float radius, int segments)
        {
            Vector3 prev = center + new Vector3(radius, 0f, 0f);
            for (int i = 1; i <= segments; i++)
            {
                float a = i / (float)segments * Mathf.PI * 2f;
                Vector3 next = center + new Vector3(Mathf.Cos(a) * radius, 0f, Mathf.Sin(a) * radius);
                Gizmos.DrawLine(prev, next);
                prev = next;
            }
        }
    }
}
