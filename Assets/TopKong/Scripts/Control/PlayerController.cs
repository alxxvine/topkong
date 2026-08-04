using UnityEngine;

namespace TopKong
{
    /// <summary>
    /// Ввод игрока. WASD и стрелки — микро-прыжки, мышь — дубина.
    ///
    /// Режим захвата курсора: курсор скрыт, читаются только дельты. Точка прицела
    /// копит эти дельты и постоянно пружинит обратно в нейтраль, поэтому просто
    /// подвести прицел и держать нельзя — чтобы дубина шла, мышью надо махать.
    /// Скорость маха напрямую становится скоростью дубины, а та — силой удара.
    /// </summary>
    [RequireComponent(typeof(Fighter))]
    public class PlayerController : MonoBehaviour
    {
        Fighter _fighter;
        GameTuning _t;
        ArenaCamera _camera;

        Vector3 _hand;

        public Vector3 HandOffsetFlat => new Vector3(_hand.x, 0f, _hand.z);

        public void Init(GameTuning tuning, ArenaCamera cam)
        {
            _fighter = GetComponent<Fighter>();
            _t = tuning;
            _camera = cam;
            _hand = _fighter.Facing * _t.handRestReach;
        }

        void Update()
        {
            if (_fighter == null || !_fighter.IsAlive) return;

            // Курсор отпущен — это пауза управления целиком, а не только мыши.
            bool controls = _fighter.ControlEnabled && Cursor.lockState == CursorLockMode.Locked;

            Vector2 move = controls ? Inp.Move() : Vector2.zero;
            // Направления от осей камеры, а не от поворота бойца: "вперёд" — это вверх
            // по экрану, иначе управление уезжало бы вместе с разворотом тела.
            Vector3 moveWorld = _camera.GroundYaw * new Vector3(move.x, 0f, move.y);
            _fighter.MoveInput = new Vector2(moveWorld.x, moveWorld.z);

            UpdateHand(controls);
        }

        void UpdateHand(bool controls)
        {
            float dt = Time.deltaTime;

            if (controls)
            {
                Vector2 delta = Inp.MouseDelta();
                // Дельта уже посчитана за кадр — умножать её на deltaTime нельзя,
                // иначе чувствительность поедет вслед за частотой кадров.
                Vector3 world = _camera.GroundYaw * new Vector3(delta.x, 0f, delta.y);
                _hand += world * _t.mouseSensitivity;
            }

            // Возврат в нейтраль перед собой. Он же превращает удержание мыши
            // в необходимость непрерывно махать.
            Vector3 rest = _fighter.Facing * _t.handRestReach;
            _hand = Vector3.Lerp(_hand, rest, Mathf.Clamp01(_t.handReturnRate * dt));

            _hand.y = 0f;
            float len = _hand.magnitude;
            if (len < 0.0001f)
            {
                _hand = _fighter.Facing * _t.handMinReach;
            }
            else
            {
                _hand = _hand / len * Mathf.Clamp(len, _t.handMinReach, _t.handMaxReach);
            }

            _fighter.HandOffset = _hand + Vector3.up * _t.clubHeightOffset;
        }
    }
}
