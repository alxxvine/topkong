using UnityEngine;

#if ENABLE_INPUT_SYSTEM && !ENABLE_LEGACY_INPUT_MANAGER
using UnityEngine.InputSystem;
#endif

// Материал трения переименован в Unity 6. Псевдоним прячет это от остального кода:
// сигнатуры и тела методов ниже остаются одинаковыми для всех версий.
#if UNITY_6000_0_OR_NEWER
using PhysMat = UnityEngine.PhysicsMaterial;
#else
using PhysMat = UnityEngine.PhysicMaterial;
#endif

namespace TopKong
{
    /// <summary>
    /// Слой совместимости между версиями Unity.
    ///
    /// В Unity 6 переименовали Rigidbody.velocity -> linearVelocity, drag -> linearDamping
    /// и PhysicMaterial -> PhysicsMaterial. Игра писалась под Unity 6, но весь остальной код
    /// ходит только через эти обёртки, поэтому папку Assets/TopKong можно без правок
    /// скопировать в проект на 2021.3 / 2022.3.
    /// </summary>
    public static class RB
    {
        public static Vector3 Vel(Rigidbody rb)
        {
#if UNITY_6000_0_OR_NEWER
            return rb.linearVelocity;
#else
            return rb.velocity;
#endif
        }

        public static void SetVel(Rigidbody rb, Vector3 v)
        {
#if UNITY_6000_0_OR_NEWER
            rb.linearVelocity = v;
#else
            rb.velocity = v;
#endif
        }

        public static void SetDamping(Rigidbody rb, float linear, float angular)
        {
#if UNITY_6000_0_OR_NEWER
            rb.linearDamping = linear;
            rb.angularDamping = angular;
#else
            rb.drag = linear;
            rb.angularDrag = angular;
#endif
        }

        /// <summary>Материал трения. Тип разный в разных версиях, поэтому на месте вызова нужен var.</summary>
        public static PhysMat NewPhysicsMaterial(string name, float dynamicFriction, float staticFriction, float bounciness)
        {
            var m = new PhysMat(name);
            m.dynamicFriction = dynamicFriction;
            m.staticFriction = staticFriction;
            m.bounciness = bounciness;
            return m;
        }
    }

    /// <summary>
    /// Ввод. По умолчанию проект использует старый Input Manager (так Unity настраивает
    /// свежесозданный проект), но если кто-то перенесёт скрипты в проект, где включён
    /// только новый Input System, прямые вызовы UnityEngine.Input там бросают исключение.
    /// Поэтому вся игра спрашивает ввод здесь, а ветка выбирается на этапе компиляции.
    /// </summary>
    public static class Inp
    {
#if ENABLE_INPUT_SYSTEM && !ENABLE_LEGACY_INPUT_MANAGER
        // Старая ось "Mouse X" отдаёт пиксели, умноженные на чувствительность 0.1.
        // Новый Input System отдаёт чистые пиксели, поэтому приводим к тому же масштабу.
        const float NewInputMouseScale = 0.1f;
#endif

        /// <summary>Направление движения: x — вправо, y — вперёд. WASD и стрелки.</summary>
        public static Vector2 Move()
        {
#if ENABLE_INPUT_SYSTEM && !ENABLE_LEGACY_INPUT_MANAGER
            var kb = Keyboard.current;
            if (kb == null) return Vector2.zero;
            float x = (kb.dKey.isPressed || kb.rightArrowKey.isPressed ? 1f : 0f)
                    - (kb.aKey.isPressed || kb.leftArrowKey.isPressed ? 1f : 0f);
            float y = (kb.wKey.isPressed || kb.upArrowKey.isPressed ? 1f : 0f)
                    - (kb.sKey.isPressed || kb.downArrowKey.isPressed ? 1f : 0f);
            return new Vector2(x, y);
#else
            float x = (Input.GetKey(KeyCode.D) || Input.GetKey(KeyCode.RightArrow) ? 1f : 0f)
                    - (Input.GetKey(KeyCode.A) || Input.GetKey(KeyCode.LeftArrow) ? 1f : 0f);
            float y = (Input.GetKey(KeyCode.W) || Input.GetKey(KeyCode.UpArrow) ? 1f : 0f)
                    - (Input.GetKey(KeyCode.S) || Input.GetKey(KeyCode.DownArrow) ? 1f : 0f);
            return new Vector2(x, y);
#endif
        }

        /// <summary>Смещение мыши за кадр. Это уже дельта — на Time.deltaTime умножать НЕ надо.</summary>
        public static Vector2 MouseDelta()
        {
#if ENABLE_INPUT_SYSTEM && !ENABLE_LEGACY_INPUT_MANAGER
            var mouse = Mouse.current;
            if (mouse == null) return Vector2.zero;
            return mouse.delta.ReadValue() * NewInputMouseScale;
#else
            return new Vector2(Input.GetAxisRaw("Mouse X"), Input.GetAxisRaw("Mouse Y"));
#endif
        }

        public static bool RestartPressed()
        {
#if ENABLE_INPUT_SYSTEM && !ENABLE_LEGACY_INPUT_MANAGER
            var kb = Keyboard.current;
            return kb != null && kb.rKey.wasPressedThisFrame;
#else
            return Input.GetKeyDown(KeyCode.R);
#endif
        }

        /// <summary>F2 — замедление времени в песочнице.</summary>
        public static bool SlowMotionPressed()
        {
#if ENABLE_INPUT_SYSTEM && !ENABLE_LEGACY_INPUT_MANAGER
            var kb = Keyboard.current;
            return kb != null && kb.f2Key.wasPressedThisFrame;
#else
            return Input.GetKeyDown(KeyCode.F2);
#endif
        }

        /// <summary>F3 — вернуть бойца в центр арены.</summary>
        public static bool RespawnPressed()
        {
#if ENABLE_INPUT_SYSTEM && !ENABLE_LEGACY_INPUT_MANAGER
            var kb = Keyboard.current;
            return kb != null && kb.f3Key.wasPressedThisFrame;
#else
            return Input.GetKeyDown(KeyCode.F3);
#endif
        }

        public static bool EscapePressed()
        {
#if ENABLE_INPUT_SYSTEM && !ENABLE_LEGACY_INPUT_MANAGER
            var kb = Keyboard.current;
            return kb != null && kb.escapeKey.wasPressedThisFrame;
#else
            return Input.GetKeyDown(KeyCode.Escape);
#endif
        }

        /// <summary>Левая кнопка мыши удерживается — идёт замах.</summary>
        public static bool SwingHeld()
        {
#if ENABLE_INPUT_SYSTEM && !ENABLE_LEGACY_INPUT_MANAGER
            var mouse = Mouse.current;
            return mouse != null && mouse.leftButton.isPressed;
#else
            return Input.GetMouseButton(0);
#endif
        }

        public static bool ClickPressed()
        {
#if ENABLE_INPUT_SYSTEM && !ENABLE_LEGACY_INPUT_MANAGER
            var mouse = Mouse.current;
            return mouse != null && mouse.leftButton.wasPressedThisFrame;
#else
            return Input.GetMouseButtonDown(0);
#endif
        }
    }
}
