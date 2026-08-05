using System.Collections.Generic;
using UnityEngine;

namespace TopKong
{
    /// <summary>
    /// Собирает бойца: капсулу-персонаж на корне и ragdoll из десяти тел под ней.
    ///
    /// Работают они по очереди, а не вместе. Пока боец под управлением, движется
    /// капсула, а тела ragdoll'а кинематические — их позу каждый кадр считает
    /// PoseDriver, и коллайдеры у них выключены, чтобы тело было представлено ровно
    /// одним объёмом. Прилетел удар — капсула отключается, тела становятся
    /// динамическими и продолжают с той же позы уже настоящей физикой.
    ///
    /// Так управление перестаёт бороться с физикой, а весь ragdoll остаётся там,
    /// ради чего он и нужен — в полёте с арены.
    ///
    /// Коллайдер дубины — единственный, который включён всегда: им бьют и в
    /// управляемом состоянии тоже.
    ///
    /// Два решения про сам риг:
    ///
    /// 1. Физические объекты имеют scale = 1, всё масштабирование живёт на дочерних
    ///    объектах-картинках. Якоря суставов задаются через InverseTransformPoint,
    ///    и на отмасштабированном трансформе они разъезжаются самым неочевидным образом.
    ///
    /// 2. Двуручный хват — замкнутая петля: грудь → правая рука → дубина → левая рука
    ///    → грудь. PhysX решает петли хуже деревьев и склонен на них дрожать, поэтому
    ///    цепь несимметричная: правая рука держит дубину обычным суставом, левая
    ///    присоединена замыкающим — мягким и без проекции.
    /// </summary>
    public static class FighterBuilder
    {
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

            // --- капсула-персонаж: она движется, она же падает с арены ---
            var rootBody = rootGo.AddComponent<Rigidbody>();
            rootBody.mass = 60f;
            rootBody.constraints = RigidbodyConstraints.FreezeRotation;
            rootBody.interpolation = RigidbodyInterpolation.Interpolate;
            rootBody.collisionDetectionMode = CollisionDetectionMode.ContinuousSpeculative;
            RB.SetDamping(rootBody, 0f, 0.05f);

            var rootCollider = rootGo.AddComponent<CapsuleCollider>();
            rootCollider.radius = 0.32f;
            rootCollider.height = 1.85f;
            rootCollider.center = new Vector3(0f, 0.95f, 0f);
            rootCollider.direction = 1;

            var rootPart = rootGo.AddComponent<BodyPart>();
            rootPart.Owner = fighter;

            var bodies = new List<Rigidbody>();
            var colliders = new List<Collider>();
            var joints = new List<ConfigurableJoint>();

            var skinMat = MaterialFactory.Lit(teamColor, 0.18f);
            var darkMat = MaterialFactory.Lit(Color.Lerp(teamColor, Color.black, 0.55f), 0.12f);
            var woodMat = MaterialFactory.Lit(new Color(0.36f, 0.24f, 0.14f), 0.10f);
            var metalMat = MaterialFactory.Lit(new Color(0.62f, 0.63f, 0.68f), 0.65f, 0.85f);

            var root = rootGo.transform;
            var rest = FighterRig.RestPose();

            // --- корпус ---
            var hips = AddPart(root, "Hips", rest.Hips, Quaternion.identity, 11f, fighter, bodies);
            AddCapsule(hips.gameObject, 0.19f, 0.46f, darkMat, colliders);

            var chest = AddPart(root, "Chest", rest.Chest, Quaternion.identity, 15f, fighter, bodies);
            AddCapsule(chest.gameObject, 0.24f, 0.60f, skinMat, colliders);

            var head = AddPart(root, "Head", rest.Head, Quaternion.identity, 4f, fighter, bodies);
            AddSphere(head.gameObject, 0.20f, Vector3.zero, skinMat, colliders);
            AddVisualOnly(head.transform, PrimitiveType.Cube, new Vector3(0f, 0.02f, 0.18f),
                Quaternion.identity, new Vector3(0.12f, 0.08f, 0.14f), darkMat);

