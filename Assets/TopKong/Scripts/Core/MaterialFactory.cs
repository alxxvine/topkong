using UnityEngine;

namespace TopKong
{
    /// <summary>
    /// Материалы, не зависящие от render pipeline.
    ///
    /// В Built-in основной шейдер называется "Standard" и цвет лежит в _Color,
    /// в URP это "Universal Render Pipeline/Lit" с _BaseColor. Если поставить не тот —
    /// всё станет розовым. Поэтому шейдер выбирается перебором, а цвет пишется
    /// в оба свойства через HasProperty.
    /// </summary>
    public static class MaterialFactory
    {
        static Shader _lit;
        static Shader _unlit;

        public static Shader LitShader
        {
            get
            {
                if (_lit == null)
                {
                    _lit = Pick(
                        "Universal Render Pipeline/Lit",
                        "HDRP/Lit",
                        "Standard",
                        "Legacy Shaders/Diffuse");
                }
                return _lit;
            }
        }

        public static Shader UnlitShader
        {
            get
            {
                if (_unlit == null)
                {
                    _unlit = Pick(
                        "Universal Render Pipeline/Unlit",
                        "Unlit/Color",
                        "Sprites/Default");
                }
                return _unlit;
            }
        }

        static Shader Pick(params string[] names)
        {
            foreach (var n in names)
            {
                var s = Shader.Find(n);
                if (s != null) return s;
            }
            Debug.LogWarning("[TopKong] Не найден ни один подходящий шейдер, объекты могут быть розовыми.");
            return null;
        }

        public static Material Lit(Color color, float smoothness = 0.2f, float metallic = 0f)
        {
            var m = new Material(LitShader);
            m.name = "TopKong_Lit";
            SetColor(m, color);
            if (m.HasProperty("_Smoothness")) m.SetFloat("_Smoothness", smoothness);
            if (m.HasProperty("_Glossiness")) m.SetFloat("_Glossiness", smoothness);
            if (m.HasProperty("_Metallic")) m.SetFloat("_Metallic", metallic);
            return m;
        }

        public static Material Unlit(Color color)
        {
            var m = new Material(UnlitShader);
            m.name = "TopKong_Unlit";
            SetColor(m, color);
            return m;
        }

        public static void SetColor(Material m, Color color)
        {
            if (m == null) return;
            if (m.HasProperty("_BaseColor")) m.SetColor("_BaseColor", color);
            if (m.HasProperty("_Color")) m.SetColor("_Color", color);
        }

        public static void SetEmission(Material m, Color color)
        {
            if (m == null) return;
            if (m.HasProperty("_EmissionColor"))
            {
                m.EnableKeyword("_EMISSION");
                m.SetColor("_EmissionColor", color);
            }
        }
    }
}
