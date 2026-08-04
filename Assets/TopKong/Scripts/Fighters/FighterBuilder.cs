using System.Collections.Generic;
using UnityEngine;

namespace TopKong
{
    /// <summary>
    /// Собирает бойца целиком из примитивов: семь физических тел, скреплённых ConfigurableJoint.
    ///
    /// Два решения, на которых держится вся стабильность рига:
    ///
    /// 1. Физические объекты имеют scale = 1, а всё масштабирование живёт на дочерних
    ///    объектах-картинках. Якоря суставов задаются через InverseTransformPoint, и на
    ///    отмасштабированном трансформе они разъезжаются самым неочевидным образом.
    ///    Коллайдеры поэтому настраиваются числами (radius/height), а не scale.
    ///
    /// 2. Риг собирается сразу в позе покоя, и только потом навешиваются суставы.
    ///    ConfigurableJoint запоминает текущий взаимный поворот как ноль, поэтому
    ///    targetRotation = identity означает "вернись в позу, в которой тебя собрали" —
    ///    и не нужна та самая инвертированная математика, на которой обычно спотыкаются
    ///    активные ragdoll'ы.
    /// </summary>
    public static class FighterBuilder
    {
        // Все координаты — локальные, от точки спавна на поверхности арены.
        // Рост около 2.1 единицы: таз на 1.0, макушка на 2.13.
        const float HipsY = 1.00f;
        const float ChestY = 1.46f;
        const float HeadY = 1.92f;