            // --- ноги ---
            var legL = BuildLeg(root, false, rest.FootLeft, skinMat, darkMat, fighter, bodies, colliders);
            var legR = BuildLeg(root, true, rest.FootRight, skinMat, darkMat, fighter, bodies, colliders);

            // --- дубина ---
            var club = AddPart(root, "Club", rest.Club, rest.ClubRotation, 9f, fighter, bodies);
            var clubCollider = AddCapsule(club.gameObject, 0.075f, 0.90f, woodMat, colliders);
            AddSphere(club.gameObject, 0.24f, FighterRig.ClubHeadLocal, metalMat, colliders);
            for (int i = 0; i < 4; i++)
            {
                var dir = Quaternion.Euler(0f, 90f * i, 0f) * Vector3.forward;
                AddVisualOnly(club.transform, PrimitiveType.Cube,
                    FighterRig.ClubHeadLocal + dir * 0.24f, Quaternion.LookRotation(dir),
                    new Vector3(0.11f, 0.11f, 0.13f), metalMat);
            }

            // --- руки от плеча к рукояти ---
            var armR = AddLimb(root, "ArmR", FighterRig.Shoulder(true), rest.HandRight,
                FighterRig.ArmRadius, 3f, skinMat, fighter, bodies, colliders);
            var armL = AddLimb(root, "ArmL", FighterRig.Shoulder(false), rest.HandLeft,
                FighterRig.ArmRadius, 3f, skinMat, fighter, bodies, colliders);

            // --- суставы: работают только когда тело стало ragdoll'ом ---
            AddJoint(chest, hips, root.TransformPoint(new Vector3(0f, 1.14f, 0f)),
                -25f, 25f, 30f, 25f, 900f, 60f, t, joints);
            AddJoint(head, chest, root.TransformPoint(new Vector3(0f, 1.66f, 0f)),
                -30f, 30f, 35f, 30f, 300f, 22f, t, joints);

            AttachLeg(root, legL, hips, false, t, joints);
            AttachLeg(root, legR, hips, true, t, joints);

            AddJoint(armR, chest, root.TransformPoint(FighterRig.Shoulder(true)),
                -80f, 80f, 70f, 80f, 260f, 20f, t, joints);
            AddJoint(club, armR, root.TransformPoint(rest.HandRight),
                -70f, 70f, 60f, 70f, 220f, 18f, t, joints);
            AddJoint(armL, chest, root.TransformPoint(FighterRig.Shoulder(false)),
                -80f, 80f, 70f, 80f, 200f, 16f, t, joints);
            // Замыкание петли: мягко, широко и без проекции — иначе плечи затрясёт.
            AddJoint(armL, club, root.TransformPoint(rest.HandLeft),
                -90f, 90f, 85f, 90f, 90f, 8f, t, joints, projection: false);

            // Тела одного бойца не толкают друг друга, и капсула-персонаж не толкает их.
            var all = new List<Collider>(colliders) { rootCollider };
            for (int i = 0; i < all.Count; i++)
            {
                for (int k = i + 1; k < all.Count; k++)
                {
                    Physics.IgnoreCollision(all[i], all[k], true);
                }
            }

            var bodyPhysMat = RB.NewPhysicsMaterial("TopKong_Body", 0.25f, 0.3f, 0.05f);
            foreach (var c in colliders) c.sharedMaterial = bodyPhysMat;
            rootCollider.sharedMaterial = bodyPhysMat;

            var clubImpact = club.gameObject.AddComponent<ClubImpact>();

            if (isPlayer && t.showClubTrail) AddClubTrail(club.transform, teamColor);

            var marker = BuildMarker(root, teamColor, isPlayer);

            fighter.Setup(new Fighter.Rig
            {
                RootBody = rootBody,
                RootCollider = rootCollider,
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
                ClubCollider = clubCollider,
                Bodies = bodies.ToArray(),
                Colliders = colliders.ToArray(),
                Joints = joints.ToArray(),
                Marker = marker,
                Impact = clubImpact
            }, t, arena, fx, teamColor, displayName, isPlayer);

