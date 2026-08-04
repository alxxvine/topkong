using System;
using UnityEngine;

namespace TopKong
{
    /// <summary>
    /// Всё, что удар должен дёрнуть за пределами физики: звук, тряска, хит-стоп.
    /// Собрано в один объект, чтобы ClubImpact не искал по сцене менеджеров.
    /// </summary>
    public class GameFx
    {
        public ArenaCamera Camera;
        public Sfx Sound;
        /// <summary>Замедление времени на долю секунды. Аргумент — сила удара 0..1.</summary>
        public Action<float> HitStop;

        public void Hit(Vector3 point, float strength01)
        {
            if (Sound != null) Sound.PlayHit(strength01);
            if (Camera != null) Camera.AddShake(strength01 * 0.55f);
            HitStop?.Invoke(strength01);
        }
    }
}
