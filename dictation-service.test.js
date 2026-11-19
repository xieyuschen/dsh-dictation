import test from 'node:test';
import assert from 'node:assert/strict';
import { DictationService } from './dictation-service.js';

const catalog = () => ({providers:[{id:'configured-default',name:'Default',languages:['auto','en']},{id:'explicit-provider',name:'Other',languages:['auto','zh']}],selection:{providerId:'configured-default',language:'en'},maxAudioBytes:960044,maxDurationSeconds:30});
function model(value=catalog()) { const service=Object.create(DictationService.prototype);service.catalog=value;service.notify=()=>{};return service; }

test('default provider is omitted, auto language is default, explicit provider is preserved',()=>{
  const service=model();
  assert.deepEqual(service.recordingSelection(),{language:'auto'});
  assert.equal(Object.hasOwn(service.recordingSelection(),'providerId'),false);
  assert.deepEqual(service.recordingSelection({providerId:'explicit-provider',language:'zh'}),{providerId:'explicit-provider',language:'zh'});
  assert.throws(()=>service.recordingSelection({providerId:'missing'}),/不可用/);
  assert.throws(()=>service.recordingSelection({language:'zh'}),/不支持/);
});

test('language choices follow catalog and selection snapshot never shares mutable catalog state',()=>{
  const service=model();
  assert.deepEqual(service.providerLanguages(),['auto','en']);
  assert.deepEqual(service.providerLanguages('explicit-provider'),['auto','zh']);
  const selection=service.recordingSelection({providerId:'explicit-provider',language:'zh'});
  service.catalog.selection.providerId='another';service.catalog.providers[1].languages[1]='ja';
  assert.deepEqual(selection,{providerId:'explicit-provider',language:'zh'});
});

test('known host limits below full 30 second PCM WAV reject capture admission',()=>{
  for(const [key,value] of [['maxDurationSeconds',29.9],['maxAudioBytes',960043]]){
    const service=model({...catalog(),[key]:value});
    assert.throws(()=>service.recordingSelection(),/不足以接收/);
  }
  assert.deepEqual(model().recordingSelection(),{language:'auto'});
});

test('catalog failure is visible and compatibility mode allows only default plus auto',async()=>{
  const service=model();service.remote={speech:{catalog:async()=>({ok:false,error:{message:'service offline'}})}};
  await service.refreshCatalog();
  assert.equal(service.catalog,null);assert.match(service.catalogWarning,/service offline/);assert.match(service.catalogWarning,/无法验证服务限制/);
  assert.deepEqual(service.recordingSelection(),{language:'auto'});
  assert.throws(()=>service.recordingSelection({providerId:'explicit-provider'}),/无法验证/);
  assert.throws(()=>service.recordingSelection({language:'en'}),/无法验证/);
});

test('valid catalog refresh replaces choices without configuring host defaults',async()=>{
  const value=catalog(),service=model(null);service.remote={speech:{catalog:async()=>({ok:true,value})}};
  assert.equal(await service.refreshCatalog(),value);assert.equal(service.catalogWarning,'');
  assert.deepEqual(service.recordingSelection(),{language:'auto'});
});

test('transcription requests omit default provider but retain explicit saved provider and language',async()=>{
  const previousWindow=globalThis.window;globalThis.window=new EventTarget();const calls=[];
  const service=new DictationService({speech:{transcribe:async request=>{calls.push(request);return {ok:true,value:{text:'ok'}};}}});
  try{
    await service.queue.transcribe(new Uint8Array([1]),new AbortController().signal,{},{});
    await service.queue.transcribe(new Uint8Array([2]),new AbortController().signal,{},{selection:{providerId:'explicit-provider',language:'zh'}});
    assert.equal(Object.hasOwn(calls[0],'providerId'),false);assert.equal(calls[0].language,'auto');
    assert.equal(calls[1].providerId,'explicit-provider');assert.equal(calls[1].language,'zh');
  }finally{await service.dispose();globalThis.window=previousWindow;}
});