            return fighter;
        }

        public struct Leg
        {
            public Rigidbody Upper;
            public Rigidbody Foot;
        }

        static Leg BuildLeg(Transform root, bool right, Vector3 footPos, Material skin, Material dark,
            Fighter owner, List<Rigidbody> bodies, List<Collider> colliders)
        {
            string suffix = right ? "R" : "L";
            Vector3 hipJoint = FighterRig.HipJoint(right);
            Vector3 knee = new Vector3(hipJoint.x, FighterRig.KneeY, footPos.z * 0.4f);

            var upper = AddLimb(root, "Leg" + suffix + "Upper", hipJoint, knee,
                FighterRig.LegRadius, 5f, skin, owner, bodies, colliders);

            var foot = AddLimb(root, "Leg" + suffix + "Foot", knee, footPos,
                FighterRig.FootRadius, 4f, skin, owner, bodies, colliders);
            AddBox(foot.gameObject, new Vector3(0.18f, 0.10f, 0.28f),
                new Vector3(0f, -0.16f, 0.04f), dark, colliders);

            return new Leg { Upper = upper, Foot = foot };
        }

        static void AttachLeg(Transform root, Leg leg, Rigidbody hips, bool right,
            GameTuning t, List<ConfigurableJoint> joints)
        {
            AddJoint(leg.Upper, hips, root.TransformPoint(FighterRig.HipJoint(right)),
                -65f, 65f, 35f, 45f, 400f, 30f, t, joints);
            AddJoint(leg.Foot, leg.Upper, root.TransformPoint(
                    new Vector3(FighterRig.HipJoint(right).x, FighterRig.KneeY, 0f)),
                -60f, 60f, 15f, 25f, 260f, 20f, t, joints);
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
            // Стартуем кинематическими: боец рождается под управлением, а не тряпкой.
            rb.isKinematic = true;
            rb.interpolation = RigidbodyInterpolation.Interpolate;
            rb.collisionDetectionMode = CollisionDetectionMode.ContinuousSpeculative;
            rb.maxAngularVelocity = 30f;
            rb.solverIterations = 12;
            rb.sleepThreshold = 0f;
            RB.SetDamping(rb, 0.02f, 0.05f);

            var part = go.AddComponent<BodyPart>();
            part.Owner = owner;
            part.IsClub = name == "Club";

            bodies.Add(rb);
            return rb;
        }

        static Rigidbody AddLimb(Transform root, string name, Vector3 from, Vector3 to,
            float radius, float mass, Material mat, Fighter owner,
            List<Rigidbody> bodies, List<Collider> colliders)
        {
            FighterRig.Limb(from, to, out Vector3 center, out Quaternion rotation);
            var rb = AddPart(root, name, center, rotation, mass, owner, bodies);
            AddCapsule(rb.gameObject, radius,
                Mathf.Max(FighterRig.LimbLength(from, to), radius * 2f), mat, colliders);
            return rb;
        }

        static CapsuleCollider AddCapsule(GameObject go, float radius, float height,
            Material mat, List<Collider> colliders)
        {
            var col = go.AddComponent<CapsuleCollider>();
            col.radius = radius;
            col.height = height;
            col.direction = 1;
            colliders.Add(col);

            // Примитив Capsule имеет радиус 0.5 и полную высоту 2, отсюда пересчёт масштаба.
            AddVisualOnly(go.transform, PrimitiveType.Capsule, Vector3.zero, Quaternion.identity,
                new Vector3(radius * 2f, Mathf.Max(height * 0.5f, radius), radius * 2f), mat);
            return col;
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

        /// <summary>Лента за набалдашником: по её форме видно, какой получилась дуга удара.</summary>
        static void AddClubTrail(Transform club, Color color)
        {
            var go = new GameObject("ClubTrail");
            go.transform.SetParent(club, false);
            go.transform.localPosition = FighterRig.ClubHeadLocal;

            var trail = go.AddComponent<TrailRenderer>();
            trail.time = 0.3f;
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
