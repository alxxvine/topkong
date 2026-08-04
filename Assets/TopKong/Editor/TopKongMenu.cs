using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace TopKong.EditorTools
{
    /// <summary>
    /// Необязательное удобство. Игра поднимается сама из любой сцены, но иметь
    /// собственную сцену с объектом TopKong удобно: настройки в инспекторе видно
    /// до нажатия Play, а не только во время.
    /// </summary>
    public static class TopKongMenu
    {
        const string ParentDir = "Assets/TopKong";
        const string SceneDir = ParentDir + "/Scenes";
        const string ArenaScenePath = SceneDir + "/Arena.unity";
        const string SandboxScenePath = SceneDir + "/Sandbox.unity";

        [MenuItem("Tools/Top Kong/Создать сцену арены", false, 10)]
        public static void CreateArenaScene()
        {
            CreateScene(ArenaScenePath, false,
                "[TopKong] Сцена создана: " + ArenaScenePath + ". Нажми Play.");
        }

        [MenuItem("Tools/Top Kong/Создать сцену песочницы", false, 11)]
        public static void CreateSandboxScene()
        {
            CreateScene(SandboxScenePath, true,
                "[TopKong] Песочница создана: " + SandboxScenePath
                + ". Нажми Play: ты один на арене с манекенами, выбыть нельзя. "
                + "F2 — замедление времени, F3 — вернуться в центр.");
        }

        static void CreateScene(string path, bool sandbox, string message)
        {
            if (!EditorSceneManager.SaveCurrentModifiedScenesIfUserWantsTo()) return;

            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

            var go = new GameObject("TopKong");
            var bootstrap = go.AddComponent<GameBootstrap>();
            bootstrap.tuning.sandboxMode = sandbox;
            Selection.activeGameObject = go;

            // Через AssetDatabase, а не Directory.CreateDirectory: созданная в обход базы
            // папка остаётся ей неизвестной до следующего Refresh, и SaveScene по пути
            // внутри такой папки падает.
            if (!AssetDatabase.IsValidFolder(SceneDir))
            {
                AssetDatabase.CreateFolder(ParentDir, "Scenes");
            }
            EditorSceneManager.SaveScene(scene, path);
            AssetDatabase.Refresh();

            Debug.Log(message);
        }

        [MenuItem("Tools/Top Kong/Добавить TopKong в текущую сцену", false, 12)]
        public static void AddToCurrentScene()
        {
            // Обход корней сцены вместо FindObjectOfType: тот помечен устаревшим
            // в Unity 6, а замена FindFirstObjectByType есть не во всех LTS,
            // которые эти скрипты должны переживать.
            var scene = EditorSceneManager.GetActiveScene();
            foreach (var root in scene.GetRootGameObjects())
            {
                var found = root.GetComponentInChildren<GameBootstrap>(true);
                if (found != null)
                {
                    Selection.activeGameObject = found.gameObject;
                    Debug.Log("[TopKong] Объект TopKong уже есть в сцене.");
                    return;
                }
            }

            var go = new GameObject("TopKong");
            go.AddComponent<GameBootstrap>();
            Undo.RegisterCreatedObjectUndo(go, "Add TopKong");
            Selection.activeGameObject = go;
            EditorSceneManager.MarkSceneDirty(go.scene);
        }
    }
}
