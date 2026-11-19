// Continuous PCM capture. Audio never stops/restarts at an ASR chunk boundary.
export class PcmResampler {
  constructor(sourceRate, targetRate = 16000) {
    if (!Number.isFinite(sourceRate) || sourceRate < 8000) throw new Error('Invalid microphone sample rate');
    this.step = sourceRate / targetRate;
    this.inputCount = 0;
    this.outputCount = 0;
    this.previous = 0;
  }
  push(input) {
    const output = [];
    for (const sample of input) {
      const index = this.inputCount++;
      while (this.outputCount * this.step <= index) {
        const position = this.outputCount * this.step;
        const fraction = index === 0 ? 1 : position - (index - 1);
        const value = this.previous + (sample - this.previous) * fraction;
        output.push(Math.round(Math.max(-1, Math.min(1, value)) * (value < 0 ? 32768 : 32767)));
        this.outputCount++;
      }
      this.previous = sample;
    }
    return Int16Array.from(output);
  }
  finish() {
    const expected = Math.round(this.inputCount / this.step);
    const count = Math.max(0, expected - this.outputCount);
    this.outputCount += count;
    return new Int16Array(count).fill(Math.round(Math.max(-1, Math.min(1, this.previous)) * (this.previous < 0 ? 32768 : 32767)));
  }
}

export function pcmWave(samples) {
  const result = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(result.buffer);
  const text = (offset, value) => { for (let i = 0; i < value.length; i++) result[offset + i] = value.charCodeAt(i); };
  text(0, 'RIFF'); view.setUint32(4, result.length - 8, true); text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i], true);
  return result;
}

export class PcmSegmenter {
  constructor({ onSegment, onCheckpoint, targetSeconds = 28, maxSeconds = 30, checkpointSeconds = 1, silenceSeconds = 0.35 }) {
    this.onSegment = onSegment;
    this.onCheckpoint = onCheckpoint;
    this.target = Math.round(targetSeconds * 16000);
    this.max = Math.round(maxSeconds * 16000);
    this.checkpointEvery = Math.round(checkpointSeconds * 16000);
    this.silenceNeeded = Math.round(silenceSeconds * 16000);
    this.buffer = new Int16Array(this.max);
    this.length = 0;
    this.silence = 0;
    this.lastCheckpoint = 0;
    this.totalSamples = 0;
  }
  push(samples) {
    for (const sample of samples) {
      this.buffer[this.length++] = sample;
      this.totalSamples++;
      this.silence = Math.abs(sample) < 390 ? this.silence + 1 : 0;
      if (this.length >= this.max || (this.length >= this.target && this.silence >= this.silenceNeeded)) {
        this.onSegment(pcmWave(this.buffer.subarray(0, this.length)));
        this.length = 0; this.silence = 0; this.lastCheckpoint = 0;
      } else if (this.length - this.lastCheckpoint >= this.checkpointEvery) {
        this.onCheckpoint(pcmWave(this.buffer.subarray(0, this.length)));
        this.lastCheckpoint = this.length;
      }
    }
  }
  tail() { return this.length ? pcmWave(this.buffer.subarray(0, this.length)) : null; }
  finish() {
    const tail = this.tail();
    this.length = 0;
    if (tail) this.onSegment(tail);
  }
}

const WORKLET_SOURCE = `
class DictationPcmCapture extends AudioWorkletProcessor {
  constructor() {
    super(); this.buffer = new Float32Array(2048); this.offset = 0; this.running = true;
    this.port.onmessage = ({data}) => {
      if (data === 'flush') {
        if (this.offset) this.port.postMessage({pcm: this.buffer.slice(0,this.offset)});
        this.offset = 0; this.running = false; this.port.postMessage({flushed: true});
      }
    };
  }
  process(inputs, outputs) {
    const channels = inputs[0];
    if (this.running && channels && channels.length) {
      for (let i=0;i<channels[0].length;i++) {
        let value=0; for(const channel of channels) value+=channel[i];
        this.buffer[this.offset++]=value/channels.length;
        if(this.offset===this.buffer.length){this.port.postMessage({pcm:this.buffer});this.buffer=new Float32Array(2048);this.offset=0;}
      }
    }
    return true;
  }
}
registerProcessor('dsh-dictation-pcm',DictationPcmCapture);
`;

