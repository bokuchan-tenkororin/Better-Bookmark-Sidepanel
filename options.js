const DEFAULTS = {
  tabOpenPosition: 'end',
  tabActiveBehavior: 'keep',
  confirmDelete: true,
  fontSize: 14,
  lineHeight: 1,
  configBackupFolderId: null
};
const OPTION_KEYS = ['tabOpenPosition','tabActiveBehavior','confirmDelete','fontSize','lineHeight'];
const UI_KEYS = ['expandedFolders','lastSelectedFolderId'];
const META_KEY = 'configBackupFolderId';
const ALL_KEYS = [...OPTION_KEYS, META_KEY, ...UI_KEYS];

const CONFIG_TITLE = '⚙️ Better Bookmark Sidepanel Config - DO NOT DELETE';
const CONFIG_PREFIX = 'https://config.better-bookmark-sidepanel.local/#';

function encode(o){ try{ return btoa(encodeURIComponent(JSON.stringify(o))); }catch{ return null; } }
function decode(h){ try{ return JSON.parse(decodeURIComponent(atob(h))); }catch{ return null; } }

async function findBookmark(){
  try{
    const res = await chrome.bookmarks.search(CONFIG_TITLE);
    for(const bm of res) if(bm.title===CONFIG_TITLE && bm.url?.startsWith(CONFIG_PREFIX)) return bm;
    const tree=await chrome.bookmarks.getTree();
    const scan=(nodes)=>{ for(const n of nodes){ if(n.title===CONFIG_TITLE && n.url?.startsWith(CONFIG_PREFIX)) return n; if(n.children){ const f=scan(n.children); if(f) return f; } } return null; };
    return scan(tree);
  }catch{ return null; }
}
async function loadFromBookmark(){
  const bm=await findBookmark();
  if(!bm?.url?.startsWith(CONFIG_PREFIX)) return null;
  return decode(bm.url.substring(CONFIG_PREFIX.length));
}
async function getAllSettings(){
  // local優先
  const local = await chrome.storage.local.get(ALL_KEYS).catch(()=>({}));
  let syncPart = {};
  const missing = [...OPTION_KEYS, META_KEY].filter(k=> !(k in local));
  if(missing.length){
    try{ syncPart = await chrome.storage.sync.get(missing); }catch{}
  }
  const combined = {...syncPart, ...local};
  return {
    v:2, savedAt:Date.now(),
    options:{ tabOpenPosition:combined.tabOpenPosition, tabActiveBehavior:combined.tabActiveBehavior, confirmDelete:combined.confirmDelete, fontSize:combined.fontSize, lineHeight:combined.lineHeight },
    ui:{ expandedFolders:combined.expandedFolders||{}, lastSelectedFolderId:combined.lastSelectedFolderId||null },
    meta:{ configBackupFolderId:combined.configBackupFolderId||null }
  };
}
async function getParentId(){
  try{
    const local = await chrome.storage.local.get([META_KEY]).catch(()=>({}));
    let configBackupFolderId = local[META_KEY];
    if(!configBackupFolderId){
      const sync = await chrome.storage.sync.get([META_KEY]).catch(()=>({}));
      configBackupFolderId = sync[META_KEY];
      if(configBackupFolderId) await chrome.storage.local.set({[META_KEY]: configBackupFolderId}).catch(()=>{});
    }
    if(configBackupFolderId){ const bms=await chrome.bookmarks.get(configBackupFolderId); if(bms[0]&&!bms[0].url) return configBackupFolderId; }
  }catch{} return '2';
}
async function saveToBookmark(override=null){
  const data=override||await getAllSettings();
  const payload={ v:2, savedAt:Date.now(), options:data.options||{}, ui:data.ui||{}, meta:data.meta||{} };
  const enc=encode(payload); if(!enc) return;
  const url=CONFIG_PREFIX+enc;
  const existing=await findBookmark();
  const parentId=payload.meta.configBackupFolderId||await getParentId();
  try{ const pc=await chrome.bookmarks.get(parentId); if(pc[0]?.url) throw new Error('not folder'); }catch{
    const fb='2';
    if(existing){ await chrome.bookmarks.update(existing.id,{title:CONFIG_TITLE,url}); try{ await chrome.bookmarks.move(existing.id,{parentId:fb}); }catch{} }
    else{ await chrome.bookmarks.create({parentId:fb,title:CONFIG_TITLE,url}); }
    return;
  }
  if(existing){
    if(existing.parentId!==parentId){ try{ await chrome.bookmarks.move(existing.id,{parentId}); }catch{} }
    await chrome.bookmarks.update(existing.id,{title:CONFIG_TITLE,url});
  }else{
    await chrome.bookmarks.create({parentId,title:CONFIG_TITLE,url});
  }
}
async function getFolders(){
  const tree=await chrome.bookmarks.getTree();
  const folders=[];
  const walk=(nodes,path)=>{
    for(const n of nodes){
      if(!n.url){
        if(n.id!=='0'){
          const full=path ? `${path} / ${n.title}` : n.title;
          const short=full.length>60 ? full.slice(0,57)+'...' : full;
          folders.push({id:n.id, full, short});
        }
        if(n.children) walk(n.children, n.id==='0' ? '' : (path ? `${path} / ${n.title}` : n.title));
      }
    }
  };
  walk(tree,''); return folders;
}

