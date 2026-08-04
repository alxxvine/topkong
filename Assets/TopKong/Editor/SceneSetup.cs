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
    /// </summary>
    [InitializeOnLoad]
    public static class SceneSetup
    {
        const string SceneDir = "Assets/TopKong/Scenes";
        const string ScenePath = SceneDir + "/Arena.unity";
        const string TriedKey = "TopKong.SceneSetup.Tried";

        static SceneSetup()
        {
            // delayCall: на момент статического конструктора AssetDatabase ещё не готов.
            EditorApplication.delayCall += EnsureScene;
        }

        static void EnsureScene()
        {
            if (File.Exists(ScenePath)) return;
            // SessionState живёт до закрытия редактора — не повторяем попытку
            // после каждой перекомпиляции скриптов.
            if (SessionState.GetBool(TriedKey, false)) return;
            SessionState.SetBool(TriedKey, true);

            if (EditorApplication.isPlayingOrWillChangePlaymode) return;

            try
            {
                Directory.CreateDirectory(SceneDir);

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
                Debug.LogWarning("[TopKong] Не удалось создать сцену арены: " + e.Message
                    + ". Это ни на что не влияет — игра запускается из любой сцены. "
                    + "Можно создать вручную: Tools → Top Kong → Создать сцену арены.");
            }
        }
    }
}