export class ContinuousCapture {
  constructor({ onSegment, onCheckpoint, onError, onLevel, deviceId }) {
    this.segmenter = new PcmSegmenter({ onSegment, onCheckpoint });
    this.onError = onError;
    this.onLevel = onLevel;
    this.deviceId = deviceId;
    this.stopped = false;
  }
  async start(signal) {
    if (signal?.aborted) { await this.dispose(); throw signal.reason ?? new DOMException('Recording cancelled', 'AbortError'); }
    let abort;
    try {
      const cancelled = new Promise((_, reject) => {
        abort = () => {
          this.stopped = true;
          reject(signal.reason ?? new DOMException('Recording cancelled', 'AbortError'));
        };
        signal?.addEventListener('abort', abort, { once: true });
      });
      // getUserMedia cannot be aborted. Settle our own startup promptly while
      // initialize's stopped checks dispose any stream granted after cancellation.
      await Promise.race([this.initialize(), cancelled]);
    } catch (error) { await this.dispose(); throw error; }
    finally { signal?.removeEventListener('abort', abort); }
  }
  async initialize() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { ...(this.deviceId ? {deviceId: {exact: this.deviceId}} : {}), channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
      if (this.stopped) { await this.dispose(); return; }
      this.context = new AudioContext();
      this.resampler = new PcmResampler(this.context.sampleRate);
      if (!this.context.audioWorklet) throw new Error('浏览器不支持 AudioWorklet，请使用新版 Chrome、Edge 或 Firefox');
      const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], {type:'application/javascript'}));
      try { await this.context.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
      if (this.stopped) { await this.dispose(); return; }
      this.node = new AudioWorkletNode(this.context, 'dsh-dictation-pcm');
      this.node.port.onmessage = ({data}) => {
        if (data.flushed) { this.flushResolve?.(); return; }
        if (!data.pcm || this.disposed) return;
        try {
          this.segmenter.push(this.resampler.push(data.pcm));
          let peak=0; for (const x of data.pcm) peak=Math.max(peak,Math.abs(x));
          this.onLevel?.(peak);
        } catch (error) { this.onError?.(error); }
      };
      this.source = this.context.createMediaStreamSource(this.stream);
      this.gain = this.context.createGain(); this.gain.gain.value = 0;
      this.source.connect(this.node); this.node.connect(this.gain); this.gain.connect(this.context.destination);
      for (const track of this.stream.getTracks()) track.addEventListener('ended', () => { if(!this.stopped) this.onError?.(new Error('麦克风已断开；已保存的录音仍可恢复')); });
      this.context.onstatechange = () => { if (!this.stopped && this.context.state === 'suspended') this.onError?.(new Error('浏览器暂停了录音；已保存部分保留，请重新开始录音')); };
      await this.context.resume();
    } catch (error) { await this.dispose(); throw error; }
  }
  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.node && this.context?.state === 'running') {
      let timer;
      await new Promise(resolve => {
        this.flushResolve = () => { clearTimeout(timer); resolve(); };
        timer = setTimeout(resolve, 1000);
        this.node.port.postMessage('flush');
      });
    }
    if (this.resampler) this.segmenter.push(this.resampler.finish());
    this.segmenter.finish();
    await this.dispose();
  }
  emergencyTail() { return this.segmenter.tail(); }
  async dispose() {
    this.stopped = true;
    this.disposed = true;
    this.node?.disconnect(); this.source?.disconnect(); this.gain?.disconnect();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    if (this.context && this.context.state !== 'closed') await this.context.close();
  }
}
