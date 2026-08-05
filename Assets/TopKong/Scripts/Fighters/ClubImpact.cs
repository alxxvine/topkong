using System.Collections.Generic;
using UnityEngine;

namespace TopKong
{
    /// <summary>
    /// Превращает касание дубины в толчок. Ни урона, ни здоровья в игре нет —
    /// удар выдаёт только импульс, а проигрывает тот, кого этим импульсом
    /// в итоге вынесло за край.
    ///
    /// Импульс считается и прикладывается вручную, а не оставляется физике: дубина
    /// в момент удара кинематическая, то есть собственного импульса у неё нет вовсе.
    /// Зато есть честная скорость набалдашника, которую Fighter меряет по смещению
    /// за кадр, — из неё и получается сила. Заодно это снимает старую проблему,
    /// когда удар древком и удар набалдашником отличались случайным образом.
    /// </summary>
    [RequireComponent(typeof(Rigidbody))]
    public class ClubImpact : MonoBehaviour
    {
        Fighter _owner;
        GameTuning _t;
        GameFx _fx;

        readonly Dictionary<Fighter, float> _lastHit = new Dictionary<Fighter, float>();

        public void Init(Fighter owner, GameTuning tuning, GameFx fx)
        {
            _owner = owner;
            _t = tuning;
            _fx = fx;
        }

        void OnCollisionEnter(Collision collision) => Handle(collision);

        // Во время быстрого проноса контакт может не породить новый Enter — дубина
        // уже касалась соперника кадром раньше. Кулдаун ниже не даёт этому
        // превратиться в непрерывное молотилово.
        void OnCollisionStay(Collision collision) => Handle(collision);

        void Handle(Collision collision)
        {
            if (_owner == null || !_owner.IsAlive || _t == null) return;

            // Бьёт только пронос. В стойке и на замахе дубина ничего не задевает,
            // иначе можно было бы наносить удары, просто наткнувшись на соперника.
            if (!_owner.Swinging) return;

            var otherRb = collision.rigidbody;
            if (otherRb == null) return;

            var part = otherRb.GetComponent<BodyPart>();
            if (part == null) return;

            var victim = part.Owner;
            if (victim == null || victim == _owner || !victim.IsAlive) return;

            float now = Time.time;
            if (_lastHit.TryGetValue(victim, out float last) && now - last < _t.hitCooldown) return;

            float speed = _owner.SwingSpeed;
            if (speed < _t.minImpactSpeed) return;

            _lastHit[victim] = now;

            float strength = Mathf.InverseLerp(_t.minImpactSpeed, _t.maxImpactSpeed, speed)
                             * _owner.SwingPower;

            Vector3 dir = victim.Position - _owner.Position;
            dir.y = 0f;
            if (dir.sqrMagnitude < 1e-4f) dir = _owner.AimDirection;
            dir = (dir.normalized + Vector3.up * _t.knockUpBias).normalized;

            float power = Mathf.Lerp(_t.minKnockback, _t.maxKnockback, Mathf.Clamp01(strength));

            // Тряпкой соперник становится ровно здесь — единственная точка входа
            // в ragdoll во всей игре.
            victim.Ragdoll(dir * power);
            victim.RecordHit(speed, strength);

            Vector3 point = collision.contactCount > 0
                ? collision.GetContact(0).point
                : transform.position;
            _fx?.Hit(point, Mathf.Clamp01(strength));
        }
    }
}
