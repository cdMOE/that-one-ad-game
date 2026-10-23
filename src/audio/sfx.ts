type OscType = OscillatorType;

/** E6 G6 A6 C7 D7: any mix of these sounds sweet together. */
const COIN_NOTES = [1319, 1568, 1760, 2093, 2349];

/**
 * Tiny WebAudio synth: every sound is generated, so there are no audio files to
 * license or download. The context is created lazily on the first user gesture
 * (browsers refuse to start audio before that).
 */
export class Sfx {
  muted = false;
  private ac: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private lastHit = 0;
  private lastPop = 0;
  private lastShot = 0;
  private lastCoin = 0;

  /** Call from a user gesture (pointerdown/keydown). Safe to call repeatedly. */
  unlock(): void {
    if (!this.ac) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ac = new Ctor();
      this.master = this.ac.createGain();
      this.master.gain.value = this.muted ? 0 : 0.5;
      this.master.connect(this.ac.destination);
      const len = this.ac.sampleRate * 0.3;
      this.noiseBuf = this.ac.createBuffer(1, len, this.ac.sampleRate);
      const data = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    if (this.ac.state === 'suspended') void this.ac.resume();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master && this.ac)
      this.master.gain.setTargetAtTime(m ? 0 : 0.5, this.ac.currentTime, 0.02);
  }

  private tone(
    freq: number,
    dur: number,
    type: OscType,
    vol: number,
    slideTo?: number,
    delay = 0,
    cutoff?: number,
  ): void {
    if (!this.ac || !this.master || this.muted) return;
    const t = this.ac.currentTime + delay;
    const osc = this.ac.createOscillator();
    const g = this.ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let out: AudioNode = osc;
    if (cutoff) {
      const filter = this.ac.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = cutoff;
      out = osc.connect(filter);
    }
    out.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private noise(dur: number, vol: number, cutoff: number): void {
    if (!this.ac || !this.master || !this.noiseBuf || this.muted) return;
    const t = this.ac.currentTime;
    const src = this.ac.createBufferSource();
    src.buffer = this.noiseBuf;
    const filter = this.ac.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;
    const g = this.ac.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  click(): void {
    this.tone(520, 0.07, 'triangle', 0.25, 760);
  }

  gate(good: boolean): void {
    if (good) {
      this.tone(520, 0.12, 'triangle', 0.35, 780);
      this.tone(780, 0.16, 'triangle', 0.3, 1170, 0.07);
    } else {
      this.tone(300, 0.22, 'sawtooth', 0.22, 120);
    }
  }

  /** A bought upgrade: a quick rising chime that climbs a step with every level. */
  upgrade(level: number): void {
    const base = 440 * Math.pow(2, Math.min(level, 12) / 12);
    [1, 1.25, 1.5, 2].forEach((m, i) =>
      this.tone(base * m, 0.12, 'triangle', 0.28, undefined, i * 0.045),
    );
  }

  /** Throttled, so a swarm fight does not turn into a wall of noise. */
  hit(): void {
    const now = performance.now();
    if (now - this.lastHit < 55) return;
    this.lastHit = now;
    this.noise(0.09, 0.35, 1800);
    this.tone(140 + Math.random() * 40, 0.08, 'square', 0.12, 70);
  }

  /**
   * Quiet, soft and throttled: weapons fire many times per second for a whole run, so this is a
   * dull "thup" (triangle, no square edge) that the ear stops noticing instead of a buzz it tires of.
   */
  shoot(): void {
    const now = performance.now();
    if (now - this.lastShot < 70) return;
    this.lastShot = now;
    this.noise(0.035, 0.1, 2400);
    this.tone(640 + Math.random() * 90, 0.05, 'triangle', 0.09, 230);
  }

  /**
   * A soft sparkle on a random pentatonic note, so a rain of coins rings like a chime instead of
   * one beep repeated. Triangle, so it never sounds like the alarm.
   */
  coin(): void {
    const now = performance.now();
    if (now - this.lastCoin < 55) return;
    this.lastCoin = now;
    const f = COIN_NOTES[Math.floor(Math.random() * COIN_NOTES.length)];
    this.tone(f, 0.08, 'triangle', 0.08, f * 1.06);
  }

  /** A monster hit or killed. Its own throttle: the pops of a fight must not swallow a bite's hit. */
  pop(): void {
    const now = performance.now();
    if (now - this.lastPop < 50) return;
    this.lastPop = now;
    this.tone(260 + Math.random() * 120, 0.08, 'triangle', 0.14, 90);
  }

  /**
   * You are standing where something is about to land: a hi-lo "dee-doo", lower than any coin and
   * louder than the battle, so it cuts through the coin rain and can't be mistaken for it.
   */
  alarm(): void {
    this.tone(1047, 0.07, 'square', 0.15, undefined, 0, 2600);
    this.tone(784, 0.08, 'square', 0.15, undefined, 0.085, 2000);
  }

  /**
   * A volley is on its way: a clean whistle that climbs and swells for as long as the warning
   * lasts (about 0.8 s), so the boom that follows lands as its answer. Sine and a quiet fifth,
   * nothing buzzy.
   */
  volley(): void {
    if (!this.ac || !this.master || this.muted) return;
    const ac = this.ac;
    const t = ac.currentTime;
    const dur = 0.72;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.018, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.1, t + dur - 0.06);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    g.connect(this.master);
    for (const [mul, vol, type] of [
      [1, 1, 'sine'],
      [1.5, 0.3, 'triangle'],
    ] as const) {
      const osc = ac.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(440 * mul, t);
      osc.frequency.exponentialRampToValueAtTime(1320 * mul, t + dur);
      const v = ac.createGain();
      v.gain.value = vol;
      osc.connect(v).connect(g);
      osc.start(t);
      osc.stop(t + dur + 0.02);
    }
  }

  /**
   * The shooter's boom: the same low thump, with a mid-range knock and a brighter rumble on top,
   * so it still lands on phone speakers, which play next to nothing below 300 Hz.
   */
  blast(): void {
    this.noise(0.3, 0.5, 1500);
    this.tone(150, 0.28, 'sine', 0.5, 45);
    this.tone(300, 0.1, 'triangle', 0.3, 110);
  }

  boom(): void {
    this.noise(0.35, 0.6, 700);
    this.tone(110, 0.3, 'sine', 0.5, 40);
  }

  win(): void {
    [523, 659, 784, 1047].forEach((f, i) =>
      this.tone(f, 0.22, 'triangle', 0.35, undefined, i * 0.09),
    );
    this.tone(1047, 0.5, 'sine', 0.2, undefined, 0.36);
  }

  /**
   * A boss's roar: a low growl that drops, under a rumble. The growl is lowpassed: a raw low
   * sawtooth rasps like a fly, a filtered one growls.
   */
  roar(): void {
    this.noise(0.55, 0.5, 420);
    this.tone(96, 0.55, 'sawtooth', 0.4, 52, 0, 700);
    this.tone(144, 0.4, 'sawtooth', 0.2, 70, 0.04, 700);
  }

  lose(): void {
    this.tone(392, 0.28, 'sawtooth', 0.25, 330);
    this.tone(330, 0.28, 'sawtooth', 0.25, 262, 0.22);
    this.tone(262, 0.6, 'sawtooth', 0.25, 120, 0.44);
  }

  /**
   * A lost shooter run: a soft, slightly silly "wah-waaah", not a punishment, so the next run is
   * the obvious answer. Triangle notes through a resonant lowpass that opens and closes like a
   * trumpet mute, the last one drooping with a little vibrato.
   */
  defeat(): void {
    if (!this.ac || !this.master || this.muted) return;
    const { ac, master } = this;
    const t0 = ac.currentTime;
    // [pitch, droops to, starts at, length]
    const notes = [
      [392, 392, 0, 0.2],
      [370, 330, 0.24, 0.6],
    ] as const;
    notes.forEach(([freq, droop, at, len], i) => {
      const t = t0 + at;
      const osc = ac.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, t);
      osc.frequency.setValueAtTime(freq, t + len * 0.35);
      osc.frequency.exponentialRampToValueAtTime(droop, t + len);
      const filter = ac.createBiquadFilter();
      filter.type = 'lowpass';
      filter.Q.value = 5;
      filter.frequency.setValueAtTime(400, t);
      filter.frequency.exponentialRampToValueAtTime(1700, t + 0.07);
      filter.frequency.exponentialRampToValueAtTime(450, t + len);
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.09, t + 0.03);
      g.gain.setValueAtTime(0.09, t + len * 0.5);
      g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      osc.connect(filter).connect(g).connect(master);
      if (i === notes.length - 1) {
        const lfo = ac.createOscillator();
        lfo.frequency.value = 6;
        const depth = ac.createGain();
        depth.gain.setValueAtTime(0, t);
        depth.gain.linearRampToValueAtTime(9, t + len);
        lfo.connect(depth).connect(osc.frequency);
        lfo.start(t);
        lfo.stop(t + len + 0.02);
      }
      osc.start(t);
      osc.stop(t + len + 0.02);
    });
  }
}