        public static Fighter Build(
            Transform parent,
            Vector3 spawnPos,
            float yawDegrees,
            Color teamColor,
            string displayName,
            bool isPlayer,
            GameTuning t,
            Arena arena,
            GameFx fx)
        {
            var rootGo = new GameObject("Fighter_" + displayName);
            rootGo.transform.SetParent(parent, false);
            rootGo.transform.SetPositionAndRotation(spawnPos, Quaternion.Euler(0f, yawDegrees, 0f));

            var fighter = rootGo.AddComponent<Fighter>();

            var bodies = new List<Rigidbody>();
            var colliders = new List<Collider>();
            var joints = new List<ConfigurableJoint>();

            var skinMat = MaterialFactory.Lit(teamColor, 0.18f);
            var darkMat = MaterialFactory.Lit(Color.Lerp(teamColor, Color.black, 0.55f), 0.12f);
            var woodMat = MaterialFactory.Lit(new Color(0.36f, 0.24f, 0.14f), 0.10f);
            var metalMat = MaterialFactory.Lit(new Color(0.62f, 0.63f, 0.68f), 0.65f, 0.85f);

            var root = rootGo.transform;

            // --- корпус ---
            var hips = AddPart(root, "Hips", new Vector3(0f, HipsY, 0f), Quaternion.identity, 12f, fighter, bodies);
            AddCapsule(hips.gameObject, 0.17f, 0.50f, Vector3.zero, darkMat, colliders);

            var chest = AddPart(root, "Chest", new Vector3(0f, ChestY, 0f), Quaternion.identity, 14f, fighter, bodies);
            AddCapsule(chest.gameObject, 0.23f, 0.62f, Vector3.zero, skinMat, colliders);

            var head = AddPart(root, "Head", new Vector3(0f, HeadY, 0f), Quaternion.identity, 4f, fighter, bodies);
            AddSphere(head.gameObject, 0.21f, Vector3.zero, skinMat, colliders);
            // Нашлёпка-нос: без неё невозможно понять, куда боец повёрнут.
            AddVisualOnly(head.transform, PrimitiveType.Cube, new Vector3(0f, 0.02f, 0.19f), Quaternion.identity,
                new Vector3(0.12f, 0.08f, 0.14f), darkMat);

            // --- рука-нога: единственная опора, на ней же прыжки ---
            var legUpper = AddPart(root, "LegArmUpper", new Vector3(0f, 0.72f, 0f), Quaternion.identity, 5f, fighter, bodies);
            AddCapsule(legUpper.gameObject, 0.115f, 0.44f, Vector3.zero, skinMat, colliders);

            var legFoot = AddPart(root, "LegArmFoot", new Vector3(0f, 0.34f, 0f), Quaternion.identity, 4f, fighter, bodies);
            AddCapsule(legFoot.gameObject, 0.12f, 0.42f, Vector3.zero, skinMat, colliders);
            // Кулак на месте стопы — от него боец и отталкивается.
            AddSphere(legFoot.gameObject, 0.17f, new Vector3(0f, -0.17f, 0f), darkMat, colliders);

            // --- рука-дубина: повёрнута так, что её длинная ось смотрит в +X ---
            var armRot = Quaternion.Euler(0f, 0f, -90f);
            var clubUpper = AddPart(root, "ClubArmUpper", new Vector3(0.55f, 1.55f, 0f), armRot, 4f, fighter, bodies);
            AddCapsule(clubUpper.gameObject, 0.10f, 0.62f, Vector3.zero, skinMat, colliders);

            var club = AddPart(root, "Club", new Vector3(1.32f, 1.50f, 0f), armRot, 8f, fighter, bodies);
            AddCapsule(club.gameObject, 0.09f, 0.82f, Vector3.zero, woodMat, colliders);
            AddSphere(club.gameObject, 0.26f, new Vector3(0f, 0.46f, 0f), metalMat, colliders);
            // Шипы на набалдашнике — чистая косметика, коллайдеров не добавляют.
            for (int i = 0; i < 4; i++)
            {
                var dir = Quaternion.Euler(0f, 90f * i, 0f) * Vector3.forward;
                AddVisualOnly(club.transform, PrimitiveType.Cube,
                    new Vector3(0f, 0.46f, 0f) + dir * 0.26f,
                    Quaternion.LookRotation(dir),
                    new Vector3(0.12f, 0.12f, 0.14f), metalMat);
            }

            // --- суставы ---
            // Порядок и якоря в мировых координатах; тела уже стоят в позе покоя.
            AddJoint(chest, hips, root.TransformPoint(new Vector3(0f, 1.21f, 0f)),
                -20f, 20f, 25f, 20f, 1200f, 90f, t, joints);

            AddJoint(head, chest, root.TransformPoint(new Vector3(0f, 1.74f, 0f)),
                -25f, 25f, 30f, 25f, 400f, 30f, t, joints);

            AddJoint(legUpper, hips, root.TransformPoint(new Vector3(0f, 0.90f, 0f)),
                -70f, 70f, 40f, 60f, 600f, 45f, t, joints);

            AddJoint(legFoot, legUpper, root.TransformPoint(new Vector3(0f, 0.52f, 0f)),
                -60f, 60f, 20f, 40f, 350f, 25f, t, joints);

            // Плечо и локоть намеренно слабые: дубину тащит ClubDriver напрямую за тело,
            // а суставы только не дают руке вывернуться и возвращают её в стойку.
            AddJoint(clubUpper, chest, root.TransformPoint(new Vector3(0.26f, 1.57f, 0f)),
                -95f, 95f, 85f, 95f, 300f, 22f, t, joints);

            AddJoint(club, clubUpper, root.TransformPoint(new Vector3(0.90f, 1.53f, 0f)),
                -100f, 100f, 90f, 100f, 200f, 16f, t, joints);

            // Тела одного бойца не должны толкать друг друга — иначе риг сам себя трясёт.
            // Соперников это не касается: столкновения между бойцами и есть игра.
            for (int i = 0; i < colliders.Count; i++)
            {
                for (int k = i + 1; k < colliders.Count; k++)
                {
                    Physics.IgnoreCollision(colliders[i], colliders[k], true);
                }
            }

            var bodyPhysMat = RB.NewPhysicsMaterial("TopKong_Body", 0.25f, 0.3f, 0.05f);
            foreach (var c in colliders) c.sharedMaterial = bodyPhysMat;

            var clubImpact = club.gameObject.AddComponent<ClubImpact>();

            // След только у игрока: по нему видно форму собственного замаха. У ботов
            // это превратилось бы в кашу из четырёх лент поверх арены.
            if (isPlayer && t.showClubTrail) AddClubTrail(club.transform, teamColor);

            var marker = BuildMarker(root, teamColor, isPlayer);

            fighter.Setup(new Fighter.Rig
            {
                Hips = hips,
                Chest = chest,
                Head = head,
                LegUpper = legUpper,
                LegFoot = legFoot,
                ClubUpper = clubUpper,
                Club = club,
                Bodies = bodies.ToArray(),
                Colliders = colliders.ToArray(),
                Joints = joints.ToArray(),
                Marker = marker,
                Impact = clubImpact
            }, t, arena, fx, teamColor, displayName, isPlayer);

            return fighter;
        }

