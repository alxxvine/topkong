using UnityEngine;

namespace TopKong
{
    /// <summary>
    /// Камера в духе Diablo: фиксированный наклон и фиксированный разворот.
    ///
    /// Разворот принципиально не меняется во время игры. Дельты мыши переводятся в мир
    /// через этот же угол, так что стоит камере повернуться — и "мышь вправо" перестанет
    /// означать "удар вправо". Поэтому камера только ездит, но никогда не крутится.
    ///
    /// Арена маленькая и должна помещаться в кадр целиком, иначе соперник прилетает
    /// из ниоткуда. Поэтому камера не висит жёстко за игроком, а стоит между центром
    /// арены и игроком — доля задаётся camFollowWeight.
    /// </summary>
    public class ArenaCamera : MonoBehaviour
    {
        GameTuning _t;
        Camera _cam;
        Transform _target;
        Vector3 _focusCenter;
        Vector3 _velocity;
        Vector3 _lookAhead;

        float _shake;
        float _shakeSeed;
        float _yaw;
        float _targetYaw;

        public Camera Cam => _cam;

        public void Init(Camera cam, GameTuning tuning, Vector3 arenaCenter)
        {
            _cam = cam;
            _t = tuning;
            _focusCenter = arenaCenter;
            _shakeSeed = Random.value * 100f;
            _yaw = _t.camYaw;
            _targetYaw = _t.camYaw;

            _cam.clearFlags = CameraClearFlags.SolidColor;
            _cam.backgroundColor = ArenaBuilder.VoidColor;
            _cam.fieldOfView = _t.camFov;
            _cam.nearClipPlane = 0.3f;
            _cam.farClipPlane = 200f;

            transform.position = DesiredPosition(_focusCenter);
            transform.rotation = Rotation;
        }

        public void SetTarget(Transform target)
        {
            _target = target;
        }

        /// <summary>Направление, куда игрок целится дубиной — камера чуть уводится туда же.</summary>
        public void SetLookAhead(Vector3 worldOffset)
        {
            _lookAhead = worldOffset;
        }

        public void AddShake(float amount)
        {
            _shake = Mathf.Min(1.2f, _shake + amount);
        }

        /// <summary>
        /// Куда боец сейчас развёрнут. Используется, только если включён camFollowFacing —
        /// по умолчанию камера не поворачивается вовсе.
        /// </summary>
        public void SetFollowFacing(Vector3 facing)
        {
            if (!_t.camFollowFacing) return;
            facing.y = 0f;
            if (facing.sqrMagnitude < 0.0001f) return;
            _targetYaw = _t.camYaw + Mathf.Atan2(facing.x, facing.z) * Mathf.Rad2Deg;
        }

        /// <summary>
        /// Проекция осей экрана на плоскость арены — по ней ходьба привязывается к камере.
        /// Берётся текущий угол камеры, а не настройка: при включённом camFollowFacing
        /// иначе "вперёд" уехало бы относительно того, что видно на экране.
        /// </summary>
        public Quaternion GroundYaw => Quaternion.Euler(0f, _yaw, 0f);

        Quaternion Rotation => Quaternion.Euler(_t.camPitch, _yaw, 0f);

        Vector3 DesiredPosition(Vector3 focus)
        {
            return focus - Rotation * Vector3.forward * _t.camDistance;
        }

        void LateUpdate()
        {
            if (_t == null) return;

            if (_t.camFollowFacing)
            {
                _yaw = Mathf.LerpAngle(_yaw, _targetYaw,
                    Mathf.Clamp01(_t.camFollowFacingSmooth * Time.unscaledDeltaTime));
            }
            else
            {
                _yaw = _t.camYaw;
            }

            Vector3 focus = _focusCenter;
            if (_target != null)
            {
                Vector3 p = _target.position + _lookAhead * _t.camLookAhead;
                focus = Vector3.Lerp(_focusCenter, p, _t.camFollowWeight);
            }

            Vector3 desired = DesiredPosition(focus);
            transform.position = Vector3.SmoothDamp(transform.position, desired, ref _velocity, _t.camSmooth);
            transform.rotation = Rotation;

            if (_shake > 0.001f)
            {
                float time = Time.unscaledTime * 26f;
                // Perlin, а не Random: тряска должна быть плавной дрожью, а не белым шумом
                float nx = Mathf.PerlinNoise(_shakeSeed, time) * 2f - 1f;
                float ny = Mathf.PerlinNoise(_shakeSeed + 13.7f, time) * 2f - 1f;
                float nz = Mathf.PerlinNoise(_shakeSeed + 27.1f, time) * 2f - 1f;
                transform.position += (transform.right * nx + transform.up * ny) * _shake * 0.5f;
                transform.rotation = Rotation * Quaternion.Euler(0f, 0f, nz * _shake * 2.2f);

                _shake = Mathf.Max(0f, _shake - Time.unscaledDeltaTime * 3.2f);
            }
        }
    }
}
