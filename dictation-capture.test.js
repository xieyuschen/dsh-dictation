import test from 'node:test';
import assert from 'node:assert/strict';
import { ContinuousCapture, PcmResampler, PcmSegmenter, pcmWave } from './dictation-capture.js';
import { audioBytes, encodeAudio, joinedTranscript } from './dictation-service.js';

test('microphone startup aborts promptly and stops a stream granted after cancellation', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let grant;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: () => new Promise(resolve => { grant = resolve; }) } } });
  try {
    const capture = new ContinuousCapture({ onSegment() {}, onCheckpoint() {} });
    const controller = new AbortController();
    const starting = capture.start(controller.signal);
    controller.abort();
    await assert.rejects(starting, { name: 'AbortError' });
    assert.equal(capture.disposed, true);
    let stopped = 0;
    grant({ getTracks: () => [{ stop() { stopped++; } }] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopped, 1);
    assert.equal(capture.context, undefined);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
    else delete globalThis.navigator;
  }
});
test('already-cancelled microphone startup never requests permission', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let calls = 0;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia() { calls++; throw new Error('must not run'); } } } });
  try {
    const capture = new ContinuousCapture({ onSegment() {}, onCheckpoint() {} });
    const controller = new AbortController(); controller.abort();
    await assert.rejects(capture.start(controller.signal), { name: 'AbortError' });
    assert.equal(calls, 0);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
    else delete globalThis.navigator;
  }
});

const samplesFromWave=wave=>{
  const view=new DataView(wave.buffer,wave.byteOffset,wave.byteLength);
  return Int16Array.from({length:(wave.length-44)/2},(_,i)=>view.getInt16(44+i*2,true));
};
test('canonical 16k mono PCM16 header is exact, including signed samples',()=>{
  const wave=pcmWave(Int16Array.of(-32768,-1,0,1,32767));
  const view=new DataView(wave.buffer);
  assert.equal(new TextDecoder().decode(wave.subarray(0,4)),'RIFF');
  assert.equal(view.getUint32(4,true),46);assert.equal(view.getUint32(24,true),16000);
  assert.equal(view.getUint16(22,true),1);assert.equal(view.getUint16(34,true),16);
  assert.deepEqual([...samplesFromWave(wave)],[-32768,-1,0,1,32767]);
});
test('segment boundaries preserve every PCM sample without restart, gaps or overlap',()=>{
  const source=Int16Array.from({length:16000*91+891},(_,i)=>1000+i%30000);
  const segments=[],checkpoints=[];
  const cut=new PcmSegmenter({onSegment:w=>segments.push(w),onCheckpoint:w=>checkpoints.push(w)});
  for(let i=0;i<source.length;i+=1973)cut.push(source.subarray(i,i+1973));
  cut.finish();cut.finish();
  assert.deepEqual(segments.map(w=>(w.length-44)/32000),[30,30,30,1+891/16000]);
  const actual=Int16Array.from(segments.flatMap(w=>[...samplesFromWave(w)]));
  assert.deepEqual(actual,source);
  assert.ok(checkpoints.length>=88);assert.ok(checkpoints.every(w=>w.length>44));
});
test('silence around twenty-eight seconds is preferred, final short tail is retained',()=>{
  const segments=[];
  const cut=new PcmSegmenter({onSegment:w=>segments.push(w),onCheckpoint:()=>{}});
  cut.push(new Int16Array(16000*27.5).fill(2000));
  cut.push(new Int16Array(16000*0.6));
  cut.finish();
  assert.deepEqual(segments.map(w=>(w.length-44)/32000),[28,0.1]);
});
test('stream resampling is independent of callback boundaries and output duration is correct',()=>{
  for(const rate of [16000,22050,44100,48000]){
    const source=Float32Array.from({length:rate*2},(_,i)=>Math.sin(i*2*Math.PI*650/rate)*0.7);
    const whole=new PcmResampler(rate),a=[...whole.push(source),...whole.finish()];
    const split=new PcmResampler(rate),b=[];
    for(let i=0;i<source.length;i+=127)b.push(...split.push(source.subarray(i,i+127)));
    b.push(...split.finish());
    assert.equal(a.length,32000);assert.deepEqual(b,a);assert.ok(a.every(x=>Math.abs(x)<32768));
  }
});
test('audio Blob normalization, base64, and ordered transcript retain exact content',async()=>{
  const bytes=pcmWave(Int16Array.of(11,-22,33));
  assert.deepEqual(await audioBytes(new Blob([bytes])),bytes);
  assert.equal(encodeAudio(bytes),Buffer.from(bytes).toString('base64'));
  assert.equal(joinedTranscript([{seq:1,status:'done',text:' two '},{seq:0,status:'done',text:'one'},{seq:2,status:'failed',text:'bad'}]),'one\ntwo');
});