        static Rigidbody AddPart(Transform root, string name, Vector3 localPos, Quaternion localRot,
            float mass, Fighter owner, List<Rigidbody> bodies)
        {
            var go = new GameObject(name);
            go.transform.SetParent(root, false);
            go.transform.localPosition = localPos;
            go.transform.localRotation = localRot;

            var rb = go.AddComponent<Rigidbody>();
            rb.mass = mass;
            rb.interpolation = RigidbodyInterpolation.Interpolate;
            // Дубина разгоняется до десятков метров в секунду — на дискретной проверке
            // она бы просто пролетала сквозь соперника между кадрами физики.
            rb.collisionDetectionMode = CollisionDetectionMode.ContinuousSpeculative;
            // Значение по умолчанию (7 рад/с) обрубило бы весь замах.
            rb.maxAngularVelocity = 30f;
            rb.solverIterations = 16;
            rb.solverVelocityIterations = 8;
            // Обмякшее тело не должно уснуть: разбудить его нечем, суставы не будят.
            rb.sleepThreshold = 0f;
            RB.SetDamping(rb, 0.02f, 0.05f);

            var part = go.AddComponent<BodyPart>();
            part.Owner = owner;
            part.IsClub = name == "Club";

            bodies.Add(rb);
            return rb;
        }

        static void AddCapsule(GameObject go, float radius, float height, Vector3 center,
            Material mat, List<Collider> colliders)
        {
            var col = go.AddComponent<CapsuleCollider>();
            col.radius = radius;
            col.height = height;
            col.center = center;
            col.direction = 1; // вдоль локальной оси Y
            colliders.Add(col);

            // Примитив Capsule имеет радиус 0.5 и полную высоту 2, отсюда пересчёт масштаба.
            AddVisualOnly(go.transform, PrimitiveType.Capsule, center, Quaternion.identity,
                new Vector3(radius * 2f, Mathf.Max(height * 0.5f, radius), radius * 2f), mat);
        }

        static void AddSphere(GameObject go, float radius, Vector3 center,
            Material mat, List<Collider> colliders)
        {
            var col = go.AddComponent<SphereCollider>();
            col.radius = radius;
            col.center = center;
            colliders.Add(col);

            AddVisualOnly(go.transform, PrimitiveType.Sphere, center, Quaternion.identity,
                Vector3.one * radius * 2f, mat);
        }

        static void AddVisualOnly(Transform parent, PrimitiveType type, Vector3 localPos,
            Quaternion localRot, Vector3 localScale, Material mat)
        {
            var go = GameObject.CreatePrimitive(type);
            go.name = "vis_" + type;
            var col = go.GetComponent<Collider>();
            if (col != null)
            {
                // Destroy отложен до конца кадра, а физика успела бы отработать с лишним
                // коллайдером. Выключаем сразу, удаляем когда получится.
                col.enabled = false;
                Object.Destroy(col);
            }
            go.transform.SetParent(parent, false);
            go.transform.localPosition = localPos;
            go.transform.localRotation = localRot;
            go.transform.localScale = localScale;
            go.GetComponent<MeshRenderer>().sharedMaterial = mat;
        }

