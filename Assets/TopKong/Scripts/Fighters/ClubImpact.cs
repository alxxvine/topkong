using System.Collections.Generic;
using UnityEngine;

namespace TopKong
{
    /// <summary>
    /// Превращает касание дубины в толчок. Ни урона, ни здоровья в игре нет —
    /// удар выдаёт только импульс и стан, а проигрывает тот, кого этим импульсом
    /// в итоге вынесло за край.
    ///
    /// PhysX и сам передал бы импульс, но его одного мало: чтобы попадание читалось,
    /// добавляется отдельный толчок с подбросом и оглушение, длительность которого
    /// зависит от скорости дубины в момент касания.
    /// </summary>
    [RequireComponent(typeof(Rigidbody))]
    public class ClubImpact : MonoBehaviour
    {
        Fighter _owner;
        GameTuning _t;
        GameFx _fx;
        Rigidbody _club;

        readonly Dictionary<Fighter, float> _lastHit = new Dictionary<Fighter, float>();

        public void Init(Fighter owner, GameTuning tuning, GameFx fx)
        {
            _owner = owner;
            _t = tuning;
            _fx = fx;
            _club = GetComponent<Rigidbody>();
        }

        void OnCollisionEnter(Collision collision) => Handle(collision);

        // Во время быстрого проноса контакт может не породить новый Enter — дубина
        // уже касалась соперника кадром раньше. Кулдаун ниже не даёт этому
        // превратиться в непрерывное молотилово.
        void OnCollisionStay(Collision collision) => Handle(collision);

        void Handle(Collision collision)
        {
            if (_owner == null || !_owner.IsAlive || _t == null) return;

            var otherRb = collision.rigidbody;
            if (otherRb == null) return;                 // арена и прочая статика

            var part = otherRb.GetComponent<BodyPart>();
            if (part == null) return;

            var victim = part.Owner;
            if (victim == null || victim == _owner || !victim.IsAlive) return;

            float now = Time.time;
            if (_lastHit.TryGetValue(victim, out float last) && now - last < _t.hitCooldown) return;

            float speed = collision.relativeVelocity.magnitude;
            if (speed < _t.minImpactSpeed) return;

            _lastHit[victim] = now;

            float strength = Mathf.InverseLerp(_t.minImpactSpeed, _t.maxImpactSpeed, speed);

            Vector3 dir = victim.Position - _club.position;
            dir.y = 0f;
            if (dir.sqrMagnitude < 1e-4f) dir = _club.transform.up;
            dir.y = 0f;
            if (dir.sqrMagnitude < 1e-4f) dir = Vector3.forward;
            dir = (dir.normalized + Vector3.up * _t.knockUpBias).normalized;

            float power = Mathf.Lerp(_t.minKnockback, _t.maxKnockback, strength);

            // VelocityChange, а не Impulse: толчок не должен зависеть от того,
            // в какую часть тела прилетело — иначе удар по голове двигал бы сильнее.
            victim.Hips.AddForce(dir * power, ForceMode.VelocityChange);
            otherRb.AddForce(dir * (power * 0.5f), ForceMode.VelocityChange);

            victim.Stun(Mathf.Lerp(_t.minStun, _t.maxStun, strength));
            _owner.RecordHit(speed, strength);

            Vector3 point = collision.contactCount > 0
                ? collision.GetContact(0).point
                : _club.position;
            _fx?.Hit(point, strength);
        }
    }
}
