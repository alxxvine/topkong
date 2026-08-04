using UnityEngine;

namespace TopKong
{
    /// <summary>
    /// Интерфейс на IMGUI (OnGUI).
    ///
    /// Выбран сознательно: uGUI или UI Toolkit потребовали бы Canvas, префабы,
    /// шрифтовые ассеты и ссылки в сцене — а вся игра строится кодом и обязана
    /// запускаться из пустой сцены. OnGUI не требует вообще ничего.
    ///
    /// Единственная тонкость — шрифт: встроенный шрифт Unity кириллицу может не
    /// содержать, и вместо текста будут квадраты. Поэтому берётся системный шрифт,
    /// а если его нет — интерфейс молча переключается на английский.
    /// </summary>
    public class Hud : MonoBehaviour
    {
        MatchManager _match;
        GameTuning _t;

        GUIStyle _big;
        GUIStyle _mid;
        GUIStyle _small;
        Texture2D _white;
        Font _font;
        bool _ru;
        bool _ready;

        public void Init(MatchManager match, GameTuning tuning)
        {
            _match = match;
            _t = tuning;
        }

        void EnsureStyles()
        {
            if (_ready) return;
            _ready = true;

            _white = new Texture2D(1, 1);
            _white.SetPixel(0, 0, Color.white);
            _white.Apply();
            _white.hideFlags = HideFlags.HideAndDontSave;

            _font = Font.CreateDynamicFontFromOSFont(
                new[] { "Arial", "Helvetica", "Segoe UI", "Liberation Sans", "DejaVu Sans", "Noto Sans" },
                24);
            _ru = _font != null;

            _big = new GUIStyle(GUI.skin.label)
            {
                alignment = TextAnchor.MiddleCenter,
                fontSize = 54,
                fontStyle = FontStyle.Bold
            };
            _mid = new GUIStyle(GUI.skin.label)
            {
                alignment = TextAnchor.MiddleCenter,
                fontSize = 22
            };
            _small = new GUIStyle(GUI.skin.label)
            {
                alignment = TextAnchor.UpperLeft,
                fontSize = 16
            };

            if (_font != null)
            {
                _big.font = _font;
                _mid.font = _font;
                _small.font = _font;
            }

            _big.normal.textColor = Color.white;
            _mid.normal.textColor = new Color(0.88f, 0.9f, 0.95f);
            _small.normal.textColor = new Color(0.78f, 0.82f, 0.88f);
        }

        string L(string ru, string en) => _ru ? ru : en;

        void Box(Rect r, Color color)
        {
            var prev = GUI.color;
            GUI.color = color;
            GUI.DrawTexture(r, _white);
            GUI.color = prev;
        }

        void OnGUI()
        {
            if (_match == null || _t == null) return;
            EnsureStyles();

            float w = Screen.width;
            float h = Screen.height;

            DrawStatus(w, h);
            DrawSwingMeter(w, h);
            DrawControls(w, h);
            DrawBanner(w, h);
        }

        void DrawStatus(float w, float h)
        {
            var rect = new Rect(18f, 16f, 220f, 62f);
            Box(rect, new Color(0f, 0f, 0f, 0.45f));

            GUI.Label(new Rect(rect.x + 12f, rect.y + 8f, rect.width - 24f, 22f),
                L("Раунд ", "Round ") + _match.Round, _small);
            GUI.Label(new Rect(rect.x + 12f, rect.y + 32f, rect.width - 24f, 22f),
                L("На арене: ", "Left: ") + _match.AliveCount, _small);
        }

