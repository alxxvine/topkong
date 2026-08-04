using System;
using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace TopKong.EditorTools
{
    /// <summary>
    /// Создаёт сцену арены при первом открытии проекта, если её ещё нет.
    ///
    /// Сама игра сцены не требует — она поднимается из любой, — но проект без единой
    /// сцены выглядит пустым и непонятным. Сцену специально не открываем: подменять
    /// то, над чем человек сейчас работает, редактор не должен. Создаём аддитивно
    /// и сразу закрываем, чтобы текущая сцена не пострадала.
    ///
    /// Момент запуска здесь — главная сложность. Первый заход приходится ровно на
    /// импорт после git pull, когда редактор занят и создание сцены падает.
    /// Поэтому вместо одной попытки — ожидание, пока редактор освободится.
    /// </summary>
    [InitializeOnLoad]
    public static class SceneSetup
    {
        const string ParentDir = "Assets/TopKong";
        const string SceneFolderName = "Scenes";
        const string SceneDir = ParentDir + "/" + SceneFolderName;
        const string ScenePath = SceneDir + "/Arena.unity";
        const string DoneKey = "TopKong.SceneSetup.Done";

        const int MaxAttempts = 60;
        static int _attempts;

        static SceneSetup()
        {
            // delayCall: на момент статического конструктора AssetDatabase ещё не готов.
            EditorApplication.delayCall += EnsureScene;
        }

        static void EnsureScene()
        {
            if (File.Exists(ScenePath)) return;
            // SessionState живёт до закрытия редактора — не начинаем всё заново
            // после каждой перекомпиляции скриптов.
            if (SessionState.GetBool(DoneKey, false)) return;

            if (EditorApplication.isPlayingOrWillChangePlaymode)
            {
                SessionState.SetBool(DoneKey, true);
                return;
            }

            // Редактор занят импортом или компиляцией — в этом состоянии и NewScene,
            // и SaveScene падают. Сразу после git pull это штатная ситуация, так что
            // не сдаёмся, а ждём следующего кадра.
            if (EditorApplication.isUpdating || EditorApplication.isCompiling)
            {
                Retry();
                return;
            }

            SessionState.SetBool(DoneKey, true);

            try
            {
                CreateFolderIfMissing();

                var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Additive);
                var go = new GameObject("TopKong");
                go.AddComponent<GameBootstrap>();
                EditorSceneManager.MoveGameObjectToScene(go, scene);

                EditorSceneManager.SaveScene(scene, ScenePath);
                EditorSceneManager.CloseScene(scene, true);
                AssetDatabase.Refresh();

                Debug.Log("[TopKong] Создана сцена " + ScenePath
                    + ". Открой её двойным кликом — в Scene-виде будет видно круг арены "
                    + "и точки спавна. Играть можно и без неё, из любой сцены.");
            }
            catch (Exception e)
            {
                Debug.LogWarning("[TopKong] Не удалось создать сцену арены ("
                    + e.GetType().Name + ": " + e.Message
                    + "). Это ни на что не влияет — игра запускается из любой сцены. "
                    + "Создать вручную: Tools → Top Kong → Создать сцену арены.");
            }
        }

        static void Retry()
        {
            if (_attempts++ >= MaxAttempts)
            {
                SessionState.SetBool(DoneKey, true);
                Debug.Log("[TopKong] Сцену арены пока не создать — редактор занят импортом. "
                    + "Когда освободится: Tools → Top Kong → Создать сцену арены. "
                    + "Играть можно и без неё.");
                return;
            }
            EditorApplication.delayCall += EnsureScene;
        }

        /// <summary>
        /// Папку обязательно заводить через AssetDatabase.
        ///
        /// Directory.CreateDirectory создаёт её на диске, но база ассетов о ней не узнает
        /// до следующего Refresh — и SaveScene по пути внутри такой папки падает.
        /// Ровно на этом сцена и не создавалась при первом заходе.
        /// </summary>
        static void CreateFolderIfMissing()
        {
            if (AssetDatabase.IsValidFolder(SceneDir)) return;

            if (!AssetDatabase.IsValidFolder(ParentDir))
            {
                Directory.CreateDirectory(ParentDir);
                AssetDatabase.Refresh();
            }

            AssetDatabase.CreateFolder(ParentDir, SceneFolderName);
        }
    }
}
