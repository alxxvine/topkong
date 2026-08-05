using UnityEngine;

namespace TopKong
{
    public enum SwingState
    {
        /// <summary>Дубина в стойке перед собой, её держат суставы.</summary>
        Guard,
        /// <summary>Кнопка зажата: рука отведена, копится заряд.</summary>
        WindUp,
        /// <summary>Пронос дугой сквозь направление прицела.</summary>
        Strike,
        /// <summary>Возврат в стойку.</summary>
        Recover
    }

    /// <summary>
    /// Удар: зажал — копишь, отпустил — бьёшь.
    ///
    /// До этого дубина непрерывно следовала за мышью, а суставы рук были намеренно
    /// слабыми, чтобы её тащил PD-регулятор. Из-за этого рука болталась и регулярно
    /// оказывалась за спиной — ударить из такого положения было нечем. Теперь стойку
    /// держат жёсткие суставы, а этот автомат на время удара перехватывает управление
    /// дубиной и ведёт её по осмысленной дуге.
    ///
    /// Класс общий для игрока и ботов: разница только в том, кто дёргает Held.
    /// Бот бьёт ровно тем же кодом и с теми же таймингами — никаких привилегий.
    /// </summary>
    public class SwingAction
    {
        readonly Fighter _f;
        readonly GameTuning _t;

        float _timer;
        float _cooldown;
        float _charge;
        // Сторона дуги чередуется: слева-направо, потом обратно.
        float _side = 1f;
        float _strikeAimDeg;

        public SwingState State { get; private set; } = SwingState.Guard;

        /// <summary>Набранный заряд 0..1. В стойке — заряд прошлого удара уже сброшен.</summary>
        public float Charge => _charge;

        public bool Held { get; set; }

        /// <summary>Идёт пронос — по нему включается помощь корпуса и звук.</summary>
        public bool Striking => State == SwingState.Strike;

        /// <summary>Пока false, дубину держат только суставы и PD-регулятор не вмешивается.</summary>
        public bool DrivesClub => State == SwingState.WindUp || State == SwingState.Strike;

        /// <summary>Мировая точка, к которой тянуть дубину. Осмысленна, только если DrivesClub.</summary>
        public Vector3 Target { get; private set; }

        /// <summary>Множитель силы тяги: слабый заряд — вялый удар.</summary>
        public float PowerScale => Mathf.Lerp(_t.swingWeakestPower, 1f, _charge);

        public SwingAction(Fighter fighter, GameTuning tuning)
        {
            _f = fighter;
            _t = tuning;
        }

        public void Tick(float dt)
        {
            _cooldown -= dt;

            switch (State)
            {
                case SwingState.Guard:
                    _charge = 0f;
                    if (Held && _cooldown <= 0f) State = SwingState.WindUp;
                    break;

                case SwingState.WindUp:
                    _charge = Mathf.Min(1f, _charge + dt / Mathf.Max(0.01f, _t.swingChargeTime));
                    if (!Held) BeginStrike();
                    break;

                case SwingState.Strike:
                    _timer += dt;
                    if (_timer >= _t.swingStrikeTime)
                    {
                        State = SwingState.Recover;
                        _timer = 0f;
                        // Следующий удар пойдёт с другой стороны — так серия ударов
                        // читается как размен, а не как повторение одного движения.
                        _side = -_side;
                        _cooldown = _t.swingCooldown;
                    }
                    break;

                case SwingState.Recover:
                    _timer += dt;
                    if (_timer >= _t.swingRecoverTime)
                    {
                        State = SwingState.Guard;
                        _timer = 0f;
                    }
                    break;
            }

            UpdateTarget();
        }

        void BeginStrike()
        {
            State = SwingState.Strike;
            _timer = 0f;
            // Направление фиксируется в момент отпускания. Иначе доворот прицела
            // посреди проноса тащил бы дубину за собой, и удар терял бы инерцию.
            _strikeAimDeg = AimDegrees();
        }

        float AimDegrees()
        {
            Vector3 aim = _f.FacingTarget;
            aim.y = 0f;
            if (aim.sqrMagnitude < 0.0001f) aim = _f.Facing;
            return Mathf.Atan2(aim.x, aim.z) * Mathf.Rad2Deg;
        }

        void UpdateTarget()
        {
            if (!DrivesClub) return;

            float half = _t.swingArcDegrees * 0.5f;
            float angle;
            float reach;

            if (State == SwingState.WindUp)
            {
                // Отводим за начало дуги: замах должен быть виден как замах,
                // а пронос — начинаться с разгона, а не с места.
                angle = AimDegrees() - _side * (half + 30f);
                reach = Mathf.Lerp(_t.handMinReach, _t.windUpReach, _charge);
            }
            else
            {
                float phase = Mathf.Clamp01(_timer / Mathf.Max(0.01f, _t.swingStrikeTime));
                angle = _strikeAimDeg + Mathf.Lerp(-half, half, phase) * _side;
                // Рука выпрямляется к середине проноса — там же и максимальная скорость.
                reach = Mathf.Lerp(_t.handMinReach, _t.handMaxReach, Mathf.Sin(phase * Mathf.PI));
            }

            Vector3 offset = Quaternion.Euler(0f, angle, 0f) * Vector3.forward * reach;
            Target = _f.Chest.position + offset + Vector3.up * _t.clubHeightOffset;
        }
    }
}
