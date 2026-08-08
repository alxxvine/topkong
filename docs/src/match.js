import { tuning as T } from 'tk/tuning.js';

// Матч: свалка до последнего.
//
// Без него игра не кончается ничем, и показать её некому: зритель видит
// возню, но не понимает, выиграл ты или нет. Правило одно — упал с арены,
// выбыл; остался один, победил.
//
// Состояний три, и переходы между ними односторонние. Отдельно от них
// не существует ни счёта, ни таймеров: всё, что нужно знать снаружи, —
// это фаза и строка, которую показать.

export const Phase = {
  /** Отсчёт перед схваткой: успеть увидеть, кто где стоит. */
  Ready: 'ready',
  Fight: 'fight',
  /** Раунд кончился, показываем итог и ждём перед новым. */
  Over: 'over',
};

export class Match {
  constructor(fighters, player, onRestart) {
    this.fighters = fighters;
    this.player = player;
    this.onRestart = onRestart;
    this.round = 0;
    this.wins = 0;
    this.losses = 0;
    this.begin();
  }

  begin() {
    this.round++;
    this.phase = Phase.Ready;
    this.timer = T.matchReadyTime;
    this.winner = null;
    this.onRestart();
  }

  get alive() {
    let n = 0;
    for (const f of this.fighters) if (f.alive) n++;
    return n;
  }

  /** Управление у бойцов есть только в схватке — в отсчёте все стоят. */
  get controlEnabled() {
    return this.phase === Phase.Fight;
  }

  tick(dt) {
    this.timer -= dt;

    if (this.phase === Phase.Ready) {
      if (this.timer <= 0) {
        this.phase = Phase.Fight;
        this.timer = 0;
      }
      return;
    }

    if (this.phase === Phase.Fight) {
      // Победа не по «остался один», а по «остался не больше одного»:
      // двое могут улететь одним ударом, и тогда не победил никто.
      if (this.alive > 1) return;
      this.phase = Phase.Over;
      this.timer = T.matchOverTime;
      this.winner = this.fighters.find((f) => f.alive) || null;
      if (this.winner === this.player) this.wins++;
      else this.losses++;
      return;
    }

    if (this.timer <= 0) this.begin();
  }

  /** Крупная строка посреди экрана. Пусто — значит показывать нечего. */
  get banner() {
    if (this.phase === Phase.Ready) {
      const left = Math.max(1, Math.ceil(this.timer));
      return { big: String(left), small: 'Раунд ' + this.round };
    }
    if (this.phase === Phase.Over) {
      if (!this.winner) return { big: 'Ничья', small: 'Все внизу' };
      return this.winner === this.player
        ? { big: 'Победа', small: 'Остался один' }
        : { big: 'Поражение', small: this.winner.name + ' выстоял' };
    }
    return null;
  }

  /** Короткая строка счёта для HUD. */
  get score() {
    return `раунд ${this.round}   счёт ${this.wins}:${this.losses}   на арене ${this.alive}`;
  }
}
