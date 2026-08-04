using System;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;
using UnityEditor;
using UnityEngine;
using Debug = UnityEngine.Debug;

namespace TopKong.EditorTools
{
    /// <summary>
    /// Сам подтягивает новые коммиты в открытый редактор: раз в минуту и при возврате
    /// в окно Unity. После успешного pull дёргает AssetDatabase.Refresh, Unity
    /// перекомпилирует скрипты, и правки оказываются в игре без единого действия.
    ///
    /// Скрипт трогает рабочую копию, поэтому предохранители тут важнее самой функции:
    ///
    /// - только `pull --ff-only` — никаких автоматических merge-коммитов и уж точно
    ///   никаких push. Если история разошлась, git просто откажется, и мы об этом сообщим;
    /// - если есть незакоммиченные правки в отслеживаемых файлах — не лезем вообще.
    ///   Git и сам не затирает локальные изменения, но полагаться на это как на
    ///   единственную защиту, когда речь про чужой рабочий каталог, неправильно;
    /// - git запускается в фоновом потоке. Синхронный вызов вешал бы редактор на всё
    ///   время сетевого запроса, а это худший способ реализовать удобство;
    /// - GIT_TERMINAL_PROMPT=0 — иначе запрос пароля повесит процесс навсегда,
    ///   и подвиснет он невидимо, без окна.
    /// </summary>
    [InitializeOnLoad]
    public static class AutoUpdater
    {
        const string MenuPath = "Tools/Top Kong/Автообновление";
        const string EnabledKey = "TopKong.AutoUpdate.Enabled";
        const double IntervalSeconds = 60.0;
        const double FirstCheckDelay = 8.0;

        static double _nextCheck;
        static bool _givenUp;
        static string _git;
        static string _repoRoot;
        static bool _resolved;

        // Пишутся из фонового потока, читаются из главного.
        static volatile bool _busy;
        static volatile string _lastSkipReason;

        // Заполняется фоновым потоком, вычитывается главным в OnUpdate.
        static volatile string _pendingLog;
        static volatile string _pendingWarning;
        static volatile bool _pendingRefresh;

        public static bool Enabled
        {
            get => EditorPrefs.GetBool(EnabledKey, true);
            set => EditorPrefs.SetBool(EnabledKey, value);
        }

        static AutoUpdater()
        {
            EditorApplication.update += OnUpdate;
            EditorApplication.focusChanged += OnFocusChanged;
            _nextCheck = EditorApplication.timeSinceStartup + FirstCheckDelay;
        }

        [MenuItem(MenuPath, false, 40)]
        static void ToggleEnabled()
        {
            Enabled = !Enabled;
            Debug.Log("[TopKong] Автообновление " + (Enabled ? "включено." : "выключено."));
        }

        [MenuItem(MenuPath, true)]
        static bool ToggleEnabledValidate()
        {
            Menu.SetChecked(MenuPath, Enabled);
            return true;
        }

        [MenuItem("Tools/Top Kong/Обновить сейчас", false, 41)]
        static void UpdateNow()
        {
            _givenUp = false;
            _lastSkipReason = null;
            Check(true);
        }

        static void OnFocusChanged(bool focused)
        {
            if (focused) Check(false);
        }

        static void OnUpdate()
        {
            // Результаты фонового потока обязаны применяться здесь: и AssetDatabase,
            // и Debug.Log — только для главного потока.
            var log = _pendingLog;
            if (log != null)
            {
                _pendingLog = null;
                Debug.Log(log);
            }

            var warning = _pendingWarning;
            if (warning != null)
            {
                _pendingWarning = null;
                Debug.LogWarning(warning);
            }

            if (_pendingRefresh)
            {
                _pendingRefresh = false;
                AssetDatabase.Refresh();
            }

            if (EditorApplication.timeSinceStartup < _nextCheck) return;
            _nextCheck = EditorApplication.timeSinceStartup + IntervalSeconds;
            Check(false);
        }

        static void Check(bool manual)
        {
            if (!manual && !Enabled) return;
            if (_busy || _givenUp) return;

            // В Play-режиме перекомпиляция посреди игры сбрасывает сессию, а во время
            // импорта Refresh просто конфликтует сам с собой.
            if (EditorApplication.isPlayingOrWillChangePlaymode) return;
            if (EditorApplication.isCompiling || EditorApplication.isUpdating) return;

            if (!Resolve()) return;

            _busy = true;
            string git = _git;
            string root = _repoRoot;
            Task.Run(() => Pull(git, root, manual));
        }

        /// <summary>Один раз за сессию находит git и корень репозитория.</summary>
        static bool Resolve()
        {
            if (_resolved) return _git != null && _repoRoot != null;
            _resolved = true;

            string projectDir = Directory.GetParent(Application.dataPath)?.FullName;
            if (string.IsNullOrEmpty(projectDir)) return false;

            _git = FindGit(projectDir);
            if (_git == null)
            {
                _givenUp = true;
                Debug.LogWarning("[TopKong] Автообновление выключено: git не найден. "
                    + "У приложений с графическим интерфейсом PATH часто беднее, чем в терминале. "
                    + "Обновляться придётся вручную (git pull) — или скажи, и я подскажу, "
                    + "как прописать путь.");
                return false;
            }

            if (Run(_git, "rev-parse --show-toplevel", projectDir, out string top, out _)
                && !string.IsNullOrWhiteSpace(top))
            {
                _repoRoot = top.Trim();
                return true;
            }

            _givenUp = true;
            Debug.LogWarning("[TopKong] Автообновление выключено: проект не в git-репозитории. "
                + "Так бывает, если проект попал на диск не через git clone. "
                + "Тогда обновления надо забирать тем же способом, каким получен проект.");
            return false;
        }

