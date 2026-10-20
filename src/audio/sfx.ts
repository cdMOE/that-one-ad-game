type OscType = OscillatorType;

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
  private lastShot = 0;

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
    osc.connect(g).connect(this.master);
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

  /** Throttled, so a swarm fight does not turn into a wall of noise. */
  hit(): void {
    const now = performance.now();
    if (now - this.lastHit < 55) return;
    this.lastHit = now;
    this.noise(0.09, 0.35, 1800);
    this.tone(140 + Math.random() * 40, 0.08, 'square', 0.12, 70);
  }

  /** Quiet and throttled: weapons fire several times per second. */
  shoot(): void {
    const now = performance.now();
    if (now - this.lastShot < 70) return;
    this.lastShot = now;
    this.noise(0.04, 0.12, 3200);
    this.tone(620 + Math.random() * 80, 0.05, 'square', 0.05, 240);
  }

  pop(): void {
    const now = performance.now();
    if (now - this.lastHit < 40) return;
    this.lastHit = now;
    this.tone(260 + Math.random() * 120, 0.09, 'triangle', 0.14, 90);
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

  lose(): void {
    this.tone(392, 0.28, 'sawtooth', 0.25, 330);
    this.tone(330, 0.28, 'sawtooth', 0.25, 262, 0.22);
    this.tone(262, 0.6, 'sawtooth', 0.25, 120, 0.44);
  }
}
