using UnityEngine;

namespace TopKong
{
    /// <summary>
    /// Звук без единого аудиофайла: все клипы синтезируются кодом при старте.
    /// Проект из-за этого остаётся чистым набором скриптов, без бинарных ассетов.
    /// </summary>
    public class Sfx : MonoBehaviour
    {
        const int SampleRate = 44100;
        const int VoiceCount = 8;

        AudioSource[] _voices;
        int _next;

        AudioClip _hit;
        AudioClip _hop;
        AudioClip _fall;
        AudioClip _win;
        AudioClip _lose;

        GameTuning _tuning;

        public void Init(GameTuning tuning)
        {
            _tuning = tuning;

            _voices = new AudioSource[VoiceCount];
            for (int i = 0; i < VoiceCount; i++)
            {
                var src = gameObject.AddComponent<AudioSource>();
                src.playOnAwake = false;
                src.spatialBlend = 0f;   // арена целиком в кадре, панорама только мешала бы
                _voices[i] = src;
            }

            _hit = BuildHit();
            _hop = BuildHop();
            _fall = BuildFall();
            _win = BuildChord(new[] { 392f, 523f, 659f }, 0.7f);
            _lose = BuildChord(new[] { 220f, 175f, 131f }, 0.8f);
        }

        void Play(AudioClip clip, float volume, float pitch)
        {
            if (clip == null || _voices == null) return;
            var src = _voices[_next];
            _next = (_next + 1) % VoiceCount;
            src.pitch = pitch;
            src.volume = Mathf.Clamp01(volume) * (_tuning != null ? _tuning.volume : 0.6f);
            src.PlayOneShot(clip);
        }

        /// <param name="strength">0..1 — насколько сильным был удар</param>
        public void PlayHit(float strength)
        {
            Play(_hit, Mathf.Lerp(0.35f, 1f, strength), Mathf.Lerp(1.35f, 0.72f, strength) + Random.Range(-0.05f, 0.05f));
        }

        public void PlayHop()
        {
            Play(_hop, 0.28f, Random.Range(0.9f, 1.15f));
        }

        public void PlayFall()
        {
            Play(_fall, 0.7f, Random.Range(0.95f, 1.05f));
        }

        public void PlayWin() => Play(_win, 0.8f, 1f);

        public void PlayLose() => Play(_lose, 0.8f, 1f);

        // --- синтез ---

        static AudioClip Build(string name, float seconds, System.Func<float, float> fn)
        {
            int samples = Mathf.Max(1, Mathf.RoundToInt(seconds * SampleRate));
            var clip = AudioClip.Create(name, samples, 1, SampleRate, false);
            var data = new float[samples];
            for (int i = 0; i < samples; i++)
            {
                data[i] = Mathf.Clamp(fn(i / (float)SampleRate), -1f, 1f);
            }
            clip.SetData(data, 0);
            return clip;
        }

        /// <summary>Глухой деревянный "тук": низкий тон плюс щелчок шума в атаке.</summary>
        static AudioClip BuildHit()
        {
            var rnd = new System.Random(1337);
            return Build("tk_hit", 0.30f, t =>
            {
                float env = Mathf.Exp(-t * 26f);
                float click = Mathf.Exp(-t * 190f) * (float)(rnd.NextDouble() * 2.0 - 1.0);
                float body = Mathf.Sin(2f * Mathf.PI * 132f * t) * 0.7f
                           + Mathf.Sin(2f * Mathf.PI * 78f * t) * 0.5f;
                return (body * env + click * 0.55f) * 0.85f;
            });
        }

        /// <summary>Короткий мягкий толчок под каждый микро-прыжок.</summary>
        static AudioClip BuildHop()
        {
            return Build("tk_hop", 0.14f, t =>
            {
                float env = Mathf.Exp(-t * 42f);
                float f = Mathf.Lerp(210f, 90f, Mathf.Clamp01(t * 12f));
                return Mathf.Sin(2f * Mathf.PI * f * t) * env * 0.8f;
            });
        }

        /// <summary>Уходящий вниз свист — кто-то улетел с арены.</summary>
        static AudioClip BuildFall()
        {
            return Build("tk_fall", 0.75f, t =>
            {
                float env = Mathf.Min(1f, t * 14f) * Mathf.Exp(-t * 3.2f);
                float f = Mathf.Lerp(680f, 120f, Mathf.Clamp01(t / 0.75f));
                return Mathf.Sin(2f * Mathf.PI * f * t) * env * 0.6f;
            });
        }

        static AudioClip BuildChord(float[] freqs, float seconds)
        {
            return Build("tk_chord", seconds, t =>
            {
                float sum = 0f;
                for (int i = 0; i < freqs.Length; i++)
                {
                    // ноты вступают по очереди, получается короткий арпеджио
                    float start = i * 0.11f;
                    if (t < start) continue;
                    float lt = t - start;
                    sum += Mathf.Sin(2f * Mathf.PI * freqs[i] * lt) * Mathf.Exp(-lt * 3.5f);
                }
                return sum / Mathf.Max(1, freqs.Length) * 0.9f;
            });
        }
    }
}
