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
        const string SceneDir = "Assets/TopKong/Scenes";
        const string ScenePath = SceneDir + "/Arena.unity";

        [MenuItem("Tools/Top Kong/Создать сцену арены", false, 10)]
        public static void CreateArenaScene()
        {
            if (!EditorSceneManager.SaveCurrentModifiedScenesIfUserWantsTo()) return;

            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

            var go = new GameObject("TopKong");
            go.AddComponent<GameBootstrap>();
            Selection.activeGameObject = go;

            // Через AssetDatabase, а не Directory.CreateDirectory: созданная в обход базы
            // папка остаётся ей неизвестной до следующего Refresh, и SaveScene по пути
            // внутри такой папки падает.
            if (!AssetDatabase.IsValidFolder(SceneDir))
            {
                AssetDatabase.CreateFolder("Assets/TopKong", "Scenes");
            }
            EditorSceneManager.SaveScene(scene, ScenePath);
            AssetDatabase.Refresh();

            Debug.Log("[TopKong] Сцена создана: " + ScenePath + ". Нажми Play.");
        }

        [MenuItem("Tools/Top Kong/Добавить TopKong в текущую сцену", false, 11)]
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
