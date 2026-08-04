using UnityEngine;

namespace TopKong
{
    /// <summary>
    /// Тянет дубину к точке прицела.
    ///
    /// Здесь и живёт вся боёвка. Дубина — обычное физическое тело, а не анимация:
    /// PD-регулятор гонит её к точке, которую двигает мышь. Дёрнул мышь резко —
    /// точка ушла далеко, рассогласование выросло, сила выросла, дубина разогналась.
    /// Дальше PhysX сам передаёт импульс сопернику, пропорциональный набранной скорости.
    /// Поэтому "быстрее машешь мышью — сильнее бьёшь" не запрограммировано отдельно,
    /// это просто следствие: отдельной кнопки атаки в игре нет вообще.
    /// </summary>
    public class ClubDriver
    {
        readonly Fighter _f;
        readonly GameTuning _t;

        public ClubDriver(Fighter fighter, GameTuning tuning)
        {
            _f = fighter;
            _t = tuning;
        }

        /// <summary>
        /// Вызывается только пока боец в сознании. Во вступлении раунда тоже работает —
        /// дубина должна висеть в стойке, а не волочиться по арене.
        /// </summary>
        public void Tick()
        {
            var club = _f.Club;
            var chest = _f.Chest;
            if (club == null || chest == null) return;

            // Дубина держится на весу без участия баланса.
            //
            // Она намеренно тяжёлая — восемь килограммов на вытянутой руке, — и именно
            // из этой массы берётся сила удара. Но та же масса статически валит бойца:
            // момент от неё на порядок больше того, что контроллер вертикали способен
            // выдать. Компенсация гравитации разводит эти два свойства: инерция остаётся
            // полной (импульс сопернику передаётся ровно тот же), а вес перестаёт тянуть
            // хозяина к земле. Пока боец оглушён, Tick не вызывается — и дубина честно
            // весит своё, утягивая обмякшее тело.
            club.AddForce(-Physics.gravity, ForceMode.Acceleration);
            var upperArm = _f.ClubUpper;
            if (upperArm != null) upperArm.AddForce(-Physics.gravity, ForceMode.Acceleration);

            Vector3 target = chest.position + _f.HandOffset;

            Vector3 error = target - club.position;
            Vector3 force = error * _t.clubKP - RB.Vel(club) * _t.clubKD;
            force = Vector3.ClampMagnitude(force, _t.clubMaxAccel);

            club.AddForce(force, ForceMode.Acceleration);

            // Часть силы уходит обратно в корпус: дубина ощутимо тяжёлая, и на резком
            // замахе бойца немного разворачивает следом. Это же не даёт руке
            // работать как безынерционному манипулятору.
            chest.AddForce(-force * _t.clubChestReaction, ForceMode.Acceleration);

            AlignClub(club, chest, target);
        }

        /// <summary>
        /// Доворачивает дубину набалдашником наружу. Без этого она болтается на суставе
        /// как попало и половина замахов приходится древком.
        /// </summary>
        void AlignClub(Rigidbody club, Rigidbody chest, Vector3 target)
        {
            Vector3 want = target - chest.position;
            want.y = 0f;
            if (want.sqrMagnitude < 1e-4f) return;
            want.Normalize();

            // Длинная ось дубины — её локальная Y (риг собран с поворотом на -90 по Z).
            Vector3 axis = Vector3.Cross(club.transform.up, want);
            club.AddTorque(axis * _t.clubAlignSpring - club.angularVelocity * _t.clubAlignDamper,
                ForceMode.Acceleration);
        }
    }
}
