using System.Collections.Generic;
using UnityEngine;

namespace TopKong
{
    /// <summary>
    /// Собирает бойца целиком из примитивов: десять физических тел на ConfigurableJoint.
    /// Обычное человеческое тело — две ноги, две руки, — и дубина, которую руки держат вдвоём.
    ///
    /// Три решения, на которых держится вся стабильность рига:
    ///
    /// 1. Физические объекты имеют scale = 1, а всё масштабирование живёт на дочерних
    ///    объектах-картинках. Якоря суставов задаются через InverseTransformPoint, и на
    ///    отмасштабированном трансформе они разъезжаются самым неочевидным образом.
    ///    Коллайдеры поэтому настраиваются числами (radius/height), а не scale.
    ///
    /// 2. Риг собирается сразу в стойке, и только потом навешиваются суставы.
    ///    ConfigurableJoint запоминает текущий взаимный поворот как ноль, поэтому
    ///    targetRotation = identity означает "вернись в позу, в которой тебя собрали".
    ///    Стойку не нужно описывать отдельно — она и есть поза сборки.
    ///
    /// 3. Двуручный хват — замкнутая петля: грудь → правая рука → дубина → левая рука
    ///    → грудь. PhysX решает петли хуже, чем деревья, и они склонны дрожать. Поэтому
    ///    цепь несимметричная: правая рука держит дубину обычным суставом, а левая
    ///    присоединяется к ней замыкающим — мягким, с широкими пределами и без проекции.
    ///    Проекция на замыкающем суставе тянет одеяло на себя и вызывает ровно то дрожание,
    ///    от которого мы уходим.
    /// </summary>
    public static class FighterBuilder
    {
        // Все координаты — локальные, от точки спавна на поверхности арены.
        // Рост около 2.0: стопы на нуле, макушка на 2.02.
        const float HipsY = 0.95f;
        const float ChestY = 1.40f;
        const float HeadY = 1.82f;
        const float HipHalfWidth = 0.13f;
        const float ShoulderHalfWidth = 0.28f;
        const float ShoulderY = 1.58f;

        // Дубина в стойке: перед грудью, горизонтально, набалдашником вправо.
        static readonly Vector3 ClubCenter = new Vector3(0.28f, 1.35f, 0.35f);
        static readonly Vector3 GripRight = new Vector3(0.05f, 1.35f, 0.35f);
        static readonly Vector3 GripLeft = new Vector3(-0.12f, 1.35f, 0.35f);
        // Смещение набалдашника в локальных осях дубины (её локальная Y смотрит в +X мира).
        static readonly Vector3 ClubHeadLocal = new Vector3(0f, 0.40f, 0f);

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
            var hips = AddPart(root, "Hips", new Vector3(0f, HipsY, 0f), Quaternion.identity, 11f, fighter, bodies);
            AddCapsule(hips.gameObject, 0.19f, 0.46f, Vector3.zero, darkMat, colliders);

            var chest = AddPart(root, "Chest", new Vector3(0f, ChestY, 0f), Quaternion.identity, 15f, fighter, bodies);
            AddCapsule(chest.gameObject, 0.24f, 0.60f, Vector3.zero, skinMat, colliders);

            var head = AddPart(root, "Head", new Vector3(0f, HeadY, 0f), Quaternion.identity, 4f, fighter, bodies);
            AddSphere(head.gameObject, 0.20f, Vector3.zero, skinMat, colliders);
            // Нашлёпка-нос: без неё невозможно понять, куда боец повёрнут.
            AddVisualOnly(head.transform, PrimitiveType.Cube, new Vector3(0f, 0.02f, 0.18f), Quaternion.identity,
                new Vector3(0.12f, 0.08f, 0.14f), darkMat);

            // --- ноги ---
            var legL = BuildLeg(root, -HipHalfWidth, "L", skinMat, darkMat, fighter, bodies, colliders);
            var legR = BuildLeg(root, HipHalfWidth, "R", skinMat, darkMat, fighter, bodies, colliders);

            // --- дубина: длинная ось смотрит в +X ---
            var club = AddPart(root, "Club", ClubCenter, Quaternion.Euler(0f, 0f, -90f), 9f, fighter, bodies);
            AddCapsule(club.gameObject, 0.075f, 0.90f, Vector3.zero, woodMat, colliders);
            AddSphere(club.gameObject, 0.24f, ClubHeadLocal, metalMat, colliders);
            for (int i = 0; i < 4; i++)
            {
                var dir = Quaternion.Euler(0f, 90f * i, 0f) * Vector3.forward;
                AddVisualOnly(club.transform, PrimitiveType.Cube,
                    ClubHeadLocal + dir * 0.24f,
                    Quaternion.LookRotation(dir),
                    new Vector3(0.11f, 0.11f, 0.13f), metalMat);
            }

            // --- руки: обе идут от плеча к рукояти ---
            var armR = AddLimb(root, "ArmR", new Vector3(ShoulderHalfWidth, ShoulderY, 0f), GripRight,
                0.085f, 3f, skinMat, fighter, bodies, colliders);
            var armL = AddLimb(root, "ArmL", new Vector3(-ShoulderHalfWidth, ShoulderY, 0f), GripLeft,
                0.085f, 3f, skinMat, fighter, bodies, colliders);

            // --- суставы ---
            AddJoint(chest, hips, root.TransformPoint(new Vector3(0f, 1.14f, 0f)),
                -20f, 20f, 25f, 20f, 1400f, 100f, t, joints);

