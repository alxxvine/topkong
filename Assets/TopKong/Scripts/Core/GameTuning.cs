using System;
using UnityEngine;

namespace TopKong
{
    /// <summary>
    /// Все числа игры в одном месте. Объект TopKong в Hierarchy показывает их в инспекторе,
    /// и менять их можно прямо во время Play — контроллеры читают значения каждый кадр.
    /// </summary>
    [Serializable]
    public class GameTuning
    {
        [Header("Арена")]
        public float arenaRadius = 7.5f;
        public float arenaThickness = 0.9f;
        [Tooltip("Ниже этой высоты боец считается упавшим и выбывает")]
        public float killY = -14f;

        [Header("Физика мира")]
        [Tooltip("Тяжелее реальной: падение с арены должно читаться быстро")]
        public float gravity = -26f;
        [Range(4, 32)] public int solverIterations = 12;
        public float fixedTimestep = 1f / 60f;

        [Header("Матч")]
        [Range(1, 7)] public int botCount = 3;
        [Tooltip("Пауза перед стартом раунда, управление заблокировано")]
        public float introTime = 1.6f;
        public float restartDelay = 4f;
        public float despawnDelay = 3f;
        public float spawnRadiusFactor = 0.62f;

        [Header("Стойка и баланс")]
        [Tooltip("На какой высоте подвеска держит таз над ареной")]
        public float standHeight = 1.0f;
        [Tooltip("Только жёсткость отклика: вес тела подвеска компенсирует отдельно")]
        public float suspensionSpring = 260f;
        public float suspensionDamper = 26f;
        // Момент прикладывается в режиме Acceleration, то есть в рад/с², а не в ньютон-метрах.
        // Момент инерции таза мал, поэтому осмысленные значения тут — сотни, а не единицы.
        public float uprightSpring = 550f;
        public float uprightDamper = 45f;
        [Tooltip("Скорость разворота к прицелу. Демпферы вертикали рыскание больше "
               + "не душат, так что значение работает в полную силу")]
        public float facingSpring = 110f;
        public float facingDamper = 10f;
        [Tooltip("Торможение на земле, когда игрок не жмёт направление")]
        public float groundFriction = 12f;
        [Tooltip("Гасит вращение таза на земле. Отдельно от uprightDamper, чтобы не делать подъём деревянным")]
        public float groundedAngularDamping = 6f;

        [Header("Подъём с земли")]
        [Tooltip("Ниже этого совпадения с вертикалью боец считается лежащим (1 — стоит ровно)")]
        [Range(0f, 1f)] public float getUpTiltThreshold = 0.62f;
        [Tooltip("Запас, чтобы не дёргаться на самой границе порога")]
        [Range(0f, 0.5f)] public float getUpHysteresis = 0.15f;
        [Tooltip("Во сколько раз усилить возврат в стойку, пока боец лежит")]
        public float getUpBoost = 3.5f;
        [Tooltip("Если не встал за это время, усилие растёт дальше без потолка — страховка от вечного лежания")]
        public float getUpTimeout = 1.2f;

        [Header("Прыжки")]
        [Tooltip("Пауза между микро-прыжками — из неё берётся весь ритм передвижения")]
        public float hopInterval = 0.30f;
        public float hopUp = 4.6f;
        [Tooltip("Насколько сильно один прыжок разгоняет в сторону движения")]
        public float hopAccel = 3.2f;
        public float maxRunSpeed = 6.2f;
        public float airControl = 9f;
        [Tooltip("Импульс вниз в опорную ногу в момент отталкивания. Ноги чередуются, и это единственное, что делает прыжки похожими на походку")]
        public float legKick = 6f;

        [Header("Прицел")]
        [Tooltip("Насколько далеко за край арены можно увести прицел (доля радиуса). "
               + "Целиться за край нужно — именно туда соперника и сбивают")]
        [Range(1f, 2.5f)] public float aimMaxRadiusFactor = 1.35f;
        [Tooltip("Линия от бойца к прицелу. Показывает, куда он развернётся")]
        public bool showAimLink = true;

        [Header("Дубина")]
        [Tooltip("Жёсткость суставов рук. Держит стойку — при малых значениях дубина "
               + "болтается и уезжает за спину. Применяется при сборке бойца: "
               + "чтобы увидеть эффект, перезапусти раунд по R")]
        public float armDriveSpring = 1500f;
        // Дальность подобрана под длину руки: тянуть дальше бессмысленно, рука упрётся
        // в пределы суставов и замах станет вязким.
        public float handMinReach = 0.55f;
        public float handMaxReach = 1.35f;
        public float clubHeightOffset = -0.05f;

