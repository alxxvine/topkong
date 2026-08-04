using UnityEngine;

namespace TopKong
{
    /// <summary>Ссылки на построенную арену, которые нужны остальной игре.</summary>
    public class Arena
    {
        public Transform Root;
        public Collider Ground;
        public float Radius;
        /// <summary>Мировая высота верхней поверхности — от неё считаются спавн и стойка.</summary>
        public float TopY;
        public Vector3 Center;

        /// <summary>Позиция бойца в плоскости арены относительно центра.</summary>
        public Vector3 Flatten(Vector3 worldPos)
        {
            return new Vector3(worldPos.x - Center.x, 0f, worldPos.z - Center.z);
        }
    }

    /// <summary>
    /// Собирает всю сцену кодом: диск арены, кромку, свет, туман, фон.
    /// Ни одного префаба и ни одного ассета — поэтому игра запускается из любой сцены.
    /// </summary>
    public static class ArenaBuilder
    {
        public static readonly Color VoidColor = new Color(0.045f, 0.05f, 0.075f);

        public static Arena Build(Transform parent, GameTuning t)
        {
            var root = new GameObject("Arena").transform;
            root.SetParent(parent, false);

            float topY = t.arenaThickness * 0.5f;

            // --- сам диск ---
            var discGo = new GameObject("Platform");
            discGo.transform.SetParent(root, false);
            var mesh = MeshUtils.CreateDisc(t.arenaRadius, t.arenaThickness);
            discGo.AddComponent<MeshFilter>().sharedMesh = mesh;
            var mr = discGo.AddComponent<MeshRenderer>();
            mr.sharedMaterial = MaterialFactory.Lit(new Color(0.30f, 0.33f, 0.40f), 0.15f);
            mr.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.On;

            // Коллайдер строится из той же сетки: где картинка кончается, там кончается и опора.
            // Статический объект, поэтому выпуклость не требуется.
            var col = discGo.AddComponent<MeshCollider>();
            col.sharedMesh = mesh;
            var groundMat = RB.NewPhysicsMaterial("TopKong_Ground", 0.45f, 0.5f, 0f);
            col.sharedMaterial = groundMat;

            // --- кромка: единственный ориентир, где обрыв ---
            var rimGo = new GameObject("Rim");
            rimGo.transform.SetParent(root, false);
            var line = rimGo.AddComponent<LineRenderer>();
            line.useWorldSpace = false;
            line.loop = true;
            line.widthMultiplier = 0.14f;
            line.numCapVertices = 2;
            var rimPts = MeshUtils.CirclePoints(t.arenaRadius - 0.07f, topY + 0.012f);
            line.positionCount = rimPts.Length;
            line.SetPositions(rimPts);
            var rimMat = MaterialFactory.Unlit(new Color(1f, 0.72f, 0.25f));
            line.sharedMaterial = rimMat;
            line.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            line.receiveShadows = false;

            // --- внутренний круг: помогает читать центр и расстояние до края ---
            var innerGo = new GameObject("InnerRing");
            innerGo.transform.SetParent(root, false);
            var inner = innerGo.AddComponent<LineRenderer>();
            inner.useWorldSpace = false;
            inner.loop = true;
            inner.widthMultiplier = 0.06f;
            var innerPts = MeshUtils.CirclePoints(t.arenaRadius * 0.45f, topY + 0.012f);
            inner.positionCount = innerPts.Length;
            inner.SetPositions(innerPts);
            inner.sharedMaterial = MaterialFactory.Unlit(new Color(1f, 1f, 1f, 0.13f));
            inner.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            inner.receiveShadows = false;

            // --- опора, уходящая в пустоту: без неё арена выглядит парящей плашкой ---
            var pillarGo = new GameObject("Pillar");
            pillarGo.transform.SetParent(root, false);
            pillarGo.transform.localPosition = new Vector3(0f, -t.arenaThickness * 0.5f - 6f, 0f);
            var pillarMesh = MeshUtils.CreateDisc(t.arenaRadius * 0.78f, 12f, 36);
            pillarGo.AddComponent<MeshFilter>().sharedMesh = pillarMesh;
            var pillarMr = pillarGo.AddComponent<MeshRenderer>();
            pillarMr.sharedMaterial = MaterialFactory.Lit(new Color(0.13f, 0.14f, 0.19f), 0.05f);
            pillarMr.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;

            BuildLighting(root);

            return new Arena
            {
                Root = root,
                Ground = col,
                Radius = t.arenaRadius,
                TopY = root.position.y + topY,
                Center = root.position
            };
        }

        static void BuildLighting(Transform parent)
        {
            var sunGo = new GameObject("Sun");
            sunGo.transform.SetParent(parent, false);
            sunGo.transform.rotation = Quaternion.Euler(52f, 35f, 0f);
            var sun = sunGo.AddComponent<Light>();
            sun.type = LightType.Directional;
            sun.color = new Color(1f, 0.95f, 0.85f);
            sun.intensity = 1.35f;
            sun.shadows = LightShadows.Soft;
            sun.shadowStrength = 0.75f;

            // Заполняющий свет сзади-снизу: иначе тела на тёмном фоне сливаются в силуэты.
            var fillGo = new GameObject("Fill");
            fillGo.transform.SetParent(parent, false);
            fillGo.transform.rotation = Quaternion.Euler(-20f, -150f, 0f);
            var fill = fillGo.AddComponent<Light>();
            fill.type = LightType.Directional;
            fill.color = new Color(0.45f, 0.55f, 0.85f);
            fill.intensity = 0.4f;
            fill.shadows = LightShadows.None;

            RenderSettings.ambientMode = UnityEngine.Rendering.AmbientMode.Flat;
            RenderSettings.ambientLight = new Color(0.24f, 0.26f, 0.34f);
            RenderSettings.fog = true;
            RenderSettings.fogMode = FogMode.Exponential;
            RenderSettings.fogDensity = 0.018f;
            RenderSettings.fogColor = VoidColor;
        }
    }
}
