/* Explicit, version-gated inspection adapter. No arbitrary selector, route or command is accepted. */
(function attachDeepScan() {
  globalThis.__GRAVITYBOX_ATTACH_DEEP_SCAN__=attachDeepScan;
  const engine=globalThis.__GRAVITYBOX_ENGINE_V1__,boot=globalThis.__GRAVITYBOX_BOOT__;
  if(!engine||engine.deepScan)return;
  const fixture=boot?.path==='/fixture';let current;
  const blocked='script,style,[data-gravitybox-protect],[data-message-id],[data-message-author-role],[data-testid*="conversation-row"],[data-testid*="message"],[data-testid="project-header"],.gravitybox-project-name,.markdown,.prose,pre,code,.monaco-editor,.xterm';
  const ids=['history','marketplace','installed','settings-open','settings-general','settings-app','settings-appearance','settings-models','settings-shortcuts','settings-close','automations','model-open','model-usage','model-close'];
  const text=e=>(e?.getAttribute('aria-label')||e?.textContent||'').replace(/\s+/g,' ').trim();
  const foldKey=s=>String(s).toLowerCase().replace(/[\u2018\u2019]/g,"'");
  let cachedDictSource=null,foldedDictEntries=new Map();
  const lookupDict=name=>{
    const entries=globalThis.__GRAVITYBOX_BOOT__?.dictionary?.entries;
    if(!entries||typeof name!=='string')return undefined;
    if(entries[name]!==undefined)return entries[name];
    if(entries!==cachedDictSource){
      cachedDictSource=entries;
      foldedDictEntries=new Map(Object.entries(entries).map(([k,v])=>[foldKey(k),v]));
    }
    return foldedDictEntries.get(foldKey(name));
  };
  const namesFor=names=>[...new Set(names.flatMap(name=>[name,lookupDict(name)]).filter(value=>typeof value==='string'))];
  const isEn=()=>{
    const bootLoc=globalThis.__GRAVITYBOX_BOOT__?.locale;
    if(typeof bootLoc==='string'&&bootLoc.trim())return bootLoc.trim().toLowerCase().startsWith('en');
    return String(engine.getLanguageMode?.()||'zh').toLowerCase().startsWith('en');
  };
  const msg=(zh,en)=>isEn()?en:zh;
  const visible=e=>!!e?.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  function hasDraft(){return engine.draftState().busy;}
  async function editorHash(){const values=[...document.querySelectorAll('input,textarea,[contenteditable]:not([contenteditable="false"])')].map(e=>e.value??e.textContent??'');const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(values)));return [...new Uint8Array(hash)].map(n=>n.toString(16).padStart(2,'0')).join('');}
  const route=()=>/^\/customizations(?:\/installed)?$/.test(location.pathname)?location.pathname:location.pathname==='/history'?'/history':location.pathname.startsWith('/settings')?'/settings':location.pathname==='/sidecars'?'/automations':'/other';
  function choose(selector,names,root=document){const labels=namesFor(names);const candidates=[...root.querySelectorAll(selector)].filter(e=>visible(e)&&!e.closest(blocked)&&!e.disabled&&e.getAttribute('aria-disabled')!=='true'&&labels.includes(text(e)));return candidates.length===1?candidates[0]:null;}
  function sidebar(){const labels=namesFor(['Sidebar','侧边栏']);return [...document.querySelectorAll('[aria-label]')].find(e=>labels.includes(e.getAttribute('aria-label'))&&visible(e));}
  function settingsNavigation(){const heading=[...document.querySelectorAll('h1')].find(e=>visible(e)&&namesFor(['Settings','设置']).includes(text(e)));let root=heading?.parentElement;for(let n=0;n<6&&root;n++,root=root.parentElement){const buttons=[...root.querySelectorAll('button')].map(text);if(namesFor(['General','通用']).some(s=>buttons.includes(s))&&namesFor(['Appearance','外观']).some(s=>buttons.includes(s)))return root;}return null;}
  function settingsVisible(){return [...document.querySelectorAll('h1,[role="heading"][aria-level="1"]')].some(e=>visible(e)&&namesFor(['Settings','设置']).includes(text(e)));}
  function scrollables(){return [document.scrollingElement,...document.querySelectorAll('div,main,section')].filter(e=>e&&visible(e)&&e.scrollHeight>e.clientHeight+4&&e.clientHeight>100&&!e.closest(blocked)&&e.getBoundingClientRect().width>innerWidth*.45&&(e===document.scrollingElement||/(auto|scroll)/.test(getComputedStyle(e).overflowY)));}
  function intercept(event){if(event.isTrusted&&current)current.intervened=true;}
  function guard(){if(!current)throw new Error(msg('尚未开始界面巡检','UI scan has not started'));if(current.intervened)return false;if(hasDraft()){current.intervened=true;return false;}return true;}
  function escapeOwned() {
    const focused = document.activeElement;
    const event = () => new KeyboardEvent('keydown', {key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true,cancelable:true});
    if (focused && focused !== document.body && focused !== document.documentElement) focused.dispatchEvent(event());
    else document.dispatchEvent(event());
  }
  async function waitClosed(isOpen) {
    const deadline=performance.now()+800;
    do {if(!current||current.intervened)return false;if(!isOpen())return true;await wait(100);} while(performance.now()<deadline);
    return !isOpen();
  }
  async function closeSettings() {
    if(!current?.settingsOwned)return true;
    const navigation=settingsNavigation(),heading=[...document.querySelectorAll('h1,[role="heading"][aria-level="1"]')].find(e=>visible(e)&&namesFor(['Settings','设置']).includes(text(e)));
    const root=heading?.closest('[data-testid="settings-root"],[data-testid="settings-dialog"],[role="dialog"]')||navigation;
    const button=root&&choose('button,[role="button"]',['Close','关闭','Close settings','关闭设置','Back','返回','Done','完成'],root);
    if(button)button.click();else escapeOwned();
    if(await waitClosed(settingsVisible))return true;
    const saved=current?.settingsRoute;
    // Only undo our own single settings-route push. Never blindly navigate back from a user page.
    if(current&&!current.intervened&&saved&&/^\/settings(?:\/|$)/.test(location.pathname)&&saved.url!==location.href){
      const index=globalThis.navigation?.currentEntry?.index;
      const delta=Number.isInteger(index)&&Number.isInteger(saved.index)?index-saved.index:history.length-saved.length;
      if(delta===1&&new URL(saved.url).origin===location.origin){history.back();return await waitClosed(()=>location.href!==saved.url||settingsVisible());}
    }
    return !settingsVisible();
  }
  async function closeModel() {
    if(!current?.modelOwned)return true;
    const isOpen=()=>visible(document.querySelector('[data-testid="model-selector-panel"]'));
    if(!isOpen())return true;
    escapeOwned();if(await waitClosed(isOpen))return true;
    const trigger=document.querySelector('[data-testid="model-selector-trigger"]');
    if(!trigger||!visible(trigger)||current?.intervened)return false;
    for(const type of ['pointerdown','mousedown','mouseup','click']){
      if(!isOpen()||!current||current.intervened)break;
      const EventType=type==='pointerdown'?PointerEvent:MouseEvent;
      trigger.dispatchEvent(new EventType(type,{bubbles:true,cancelable:true,button:0,buttons:type.endsWith('down')?1:0,pointerType:'mouse',isPrimary:true}));
      await wait(50);
    }
    return await waitClosed(isOpen);
  }
  function reached(id){
    if(fixture)return true;
    const paths={history:'/history',marketplace:'/customizations',installed:'/customizations/installed'};
    if(paths[id])return location.pathname===paths[id];
    if(id==='settings-open')return settingsVisible();
    if(id.startsWith('settings-')){const patterns={'settings-general':/^(General|通用)$/,'settings-app':/^(App|Application|应用|应用设置)$/,'settings-appearance':/^(Appearance|外观)$/,'settings-models':/Models.*Usage|模型与(?:用量|使用量)/i,'settings-shortcuts':/Keyboard|Keybindings|快捷键/i};return settingsVisible()&&[...document.querySelectorAll('h2,[role="heading"][aria-level="2"]')].some(e=>visible(e)&&patterns[id]?.test(text(e)));}
    if(id==='automations')return [...document.querySelectorAll('h1,[role="heading"]')].some(e=>visible(e)&&['Automations','自动化'].includes(text(e)));
    if(id==='model-open')return visible(document.querySelector('[data-testid="model-selector-panel"]'));
    if(id==='model-usage')return /Weekly Limit Remaining|每周剩余限额/.test(document.querySelector('[data-testid="model-selector-panel"]')?.textContent??'');
    return false;
  }
  function catalog(){
    if(!fixture)return engine.pluginCatalog?.()??[];
    const entries=[];const root=document.querySelector('[data-gravitybox-deep-catalog]');
    if(!root)return entries;
    for(const anchor of root.querySelectorAll('a[href]')){
      const url=new URL(anchor.href,location.href);if(url.origin!==location.origin||!/^\/customizations\/(?:plugins\/[\w.-]+|marketplaces\/[\w.-]+\/plugins\/[\w.-]+)$/.test(url.pathname)||anchor.closest(blocked))continue;
      const id=url.pathname.split('/').at(-1);let card=anchor.parentElement;
      const first=document.createTreeWalker(anchor,NodeFilter.SHOW_TEXT);let name=anchor.getAttribute('aria-label')||'';
      while(!name&&first.nextNode()){if(!first.currentNode.parentElement.closest('svg'))name=first.currentNode.nodeValue.trim();}
      if(!name)continue;
      for(let n=0;n<7&&card;n++,card=card.parentElement){
        if(card.querySelectorAll('a[href*="/plugins/"]').length!==1||card.querySelector('input,textarea,[contenteditable="true"],pre,code'))break;
        const parts=[];const walker=document.createTreeWalker(card,NodeFilter.SHOW_TEXT);
        while(walker.nextNode()){const node=walker.currentNode;if(node.parentElement.closest(blocked+',button,svg,[role="button"]'))continue;const value=node.nodeValue.trim();if(value&&value!==name&&!['Install','安装','Installed','已安装','Official','官方'].includes(value))parts.push(value);}
        const description=parts.join(' ').replace(/\s+/g,' ').trim();
        if(description){entries.push({id,name:name.slice(0,160),description:description.slice(0,2000),truncated:description.length>2000,source:location.pathname.endsWith('/installed')?'installed-view':'marketplace-view'});break;}
      }
      if(entries.length>=250)break;
    }return entries;
  }
  engine.deepScan={
    plan(){return ids;},
    async begin(keys=[]){
      if(current)return{ok:false,message:msg('已有界面遍历正在进行','UI traversal already in progress')};
      if(hasDraft())return{ok:false,message:msg('请先保存草稿或结束生成；深度扫描不会清空输入框。','Save unsent drafts or wait for generation to finish; deep scan will not clear input.')};
      if([...document.querySelectorAll('[role="dialog"],[role="menu"]')].some(visible)||settingsVisible())return{ok:false,message:msg('请先关闭现有弹窗和菜单，并返回普通对话页面。','Close open dialogs and menus and return to a conversation view first.')};
      if(choose('button',['Stop generating','停止生成','Stop','停止']))return{ok:false,message:msg('请等待当前回复生成完成。','Wait for the current response to finish generating.')};
      const focused=document.activeElement;const scroll=scrollables().slice(0,20).map(e=>({element:e,id:e.getAttribute('data-testid'),top:e.scrollTop,left:e.scrollLeft}));
      current={url:location.href,length:history.length,index:globalThis.navigation?.currentEntry?.index,hash:await editorHash(),model:document.querySelector('[data-testid="model-selector-trigger"]')?.getAttribute('aria-label')??null,scroll,focused,keys,intervened:false,settingsOwned:false,modelOwned:false,lastURL:location.href};
      for(const type of ['pointerdown','keydown','input','compositionstart','wheel'])document.addEventListener(type,intercept,true);
      return{ok:true,message:msg('已准备只读界面遍历','Read-only UI traversal ready')};
    },
    async step(id){
      if(!ids.includes(id))return{ok:false,message:msg('入口未在适配清单中','Step entry not in supported list')};
      if(!guard())return{ok:false,userIntervened:true,message:msg('用户已接管界面','User took control of UI')};
      const test=fixture?document.querySelector(`[data-gravitybox-deep-step="${id}"]`):null;
      let element;
      if(test)element=test;
      else if(['history','marketplace','installed'].includes(id)){
        const target={history:'/history',marketplace:'/customizations',installed:'/customizations/installed'}[id];
        const links=[...document.querySelectorAll('a[href]')].filter(e=>{const u=new URL(e.href,location.href);return u.origin===location.origin&&u.pathname===target&&!u.search&&visible(e)&&!e.closest(blocked);});
        if(links.length===1)element=links[0];
      }else if(id==='settings-open'){const side=sidebar();if(side)element=choose('button',['Settings','设置'],side);if(element){current.settingsOwned=true;current.settingsRoute={url:location.href,index:globalThis.navigation?.currentEntry?.index,length:history.length};}}
      else if(id==='settings-close'){const ok=await closeSettings();if(ok)current.settingsOwned=false;return{ok,message:ok?msg('设置已关闭','Settings closed'):msg('设置关闭入口不可用','Settings close control unavailable')};}
      else if(id.startsWith('settings-')){
        if(!current.settingsOwned||!settingsVisible())return{ok:false,message:msg('设置未打开，已跳过','Settings not open; skipped')};
        const labels={'settings-general':['General','通用'],'settings-app':['App','Application','应用','应用设置'],'settings-appearance':['Appearance','外观'],'settings-models':['Models','Models & Usage','模型','模型与使用量','模型与用量','驱动模型'],'settings-shortcuts':['Keyboard Shortcuts','Keyboard shortcuts','Keybindings','快捷键','键盘快捷键','键盘快捷方式']}[id];
        const navigation=settingsNavigation();if(labels&&navigation)element=choose('button',labels,navigation);
      }else if(id==='automations'){const side=sidebar();if(side)element=choose('button',['Automations','自动化'],side);}
      else if(id==='model-open'){element=document.querySelector('[data-testid="model-selector-trigger"]');if(element&&visible(element))current.modelOwned=true;else element=null;}
      else if(id==='model-usage'){
        if(!current.modelOwned)return{ok:false,message:msg('模型菜单未打开，已跳过','Model menu not open; skipped')};
        element=choose('[role="menuitem"]',['View Usage','查看用量']);
        if(element){element.focus();element.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',code:'ArrowRight',bubbles:true}));await wait(150);if(!reached(id)){element.dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerType:'mouse'}));await wait(150);}if(!reached(id))element.click();}
      }else if(id==='model-close'){await closeModel();await wait(150);const ok=!visible(document.querySelector('[data-testid="model-selector-panel"]'));if(ok)current.modelOwned=false;return{ok,message:ok?msg('模型菜单已关闭','Model menu closed'):msg('模型菜单关闭未确认','Model menu closure unconfirmed')};}
      if(!element)return{ok:false,message:msg('当前版本或账号下未找到唯一安全入口','No unique safe control found for current version or account')};
      if(id!=='model-usage')element.click();
      await wait(250);
      for(let n=0;n<8&&!reached(id)&&!current.intervened;n++)await wait(150);
      if(!current)return{ok:false,message:msg('页面上下文已变化','Page context changed')};
      const catalogue=['marketplace','installed'].includes(id)&&(!fixture||document.querySelector('[data-gravitybox-deep-catalog]'));
      if(catalogue)for(let n=0;n<30&&!catalog().length&&!current.intervened;n++)await wait(150);
      current.lastURL=location.href;current.lastStep=id;
      const ok=reached(id),limited=ok&&catalogue&&!catalog().length;return{ok,limited,userIntervened:current.intervened,message:limited?msg('目录展示说明未就绪或为空，已标记待检查','Catalog descriptions empty or not ready; flagged for review'):ok?msg('已打开并检查，未执行安装、发送或账号操作','Opened and inspected; no install, send, or account action performed'):msg('入口触发后未确认目标界面，已标记受限','Target view unconfirmed after click; flagged as limited')};
    },
    sample(){if(!guard())return{userIntervened:true};const candidates=engine.collectUntranslated();const keys=[...new Set([...current.keys,...candidates.map(e=>e.key)])];return{route:route(),audit:engine.auditUi(keys),plugins:catalog(),candidates};},
    async scroll(){
      if(!guard())return{more:false,userIntervened:true};
      let list=scrollables();if(current.lastStep==='model-usage')list=[...document.querySelectorAll('[data-testid="model-selector-panel"] [role="menu"] div')].filter(e=>visible(e)&&e.scrollHeight>e.clientHeight+4&&e.clientHeight>60&&/(auto|scroll)/.test(getComputedStyle(e).overflowY));
      const element=list.sort((a,b)=>b.clientHeight-a.clientHeight)[0];if(!element)return{more:false};
      const before=element.scrollTop;element.scrollTop=Math.min(element.scrollHeight-element.clientHeight,before+element.clientHeight*.8);await wait(180);
      return{more:element.scrollTop>before+1};
    },
    async finish(){
      if(!current)return{routeRestored:false,editorsMatch:false,scrollRestored:0,userIntervened:false,message:msg('页面上下文不可用，恢复情况待确认','Page context unavailable; restoration unconfirmed')};
      const saved=current;
      try {
        if(saved.intervened)return{routeRestored:false,editorsMatch:false,scrollRestored:0,userIntervened:true,message:msg('用户已接管，保留用户当前界面；没有清空或覆盖输入。','User took control; kept current view without clearing or overwriting input.')};
        await closeModel();await closeSettings();await wait(150);
        if(saved.intervened)return{routeRestored:false,editorsMatch:false,scrollRestored:0,userIntervened:true,message:msg('用户已接管，保留用户当前界面；没有清空或覆盖输入。','User took control; kept current view without clearing or overwriting input.')};
        const index=globalThis.navigation?.currentEntry?.index;
        const delta=Number.isInteger(index)&&Number.isInteger(saved.index)?index-saved.index:history.length-saved.length;
        if(location.href!==saved.url&&location.href===saved.lastURL&&delta>0&&delta<=40){history.go(-delta);for(let n=0;n<20&&location.href!==saved.url&&!saved.intervened;n++)await wait(100);}
        if(saved.intervened)return{routeRestored:false,editorsMatch:false,scrollRestored:0,userIntervened:true,message:msg('用户已接管，保留用户当前界面；没有清空或覆盖输入。','User took control; kept current view without clearing or overwriting input.')};
        const routeRestored=location.href===saved.url;let restored=0;
        if(routeRestored){for(const item of saved.scroll){let element=item.element.isConnected?item.element:null;if(!element&&item.id&&/^[\w-]+$/.test(item.id))element=document.querySelector(`[data-testid="${item.id}"]`);if(element){element.scrollTop=item.top;element.scrollLeft=item.left;restored++;}}if(saved.focused?.isConnected)saved.focused.focus({preventScroll:true});}
        const editorsMatch=routeRestored&&(await editorHash())===saved.hash;const modelMatch=(document.querySelector('[data-testid="model-selector-trigger"]')?.getAttribute('aria-label')??null)===saved.model;
        return{routeRestored,editorsMatch,modelMatch,scrollRestored:restored,scrollExpected:saved.scroll.length,userIntervened:false,message:routeRestored&&editorsMatch&&modelMatch?msg('已恢复原页面，编辑区哈希和模型选择一致。','Original view restored with matching editor hash and model selection.'):msg('页面、编辑区或模型选择恢复未完全确认，请检查当前窗口；没有强制改写内容。','View, editor, or model restoration partially unconfirmed; check the current window without forced changes.')};
      } finally {
        for(const type of ['pointerdown','keydown','input','compositionstart','wheel'])document.removeEventListener(type,intercept,true);
        if(current===saved)current=null;
      }
    }
  };
  const dispose=engine.dispose.bind(engine);engine.dispose=(...args)=>{for(const type of ['pointerdown','keydown','input','compositionstart','wheel'])document.removeEventListener(type,intercept,true);current=null;delete globalThis.__GRAVITYBOX_ATTACH_DEEP_SCAN__;return dispose(...args);};
})();
