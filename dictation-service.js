import { ContinuousCapture, pcmWave } from './dictation-capture.js';
import { IndexedDbStore } from './dictation-store.js';
import { DictationQueue } from './dictation-queue.js';

export async function audioBytes(audio) {
  if (audio instanceof Uint8Array) return audio;
  if (audio instanceof ArrayBuffer) return new Uint8Array(audio);
  if (audio?.arrayBuffer) return new Uint8Array(await audio.arrayBuffer());
  throw new Error('录音数据不可读');
}
export function encodeAudio(bytes) {
  let binary = '';
  for (let i=0;i<bytes.length;i+=16384) binary+=String.fromCharCode(...bytes.subarray(i,i+16384));
  return btoa(binary);
}
export function joinedTranscript(chunks) {
  return chunks.filter(c=>c.status==='done').sort((a,b)=>a.seq-b.seq).map(c=>c.text.trim()).filter(Boolean).join('\n');
}

export class DictationService {
  constructor(remote) {
    this.remote=remote; this.listeners=new Set(); this.records=[]; this.chunks=new Map();
    this.ready=false; this.owner=false; this.error=''; this.unsaved=[]; this.writes=Promise.resolve();
    this.startGeneration=0;this.catalog=null;this.catalogWarning='';
    this.tabId=globalThis.crypto?.randomUUID?.()??('dictation-'+Date.now()+'-'+Math.random());
    this.ownershipWaiters=new Set();this.deferOwnershipUntil=0;this.ownerOperation=0;
    this.lockReleased=Promise.resolve();this.releaseLock=()=>{};
    this.store=new IndexedDbStore();
    this.queue=new DictationQueue({store:this.store,transcribe:async(audio,signal,chunk,recording)=>{
      const result=await remote.speech.transcribe({audioBase64:encodeAudio(await audioBytes(audio)),...(recording.selection??{language:'auto'})},signal);
      if(!result.ok) throw new Error(result.error.message);
      return result.value;
    },onStorageError:error=>this.storageFailure(error)});
    this.unsubscribe=this.store.subscribe(()=>this.scheduleRefresh());
    this.channel=typeof BroadcastChannel==='function'?new BroadcastChannel('dsh-dictation-changed'):null;
    if(this.channel)this.channel.onmessage=event=>this.ownershipMessage(event.data);
    this.beforeUnload=event=>{if(this.capture||this.starting||this.unsaved.length){event.preventDefault();event.returnValue='';}};
    window.addEventListener('beforeunload',this.beforeUnload);
    this.pageHide=()=>{if(this.capture||this.starting)this.stop().catch(()=>{});};
    window.addEventListener('pagehide',this.pageHide);
  }
  subscribe(listener){this.listeners.add(listener);return()=>this.listeners.delete(listener);}
  notify(){for(const fn of this.listeners)fn();}
  initialize(){
    if(this.initializing)return this.initializing;
    if(this.closing||this.disposed)return Promise.resolve();
    this.initializing=(async()=>{
      try{
        if(!globalThis.indexedDB)throw new Error('浏览器无法使用本地数据库，不能保证录音保存；录音已禁用');
        if(!navigator.locks)throw new Error('浏览器不支持跨标签页录音锁，请使用新版浏览器');
        await this.refreshCatalog();
        await this.attemptOwnership();
        if(this.closing||this.disposed)return;
        await this.refresh();
        if(!this.closing&&!this.disposed){this.ready=true;this.notify();this.scheduleOwnershipRetry();}
      }catch(error){this.error=error.message;this.ready=true;this.notify();}
    })();
    return this.initializing;
  }
  async refreshCatalog(){
    let timer;
    try{
      if(typeof this.remote.speech.catalog!=='function')throw new Error('当前 DSH 未提供语音目录接口');
      const result=await Promise.race([this.remote.speech.catalog(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('读取语音目录超时')),3000);})]);
      if(!result?.ok)throw new Error(result?.error?.message||'语音目录返回无效结果');
      const catalog=result.value;
      if(!Array.isArray(catalog?.providers)||!catalog.selection)throw new Error('语音目录格式不兼容');
      this.catalog=catalog;this.catalogWarning='';
    }catch(error){
      this.catalog=null;this.catalogWarning='无法读取语音服务目录：'+String(error.message??error)+'。兼容模式仅使用 DSH 默认服务和自动语言；无法验证服务限制。';
    }finally{clearTimeout(timer);if(!this.disposed)this.notify();}
    return this.catalog;
  }
  providerLanguages(providerId=''){
    if(!this.catalog)return ['auto'];
    const provider=this.catalog.providers.find(p=>p.id===(providerId||this.catalog.selection.providerId));
    return provider?.languages?.filter(l=>typeof l==='string')??[];
  }
  recordingSelection({providerId='',language='auto'}={}){
    if(typeof providerId!=='string'||typeof language!=='string')throw new Error('无效的语音服务或语言选择');
    if(!this.catalog){
      if(providerId||language!=='auto')throw new Error('无法验证语音服务目录，请使用 DSH 默认服务和自动语言，或重新读取目录');
      return {language:'auto'};
    }
    if(providerId&&!this.catalog.providers.some(p=>p.id===providerId))throw new Error('选择的语音服务已不可用，请重新选择');
    if(!this.catalog.providers.some(p=>p.id===(providerId||this.catalog.selection.providerId)))throw new Error('DSH 未配置可用的默认语音服务，请先配置语音服务');
    if(!this.providerLanguages(providerId).includes(language))throw new Error('所选语音服务不支持该语言，请在录音设置中选择目录列出的语言');
    for(const [key,minimum,label] of [['maxDurationSeconds',30,'30 秒'],['maxAudioBytes',960044,'960044 字节']]){
      const limit=this.catalog[key];
      if(typeof limit==='number'&&Number.isFinite(limit)&&limit<minimum)throw new Error('语音服务限制 '+key+'='+limit+'，不足以接收 '+label+' 的完整录音片段；请调整服务限制后再录音');
    }
    return {...(providerId?{providerId}:{}),language};
  }
  ownershipPost(message){
    if(this.closing||this.disposed)return;
    try{this.channel?.postMessage({...message,from:this.tabId});}catch{}
  }
  ownershipMessage(message){
    if(this.closing||this.disposed)return;
    if(message==='changed'){this.scheduleRefresh(false);return;}
    if(!message||typeof message!=='object'||message.from===this.tabId)return;
    if(message.type==='claim'&&typeof message.target==='string'&&this.owner){
      if(this.capture||this.starting||this.stopping||this.unsaved.length||this.blocked||this.ownerOperation||this.yielding){
        this.ownershipPost({type:'busy',target:message.target,reason:this.unsaved.length||this.blocked?'另一个页面有录音尚未保存，请先在该页面保存。':'另一个页面正在录音或处理录音，请先在该页面暂停。'});
      }else this.yieldOwnership(message.target).catch(error=>{this.error=error.message;this.notify();});
    }else if(message.type==='yield'&&typeof message.target==='string'&&Number.isFinite(message.until)){
      this.deferOwnershipUntil=message.target===this.tabId?0:Math.max(this.deferOwnershipUntil,Math.min(message.until,Date.now()+5000));
      this.wakeOwnershipWaiters();this.scheduleOwnershipRetry();
    }else if(message.type==='busy'&&message.target===this.tabId){
      this.ownershipReason=String(message.reason??'另一个页面正在录音，请先暂停。');
    }
  }
  scheduleOwnershipRetry(){
    clearTimeout(this.ownershipTimer);this.ownershipTimer=null;
    if(this.closing||this.disposed||this.owner||this.blocked||!navigator.locks)return;
    const delay=Math.max(1500,this.deferOwnershipUntil-Date.now()+25);
    this.ownershipTimer=setTimeout(()=>{
      this.ownershipTimer=null;
      this.attemptOwnership().catch(error=>{this.error=error.message;this.notify();}).finally(()=>this.scheduleOwnershipRetry());
    },delay);
  }
  attemptOwnership(){
    if(this.closing||this.disposed||this.blocked||this.yielding||Date.now()<this.deferOwnershipUntil)return Promise.resolve(false);
    if(this.owner)return Promise.resolve(true);
    if(this.acquiring)return this.acquiring;
    let settled;
    const available=new Promise(resolve=>settled=resolve);
    // Every acquisition epoch owns its own deferred; never reuse a resolved
    // release promise after yielding and reacquiring the same browser lock.
    try{
      this.lockTask=navigator.locks.request('dsh-dictation-worker-v1',{ifAvailable:true},async lock=>{
        if(!lock){settled(false);return;}
        try{
          if(this.closing||this.disposed||Date.now()<this.deferOwnershipUntil)return;
          this.lockReleased=new Promise(resolve=>this.releaseLock=resolve);
          // Another owner may have left interrupted recordings since our last epoch.
          this.queue.initialized=false;
          await this.queue.start();
          if(this.closing||this.disposed)return;
          this.owner=true;this.ownershipReason='';clearTimeout(this.ownershipTimer);
          this.clearedOwnershipError=this.ownershipError;
          if(this.ownershipError&&this.error===this.ownershipError)this.error='';
          this.ownershipError='';
          this.notify();settled(true);
          await this.lockReleased;
        }finally{
          // The lock remains HELD until the worker has aborted and persisted its
          // current segment. No successor may recover/transcribe concurrently.
          try{await this.queue.stop();}finally{this.owner=false;settled(false);this.notify();}
        }
      }).catch(error=>{this.error=error.message;settled(false);this.notify();});
    }catch(error){this.error=error.message;settled(false);this.notify();}
    const attempt=available.finally(()=>{if(this.acquiring===attempt)this.acquiring=null;this.scheduleOwnershipRetry();});
    this.acquiring=attempt;
    return attempt;
  }
  yieldOwnership(target){
    if(this.yielding)return this.yielding;
    if(!this.owner||this.capture||this.starting||this.stopping||this.unsaved.length||this.blocked||this.ownerOperation)return Promise.resolve(false);
    this.deferOwnershipUntil=Date.now()+4000;
    this.ownershipPost({type:'yield',target,until:this.deferOwnershipUntil});
    this.yielding=Promise.resolve(false);
    const held=this.lockTask;
    this.owner=false;this.notify();
    const task=(async()=>{
      try{
        await this.writes;
        await this.queue.stop();
        // Any failed persistence leaves this owner in control of its lock.
        if(this.blocked||this.unsaved.length){this.owner=true;return false;}
        this.releaseLock();await held;return true;
      }catch(error){this.owner=true;throw error;}
      finally{this.yielding=null;this.scheduleOwnershipRetry();this.notify();}
    })();
    this.yielding=task;return task;
  }
  wakeOwnershipWaiters(){for(const wake of [...this.ownershipWaiters])wake();}
  waitOwnership(delay){
    return new Promise(resolve=>{
      const finish=()=>{clearTimeout(timer);this.ownershipWaiters.delete(finish);resolve();};
      const timer=setTimeout(finish,delay);this.ownershipWaiters.add(finish);
    });
  }
  async tryClaimOwnership({generation=this.startGeneration,timeoutMs=2000}={}){
    if(this.owner&&!this.yielding)return true;
    if(this.closing||this.disposed)throw new DOMException('录音启动已取消','AbortError');
    this.ownershipReason='';
    const deadline=Date.now()+Math.max(0,Math.min(timeoutMs,5000));
    let nextRequest=0;
    do{
      if(this.closing||this.disposed||generation!==this.startGeneration)throw new DOMException('录音启动已取消','AbortError');
      if(Date.now()>=nextRequest){this.ownershipPost({type:'claim',target:this.tabId});nextRequest=Date.now()+400;}
      if(await this.attemptOwnership())return true;
      if(Date.now()>=deadline)break;
      await this.waitOwnership(Math.min(100,Math.max(0,deadline-Date.now())));
    }while(Date.now()<=deadline);
    this.scheduleOwnershipRetry();
    this.ownershipError=this.ownershipReason||'另一个页面正在处理听写，请先暂停该页面的录音后重试。';
    throw new Error(this.ownershipError);
  }
  scheduleRefresh(broadcast=true){
    if(broadcast)this.channel?.postMessage('changed');
    if(this.refreshTimer||this.disposed)return;
    this.refreshTimer=setTimeout(()=>{this.refreshTimer=null;this.refresh().catch(error=>{this.error=error.message;this.notify();});},150);
  }
  async refresh(){
    if(this.disposed)return;
    const records=await this.store.listRecordings();
    const chunks=new Map();
    for(const record of records)chunks.set(record.id,await this.store.listChunks(record.id,{includeAudio:false}));
    this.records=records;this.chunks=chunks;this.notify();
  }
  serial(operation){
    this.writes=this.writes.then(operation).catch(error=>{this.storageFailure(error);});
    return this.writes;
  }
  checkpoint(recordingId,audio){
    this.serial(async()=>{if(!this.blocked)await this.store.updateRecording(recordingId,{tailAudio:audio,tailUpdatedAt:Date.now()});});
  }
  segment(recordingId,audio){
    const item={recordingId,audio};this.unsaved.push(item);
    this.serial(async()=>{
      if(this.blocked)return;
      await this.queue.enqueue(recordingId,audio);
      this.unsaved=this.unsaved.filter(x=>x!==item);
    });
  }
  storageFailure(error){
    if(this.blocked)return;
    this.blocked=true;
    this.error='本地保存失败，已停止继续录音。请不要刷新，先下载“未保存录音”：'+String(error.message??error);
    this.notify();
    this.stop().catch(()=>{});
  }
  cancelStart(){this.startGeneration++;this.startupController?.abort(new DOMException('录音启动已取消','AbortError'));this.wakeOwnershipWaiters();}
  async start(sessionId,{providerId='',language='auto',deviceId=''}={}){
    if(this.closing||this.disposed)throw new Error('听写服务已关闭');
    if(!this.ready)throw new Error('听写服务正在准备，请稍后重试');
    if(this.capture||this.starting)throw new Error('已有录音正在进行');
    if(this.blocked)throw new Error(this.error);
    const selection=this.recordingSelection({providerId,language});
    const resolvedProviderId=providerId||this.catalog?.selection?.providerId||null;
    const controller=this.startupController=new AbortController();
    const generation=++this.startGeneration;
    const cancelled=()=>generation!==this.startGeneration||this.closing||this.disposed;
    const cancellation=()=>Object.assign(new Error('录音启动已取消'),{name:'AbortError'});
    this.currentSessionId=String(sessionId);
    this.starting=true;this.notify();
    const task=this.startTask=(async()=>{
      let record,capture;
      try{
        await this.tryClaimOwnership({generation});
        if(cancelled())throw cancellation();
        if(this.blocked)throw new Error(this.error);
        // Admission stays local; offline speech must still be preserved.
        record=await this.store.createRecording({sessionId:String(sessionId),selection:{...selection},resolvedProviderId});
        if(cancelled())throw cancellation();
        this.currentId=record.id;this.startedAt=Date.now();this.error='';
        capture=new ContinuousCapture({deviceId,onSegment:audio=>this.segment(record.id,audio),onCheckpoint:audio=>this.checkpoint(record.id,audio),onError:error=>{this.error=error.message;this.stop().catch(()=>{});this.notify();}});
        if(cancelled())throw cancellation();
        this.capture=capture;this.notify();
        await capture.start(controller.signal);
        if(cancelled())throw cancellation();
        if(navigator.storage?.persist) navigator.storage.persist().catch(()=>{});
        return record;
      }catch(error){
        try{
          if(capture)await capture.stop();
          await this.writes;
          if(record&&!this.blocked)await this.store.updateRecording(record.id,{state:'interrupted'});
        }catch(cleanupError){this.storageFailure(cleanupError);}
        if(this.capture===capture)this.capture=null;
        if(error.name!=='AbortError'&&!this.blocked)this.error=error.message??String(error);
        throw error;
      }finally{if(this.startupController===controller)this.startupController=null;this.starting=false;this.notify();}
    })();
    try{return await task;}finally{if(this.startTask===task)this.startTask=null;}
  }
  async stop(){
    this.cancelStart();
    if(this.stopping)return this.stopping;
    const capture=this.capture, id=this.currentId;
    if(!capture)return;
    this.stopping=(async()=>{
      try{
        await capture.stop();
        await this.writes;
        if(!this.blocked)await this.queue.finishRecording(id);
      }catch(error){this.error=error.message;}
      finally{if(this.capture===capture)this.capture=null;this.stopping=null;this.notify();await this.refresh().catch(()=>{});}
    })();return this.stopping;
  }
  async retryRecording(id){
    if(!this.owner||this.yielding||this.closing)throw new Error('请在持有听写任务的页面重试，或先点击麦克风接管');
    if(this.blocked)throw new Error(this.error);
    this.ownerOperation++;
    try{
      const chunks=await this.store.listChunks(id,{includeAudio:false});
      for(const chunk of chunks)if(chunk.status==='failed')await this.queue.retry(chunk.id);
      await this.queue.start();await this.refresh();
    }finally{this.ownerOperation--;}
  }
  async remove(id){
    if(!this.owner||this.yielding||this.closing)throw new Error('请在持有听写任务的页面删除，或先点击麦克风接管');
    if((this.capture||this.starting||this.stopping)&&this.currentId===id)throw new Error('请先停止录音');
    this.ownerOperation++;
    try{
      await this.queue.stop();
      try{await this.store.deleteRecording(id);}finally{if(!this.blocked&&!this.closing)await this.queue.start();}
      await this.refresh();
    }finally{this.ownerOperation--;}
  }
  async exportAudio(id,{unsavedOnly=false}={}){
    const waves=[];
    if(!unsavedOnly){
      for(const chunk of await this.store.listChunks(id))waves.push(chunk.audio);
      const rec=await this.store.getRecording(id);
      if(rec?.tailAudio&&!this.unsaved.some(item=>item.recordingId===id))waves.push(rec.tailAudio);
    }
    // Uncommitted segments are only here after storage failure; retain them for emergency export.
    for(const item of this.unsaved)if(item.recordingId===id)waves.push(item.audio);
    if(!waves.length)throw new Error('没有可导出的录音');
    const header=pcmWave(new Int16Array(0));
    const total=waves.reduce((n,w)=>n+Math.max(0,(w.size??w.byteLength)-44),0);
    if(total>0xffffffff-36)throw new Error('录音超过单个 WAV 文件限制，请分批导出');
    const view=new DataView(header.buffer);view.setUint32(4,36+total,true);view.setUint32(40,total,true);
    return new Blob([header,...waves.map(w=>w instanceof Blob?w.slice(44):w.subarray(44))],{type:'audio/wav'});
  }
  dispose(){
    if(this.disposeTask)return this.disposeTask;
    if(this.disposed)return Promise.resolve();
    this.closing=true;clearTimeout(this.ownershipTimer);this.cancelStart();
    this.disposeTask=(async()=>{
      try{
        await this.stop();
        // Pending getUserMedia cannot be aborted by the browser API. Its start
        // continuation sees closing and stops any stream before DB shutdown.
        if(this.startTask)await this.startTask.catch(()=>{});
        if(this.initializing)await this.initializing;
        if(this.acquiring)await this.acquiring;
        if(this.yielding)await this.yielding.catch(()=>{});
        await this.queue.close();
      }finally{
        this.disposed=true;this.owner=false;this.ready=false;
        clearTimeout(this.refreshTimer);this.unsubscribe();this.channel?.close();
        window.removeEventListener('beforeunload',this.beforeUnload);window.removeEventListener('pagehide',this.pageHide);
        this.releaseLock();
        try{await this.lockTask;}finally{this.store.close();this.listeners.clear();}
      }
    })();
    return this.disposeTask;
  }
}
