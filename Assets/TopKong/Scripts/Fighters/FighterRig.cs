using UnityEngine;

namespace TopKong
{
    /// <summary>
    /// Геометрия тела и вычисление позы. Общая для сборщика и для контроллера позы:
    /// пока боец под управлением, его тела кинематические и расставляются вот этими
    /// формулами, а в момент удара те же тела становятся динамическими и продолжают
    /// с ровно той позы, в которой их застали. Разъехаться они не могут, потому что
    /// источник координат один.
    ///
    /// Все величины — в локальных координатах бойца: ноль на арене под ним,
    /// +Z — направление взгляда.
    /// </summary>
    public static class FighterRig
    {
        public const float HipsY = 0.95f;
        public const float ChestY = 1.40f;
        public const float HeadY = 1.82f;

        public const float HipHalfWidth = 0.13f;
        public const float HipJointY = 0.88f;
        public const float KneeY = 0.48f;
        public const float FootY = 0.10f;

        public const float ShoulderHalfWidth = 0.28f;
        public const float ShoulderY = 1.58f;
        public const float HandHalfWidth = 0.10f;

        /// <summary>Дубина держится перед собой: центр на этой высоте, головой вперёд.</summary>
        public const float ClubY = 1.30f;
        public const float ClubRestReach = 0.62f;
        /// <summary>Насколько рукоять отстоит от центра дубины назад.</summary>
        public const float ClubGripOffset = 0.32f;
        public static readonly Vector3 ClubHeadLocal = new Vector3(0f, 0.40f, 0f);

        public const float LegRadius = 0.11f;
        public const float FootRadius = 0.10f;
        public const float ArmRadius = 0.085f;

        /// <summary>Полный набор локальных позиций и поворотов тела.</summary>
        public struct Pose
        {
            public Vector3 Hips;
            public Vector3 Chest;
            public Vector3 Head;
            public Vector3 FootLeft;
            public Vector3 FootRight;
            public Vector3 Club;
            public Quaternion ClubRotation;
            public Vector3 HandLeft;
            public Vector3 HandRight;
        }

        /// <summary>
        /// Поза по параметрам.
        /// </summary>
        /// <param name="bob">Вертикальное смещение таза — им же делается подскок при шаге.</param>
        /// <param name="stepPhase">0..1, фаза шага. Ноги ходят в противофазе.</param>
        /// <param name="stride">Размах шага: 0 в покое, больше на скорости.</param>
        /// <param name="clubAngleDeg">Куда развёрнута дубина относительно взгляда.</param>
        /// <param name="clubReach">Насколько дубина вынесена от груди.</param>
        /// <param name="lean">Наклон корпуса вперёд: от разгона и от удара.</param>
        /// <param name="sway">Заваливание вбок. Им и делается вся шаткость походки.</param>
        /// <param name="clubHeight">Смещение дубины по высоте. Отрицательное — волочится.</param>
        public static Pose Compute(float bob, float stepPhase, float stride,
            float clubAngleDeg, float clubReach, float lean, float sway = 0f,
            float clubHeight = 0f)
        {
            var pose = new Pose();

            // Смещения намеренно разные по высоте: наклоны корпуса нигде не задаются
            // явно, PoseDriver выводит их из направлений таз→грудь и грудь→голова.
            // Поэтому «завалить тело» здесь означает просто развести эти точки вбок
            // на разную величину — и тело заваливается само, оставаясь связным.
            pose.Hips = new Vector3(sway * 0.02f, HipsY + bob, lean * 0.02f);
            pose.Chest = new Vector3(sway * 0.10f, ChestY + bob, lean * 0.12f);
            pose.Head = new Vector3(sway * 0.22f, HeadY + bob, lean * 0.20f);

            // Ноги в противофазе: одна выносится вперёд и приподнимается, другая позади.
            float phaseL = stepPhase * Mathf.PI * 2f;
            float phaseR = phaseL + Mathf.PI;
            pose.FootLeft = Foot(-HipHalfWidth, phaseL, stride);
            pose.FootRight = Foot(HipHalfWidth, phaseR, stride);

            Vector3 direction = Quaternion.Euler(0f, clubAngleDeg, 0f) * Vector3.forward;
            Vector3 side = Vector3.Cross(Vector3.up, direction);

            Vector3 chestPoint = new Vector3(0f, ClubY + bob + clubHeight, lean * 0.12f);
            pose.Club = chestPoint + direction * clubReach;
            // Длинная ось дубины — её локальная Y, поэтому разворачиваем Y на направление.
            pose.ClubRotation = Quaternion.FromToRotation(Vector3.up, direction);

            Vector3 grip = pose.Club - direction * ClubGripOffset;
            pose.HandRight = grip + side * HandHalfWidth;
            pose.HandLeft = grip - side * HandHalfWidth;

            return pose;
        }

        static Vector3 Foot(float x, float phase, float stride)
        {
            // Подъём только на передней половине шага: сзади нога скользит по земле.
            float lift = Mathf.Max(0f, Mathf.Sin(phase)) * stride * 0.35f;
            float forward = Mathf.Cos(phase) * stride;
            return new Vector3(x, FootY + lift, forward);
        }

        public static Vector3 Shoulder(bool right)
        {
            return new Vector3(right ? ShoulderHalfWidth : -ShoulderHalfWidth, ShoulderY, 0f);
        }

        public static Vector3 HipJoint(bool right)
        {
            return new Vector3(right ? HipHalfWidth : -HipHalfWidth, HipJointY, 0f);
        }

        /// <summary>Положение и поворот конечности, натянутой между двумя точками.</summary>
        public static void Limb(Vector3 from, Vector3 to, out Vector3 center, out Quaternion rotation)
        {
            center = (from + to) * 0.5f;
            Vector3 delta = to - from;
            rotation = delta.sqrMagnitude > 1e-6f
                ? Quaternion.FromToRotation(Vector3.up, delta.normalized)
                : Quaternion.identity;
        }

        public static float LimbLength(Vector3 from, Vector3 to)
        {
            return (to - from).magnitude;
        }

        /// <summary>Поза покоя — из неё собирается тело и в неё же оно возвращается после падения.</summary>
        public static Pose RestPose()
        {
            return Compute(0f, 0f, 0f, 0f, ClubRestReach, 0f, 0f, 0f);
        }
    }
}