        [Header("Замах")]
        [Tooltip("За сколько секунд удержания заряд набирается полностью")]
        public float swingChargeTime = 0.55f;
        [Tooltip("Длительность самого проноса. Меньше — резче удар")]
        public float swingStrikeTime = 0.22f;
        [Tooltip("Возврат в стойку после удара")]
        public float swingRecoverTime = 0.18f;
        [Tooltip("Пауза перед следующим замахом")]
        public float swingCooldown = 0.15f;
        [Tooltip("Ширина дуги проноса в градусах")]
        [Range(60f, 220f)] public float swingArcDegrees = 150f;
        [Tooltip("На сколько дубина отводится назад при замахе")]
        public float windUpReach = 0.95f;
        [Tooltip("Во сколько раз слабее незаряженный удар по сравнению с полным")]
        [Range(0.1f, 1f)] public float swingWeakestPower = 0.5f;
        [Tooltip("Жёсткость притяжения дубины к точке прицела")]
        public float clubKP = 420f;
        public float clubKD = 34f;
        public float clubMaxAccel = 700f;
        [Tooltip("Доля тяги дубины, возвращаемая в корпус противодействием. 1 — замах "
               + "полностью уравновешен телом и бойца никуда не утаскивает; меньше — "
               + "дубина тянет хозяина за собой")]
        [Range(0f, 1.2f)] public float clubChestReaction = 1f;
        public float clubAlignSpring = 30f;
        public float clubAlignDamper = 4f;
        [Tooltip("Момент, которым корпус доворачивается вслед за проносом. Больше — размашистее")]
        public float swingBodyAssist = 45f;
        [Tooltip("Сколько веса дубины компенсируется во время проноса. 1 — невесомая, "
               + "0 — тянет в полную силу и заваливает бойца")]
        [Range(0f, 1f)] public float swingGravityCompensation = 0.8f;

        [Header("Удары")]
        [Tooltip("Медленнее этой скорости касание не считается ударом")]
        public float minImpactSpeed = 4.5f;
        public float maxImpactSpeed = 24f;
        public float minKnockback = 2.5f;
        public float maxKnockback = 13f;
        [Tooltip("Сколько от удара уходит вверх — с подбросом сбивать с арены веселее")]
        public float knockUpBias = 0.35f;
        public float minStun = 0.15f;
        public float maxStun = 1.2f;
        public float hitCooldown = 0.22f;
        [Tooltip("Сколько боец собирается обратно в стойку после стана")]
        public float stunRecoverTime = 0.55f;
        public float hitStopMax = 0.055f;
        public float shakeMul = 0.9f;

        [Header("Суставы")]
        [Tooltip("Общий множитель жёсткости всех суставов. Меньше — тело тряпичнее")]
        public float driveSpringMul = 1f;
        public float driveDamperMul = 1f;

        [Header("Камера")]
        public float camPitch = 55f;
        [Tooltip("Разворот камеры. Менять осторожно: от него зависит соответствие мыши и удара")]
        public float camYaw = 0f;
        public float camDistance = 21f;
        public float camFov = 42f;
        [Range(0f, 1f)]
        [Tooltip("0 — камера стоит по центру арены, 1 — жёстко висит за игроком")]
        public float camFollowWeight = 0.45f;
        public float camSmooth = 0.18f;
        public float camLookAhead = 0.35f;
        [Tooltip("Камера едет за поворотом бойца. Выключено намеренно: на маленькой арене "
               + "важнее видеть всех соперников, чем смотреть глазами персонажа")]
        public bool camFollowFacing = false;
        public float camFollowFacingSmooth = 6f;

        [Header("Боты")]
        [Range(0f, 1f)] public float botSkill = 0.55f;
        public float botEngageRange = 2.4f;
        public float botSwingRange = 3.4f;
        [Tooltip("Доля радиуса арены, после которой бот бросает всё и идёт к центру")]
        [Range(0.3f, 0.95f)] public float botEdgeCaution = 0.72f;
        public float botReaction = 0.35f;

        [Header("Звук")]
        [Range(0f, 1f)] public float volume = 0.6f;

        [Header("Песочница (отладка ощущений)")]
        [Tooltip("Ты один на арене с манекенами: раунд не заканчивается, выбыть нельзя")]
        public bool sandboxMode = false;
        [Range(0, 6)] public int dummyCount = 3;
        public float dummyRespawnDelay = 1.5f;
        [Tooltip("Множитель времени в замедленном режиме (F2)")]
        [Range(0.05f, 1f)] public float sandboxSlowMotion = 0.25f;
        [Tooltip("След за дубиной игрока. Показывает форму замаха — по нему сразу видно, что не так")]
        public bool showClubTrail = true;
    }
}