const i18n=k=>chrome.i18n.getMessage(k)||k;
function applyI18n(){ document.querySelectorAll('[data-i18n]').forEach(el=>{ const m=chrome.i18n.getMessage(el.getAttribute('data-i18n')); if(m) el.textContent=m; }); }

async function populateSelect(){
  const sel=document.getElementById('backupFolderSelect');
  if(!sel) return;
  const folders=await getFolders();
  const local = await chrome.storage.local.get([META_KEY]).catch(()=>({}));
  let configBackupFolderId = local[META_KEY];
  if(!configBackupFolderId){
    const sync = await chrome.storage.sync.get([META_KEY]).catch(()=>({}));
    configBackupFolderId = sync[META_KEY];
  }
  sel.innerHTML='';
  const def=document.createElement('option');
  def.value=''; def.textContent=i18n('optionsBackupFolderDefault')||'Default';
  sel.appendChild(def);
  for(const f of folders){
    const opt=document.createElement('option');
    opt.value=f.id; opt.textContent=f.short||f.full; opt.title=f.full;
    if(f.id===configBackupFolderId) opt.selected=true;
    sel.appendChild(opt);
  }
}

async function load(){
  try{
    // local優先で存在チェック
    const local = await chrome.storage.local.get(ALL_KEYS).catch(()=>({}));
    const hasOpt=OPTION_KEYS.some(k=>local[k]!==undefined);
    const hasUI=local.expandedFolders && Object.keys(local.expandedFolders).length>0;
    if(!hasOpt && !hasUI){
      // syncチェック
      try{
        const sync = await chrome.storage.sync.get([...OPTION_KEYS, META_KEY]).catch(()=>({}));
        const hasOptSync = OPTION_KEYS.some(k=>sync[k]!==undefined);
        if(hasOptSync){
          await chrome.storage.local.set(sync).catch(()=>{});
        }else{
          const backup=await loadFromBookmark();
          if(backup?.options){
            await chrome.storage.local.set(backup.options).catch(()=>{});
            if(backup.meta?.configBackupFolderId) await chrome.storage.local.set({configBackupFolderId:backup.meta.configBackupFolderId}).catch(()=>{});
            if(backup.ui?.expandedFolders) await chrome.storage.local.set({expandedFolders:backup.ui.expandedFolders}).catch(()=>{});
            if(backup.ui?.lastSelectedFolderId) await chrome.storage.local.set({lastSelectedFolderId:backup.ui.lastSelectedFolderId}).catch(()=>{});
            // 互換でsyncにも
            try{ await chrome.storage.sync.set(backup.options).catch(()=>{}); }catch{}
          }
        }
      }catch{}
    }
  }catch{}
  // 表示はlocal優先
  const localData = await chrome.storage.local.get(DEFAULTS).catch(()=>({}));
  let data = localData;
  const missing = Object.keys(DEFAULTS).filter(k=> !(k in localData));
  if(missing.length){
    try{
      const syncData = await chrome.storage.sync.get(DEFAULTS).catch(()=>({}));
      data = {...syncData, ...localData};
      if(Object.keys(syncData).length) await chrome.storage.local.set(syncData).catch(()=>{});
    }catch{}
  }
  // DEFAULTS補完
  data = {...DEFAULTS, ...data};
  document.querySelectorAll('input[name="tabOpenPosition"]').forEach(r=>r.checked=r.value===data.tabOpenPosition);
  document.querySelectorAll('input[name="tabActiveBehavior"]').forEach(r=>r.checked=r.value===data.tabActiveBehavior);
  const show=data.confirmDelete!==false;
  document.querySelectorAll('input[name="confirmDelete"]').forEach(r=>r.checked=(r.value==='show'&&show)||(r.value==='hide'&&!show));
  document.getElementById('fontSize').value=data.fontSize;
  document.getElementById('fontSizeNum').value=data.fontSize;
  document.getElementById('lineHeight').value=data.lineHeight;
  document.getElementById('lineHeightNum').value=data.lineHeight;
  await populateSelect();
}
function toast(k){
  const el=document.getElementById('toast');
  el.textContent=i18n(k)||k;
  el.classList.remove('hidden');
  setTimeout(()=>el.classList.add('hidden'),2000);
}
function bind(){
  document.querySelectorAll('input[name="tabOpenPosition"]').forEach(r=>{
    r.addEventListener('change', async()=>{
      await chrome.storage.local.set({tabOpenPosition:r.value});
      try{ await chrome.storage.sync.set({tabOpenPosition:r.value}); }catch{}
      await saveToBookmark();
      toast('optionsSaved');
    });
  });
  document.querySelectorAll('input[name="tabActiveBehavior"]').forEach(r=>{
    r.addEventListener('change', async()=>{
      await chrome.storage.local.set({tabActiveBehavior:r.value});
      try{ await chrome.storage.sync.set({tabActiveBehavior:r.value}); }catch{}
      await saveToBookmark();
      toast('optionsSaved');
    });
  });
  document.querySelectorAll('input[name="confirmDelete"]').forEach(r=>{
    r.addEventListener('change', async()=>{
      await chrome.storage.local.set({confirmDelete:r.value==='show'});
      try{ await chrome.storage.sync.set({confirmDelete:r.value==='show'}); }catch{}
      await saveToBookmark();
      toast('optionsSaved');
    });
  });
  const fs=document.getElementById('fontSize'), fsn=document.getElementById('fontSizeNum');
  const syncFs=async v=>{ await chrome.storage.local.set({fontSize:parseInt(v)}); try{ await chrome.storage.sync.set({fontSize:parseInt(v)}); }catch{} await saveToBookmark(); toast('optionsSaved'); };
  fs.addEventListener('input',()=>fsn.value=fs.value);
  fs.addEventListener('change',()=>syncFs(fs.value));
  fsn.addEventListener('change',()=>{ fs.value=fsn.value; syncFs(fsn.value); });
  const lh=document.getElementById('lineHeight'), lhn=document.getElementById('lineHeightNum');
  const syncLh=async v=>{ await chrome.storage.local.set({lineHeight:parseFloat(v)}); try{ await chrome.storage.sync.set({lineHeight:parseFloat(v)}); }catch{} await saveToBookmark(); toast('optionsSaved'); };
  lh.addEventListener('input',()=>lhn.value=lh.value);
  lh.addEventListener('change',()=>syncLh(lh.value));
  lhn.addEventListener('change',()=>{ lh.value=lhn.value; syncLh(lhn.value); });
  document.getElementById('backupFolderSelect').addEventListener('change', async()=>{
    const val=document.getElementById('backupFolderSelect').value||null;
    await chrome.storage.local.set({configBackupFolderId:val});
    try{ await chrome.storage.sync.set({configBackupFolderId:val}); }catch{}
    await saveToBookmark();
    toast('optionsSaved');
  });
}
applyI18n();
load().then(bind);
