using System;
using System.IO;
using System.Reflection;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;

namespace TopKong.EditorTools
{
    /// <summary>
    /// Включает URP в один клик.
    ///
    /// Игра одинаково работает и на Built-in, и на URP — MaterialFactory подбирает
    /// шейдер в рантайме. Проект приходит на Built-in, потому что это то, что Unity
    /// настраивает сама, и на этом он гарантированно открывается и запускается.
    /// Кто хочет URP — ставит пакет и жмёт этот пункт меню.
    ///
    /// Всё обращение к URP идёт через рефлексию, и это принципиально: прямая ссылка
    /// на типы URP в проекте, где пакета нет, роняет компиляцию всей редакторной
    /// сборки — то есть ломает вообще все скрипты, включая саму игру. Рефлексия
    /// компилируется всегда, а отсутствие пакета превращается в строчку в консоли.
    /// </summary>
    public static class UrpSetup
    {
        const string SettingsDir = "Assets/TopKong/Settings";
        const string RendererPath = SettingsDir + "/TopKong_URP_Renderer.asset";
        const string PipelinePath = SettingsDir + "/TopKong_URP.asset";

        const string UrpAssetTypeName = "UnityEngine.Rendering.Universal.UniversalRenderPipelineAsset";
        const string UrpRendererTypeName = "UnityEngine.Rendering.Universal.UniversalRendererData";

        [MenuItem("Tools/Top Kong/Включить URP", false, 30)]
        public static void Setup()
        {
            if (GraphicsSettings.currentRenderPipeline != null)
            {
                Debug.Log("[TopKong] URP (или другой SRP) уже активен: "
                          + GraphicsSettings.currentRenderPipeline.name + ". Делать нечего.");
                return;
            }

            var assetType = FindType(UrpAssetTypeName);
            if (assetType == null)
            {
                Debug.LogWarning("[TopKong] Пакет URP не установлен. "
                                 + "Window → Package Manager → Unity Registry → Universal RP → Install, "
                                 + "потом снова Tools → Top Kong → Включить URP. "
                                 + "Игра при этом прекрасно работает и на Built-in.");
                return;
            }

            var pipeline = FindExistingPipelineAsset() ?? CreatePipelineAsset(assetType);
            if (pipeline == null)
            {
                Debug.LogWarning("[TopKong] Не удалось создать URP-ассет автоматически. "
                                 + "Сделай его вручную: Assets → Create → Rendering → "
                                 + "URP Asset (with Universal Renderer), затем снова нажми этот пункт меню — "
                                 + "он подхватит готовый ассет.");
                return;
            }

            if (!Assign(pipeline))
            {
                Debug.LogWarning("[TopKong] URP-ассет создан (" + AssetDatabase.GetAssetPath(pipeline)
                                 + "), но назначить его не вышло. Пропиши его вручную: "
                                 + "Project Settings → Graphics → Default Render Pipeline.");
                return;
            }

            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();
            Debug.Log("[TopKong] URP включён: " + AssetDatabase.GetAssetPath(pipeline));
        }

        static RenderPipelineAsset FindExistingPipelineAsset()
        {
            var guids = AssetDatabase.FindAssets("t:RenderPipelineAsset");
            foreach (var guid in guids)
            {
                var path = AssetDatabase.GUIDToAssetPath(guid);
                var asset = AssetDatabase.LoadAssetAtPath<RenderPipelineAsset>(path);
                if (asset != null && asset.GetType().FullName == UrpAssetTypeName) return asset;
            }
            return null;
        }

        static RenderPipelineAsset CreatePipelineAsset(Type assetType)
        {
            try
            {
                var rendererType = FindType(UrpRendererTypeName);
                if (rendererType == null) return null;

                Directory.CreateDirectory(SettingsDir);

                var rendererData = ScriptableObject.CreateInstance(rendererType);
                if (rendererData == null) return null;
                rendererData.name = "TopKong_URP_Renderer";
                AssetDatabase.CreateAsset(rendererData, RendererPath);

                // UniversalRenderPipelineAsset.Create(ScriptableRendererData) — публичный
                // статический фабричный метод URP. Ищем по числу параметров, потому что
                // между версиями у него менялись значения по умолчанию.
                MethodInfo create = null;
                foreach (var m in assetType.GetMethods(BindingFlags.Public | BindingFlags.Static))
                {
                    if (m.Name == "Create" && m.GetParameters().Length == 1)
                    {
                        create = m;
                        break;
                    }
                }
                if (create == null) return null;

                var pipeline = create.Invoke(null, new object[] { rendererData }) as RenderPipelineAsset;
                if (pipeline == null) return null;

                pipeline.name = "TopKong_URP";
                AssetDatabase.CreateAsset(pipeline, PipelinePath);
                AssetDatabase.SaveAssets();
                return pipeline;
            }
            catch (Exception e)
            {
                Debug.LogWarning("[TopKong] Автосоздание URP-ассета не удалось: " + e.Message);
                return null;
            }
        }

        /// <summary>
        /// Свойство GraphicsSettings несколько раз переименовывали
        /// (renderPipelineAsset → defaultRenderPipeline), поэтому пробуем оба имени.
        /// </summary>
        static bool Assign(RenderPipelineAsset pipeline)
        {
            bool assigned = TrySetStatic(typeof(GraphicsSettings), "defaultRenderPipeline", pipeline)
                         || TrySetStatic(typeof(GraphicsSettings), "renderPipelineAsset", pipeline);

            // Уровень качества может переопределять пайплайн — если поле есть, чистим его,
            // иначе назначение в Graphics ничего не изменит.
            TrySetStatic(typeof(QualitySettings), "renderPipeline", pipeline);

            return assigned;
        }

        static bool TrySetStatic(Type type, string propertyName, object value)
        {
            try
            {
                var prop = type.GetProperty(propertyName, BindingFlags.Public | BindingFlags.Static);
                if (prop == null || !prop.CanWrite) return false;
                prop.SetValue(null, value, null);
                return true;
            }
            catch (Exception)
            {
                return false;
            }
        }

        static Type FindType(string fullName)
        {
            foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                try
                {
                    var type = assembly.GetType(fullName, false);
                    if (type != null) return type;
                }
                catch (Exception)
                {
                    // Некоторые сборки не отдают типы — просто пропускаем.
                }
            }
            return null;
        }
    }
}
