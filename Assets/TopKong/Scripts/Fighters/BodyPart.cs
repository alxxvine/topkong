using UnityEngine;

namespace TopKong
{
    /// <summary>
    /// Метка на каждом физическом теле бойца. По ней при столкновении за один
    /// GetComponent находится владелец — без GetComponentInParent и без слоёв,
    /// которых у нас нет (слои живут в ProjectSettings, а мы их не коммитим).
    /// </summary>
    public class BodyPart : MonoBehaviour
    {
        public Fighter Owner;
        public bool IsClub;
    }
}
