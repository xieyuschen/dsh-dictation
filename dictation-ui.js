import React from 'react';
import { DictationService, joinedTranscript } from './dictation-service.js';

const h=React.createElement;
const boxStyle={display:'flex',flexDirection:'column',gap:8,width:'100%',maxWidth:720,padding:10,border:'1px solid var(--border-color, #7776)',borderRadius:8,fontSize:13};
const rowStyle={display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'};
const smallButton={padding:'4px 8px',border:'1px solid #8886',borderRadius:5,background:'transparent',color:'inherit',cursor:'pointer'};
const dictationMicStyle={display:'inline-flex',alignItems:'center',justifyContent:'center',position:'relative',flexShrink:0,width:36,height:36,padding:0,border:'1px solid transparent',borderRadius:'50%',background:'transparent',color:'var(--dsw-alias-label-secondary, inherit)',cursor:'pointer',touchAction:'manipulation',WebkitTapHighlightColor:'transparent'};
function dictationIcon(kind){
  const props={width:19,height:19,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.8,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true,focusable:false};
  if(kind==='pause')return h('svg',props,h('rect',{x:7,y:5,width:3,height:14,rx:1,fill:'currentColor',stroke:'none'}),h('rect',{x:14,y:5,width:3,height:14,rx:1,fill:'currentColor',stroke:'none'}));
  if(kind==='spinner')return h('svg',{...props,className:'dsh-dictation-spinner'},h('circle',{cx:12,cy:12,r:8,opacity:.2}),h('path',{d:'M12 4a8 8 0 0 1 8 8'}));
  return h('svg',props,h('rect',{x:9,y:3,width:6,height:12,rx:3}),h('path',{d:'M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M9 22h6'}));
}
function downloadBlob(blob,name){
  const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
function localSetting(key,fallback=''){try{return localStorage.getItem(key)??fallback;}catch{return fallback;}}
function saveSetting(key,value){try{localStorage.setItem(key,value);}catch{}}
function dictationDate(time){return new Date(time).toLocaleString();}
function dictationDuration(chunks){return Math.round(chunks.reduce((sum,c)=>sum+(c.audioBytes?Math.max(0,c.audioBytes-44)/32000:0),0));}

function DictationInput({sessionId,inputActions,locked,onActiveChange,service,configForm}){
  const [revision,setRevision]=React.useState(0),[open,setOpen]=React.useState(false),[message,setMessage]=React.useState('');
  const [configSnap,setConfigSnap]=React.useState(()=>configForm?.getSnapshot?.()||{});
  React.useEffect(()=>{
    if(!configForm?.subscribe)return;
    setConfigSnap(configForm.getSnapshot()||{});
    return configForm.subscribe(()=>setConfigSnap(configForm.getSnapshot()||{}));
  },[configForm]);
  const asrConfig=configSnap?.value?.asr||{};
  const advancedMode=Boolean(asrConfig.advancedMode);
  React.useEffect(()=>{if(!advancedMode)setOpen(false);},[advancedMode]);
  const [providerId,setProviderId]=React.useState(()=>localSetting('dsh.dictation.provider'));
  const [language,setLanguage]=React.useState(()=>localSetting('dsh.dictation.language','auto'));
  const [deviceId,setDeviceId]=React.useState(()=>localSetting('dsh.dictation.device'));
  const [devices,setDevices]=React.useState([]),[busy,setBusy]=React.useState(false);
  const [now,setNow]=React.useState(Date.now());
  const configuredProviderId=asrConfig.enabled?(asrConfig.providerId||'dsh-dictation-compatible'):'';
  const catalogProviders=service.catalog?.providers??[];
  const effectiveProviderId=providerId||(configuredProviderId&&catalogProviders.some(p=>p.id===configuredProviderId)?configuredProviderId:'');
  const live=React.useRef(null),inserting=React.useRef(false),insertionTask=React.useRef(Promise.resolve()),session=React.useRef(String(sessionId));
  const mic=React.useRef(null),gesture=React.useRef({timer:null,suppressUntil:0});
  const panelId=React.useId();
  React.useEffect(()=>{if(service.owner)setMessage(value=>value===service.clearedOwnershipError?'':value);},[service.owner]);
  session.current=String(sessionId);
  React.useEffect(()=>service.subscribe(()=>setRevision(x=>x+1)),[service]);
  React.useEffect(()=>{const t=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(t);},[]);
  React.useEffect(()=>{
    onActiveChange(open);return()=>onActiveChange(false);
  },[open,onActiveChange]);
  React.useEffect(()=>()=>clearTimeout(gesture.current.timer),[]);
  React.useEffect(()=>()=>{
    live.current=null;
    // Switching conversations stops capture gracefully; already-saved tasks keep running.
    if(service.currentSessionId===String(sessionId))service.stop().catch(()=>{});
  },[service,sessionId]);
  React.useEffect(()=>{
    if(!live.current||inserting.current)return;
    inserting.current=true;
    insertionTask.current=(async()=>{
      const active=live.current;
      if(!active||active.sessionId!==session.current)return;
      const chunks=await service.store.listChunks(active.id,{includeAudio:false});
      for(const chunk of chunks){
        if(live.current!==active||active.sessionId!==session.current||active.conflict)break;
        if(chunk.status!=='done')break;
        if(chunk.delivery==='applied'||active.delivered.has(chunk.id))continue;
        const text=chunk.text.trim();
        if(text&&!inputActions.insertText((active.inserted?'\n':'')+text,active.span)){
          active.conflict=true;
          await service.store.updateChunk(chunk.id,{delivery:'conflict'});
          setMessage('草稿已编辑或正在发送，自动插入已暂停。识别文字仍在录音列表中，可检查后手动插入。');
          break;
        }
        // In-memory guard precedes persistence: never duplicate insertion on a same-page refresh event.
        active.delivered.add(chunk.id);
        if(text){active.inserted=true;inputActions.persistDraft();active.span=inputActions.captureInsertion();}
        await service.store.updateChunk(chunk.id,{delivery:'applied'});
      }
    })().catch(error=>{live.current=null;service.storageFailure(error);}).finally(()=>{inserting.current=false;});
  },[revision,inputActions,service]);
  const action=fn=>async()=>{setBusy(true);try{await fn();}catch(error){if(error.name!=='AbortError')setMessage(error.message??String(error));}finally{setBusy(false);}};
  const start=action(async()=>{
    setMessage('');
    const span=inputActions.captureInsertion();
    const record=await service.start(sessionId,{providerId:effectiveProviderId,language,deviceId});
    live.current={id:record.id,sessionId:String(sessionId),span,delivered:new Set(),inserted:false,conflict:false};
    setRevision(x=>x+1);
    navigator.mediaDevices.enumerateDevices().then(all=>setDevices(all.filter(d=>d.kind==='audioinput'))).catch(()=>{});
  });
  const insert=record=>action(async()=>{
    if(service.blocked)throw new Error(service.error);
    if(record.sessionId!==String(sessionId))throw new Error('请在原会话插入此录音的文字，或复制下方文本');
    if(live.current?.id===record.id)live.current.conflict=true;
    await insertionTask.current;
    if(service.blocked)throw new Error(service.error);
    const chunks=await service.store.listChunks(record.id,{includeAudio:false});
    const pending=chunks.filter(c=>c.status==='done'&&c.delivery!=='applied'&&!(live.current?.id===record.id&&live.current.delivered.has(c.id)));
    const text=joinedTranscript(pending);
    if(!text)return;
    if(!inputActions.insertText(text,inputActions.captureInsertion()))throw new Error('当前草稿无法插入；识别文字仍保留');
    inputActions.persistDraft();
    if(live.current?.id===record.id){live.current.conflict=true;for(const c of pending)live.current.delivered.add(c.id);}
    try{for(const c of pending)await service.store.updateChunk(c.id,{delivery:'applied'});}
    catch(error){service.storageFailure(error);throw error;}
    await service.refresh();setMessage('已插入。请检查草稿后手动发送。');
  });
  const button=(label,onClick,disabled=false,extra={})=>h('button',{type:'button',style:smallButton,onClick,disabled,...extra},label);
  const records=[...service.records].sort((a,b)=>b.createdAt-a.createdAt);
  const pending=[...service.chunks.values()].flat().filter(c=>c.status==='pending'||c.status==='transcribing').length;
  const sessionRecords=records.filter(record=>record.sessionId===String(sessionId));
  const failedChunks=(advancedMode?sessionRecords:sessionRecords.filter(record=>record.id===service.currentId)).flatMap(record=>(service.chunks.get(record.id)??[]).filter(chunk=>chunk.status==='failed'));
  const failed=failedChunks.length;
  const latestFailedError=failedChunks.at(-1)?.error||'';
  const active=!!service.capture||service.starting;
  const unavailableReason=locked?'当前会话暂时不可编辑':busy?'正在处理上一项操作':service.blocked?(service.error||'本地保存失败，请先下载未保存录音'):service.closing?'听写正在重新加载':!service.ready?'正在准备听写':service.stopping?'正在保存录音，请稍候':'';
  const unavailable=!!unavailableReason;
  const label=service.stopping?'正在保存录音':service.starting?'取消录音启动':active?'结束录音':'开始录音';
  const emergency=service.unsaved.length>0;
  const feedback=message||service.error;
  const warning=emergency?'录音未保存，请立即下载，勿刷新。':service.blocked?(advancedMode?'保存失败，请勿刷新；右键查看详情。':'本地保存失败，请勿刷新。'):feedback?(/permission|notallowed|权限/i.test(feedback)?'无法使用麦克风，请检查权限。':/notfound|找不到|未找到/i.test(feedback)?'未找到麦克风，请检查连接。':/草稿已编辑/.test(feedback)?'草稿已编辑，识别文字已保留。':feedback.length>90?feedback.slice(0,89)+'…':feedback):failed?(advancedMode?'有录音未识别，右键或长按处理。':'识别失败：'+(latestFailedError?(latestFailedError.length>60?latestFailedError.slice(0,59)+'…':latestFailedError):'请检查语音服务配置')):'';
  const cancelGesture=()=>{clearTimeout(gesture.current.timer);gesture.current.timer=null;};
  const showAdvanced=()=>{if(!advancedMode)return;cancelGesture();setOpen(true);navigator.mediaDevices?.enumerateDevices?.().then(all=>setDevices(all.filter(d=>d.kind==='audioinput'))).catch(()=>{});};
  const toggle=()=>{
    if(Date.now()<gesture.current.suppressUntil)return;
    if(active){service.stop().catch(error=>setMessage(error.message??String(error)));return;}
    if(unavailable){setMessage(unavailableReason);return;}
    start();
  };
  const compact=h('div',{style:{...rowStyle,gap:6,minHeight:36}},
    h('button',{
      ref:mic,type:'button',className:'dsh-dictation-mic',
      style:{...dictationMicStyle,...(active?{color:'var(--dsw-alias-label-error, #dc4545)',background:'rgba(220,69,69,.10)'}:{}),opacity:!active&&unavailable?0.55:1},
      'aria-label':label,'aria-pressed':!!active,'aria-expanded':advancedMode?open:undefined,'aria-controls':advancedMode?panelId:undefined,'aria-disabled':!active&&!!unavailable,
      title:(!active&&unavailableReason?unavailableReason:service.starting?'点击取消录音启动':active?(advancedMode?'点击暂停并保存尾段；右键或长按管理录音':'点击结束录音并开始识别'):(advancedMode?(!service.owner?'点击录音，其他标签页空闲时会自动接管；右键或长按管理录音':'点击录音；右键或长按管理录音'):'点击开始录音'))+(advancedMode?'（↓ / Shift+F10）':'')+(failed?' · 有录音未识别':'')+(active&&service.startedAt?' · '+Math.max(0,Math.floor((now-service.startedAt)/1000))+' 秒':''),
      onClick:toggle,
      onContextMenu:advancedMode?event=>{event.preventDefault();gesture.current.suppressUntil=Date.now()+700;showAdvanced();}:undefined,
      onKeyDown:advancedMode?event=>{if(event.key==='ArrowDown'||(event.key==='F10'&&event.shiftKey)){event.preventDefault();showAdvanced();}else if(event.key==='Escape'){event.preventDefault();setOpen(false);}}:undefined,
      onPointerDown:advancedMode?event=>{if(event.button!==0)return;cancelGesture();gesture.current.suppressUntil=0;gesture.current.longPressed=false;gesture.current.x=event.clientX;gesture.current.y=event.clientY;gesture.current.timer=setTimeout(()=>{gesture.current.longPressed=true;gesture.current.suppressUntil=Date.now()+1500;showAdvanced();},500);}:undefined,
      onPointerMove:advancedMode?event=>{if(Math.hypot(event.clientX-gesture.current.x,event.clientY-gesture.current.y)>10)cancelGesture();}:undefined,
      onPointerUp:advancedMode?()=>{if(gesture.current.longPressed)gesture.current.suppressUntil=Date.now()+750;cancelGesture();}:undefined,
      onPointerCancel:advancedMode?cancelGesture:undefined,
      onPointerLeave:advancedMode?cancelGesture:undefined,
    },dictationIcon(service.stopping?'spinner':active?'pause':'mic'),!active&&pending>0&&h('span',{'aria-hidden':true,style:{position:'absolute',right:2,top:2,width:5,height:5,borderRadius:'50%',background:'var(--dsw-alias-label-secondary, #888)'}})),
    pending>0&&h('span',{role:'status','aria-live':'polite','aria-label':pending+' 段录音正在后台识别',style:{display:'inline-flex',alignItems:'center',opacity:.5}},h('span',{style:{display:'inline-flex',width:12,height:12}},dictationIcon('spinner'))),
    warning&&h('span',{role:service.error||emergency||service.blocked||(!advancedMode&&failed)?'alert':'status',style:{fontSize:12,lineHeight:'18px',maxWidth:'min(360px, 70vw)',color:service.error||emergency||service.blocked||(!advancedMode&&failed)?'var(--dsw-alias-label-error, #d34b4b)':'var(--dsw-alias-label-secondary, inherit)'}},warning),
    emergency&&button('下载未保存录音',action(async()=>{await service.stop();downloadBlob(await service.exportAudio(service.currentId,{unsavedOnly:true}),'dictation-unsaved.wav');}),false,{'aria-label':'下载未保存录音，勿刷新页面'})
  );
  return h('div',{style:{display:'inline-flex',flexDirection:'column',alignItems:'flex-start',gap:open?8:0,maxWidth:'100%',width:open?'100%':undefined},'data-dictation-state':service.stopping?'saving':service.starting?'starting':active?'recording':pending?'pending':'idle',onKeyDown:event=>{if(event.key==='Escape'&&open){event.preventDefault();setOpen(false);mic.current?.focus();}}},
    h('style',null,'.dsh-dictation-mic:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))!important}.dsh-dictation-mic:focus-visible{outline:2px solid var(--dsw-alias-label-primary,#5689df);outline-offset:2px}.dsh-dictation-mic[aria-disabled="true"]{cursor:default}.dsh-dictation-spinner{animation:dsh-dictation-spin 1s linear infinite}@keyframes dsh-dictation-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.dsh-dictation-spinner{animation:none}}'),
    compact,
    advancedMode&&open&&h('section',{id:panelId,style:boxStyle,'aria-label':'可靠分段听写'},
    h('div',{style:rowStyle},
      h('strong',null,'录音与恢复'),
      active&&h('span',{role:'status'},service.starting?'正在等待麦克风…':'录音中 · '+Math.max(0,Math.floor((now-service.startedAt)/1000))+' 秒'),
      pending>0&&h('span',null,pending+' 段待识别'),
      button('收起',()=>{setOpen(false);mic.current?.focus();},false)
    ),
    h('div',{style:rowStyle},
      h('label',null,'语音服务 ',h('select',{value:providerId,disabled:active,onChange:e=>{setProviderId(e.target.value);saveSetting('dsh.dictation.provider',e.target.value);setLanguage('auto');saveSetting('dsh.dictation.language','auto');}},h('option',{value:''},'DSH 配置的默认服务'),...((service.catalog?.providers??[]).map(p=>h('option',{key:p.id,value:p.id},p.name||p.id))),providerId&&!(service.catalog?.providers??[]).some(p=>p.id===providerId)&&h('option',{value:providerId},'不可用：'+providerId))),
      h('label',null,'识别语言 ',h('select',{value:language,disabled:active,onChange:e=>{setLanguage(e.target.value);saveSetting('dsh.dictation.language',e.target.value);}},...service.providerLanguages(providerId).map(value=>h('option',{key:value,value},value==='auto'?'自动':value)),!service.providerLanguages(providerId).includes(language)&&h('option',{value:language},'未支持：'+language))),
      button('重新读取语音目录',action(()=>service.refreshCatalog()),busy||active),
      h('label',null,'麦克风 ',h('select',{value:deviceId,disabled:!!service.capture,onChange:e=>{setDeviceId(e.target.value);saveSetting('dsh.dictation.device',e.target.value);}},h('option',{value:''},'系统默认'),...devices.filter(d=>d.deviceId!=='default').map(d=>h('option',{key:d.deviceId,value:d.deviceId},d.label||'麦克风'))))
    ),
    service.catalogWarning&&h('p',{role:'status'},service.catalogWarning),
    h('small',null,'音频先保存到本浏览器，再排队识别；每约 1 秒保存正在录制的尾段。不会自动发送。录音不会自动删除，请在确认后清理。'),
    h('small',null,'刷新恢复后不会自动重复写入草稿；手动插入前请检查已有文字。意外关闭可能损失最后约 1 秒；清理浏览器数据会删除本地录音。手机锁屏或系统休眠仍可能中断采集。'),
    !service.owner&&service.ready&&h('p',{role:'status'},'本页正在待命。点击麦克风可在其他标签页空闲时接管；正在录音、启动或保存的标签页不会被打断。关闭持有任务的标签页后，本页会自动接管，无需刷新。'),
    (message||service.error)&&h('p',{role:'alert',style:{whiteSpace:'pre-wrap',margin:0}},message||service.error),
    service.unsaved.length>0&&button('下载未保存录音（请先保存，勿刷新）',action(async()=>{await service.stop();downloadBlob(await service.exportAudio(service.currentId,{unsavedOnly:true}),'dictation-unsaved.wav');})),
    ...records.map(record=>{
      const chunks=service.chunks.get(record.id)??[];
      const done=chunks.filter(c=>c.status==='done').length,failed=chunks.filter(c=>c.status==='failed');
      const pending=chunks.filter(c=>c.status!=='done').length;
      const text=joinedTranscript(chunks);
      const uninserted=chunks.some(c=>c.status==='done'&&c.text.trim()&&c.delivery!=='applied');
      return h('details',{key:record.id,'data-recording-id':record.id,open:record.id===service.currentId||undefined,style:{borderTop:'1px solid #8884',paddingTop:6}},
        h('summary',null,dictationDate(record.createdAt)+' · '+(record.state==='recording'?'录音中':record.state==='interrupted'?'已中断 / 已恢复':'已停止')+' · '+done+'/'+chunks.length+' 段已识别'+(pending?' · 待处理 '+pending+' 段':'')+(failed.length?' · 有失败片段':'')),
        h('div',{style:{...rowStyle,marginTop:8}},
          button('下载完整录音',action(async()=>{if(service.capture&&service.currentId===record.id)await service.stop();downloadBlob(await service.exportAudio(record.id),'dictation-'+record.createdAt+'.wav');}),busy),
          button('插入未写入文字',insert(record),busy||locked||!uninserted||record.sessionId!==String(sessionId)),
          button('复制全部文字',action(async()=>{await navigator.clipboard.writeText(text);setMessage('已复制识别文字');}),!text),
          failed.length>0&&button('重试失败片段',action(()=>service.retryRecording(record.id)),busy||!service.owner),
          button('删除录音与结果',action(async()=>{if(window.confirm('永久删除这次听写的本地录音和识别结果？已插入草稿的文字不会删除。'))await service.remove(record.id);}),busy||!service.owner||(!!service.capture&&service.currentId===record.id))
        ),
        record.sessionId!==String(sessionId)&&h('small',null,'此录音来自其他会话，可复制文字或下载音频。'),
        failed.map(c=>h('p',{key:c.id,role:'alert'},'第 '+(c.seq+1)+' 段失败（音频已保留）：'+c.error)),
        h('textarea',{readOnly:true,value:text,rows:Math.min(8,Math.max(2,text.split('\n').length)),style:{width:'100%',marginTop:8,boxSizing:'border-box',background:'transparent',color:'inherit'},'aria-label':'已保留的识别文字'})
      );
    })
    )
  );
}

function DictationConfigPage(props){
  const {ctx,service,view}=props;
  const formController=ctx?.configForms?.get?.('ui-dictation');
  const [snapshot,setSnapshot]=React.useState(()=>{
    if(formController?.getSnapshot)return formController.getSnapshot()||{};
    if(props.form?.state)return props.form.state;
    return {};
  });

  React.useEffect(()=>{
    if(formController?.subscribe){
      setSnapshot(formController.getSnapshot()||{});
      return formController.subscribe(()=>{
        setSnapshot(formController.getSnapshot()||{});
      });
    }
    if(props.form?.state){
      setSnapshot(props.form.state);
    }
  },[formController,props.form?.state]);

  const remoteAsr=snapshot?.value?.asr||{};
  const remoteEnabled=Boolean(remoteAsr.enabled);
  const remoteEndpoint=remoteAsr.endpoint||'';
  const remoteModel=remoteAsr.model||'';
  const remoteHostHeader=remoteAsr.hostHeader||'';
  const remoteTimeoutMs=remoteAsr.timeoutMs??180000;
  const remoteProviderId=remoteAsr.providerId||'dsh-dictation-compatible';
  const remoteProviderName=remoteAsr.providerName||'Compatible ASR';
  const remoteLanguages=Array.isArray(remoteAsr.languages)?remoteAsr.languages.join(', '):'auto';
  const remoteAdvancedMode=Boolean(remoteAsr.advancedMode);

  if(view==='summary'){
    return remoteEnabled
      ?(remoteModel?(remoteModel+' ('+(remoteEndpoint||'默认端点')+')'):'已配置并启用')
      :'未启用服务端 ASR 适配器';
  }

  const [draft,setDraft]=React.useState({
    enabled:remoteEnabled,
    endpoint:remoteEndpoint,
    model:remoteModel,
    apiKey:'',
    hostHeader:remoteHostHeader,
    timeoutMs:String(remoteTimeoutMs),
    providerId:remoteProviderId,
    providerName:remoteProviderName,
    languages:remoteLanguages,
    advancedMode:remoteAdvancedMode,
  });
  const [dirty,setDirty]=React.useState(false);
  const [saving,setSaving]=React.useState(false);
  const [feedback,setFeedback]=React.useState(null);

  React.useEffect(()=>{
    if(!dirty){
      setDraft({
        enabled:remoteEnabled,
        endpoint:remoteEndpoint,
        model:remoteModel,
        apiKey:'',
        hostHeader:remoteHostHeader,
        timeoutMs:String(remoteTimeoutMs),
        providerId:remoteProviderId,
        providerName:remoteProviderName,
        languages:remoteLanguages,
        advancedMode:remoteAdvancedMode,
      });
    }
  },[remoteEnabled,remoteEndpoint,remoteModel,remoteHostHeader,remoteTimeoutMs,remoteProviderId,remoteProviderName,remoteLanguages,remoteAdvancedMode,dirty]);

  const updateField=(key,val)=>{
    setDraft(prev=>({...prev,[key]:val}));
    setDirty(true);
    setFeedback(null);
  };

  const handleReset=()=>{
    setDraft({
      enabled:remoteEnabled,
      endpoint:remoteEndpoint,
      model:remoteModel,
      apiKey:'',
      hostHeader:remoteHostHeader,
      timeoutMs:String(remoteTimeoutMs),
      providerId:remoteProviderId,
      providerName:remoteProviderName,
      languages:remoteLanguages,
      advancedMode:remoteAdvancedMode,
    });
    setDirty(false);
    setFeedback(null);
  };

  const handleSave=async(e)=>{
    if(e)e.preventDefault();
    if(saving)return;

    if(draft.enabled){
      if(!draft.endpoint.trim()){
        setFeedback({type:'error',text:'启用时必须填写转写服务接口地址 (Endpoint)'});
        return;
      }
      if(!draft.model.trim()){
        setFeedback({type:'error',text:'启用时必须填写模型标识 (Model)'});
        return;
      }
      if(!/^https?:\/\//i.test(draft.endpoint.trim())){
        setFeedback({type:'error',text:'转写接口地址必须以 http:// 或 https:// 开头'});
        return;
      }
    }

    const parsedTimeout=parseInt(draft.timeoutMs,10);
    const timeoutVal=Number.isFinite(parsedTimeout)&&parsedTimeout>=50&&parsedTimeout<=300000?parsedTimeout:180000;
    const parsedLangs=draft.languages.split(/[,，\s]+/).map(s=>s.trim()).filter(Boolean);
    const langsVal=parsedLangs.length>0?parsedLangs:['auto'];

    const ops=[
      {op:'set',path:['asr','enabled'],value:Boolean(draft.enabled)},
      {op:'set',path:['asr','endpoint'],value:draft.endpoint.trim()},
      {op:'set',path:['asr','model'],value:draft.model.trim()},
      {op:'set',path:['asr','hostHeader'],value:draft.hostHeader.trim()},
      {op:'set',path:['asr','timeoutMs'],value:timeoutVal},
      {op:'set',path:['asr','providerId'],value:draft.providerId.trim()||'dsh-dictation-compatible'},
      {op:'set',path:['asr','providerName'],value:draft.providerName.trim()||'Compatible ASR'},
      {op:'set',path:['asr','languages'],value:langsVal},
      {op:'set',path:['asr','advancedMode'],value:Boolean(draft.advancedMode)},
    ];
    if(draft.apiKey.trim()){
      ops.push({op:'set',path:['asr','apiKey'],value:draft.apiKey.trim()});
    }

    setSaving(true);
    setFeedback(null);
    try{
      const revision=snapshot?.revision;
      let ok=false;
      if(formController?.mutate){
        ok=await formController.mutate(ops,revision);
      }else if(props.form?.mutate){
        ok=await props.form.mutate(ops,revision);
      }
      if(ok){
        setDirty(false);
        setDraft(prev=>({...prev,apiKey:''}));
        setFeedback({type:'success',text:'配置已成功保存并即刻生效，已写入服务端配置。'});
        if(service?.refreshCatalog)service.refreshCatalog().catch(()=>{});
      }else{
        setFeedback({type:'error',text:'保存失败：服务端未接受此配置更新，请检查输入参数。'});
      }
    }catch(err){
      setFeedback({type:'error',text:'保存出错：'+(err.message||String(err))});
    }finally{
      setSaving(false);
    }
  };

  const isReadOnly=snapshot?.writable===false;

  return h('div',{className:'dsh-dictation-config','data-dictation-config':true},
    h('style',null,`
      .dsh-dictation-config{display:flex;flex-direction:column;gap:14px;width:100%;max-width:720px;padding:18px 20px;border:1px solid var(--border-color,#cbd5e1);border-radius:8px;background:var(--dsw-alias-interactive-bg,transparent);color:var(--dsw-alias-label-primary,inherit);box-sizing:border-box;font-size:13px;line-height:1.5}
      .dsh-dictation-config-head{border-bottom:1px solid var(--border-color,#e2e8f0);padding-bottom:10px}
      .dsh-dictation-config-title{font-size:15px;font-weight:600;margin:0 0 4px 0}
      .dsh-dictation-config-desc{font-size:12px;color:var(--dsw-alias-label-secondary,#64748b);margin:0}
      .dsh-dictation-field{display:flex;flex-direction:column;gap:4px}
      .dsh-dictation-field-toggle{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,0.06))}
      .dsh-dictation-label{font-weight:500;font-size:13px}
      .dsh-dictation-hint{font-size:12px;color:var(--dsw-alias-label-secondary,#64748b)}
      .dsh-dictation-input{width:100%;padding:6px 10px;font-size:13px;line-height:1.4;border:1px solid var(--border-color,#cbd5e1);border-radius:6px;background:var(--dsw-alias-interactive-bg,transparent);color:inherit;box-sizing:border-box;outline:none}
      .dsh-dictation-input:focus{border-color:var(--dsw-alias-brand-primary,#2563eb)}
      .dsh-dictation-actions{display:flex;align-items:center;gap:10px;padding-top:6px}
      .dsh-dictation-btn-primary{padding:6px 16px;font-size:13px;font-weight:500;border-radius:6px;border:1px solid transparent;background:var(--dsw-alias-brand-primary,#2563eb);color:#fff;cursor:pointer}
      .dsh-dictation-btn-primary:disabled{opacity:0.55;cursor:not-allowed}
      .dsh-dictation-btn-secondary{padding:6px 14px;font-size:13px;border-radius:6px;border:1px solid var(--border-color,#cbd5e1);background:transparent;color:inherit;cursor:pointer}
      .dsh-dictation-feedback{padding:8px 12px;border-radius:6px;font-size:13px}
      .dsh-dictation-feedback.success{background:rgba(34,197,94,0.12);border:1px solid rgba(34,197,94,0.3);color:var(--dsw-alias-label-success,#16a34a)}
      .dsh-dictation-feedback.error{background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.3);color:var(--dsw-alias-label-error,#dc2626)}
    `),
    h('div',{className:'dsh-dictation-config-head'},
      h('h4',{className:'dsh-dictation-config-title'},'兼容 ASR 服务端适配器配置'),
      h('p',{className:'dsh-dictation-config-desc'},'配置与管理 DSH 服务端 ASR 转写后端。保存后即刻热更新，并持久化写入 cordis.patch.yml。')
    ),
    isReadOnly&&h('div',{className:'dsh-dictation-feedback error',role:'status'},'当前部署的配置为只读，无法在线保存修改。'),
    feedback&&h('div',{className:'dsh-dictation-feedback '+feedback.type,role:feedback.type==='error'?'alert':'status'},feedback.text),
    h('div',{className:'dsh-dictation-field-toggle'},
      h('input',{
        id:'dictation-config-enabled',
        type:'checkbox',
        checked:draft.enabled,
        disabled:isReadOnly,
        onChange:e=>updateField('enabled',e.target.checked),
        style:{width:16,height:16,cursor:'pointer'}
      }),
      h('label',{htmlFor:'dictation-config-enabled',className:'dsh-dictation-label',style:{cursor:'pointer'}},'启用服务端兼容 ASR 适配器'),
      h('span',{className:'dsh-dictation-hint'},draft.enabled?'已开启（将在 speech 服务目录中注册适配器）':'已关闭（默认沿用 DSH 既有提供方）')
    ),
    h('div',{className:'dsh-dictation-field'},
      h('label',{className:'dsh-dictation-label',htmlFor:'dictation-config-endpoint'},'转写接口地址 (Endpoint)'),
      h('input',{
        id:'dictation-config-endpoint',
        className:'dsh-dictation-input',
        type:'text',
        placeholder:'https://asr.example.com/v1/audio/transcriptions',
        value:draft.endpoint,
        disabled:isReadOnly,
        onChange:e=>updateField('endpoint',e.target.value)
      }),
      h('span',{className:'dsh-dictation-hint'},'OpenAI 兼容的 audio/transcriptions HTTP(S) 完整接口地址。')
    ),
    h('div',{className:'dsh-dictation-field'},
      h('label',{className:'dsh-dictation-label',htmlFor:'dictation-config-model'},'模型标识 (Model)'),
      h('input',{
        id:'dictation-config-model',
        className:'dsh-dictation-input',
        type:typeof draft.model==='string'?'text':'text',
        placeholder:'compatible-asr-model',
        value:draft.model,
        disabled:isReadOnly,
        onChange:e=>updateField('model',e.target.value)
      }),
      h('span',{className:'dsh-dictation-hint'},'后端推理服务接受的模型名称。')
    ),
    h('div',{className:'dsh-dictation-field'},
      h('label',{className:'dsh-dictation-label',htmlFor:'dictation-config-apikey'},'鉴权密钥 (API Key)'),
      h('input',{
        id:'dictation-config-apikey',
        className:'dsh-dictation-input',
        type:'password',
        autoComplete:'new-password',
        placeholder:'留空保持当前配置不变',
        value:draft.apiKey,
        disabled:isReadOnly,
        onChange:e=>updateField('apiKey',e.target.value)
      }),
      h('span',{className:'dsh-dictation-hint'},'可选 Bearer Token。schema 标记为 secret，在前端读取时脱敏。')
    ),
    h('div',{className:'dsh-dictation-field'},
      h('label',{className:'dsh-dictation-label',htmlFor:'dictation-config-hostheader'},'网关 Host 请求头 (Host Header)'),
      h('input',{
        id:'dictation-config-hostheader',
        className:'dsh-dictation-input',
        type:'text',
        placeholder:'asr.example.com',
        value:draft.hostHeader,
        disabled:isReadOnly,
        onChange:e=>updateField('hostHeader',e.target.value)
      }),
      h('span',{className:'dsh-dictation-hint'},'可选可信网关 Host 请求头（用于内部集群 Ingress 虚拟主机路由转发）。')
    ),
    h('div',{className:'dsh-dictation-field'},
      h('label',{className:'dsh-dictation-label',htmlFor:'dictation-config-timeout'},'请求超时 (Timeout, 毫秒)'),
      h('input',{
        id:'dictation-config-timeout',
        className:'dsh-dictation-input',
        type:'number',
        min:50,
        max:300000,
        step:1000,
        placeholder:'180000',
        value:draft.timeoutMs,
        disabled:isReadOnly,
        onChange:e=>updateField('timeoutMs',e.target.value)
      }),
      h('span',{className:'dsh-dictation-hint'},'单次音频转写请求超时时间，范围 50 - 300000 毫秒（默认 180000 毫秒）。')
    ),
    h('div',{className:'dsh-dictation-field'},
      h('label',{className:'dsh-dictation-label',htmlFor:'dictation-config-providerid'},'提供方标识 (Provider ID)'),
      h('input',{
        id:'dictation-config-providerid',
        className:'dsh-dictation-input',
        type:'text',
        placeholder:'dsh-dictation-compatible',
        value:draft.providerId,
        disabled:isReadOnly,
        onChange:e=>updateField('providerId',e.target.value)
      }),
      h('span',{className:'dsh-dictation-hint'},'speech 服务目录中的唯一注册标识。')
    ),
    h('div',{className:'dsh-dictation-field'},
      h('label',{className:'dsh-dictation-label',htmlFor:'dictation-config-providername'},'显示名称 (Provider Name)'),
      h('input',{
        id:'dictation-config-providername',
        className:'dsh-dictation-input',
        type:'text',
        placeholder:'Compatible ASR',
        value:draft.providerName,
        disabled:isReadOnly,
        onChange:e=>updateField('providerName',e.target.value)
      }),
      h('span',{className:'dsh-dictation-hint'},'在语音听写设置菜单中展示的提供方名称。')
    ),
    h('div',{className:'dsh-dictation-field'},
      h('label',{className:'dsh-dictation-label',htmlFor:'dictation-config-languages'},'支持语言列表 (Languages)'),
      h('input',{
        id:'dictation-config-languages',
        className:'dsh-dictation-input',
        type:'text',
        placeholder:'auto, zh, en, yue, ja, ko',
        value:draft.languages,
        disabled:isReadOnly,
        onChange:e=>updateField('languages',e.target.value)
      }),
      h('span',{className:'dsh-dictation-hint'},'逗号分隔的语言代码列表，首项建议保留 auto。')
    ),
    h('div',{className:'dsh-dictation-field'},
      h('div',{className:'dsh-dictation-field-toggle'},
        h('input',{
          id:'dictation-config-advanced',
          type:'checkbox',
          checked:draft.advancedMode,
          disabled:isReadOnly,
          onChange:e=>updateField('advancedMode',e.target.checked),
          style:{width:16,height:16,cursor:'pointer'}
        }),
        h('label',{htmlFor:'dictation-config-advanced',className:'dsh-dictation-label',style:{cursor:'pointer'}},'启用分段录音与高级恢复面板 (Advanced Mode)')
      ),
      h('span',{className:'dsh-dictation-hint'},'开启后支持长按/右键麦克风打开分段录音、服务/语言选择与历史恢复面板；关闭时仅保留简洁的一键开始与结束识别。')
    ),
    h('div',{className:'dsh-dictation-actions'},
      h('button',{
        type:'button',
        className:'dsh-dictation-btn-primary',
        disabled:isReadOnly||saving||!dirty,
        onClick:handleSave
      },saving?'正在保存…':'保存配置'),
      dirty&&h('button',{
        type:'button',
        className:'dsh-dictation-btn-secondary',
        disabled:isReadOnly||saving,
        onClick:handleReset
      },'放弃更改')
    )
  );
}

function registerUi(ctx){
  const service=new DictationService(ctx.remote);
  const configForm=ctx.configForms?.get?.('ui-dictation');
  ctx.effect(()=>()=>service.dispose());
  service.initialize();
  ctx.slots.inject('conversation.input.activity',()=>ctx.slots.register({name:'conversation.input.activity',inject:()=>({service,configForm})},DictationInput));

  function ConfigPage(props){
    return h(DictationConfigPage,{...props,ctx,service});
  }

  ctx.slots.inject('plugins.row.config',()=>ctx.slots.register({
    name:'plugins.row.config',
    key:'dsh-dictation#ui-dictation',
    locale:'dictation',
  },ConfigPage));

  ctx.slots.inject('plugins.bundle.config',()=>ctx.slots.register({
    name:'plugins.bundle.config',
    key:'dsh-dictation',
    locale:'dictation',
  },ConfigPage));
}

export async function apply(ctx){
  const disposeRemote=await ctx.remote.$mount(TYPERT_REMOTE);
  const ui=ctx.inject(['remote.speech','slots'],registerUi);
  try{await ui;}catch(error){await ui.dispose();await disposeRemote();throw error;}
  return async()=>{await ui.dispose();await disposeRemote();};
}
