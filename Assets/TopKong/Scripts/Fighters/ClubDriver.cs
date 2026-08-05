using UnityEngine;

namespace TopKong
{
    /// <summary>
    /// Ведёт дубину во время удара.
    ///
    /// Раньше этот регулятор тянул дубину постоянно, а суставы рук были намеренно
    /// слабыми, чтобы ему не мешать. Из-за этого в покое рука болталась и уезжала
    /// за спину. Теперь наоборот: стойку держат жёсткие суставы, а регулятор
    /// вмешивается только на замахе и проносе — когда SwingAction говорит, куда вести.
    ///
    /// Сам удар по-прежнему чисто физический: дубина — обычное тело, PD-регулятор
    /// разгоняет её по дуге, дальше PhysX сам передаёт сопернику импульс,
    /// пропорциональный набранной скорости. Никакого "нанесения урона" в коде нет.
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

        public void Tick()
        {
            var club = _f.Club;
            var chest = _f.Chest;
            if (club == null || chest == null) return;

            var swing = _f.Swing;
            bool striking = swing.Striking;

            // Дубина держится на весу без участия баланса.
            //
            // Она намеренно тяжёлая — девять килограммов на вытянутых руках, — и именно
            // из этой массы берётся сила удара. Но та же масса статически валит бойца:
            // момент от неё на порядок больше того, что контроллер вертикали способен
            // выдать. Компенсация гравитации разводит эти два свойства: инерция остаётся
            // полной (импульс сопернику передаётся ровно тот же), а вес перестаёт тянуть
            // хозяина к земле. Пока боец оглушён, Tick не вызывается — и дубина честно
            // весит своё, утягивая обмякшее тело.
            //
            // На проносе компенсация ослабляется: тяжёлый удар обязан тянуть бойца
            // за собой, иначе он не чувствуется весомым.
            float compensation = striking ? _t.swingGravityCompensation : 1f;
            ApplyLift(club, compensation);
            ApplyLift(_f.ArmR, compensation);
            ApplyLift(_f.ArmL, compensation);

            // Вне замаха дубину держат суставы. Если тянуть её ещё и регулятором,
            // два источника правды начинают спорить, и стойка дрожит.
            if (!swing.DrivesClub) return;

            Vector3 target = swing.Target;
            Vector3 error = target - club.position;
            Vector3 force = error * (_t.clubKP * swing.PowerScale) - RB.Vel(club) * _t.clubKD;
            force = Vector3.ClampMagnitude(force, _t.clubMaxAccel * swing.PowerScale);

            club.AddForce(force, ForceMode.Acceleration);

            // Часть силы уходит обратно в корпус: дубина ощутимо тяжёлая, и на резком
            // замахе бойца немного разворачивает следом.
            chest.AddForce(-force * _t.clubChestReaction, ForceMode.Acceleration);

            if (striking) AssistWithBody(club, chest);

            AlignClub(club, chest, target);
        }

        static void ApplyLift(Rigidbody body, float compensation)
        {
            if (body != null) body.AddForce(-Physics.gravity * compensation, ForceMode.Acceleration);
        }

        /// <summary>
        /// Разворачивает корпус вслед за проносом дубины.
        ///
        /// Без этого удар выглядит как движение одной оторванной конечности. Момент
        /// считается от того, куда дубина летит сейчас, а не от точки прицела: иначе
        /// корпус доворачивался бы к цели ещё до начала движения.
        /// </summary>
        void AssistWithBody(Rigidbody club, Rigidbody chest)
        {
            Vector3 velocity = RB.Vel(club);
            velocity.y = 0f;
            if (velocity.sqrMagnitude < 0.5f) return;

            Vector3 arm = club.position - chest.position;
            arm.y = 0f;
            if (arm.sqrMagnitude < 1e-4f) return;

            float swingSign = Vector3.Dot(Vector3.Cross(arm.normalized, velocity), Vector3.up);
            chest.AddTorque(Vector3.up * (swingSign * _t.swingBodyAssist), ForceMode.Acceleration);
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