        /// <summary>Скорость дубины прямо сейчас — она же сила удара, если попасть.</summary>
        void DrawSwingMeter(float w, float h)
        {
            var player = _match.Player;
            if (player == null || !player.IsAlive) return;

            float fill = Mathf.Clamp01(player.SwingSpeed / Mathf.Max(0.01f, _t.maxImpactSpeed));
            float barW = Mathf.Min(360f, w * 0.32f);
            var back = new Rect((w - barW) * 0.5f, h - 62f, barW, 16f);

            Box(back, new Color(0f, 0f, 0f, 0.5f));
            // Порог, ниже которого касание вообще не считается ударом.
            float threshold = Mathf.Clamp01(_t.minImpactSpeed / Mathf.Max(0.01f, _t.maxImpactSpeed));
            Box(new Rect(back.x + back.width * threshold - 1f, back.y - 3f, 2f, back.height + 6f),
                new Color(1f, 1f, 1f, 0.35f));
            Box(new Rect(back.x + 2f, back.y + 2f, (back.width - 4f) * fill, back.height - 4f),
                Color.Lerp(new Color(0.4f, 0.7f, 1f), new Color(1f, 0.45f, 0.2f), fill));

            var label = new GUIStyle(_mid) { fontSize = 14 };
            // Пока ЛКМ не зажата, рука не работает — подсказываем это прямо на полоске,
            // иначе непонятно, почему дубина не двигается вслед за мышью.
            label.normal.textColor = player.Swinging
                ? new Color(1f, 0.8f, 0.4f)
                : new Color(0.7f, 0.74f, 0.8f);
            GUI.Label(new Rect(back.x, back.y - 22f, back.width, 20f),
                player.Swinging
                    ? L("СИЛА ЗАМАХА", "SWING POWER")
                    : L("ЗАЖМИ ЛКМ И МАШИ", "HOLD LMB AND SWING"), label);
        }

        void DrawControls(float w, float h)
        {
            string text = L(
                "WASD / стрелки — прыжки\n" +
                "мышь — поворот\n" +
                "ЛКМ + мышь — удар (маши быстрее — бьёт сильнее)\n" +
                "R — новый раунд      Esc — освободить курсор",
                "WASD / arrows - hop\n" +
                "mouse - turn\n" +
                "LMB + mouse - swing (faster swing hits harder)\n" +
                "R - new round      Esc - release cursor");

            var rect = new Rect(18f, h - 112f, 440f, 96f);
            Box(rect, new Color(0f, 0f, 0f, 0.35f));
            GUI.Label(new Rect(rect.x + 12f, rect.y + 8f, rect.width - 24f, rect.height - 16f), text, _small);
        }

        void DrawBanner(float w, float h)
        {
            string main = null;
            string sub = null;

            if (Cursor.lockState != CursorLockMode.Locked)
            {
                main = L("ПАУЗА", "PAUSED");
                sub = L("Клик — вернуться в игру", "Click to resume");
            }
            else if (_match.State == MatchState.Intro)
            {
                main = L("ПРИГОТОВЬСЯ", "GET READY");
                sub = L("Сбрось всех с арены", "Knock everyone off the arena");
            }
            else if (_match.State == MatchState.RoundOver)
            {
                main = _match.PlayerWon
                    ? L("ПОБЕДА", "YOU WIN")
                    : L("ТЫ ВЫЛЕТЕЛ", "YOU ARE OUT");
                sub = L("Новый раунд через ", "Next round in ")
                    + Mathf.CeilToInt(Mathf.Max(0f, _match.StateTimer))
                    + L("   (R — сразу)", "   (R for now)");
            }
            else if (_match.Player != null && !_match.Player.IsAlive)
            {
                main = L("ТЫ ВЫЛЕТЕЛ", "YOU ARE OUT");
                sub = L("Досматриваем, кто останется   (R — новый раунд)",
                        "Watching the rest   (R for a new round)");
            }

            if (main == null) return;

            var box = new Rect(0f, h * 0.30f, w, 120f);
            Box(new Rect(0f, box.y, w, box.height), new Color(0f, 0f, 0f, 0.35f));
            GUI.Label(new Rect(0f, box.y + 10f, w, 64f), main, _big);
            GUI.Label(new Rect(0f, box.y + 76f, w, 30f), sub, _mid);
        }
    }
}
