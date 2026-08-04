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

            _sfx = gameObject.AddComponent<Sfx>();
            _sfx.Init(tuning);

            _fx = new GameFx { Camera = _camera, Sound = _sfx };

            _match = gameObject.AddComponent<MatchManager>();
            _match.Init(tuning, _arena, _camera, _sfx, _fx);

            _hud = gameObject.AddComponent<Hud>();
            _hud.Init(_match, tuning);

            _match.StartRound();
            SetCursorLocked(true);
        }

        void Update()
        {
            if (Inp.EscapePressed())
            {
                SetCursorLocked(false);
            }
            else if (Cursor.lockState != CursorLockMode.Locked && Inp.ClickPressed())
            {
                SetCursorLocked(true);
            }
        }

        static void SetCursorLocked(bool locked)
        {
            Cursor.lockState = locked ? CursorLockMode.Locked : CursorLockMode.None;
            Cursor.visible = !locked;
        }

        void OnDestroy()
        {
            if (_instance == this) _instance = null;
            Time.timeScale = 1f;
            SetCursorLocked(false);
        }
    }
}