        static void Pull(string git, string root, bool manual)
        {
            try
            {
                // --untracked-files=no обязателен: Unity генерирует сотни неотслеживаемых
                // файлов (Library, .meta, ProjectSettings), и без этого флага рабочее
                // дерево всегда выглядело бы грязным, а обновление не срабатывало бы никогда.
                if (!Run(git, "status --porcelain --untracked-files=no", root, out string status, out _))
                {
                    Report(null, "[TopKong] Не удалось спросить git о состоянии репозитория.");
                    return;
                }

                string dirty = FilterDirty(status);
                if (dirty != null)
                {
                    // Не спамим одинаковым сообщением каждую минуту.
                    if (manual || _lastSkipReason != dirty)
                    {
                        _lastSkipReason = dirty;
                        Report(null,
                            "[TopKong] Обновление пропущено: есть незакоммиченные правки в "
                            + dirty + ". Твои изменения важнее моих — закоммить их или откати, "
                            + "и обновление продолжится само.");
                    }
                    return;
                }
                _lastSkipReason = null;

                if (!Run(git, "rev-parse --abbrev-ref HEAD", root, out string branch, out _))
                {
                    Report(null, "[TopKong] Не удалось определить текущую ветку.");
                    return;
                }
                branch = branch.Trim();

                bool ok = Run(git, "pull --ff-only origin " + branch, root, out string output, out string error);
                string combined = (output + "\n" + error).Trim();

                if (!ok)
                {
                    Report(null, "[TopKong] git pull не прошёл:\n" + combined);
                    return;
                }

                if (combined.Contains("Already up to date") || combined.Contains("Already up-to-date"))
                {
                    if (manual) Report("[TopKong] Обновлений нет, уже последняя версия.", null);
                    return;
                }

                _pendingRefresh = true;
                Report("[TopKong] Подтянуты обновления, Unity сейчас перекомпилирует скрипты.\n"
                    + combined, null);
            }
            catch (Exception e)
            {
                Report(null, "[TopKong] Автообновление споткнулось: " + e.Message);
            }
            finally
            {
                _busy = false;
            }
        }

        /// <summary>
        /// Возвращает список изменённых отслеживаемых файлов или null, если мешать нечему.
        /// ProjectVersion.txt не считается: Unity переписывает его под свою версию при
        /// первом же открытии проекта, и учитывать это как "правки пользователя"
        /// значило бы отключить обновления навсегда.
        /// </summary>
        static string FilterDirty(string status)
        {
            if (string.IsNullOrWhiteSpace(status)) return null;

            var names = new System.Collections.Generic.List<string>();
            foreach (var raw in status.Split('\n'))
            {
                string line = raw.Trim();
                if (line.Length < 4) continue;
                string path = line.Substring(2).Trim();
                if (path.EndsWith("ProjectVersion.txt", StringComparison.Ordinal)) continue;
                names.Add(path);
            }

            if (names.Count == 0) return null;
            return names.Count <= 3
                ? string.Join(", ", names)
                : names[0] + " и ещё " + (names.Count - 1) + " файлов";
        }

        static void Report(string log, string warning)
        {
            if (log != null) _pendingLog = log;
            if (warning != null) _pendingWarning = warning;
        }

        static string FindGit(string workDir)
        {
            string[] candidates =
            {
                "git",
                "/usr/bin/git",
                "/usr/local/bin/git",
                "/opt/homebrew/bin/git",
                @"C:\Program Files\Git\cmd\git.exe",
                @"C:\Program Files (x86)\Git\cmd\git.exe",
            };

            foreach (var candidate in candidates)
            {
                if (Run(candidate, "--version", workDir, out _, out _)) return candidate;
            }
            return null;
        }

        static bool Run(string exe, string args, string workDir, out string stdout, out string stderr)
        {
            stdout = string.Empty;
            stderr = string.Empty;
            try
            {
                var psi = new ProcessStartInfo(exe, args)
                {
                    WorkingDirectory = workDir,
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true
                };
                // Без этого запрос логина/пароля повесил бы процесс молча и навсегда.
                psi.EnvironmentVariables["GIT_TERMINAL_PROMPT"] = "0";
                psi.EnvironmentVariables["GCM_INTERACTIVE"] = "never";

                using (var process = Process.Start(psi))
                {
                    if (process == null) return false;
                    stdout = process.StandardOutput.ReadToEnd();
                    stderr = process.StandardError.ReadToEnd();
                    if (!process.WaitForExit(30000))
                    {
                        try { process.Kill(); } catch (Exception) { }
                        return false;
                    }
                    return process.ExitCode == 0;
                }
            }
            catch (Exception)
            {
                // Не найденный исполняемый файл — это ожидаемый исход перебора кандидатов,
                // а не повод шуметь в консоли.
                return false;
            }
        }
    }
}