        static void AddJoint(Rigidbody body, Rigidbody connectedTo, Vector3 worldAnchor,
            float xLow, float xHigh, float yLimit, float zLimit,
            float spring, float damper, GameTuning t, List<ConfigurableJoint> joints)
        {
            var j = body.gameObject.AddComponent<ConfigurableJoint>();

            // Порядок важен: пока autoConfigure включён, назначение connectedBody
            // перезаписывает connectedAnchor.
            j.autoConfigureConnectedAnchor = false;
            j.connectedBody = connectedTo;
            j.anchor = body.transform.InverseTransformPoint(worldAnchor);
            j.connectedAnchor = connectedTo.transform.InverseTransformPoint(worldAnchor);

            j.xMotion = ConfigurableJointMotion.Locked;
            j.yMotion = ConfigurableJointMotion.Locked;
            j.zMotion = ConfigurableJointMotion.Locked;

            j.angularXMotion = ConfigurableJointMotion.Limited;
            j.angularYMotion = ConfigurableJointMotion.Limited;
            j.angularZMotion = ConfigurableJointMotion.Limited;
            j.lowAngularXLimit = new SoftJointLimit { limit = xLow };
            j.highAngularXLimit = new SoftJointLimit { limit = xHigh };
            j.angularYLimit = new SoftJointLimit { limit = yLimit };
            j.angularZLimit = new SoftJointLimit { limit = zLimit };

            j.rotationDriveMode = RotationDriveMode.Slerp;
            j.slerpDrive = new JointDrive
            {
                positionSpring = spring * t.driveSpringMul,
                positionDamper = damper * t.driveDamperMul,
                maximumForce = float.MaxValue
            };
            j.targetRotation = Quaternion.identity;

            j.enablePreprocessing = false;
            j.projectionMode = JointProjectionMode.PositionAndRotation;
            j.projectionDistance = 0.08f;
            j.projectionAngle = 25f;
            j.enableCollision = false;

            joints.Add(j);
        }

        /// <summary>
        /// Лента за набалдашником дубины. Главный инструмент отладки ощущений: словами
        /// «мах какой-то не такой» описать трудно, а на форме следа сразу видно, идёт ли
        /// дубина широкой дугой или её дёргает по прямой.
        /// </summary>
        static void AddClubTrail(Transform club, Color color)
        {
            var go = new GameObject("ClubTrail");
            go.transform.SetParent(club, false);
            // На конце дубины, а не в центре тела: рисовать надо путь ударной части.
            go.transform.localPosition = new Vector3(0f, 0.46f, 0f);

            var trail = go.AddComponent<TrailRenderer>();
            trail.time = 0.35f;
            trail.widthMultiplier = 0.22f;
            trail.numCapVertices = 2;
            trail.minVertexDistance = 0.03f;
            trail.sharedMaterial = MaterialFactory.Unlit(color);
            trail.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            trail.receiveShadows = false;

            var curve = new AnimationCurve();
            curve.AddKey(0f, 1f);
            curve.AddKey(1f, 0f);
            trail.widthCurve = curve;
        }

        /// <summary>Круг под ногами. Единственный способ в свалке понять, кто из них ты.</summary>
        static LineRenderer BuildMarker(Transform root, Color color, bool isPlayer)
        {
            var go = new GameObject("Marker");
            // Ребёнок корня бойца (тот стоит на месте, физика двигает только тела),
            // а не таза: маркер должен лежать на арене, а не крутиться вместе с телом.
            // Позицию каждый кадр выставляет Fighter.LateUpdate.
            go.transform.SetParent(root, false);

            var line = go.AddComponent<LineRenderer>();
            line.useWorldSpace = false;
            line.loop = true;
            line.widthMultiplier = isPlayer ? 0.09f : 0.055f;
            var pts = MeshUtils.CirclePoints(isPlayer ? 0.55f : 0.45f, 0f, 32);
            line.positionCount = pts.Length;
            line.SetPositions(pts);
            line.sharedMaterial = MaterialFactory.Unlit(isPlayer ? Color.white : color);
            line.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            line.receiveShadows = false;
            return line;
        }
    }
}
