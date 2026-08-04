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
        public float uprightSpring = 400f;
        public float uprightDamper = 35f;
        public float facingSpring = 55f;
        public float facingDamper = 8f;
        [Tooltip("Торможение на земле, когда игрок не жмёт направление")]
        public float groundFriction = 12f;

        [Header("Прыжки (рука-нога)")]
        [Tooltip("Пауза между микро-прыжками — из неё берётся весь ритм передвижения")]
        public float hopInterval = 0.30f;
        public float hopUp = 4.6f;
        [Tooltip("Насколько сильно один прыжок разгоняет в сторону движения")]
        public float hopAccel = 3.2f;
        public float maxRunSpeed = 6.2f;
        public float airControl = 9f;
        [Tooltip("Импульс вниз в руку-ногу в момент отталкивания — чистая визуальная отдача")]
        public float legKick = 6f;

        [Header("Дубина")]
        public float mouseSensitivity = 0.055f;
        // Дальность подобрана под длину руки в риге: центр дубины в стойке стоит
        // в 1.32 от центра груди, поэтому за 1.45 тянуть бессмысленно — рука просто
        // упрётся в пределы суставов и замах станет вязким.
        public float handMinReach = 0.60f;
        public float handMaxReach = 1.45f;
        public float handRestReach = 1.05f;
        [Tooltip("Как быстро рука возвращается в нейтраль. Больше — тем активнее надо махать")]
        public float handReturnRate = 7f;
        public float clubHeightOffset = -0.15f;
        [Tooltip("Жёсткость притяжения дубины к точке прицела")]
        public float clubKP = 420f;
        public float clubKD = 34f;
        public float clubMaxAccel = 700f;
        [Tooltip("Доля силы, уходящая обратно в корпус — вес дубины и отдача")]
        public float clubChestReaction = 0.22f;
        public float clubAlignSpring = 30f;
        public float clubAlignDamper = 4f;

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

        [Header("Боты")]
        [Range(0f, 1f)] public float botSkill = 0.55f;
        public float botEngageRange = 2.4f;
        public float botSwingRange = 3.4f;
        [Tooltip("Доля радиуса арены, после которой бот бросает всё и идёт к центру")]
        [Range(0.3f, 0.95f)] public float botEdgeCaution = 0.72f;
        public float botReaction = 0.35f;

        [Header("Звук")]
        [Range(0f, 1f)] public float volume = 0.6f;
    }
}
