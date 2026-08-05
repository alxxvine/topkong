using UnityEngine;

namespace TopKong
{
    public enum SwingState
    {
        Guard,
        WindUp,
        Strike,
        Recover
    }

    /// <summary>
    /// Удар как сценарий, а не как физика.
    ///
    /// Раньше дубину вёл PD-регулятор, а замах возникал из того, как игрок водит мышью.
    /// Идея пришла из VR, где у игрока есть настоящая рука с настоящей скоростью;
    /// на мыши такой руки нет, и всё сводилось к угадыванию намерения по двумерному
    /// курсору — отсюда вязкость, раскачка и бесконечная подкрутка коэффициентов.
    ///
    /// Теперь это чистый таймлайн: класс не трогает физику вовсе, а лишь выдаёт три числа —
    /// куда развёрнута дубина, насколько вынесена и как наклонён корпус. Разворачивает
    /// их в позу PoseDriver. Физика остаётся там, где она хороша: в том, как соперник
    /// получает импульс и улетает.
    ///
    /// Класс общий для игрока и ботов: разница только в том, кто держит Held.
    /// </summary>
    public class SwingAction
    {
        readonly GameTuning _t;

        float _timer;
        float _cooldown;
        float _charge;
        // Сторона дуги чередуется: слева-направо, потом обратно.
        float _side = 1f;

        float _angle;
        float _reach;
        float _lean;

        public SwingState State { get; private set; } = SwingState.Guard;
        public bool Held { get; set; }
        public float Charge => _charge;

        /// <summary>Идёт пронос — только в это время дубина считается бьющей.</summary>
        public bool Striking => State == SwingState.Strike;

        /// <summary>Куда развёрнута дубина относительно взгляда, в градусах.</summary>
        public float ClubAngle => _angle;

        /// <summary>Насколько дубина вынесена от корпуса.</summary>
        public float ClubReach => _reach;

        /// <summary>Наклон корпуса: отрицательный — отклонился назад на замахе.</summary>
        public float Lean => _lean;

        /// <summary>Сила удара 0..1: во столько раз он весомее незаряженного.</summary>
        public float Power { get; private set; } = 1f;

        public SwingAction(GameTuning tuning)
        {
            _t = tuning;
            _reach = FighterRig.ClubRestReach;
        }

        public void Tick(float dt)
        {
            _cooldown -= dt;

            switch (State)
            {
                case SwingState.Guard:
                    _charge = 0f;
                    if (Held && _cooldown <= 0f)
                    {
                        State = SwingState.WindUp;
                        _timer = 0f;
                    }
                    break;

                case SwingState.WindUp:
                    _timer += dt;
                    _charge = Mathf.Min(1f, _timer / Mathf.Max(0.01f, _t.swingChargeTime));
                    if (!Held)
                    {
                        State = SwingState.Strike;
                        _timer = 0f;
                        Power = Mathf.Lerp(_t.swingWeakestPower, 1f, _charge);
                    }
                    break;

                case SwingState.Strike:
                    _timer += dt;
                    if (_timer >= _t.swingStrikeTime)
                    {
                        State = SwingState.Recover;
                        _timer = 0f;
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

            UpdatePose(dt);
        }

        void UpdatePose(float dt)
        {
            float half = _t.swingArcDegrees * 0.5f;
            float targetAngle;
            float targetReach;
            float targetLean;
            float blend;

            switch (State)
            {
                case SwingState.WindUp:
                    // Отводим за начало дуги и подаём корпус назад: замах должен читаться
                    // как замах ещё до того, как что-то полетит.
                    targetAngle = -_side * (half + 25f);
                    targetReach = FighterRig.ClubRestReach * 0.8f;
                    targetLean = -0.4f * _charge;
                    blend = 12f * dt;
                    break;

                case SwingState.Strike:
                {
                    float phase = Mathf.Clamp01(_timer / Mathf.Max(0.01f, _t.swingStrikeTime));
                    // Ease-out: пронос резкий в начале и доводится к концу. Линейная
                    // развёртка выглядит как равномерное вращение манипулятора, а не как удар.
                    float eased = 1f - (1f - phase) * (1f - phase);
                    targetAngle = Mathf.Lerp(-(half + 25f), half, eased) * _side;
                    targetReach = Mathf.Lerp(FighterRig.ClubRestReach, _t.handMaxReach,
                        Mathf.Sin(phase * Mathf.PI));
                    targetLean = Mathf.Sin(phase * Mathf.PI);
                    // Во время удара поза ставится напрямую: любое сглаживание здесь
                    // размазало бы тайминг, ради которого сценарный удар и делался.
                    blend = 1f;
                    break;
                }

                case SwingState.Recover:
                    targetAngle = 0f;
                    targetReach = FighterRig.ClubRestReach;
                    targetLean = 0f;
                    blend = 10f * dt;
                    break;

                default:
                    targetAngle = 0f;
                    targetReach = FighterRig.ClubRestReach;
                    targetLean = 0f;
                    blend = 8f * dt;
                    break;
            }

            blend = Mathf.Clamp01(blend);
            _angle = Mathf.Lerp(_angle, targetAngle, blend);
            _reach = Mathf.Lerp(_reach, targetReach, blend);
            _lean = Mathf.Lerp(_lean, targetLean, blend);
        }

        public void Reset()
        {
            State = SwingState.Guard;
            Held = false;
            _timer = 0f;
            _cooldown = 0f;
            _charge = 0f;
            _angle = 0f;
            _reach = FighterRig.ClubRestReach;
            _lean = 0f;
        }
    }
}