            AddJoint(head, chest, root.TransformPoint(new Vector3(0f, 1.66f, 0f)),
                -25f, 25f, 30f, 25f, 450f, 32f, t, joints);

            AttachLeg(root, legL, hips, -HipHalfWidth, t, joints);
            AttachLeg(root, legR, hips, HipHalfWidth, t, joints);

            // Дальше идут только суставы рук и дубины. Запоминаем границу: на время
            // замаха их приводы ослабляются отдельно от остального тела.
            int armJointStart = joints.Count;

            // Руки держат дубину жёстко: стойка должна быть стойкой, а не висящей плетью.
            AddJoint(armR, chest, root.TransformPoint(new Vector3(ShoulderHalfWidth, ShoulderY, 0f)),
                -80f, 80f, 70f, 80f, t.armDriveSpring, t.armDriveSpring * 0.07f, t, joints);

            AddJoint(club, armR, root.TransformPoint(GripRight),
                -70f, 70f, 60f, 70f, t.armDriveSpring * 0.8f, t.armDriveSpring * 0.06f, t, joints);

            AddJoint(armL, chest, root.TransformPoint(new Vector3(-ShoulderHalfWidth, ShoulderY, 0f)),
                -80f, 80f, 70f, 80f, t.armDriveSpring * 0.6f, t.armDriveSpring * 0.05f, t, joints);

            // Замыкание петли. Мягко, широко и без проекции — иначе плечи затрясёт.
            AddJoint(armL, club, root.TransformPoint(GripLeft),
                -90f, 90f, 85f, 90f, t.armDriveSpring * 0.25f, t.armDriveSpring * 0.03f, t, joints,
                projection: false);

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

            var armJoints = new bool[joints.Count];
            for (int i = armJointStart; i < joints.Count; i++) armJoints[i] = true;

            fighter.Setup(new Fighter.Rig
            {
                Hips = hips,
                Chest = chest,
                Head = head,
                LegLUpper = legL.Upper,
                LegLFoot = legL.Foot,
                LegRUpper = legR.Upper,
                LegRFoot = legR.Foot,
                ArmR = armR,
                ArmL = armL,
                Club = club,
                Bodies = bodies.ToArray(),
                Colliders = colliders.ToArray(),
                Joints = joints.ToArray(),
                ArmJoints = armJoints,
                Marker = marker,
                Impact = clubImpact
            }, t, arena, fx, teamColor, displayName, isPlayer);

            return fighter;
        }

        struct Leg
        {
            public Rigidbody Upper;
            public Rigidbody Foot;
        }

        static Leg BuildLeg(Transform root, float x, string suffix, Material skin, Material dark,
            Fighter owner, List<Rigidbody> bodies, List<Collider> colliders)
        {
            var upper = AddPart(root, "Leg" + suffix + "Upper", new Vector3(x, 0.68f, 0f),
                Quaternion.identity, 5f, owner, bodies);
            AddCapsule(upper.gameObject, 0.11f, 0.44f, Vector3.zero, skin, colliders);

            var foot = AddPart(root, "Leg" + suffix + "Foot", new Vector3(x, 0.28f, 0f),
                Quaternion.identity, 4f, owner, bodies);
            AddCapsule(foot.gameObject, 0.10f, 0.40f, Vector3.zero, skin, colliders);
            AddBox(foot.gameObject, new Vector3(0.18f, 0.10f, 0.28f), new Vector3(0f, -0.23f, 0.05f),
                dark, colliders);

            return new Leg { Upper = upper, Foot = foot };
        }

        static void AttachLeg(Transform root, Leg leg, Rigidbody hips, float x,
            GameTuning t, List<ConfigurableJoint> joints)
        {
            AddJoint(leg.Upper, hips, root.TransformPoint(new Vector3(x, 0.88f, 0f)),
                -65f, 65f, 35f, 45f, 700f, 50f, t, joints);

            AddJoint(leg.Foot, leg.Upper, root.TransformPoint(new Vector3(x, 0.48f, 0f)),
                -60f, 60f, 15f, 25f, 450f, 32f, t, joints);
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

        /// <summary>Конечность между двумя точками: сама считает длину, центр и поворот.</summary>
        static Rigidbody AddLimb(Transform root, string name, Vector3 from, Vector3 to,
            float radius, float mass, Material mat, Fighter owner,
            List<Rigidbody> bodies, List<Collider> colliders)
        {
            Vector3 delta = to - from;
            float length = delta.magnitude;
            Quaternion rot = length > 0.0001f
                ? Quaternion.FromToRotation(Vector3.up, delta / length)
                : Quaternion.identity;

            var rb = AddPart(root, name, (from + to) * 0.5f, rot, mass, owner, bodies);
            AddCapsule(rb.gameObject, radius, Mathf.Max(length, radius * 2f), Vector3.zero, mat, colliders);
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

        static void AddBox(GameObject go, Vector3 size, Vector3 center,
            Material mat, List<Collider> colliders)
        {
            var col = go.AddComponent<BoxCollider>();
            col.size = size;
            col.center = center;
            colliders.Add(col);

            AddVisualOnly(go.transform, PrimitiveType.Cube, center, Quaternion.identity, size, mat);
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
            float spring, float damper, GameTuning t, List<ConfigurableJoint> joints,
            bool projection = true)
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
            j.projectionMode = projection
                ? JointProjectionMode.PositionAndRotation
                : JointProjectionMode.None;
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
            go.transform.localPosition = ClubHeadLocal;

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
