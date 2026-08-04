using UnityEngine;

namespace TopKong
{
    public static class MeshUtils
    {
        /// <summary>
        /// Диск (цилиндр) заданного радиуса и толщины, центр в начале координат.
        ///
        /// Встроенный примитив Cylinder тоже подошёл бы, но у него всего 20 граней —
        /// на арене радиусом 7.5 край выглядит откровенно многоугольным, а он тут
        /// главный элемент: по нему игрок читает, где обрыв. Плюс своя сетка идёт
        /// и в MeshCollider, то есть коллизия совпадает с картинкой один в один.
        ///
        /// Боковые вершины дублируются, чтобы нормали граней были резкими,
        /// а не сглаженными по кругу.
        /// </summary>
        public static Mesh CreateDisc(float radius, float thickness, int segments = 72)
        {
            segments = Mathf.Max(8, segments);
            float h = thickness * 0.5f;

            var mesh = new Mesh { name = "TopKong_Disc" };

            int capVerts = (segments + 1) * 2;  // центр + кольцо, для верха и низа
            int sideVerts = segments * 4;
            var verts = new Vector3[capVerts + sideVerts];
            var normals = new Vector3[verts.Length];
            var uvs = new Vector2[verts.Length];

            // --- крышки ---
            int topCenter = 0;
            int bottomCenter = segments + 1;
            verts[topCenter] = new Vector3(0f, h, 0f);
            normals[topCenter] = Vector3.up;
            uvs[topCenter] = new Vector2(0.5f, 0.5f);
            verts[bottomCenter] = new Vector3(0f, -h, 0f);
            normals[bottomCenter] = Vector3.down;
            uvs[bottomCenter] = new Vector2(0.5f, 0.5f);

            for (int i = 0; i < segments; i++)
            {
                float a = i / (float)segments * Mathf.PI * 2f;
                float cx = Mathf.Cos(a);
                float cz = Mathf.Sin(a);
                var uv = new Vector2(cx * 0.5f + 0.5f, cz * 0.5f + 0.5f);

                verts[topCenter + 1 + i] = new Vector3(cx * radius, h, cz * radius);
                normals[topCenter + 1 + i] = Vector3.up;
                uvs[topCenter + 1 + i] = uv;

                verts[bottomCenter + 1 + i] = new Vector3(cx * radius, -h, cz * radius);
                normals[bottomCenter + 1 + i] = Vector3.down;
                uvs[bottomCenter + 1 + i] = uv;
            }

            // --- бок ---
            int sideStart = capVerts;
            for (int i = 0; i < segments; i++)
            {
                float a0 = i / (float)segments * Mathf.PI * 2f;
                float a1 = (i + 1) / (float)segments * Mathf.PI * 2f;
                Vector3 p0 = new Vector3(Mathf.Cos(a0) * radius, 0f, Mathf.Sin(a0) * radius);
                Vector3 p1 = new Vector3(Mathf.Cos(a1) * radius, 0f, Mathf.Sin(a1) * radius);
                Vector3 n = ((p0 + p1) * 0.5f).normalized;

                int b = sideStart + i * 4;
                verts[b + 0] = new Vector3(p0.x, h, p0.z);
                verts[b + 1] = new Vector3(p1.x, h, p1.z);
                verts[b + 2] = new Vector3(p0.x, -h, p0.z);
                verts[b + 3] = new Vector3(p1.x, -h, p1.z);
                for (int k = 0; k < 4; k++) normals[b + k] = n;

                float u0 = i / (float)segments;
                float u1 = (i + 1) / (float)segments;
                uvs[b + 0] = new Vector2(u0, 1f);
                uvs[b + 1] = new Vector2(u1, 1f);
                uvs[b + 2] = new Vector2(u0, 0f);
                uvs[b + 3] = new Vector2(u1, 0f);
            }

            var tris = new int[segments * 3 * 2 + segments * 6];
            int t = 0;
            for (int i = 0; i < segments; i++)
            {
                int next = (i + 1) % segments;

                // верх — против часовой при взгляде сверху
                tris[t++] = topCenter;
                tris[t++] = topCenter + 1 + next;
                tris[t++] = topCenter + 1 + i;

                // низ
                tris[t++] = bottomCenter;
                tris[t++] = bottomCenter + 1 + i;
                tris[t++] = bottomCenter + 1 + next;
            }
            for (int i = 0; i < segments; i++)
            {
                int b = sideStart + i * 4;
                tris[t++] = b + 0;
                tris[t++] = b + 1;
                tris[t++] = b + 2;

                tris[t++] = b + 2;
                tris[t++] = b + 1;
                tris[t++] = b + 3;
            }

            mesh.vertices = verts;
            mesh.normals = normals;
            mesh.uv = uvs;
            mesh.triangles = tris;
            mesh.RecalculateBounds();
            return mesh;
        }

        /// <summary>Точки окружности для LineRenderer, которым рисуется кромка арены.</summary>
        public static Vector3[] CirclePoints(float radius, float y, int segments = 96)
        {
            var pts = new Vector3[segments];
            for (int i = 0; i < segments; i++)
            {
                float a = i / (float)segments * Mathf.PI * 2f;
                pts[i] = new Vector3(Mathf.Cos(a) * radius, y, Mathf.Sin(a) * radius);
            }
            return pts;
        }
    }
}
