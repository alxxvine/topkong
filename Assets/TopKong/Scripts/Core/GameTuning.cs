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

        [Header("Движение")]
        public float maxRunSpeed = 4.0f;
        [Tooltip("Разгон до полной скорости. Намеренно небыстрый: инерция у края — "
               + "это и есть ощущение риска")]
        public float moveAccel = 16f;
        [Tooltip("Торможение, когда направление отпущено. Низкое — значит у края "
               + "мгновенно остановиться нельзя")]
        public float moveBrake = 10f;
        [Tooltip("Управление в воздухе. Малое намеренно: сбитый должен долетать до края, "
               + "а не выруливать обратно на арену")]
        public float airControl = 4f;
        [Tooltip("Градусов разворота в секунду. Тело кинематическое, так что это "
               + "ровно та скорость, которую видно на экране")]
        public float turnSpeed = 420f;
        [Tooltip("Насколько теряется управление во время проноса. 0 — стоишь как вкопанный, "
               + "1 — удар не мешает бегать. Удар должен чего-то стоить")]
        [Range(0f, 1f)] public float swingMoveLock = 0.2f;

        [Header("Шаг")]
        [Tooltip("Шагов в секунду на полной скорости")]
        public float stepRate = 2.4f;
        [Tooltip("Насколько далеко выносится нога")]
        public float stepLength = 0.28f;
        [Tooltip("Подскок корпуса на шаге")]
        public float stepBob = 0.07f;

        [Header("Вес и шаткость")]
        [Tooltip("Амплитуда покачивания корпуса. У края арены усиливается автоматически")]
        public float wobbleAmount = 0.5f;
        [Tooltip("Как часто корпус качает")]
        public float wobbleRate = 1.1f;
        [Tooltip("Завал корпуса от разгона и торможения — из него читается инерция")]
        public float leanFromAccel = 0.06f;
        [Tooltip("Отставание дубины при развороте, градусов на градус/сек. "
               + "Отсюда у неё берётся вес")]
        public float limbLag = 0.12f;

        [Header("Подъём после падения")]
        [Tooltip("Сколько тряпка должна пролежать спокойно, прежде чем вставать")]
        public float standUpSettle = 0.45f;
        [Tooltip("Страховка: встать не позже этого времени с момента удара")]
        public float standUpTimeout = 3f;
        [Tooltip("Длительность самого вставания")]
        public float standUpTime = 0.5f;

        [Header("Прицел")]
        [Tooltip("Насколько далеко за край арены можно увести прицел (доля радиуса). "
               + "Целиться за край нужно — именно туда соперника и сбивают")]
        [Range(1f, 2.5f)] public float aimMaxRadiusFactor = 1.35f;
        [Tooltip("Линия от бойца к прицелу. Показывает, куда он развернётся")]
        public bool showAimLink = true;

        [Header("Удар")]
        [Tooltip("За сколько секунд удержания заряд набирается полностью")]
        public float swingChargeTime = 0.5f;
        [Tooltip("Длительность самого проноса. Меньше — резче удар")]
        public float swingStrikeTime = 0.18f;
        [Tooltip("Возврат в стойку после удара")]
        public float swingRecoverTime = 0.16f;
        [Tooltip("Пауза перед следующим замахом")]
        public float swingCooldown = 0.12f;
        [Tooltip("Ширина дуги проноса в градусах")]
        [Range(60f, 220f)] public float swingArcDegrees = 150f;
        [Tooltip("Насколько дубина вылетает от корпуса на пике проноса")]
        public float handMaxReach = 1.15f;
        [Tooltip("Во сколько раз слабее незаряженный удар по сравнению с полным")]
        [Range(0.1f, 1f)] public float swingWeakestPower = 0.5f;

        [Header("Удары")]
        [Tooltip("Медленнее этой скорости касание не считается ударом")]
        public float minImpactSpeed = 4.5f;
        public float maxImpactSpeed = 24f;
        public float minKnockback = 2.5f;
        public float maxKnockback = 13f;
        [Tooltip("Сколько от удара уходит вверх — с подбросом сбивать с арены веселее")]
        public float knockUpBias = 0.35f;
        public float hitCooldown = 0.22f;
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
