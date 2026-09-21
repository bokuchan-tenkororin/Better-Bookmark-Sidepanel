// background.js v2.0 - storage.local優先 + bookmark tree cache + favicon lazy support
let isSidePanelOpen = false;
let tabCache = {};
let saveQueue = Promise.resolve();
let cacheReadyPromise = null;

const CONFIG_TITLE = '⚙️ Better Bookmark Sidepanel Config - DO NOT DELETE';
const CONFIG_PREFIX = 'https://config.better-bookmark-sidepanel.local/#';
const OPTION_KEYS = ['tabOpenPosition','tabActiveBehavior','confirmDelete','fontSize','lineHeight'];
const UI_KEYS = ['expandedFolders','lastSelectedFolderId'];
const META_KEY = 'configBackupFolderId';
const BOOKMARK_CACHE_KEY = 'bookmarkTreeCacheV2';
const DELETED_BOOKMARKS_KEY = 'deletedBookmarksHistory';
const DELETED_MAX = 500;

function encode(obj){ try{ return btoa(encodeURIComponent(JSON.stringify(obj))); }catch{ return null; } }
function decode(h){ try{ return JSON.parse(decodeURIComponent(atob(h))); }catch{ return null; } }

// storage.local優先で取得、なければsyncから移行
async function getLocalWithSyncFallback(keys){
  try{
    const local = await chrome.storage.local.get(keys);
    const missing = keys.filter(k => !(k in local));
    if (missing.length){
      try{
        const sync = await chrome.storage.sync.get(missing);
        if (Object.keys(sync).length){
          // 移行
          await chrome.storage.local.set(sync).catch(()=>{});
          return {...sync, ...local};
        }
      }catch{}
    }
    return local;
  }catch{
    return {};
  }
}

async function getParentId(){
  try{
    const local = await chrome.storage.local.get([META_KEY]);
    let configBackupFolderId = local[META_KEY];
    if (!configBackupFolderId){
      const sync = await chrome.storage.sync.get([META_KEY]).catch(()=>({}));
      configBackupFolderId = sync[META_KEY];
      if (configBackupFolderId){
        await chrome.storage.local.set({[META_KEY]: configBackupFolderId}).catch(()=>{});
      }
    }
    if(configBackupFolderId){
      const bms=await chrome.bookmarks.get(configBackupFolderId);
      if(bms[0]&&!bms[0].url) return configBackupFolderId;
    }
  }catch{} return '2';
}

async function findBookmark(){
  try{
    const parentId=await getParentId();
    try{ const ch=await chrome.bookmarks.getChildren(parentId); for(const bm of ch) if(bm.title===CONFIG_TITLE && bm.url?.startsWith(CONFIG_PREFIX)) return bm; }catch{}
    const res=await chrome.bookmarks.search(CONFIG_TITLE);
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
  const allKeys = [...OPTION_KEYS, META_KEY, ...UI_KEYS];
  const local = await chrome.storage.local.get(allKeys).catch(()=>({}));
  let syncPart = {};
  const missingOpt = [...OPTION_KEYS, META_KEY].filter(k=> !(k in local));
  if (missingOpt.length){
    try{ syncPart = await chrome.storage.sync.get(missingOpt); }catch{}
    if (Object.keys(syncPart).length){
      await chrome.storage.local.set(syncPart).catch(()=>{});
    }
  }
  const combined = {...syncPart, ...local};
  return {
    v:2, savedAt:Date.now(),
    options:{ tabOpenPosition:combined.tabOpenPosition, tabActiveBehavior:combined.tabActiveBehavior, confirmDelete:combined.confirmDelete, fontSize:combined.fontSize, lineHeight:combined.lineHeight },
    ui:{ expandedFolders:combined.expandedFolders||{}, lastSelectedFolderId:combined.lastSelectedFolderId||null },
    meta:{ configBackupFolderId:combined.configBackupFolderId||null }
  };
}
async function saveToBookmark(override=null){
  const data=override||await getAllSettings();
  const payload={ v:2, savedAt:Date.now(), options:data.options||{}, ui:data.ui||{}, meta:data.meta||{} };
  if(Object.keys(payload.options).length===0 && Object.keys(payload.ui.expandedFolders||{}).length===0) return;
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
async function restoreIfNeeded(){
  // local優先で存在チェック
  const checkKeys = [...OPTION_KEYS, ...UI_KEYS];
  const local = await chrome.storage.local.get(checkKeys).catch(()=>({}));
  const hasOpt=OPTION_KEYS.some(k=>local[k]!==undefined);
  const hasUI=local.expandedFolders && Object.keys(local.expandedFolders).length>0;
  if(hasOpt||hasUI){ await saveToBookmark(); return; }
  // syncもチェックして移行
  try{
    const sync=await chrome.storage.sync.get(OPTION_KEYS).catch(()=>({}));
    const hasOptSync = OPTION_KEYS.some(k=>sync[k]!==undefined);
    if(hasOptSync){
      await chrome.storage.local.set(sync).catch(()=>{});
      await saveToBookmark();
      return;
    }
  }catch{}
  const backup=await loadFromBookmark();
  if(!backup) return;
  if(backup.options){
    if(Object.keys(backup.options).length) await chrome.storage.local.set(backup.options).catch(()=>{});
    if(backup.meta?.configBackupFolderId) await chrome.storage.local.set({configBackupFolderId:backup.meta.configBackupFolderId}).catch(()=>{});
    if(backup.ui?.expandedFolders) await chrome.storage.local.set({expandedFolders:backup.ui.expandedFolders}).catch(()=>{});
    if(backup.ui?.lastSelectedFolderId) await chrome.storage.local.set({lastSelectedFolderId:backup.ui.lastSelectedFolderId}).catch(()=>{});
    // 互換のためsyncにも書いておく
    try{ await chrome.storage.sync.set(backup.options).catch(()=>{}); }catch{}
  }
}

// ---- Bookmark Tree Cache ----
async function refreshBookmarkTreeCache(){
  try{
    const tree = await chrome.bookmarks.getTree();
    await chrome.storage.local.set({[BOOKMARK_CACHE_KEY]: {tree, ts: Date.now()}});
  }catch(e){}
}
let bookmarkCacheTimer = null;
function scheduleBookmarkCache(){
  if(bookmarkCacheTimer) clearTimeout(bookmarkCacheTimer);
  bookmarkCacheTimer = setTimeout(()=>{ refreshBookmarkTreeCache().catch(()=>{}); }, 250);
}
// ブックマーク変更でキャッシュ更新
try{
  chrome.bookmarks.onChanged.addListener(scheduleBookmarkCache);
  chrome.bookmarks.onCreated.addListener(scheduleBookmarkCache);
  chrome.bookmarks.onRemoved.addListener(scheduleBookmarkCache);
  chrome.bookmarks.onMoved.addListener(scheduleBookmarkCache);
  if (chrome.bookmarks.onChildrenReordered) chrome.bookmarks.onChildrenReordered.addListener(scheduleBookmarkCache);
}catch{}

// ---- 削除したブックマークの履歴保存 ----
chrome.bookmarks.onRemoved.addListener((id, removeInfo) => {
  enqueue(async () => {
    try {
      const node = removeInfo && removeInfo.node ? removeInfo.node : null;
      if (!node) return;
      // 設定用ブックマークは除外
      if (node.title === CONFIG_TITLE && node.url && node.url.startsWith(CONFIG_PREFIX)) return;
      // ルートIDは除外
      if (['0','1','2','3'].includes(String(id))) return;
      // 内部用: 空タイトルかつconfig prefix含むものも除外（二重チェック）
      if (node.title === CONFIG_TITLE) return;

      const entry = {
        id: String(id),
        parentId: String(removeInfo.parentId || ''),
        index: removeInfo.index || 0,
        node: node, // title, url, children を含む完全なノード
        deletedAt: Date.now()
      };
      const { [DELETED_BOOKMARKS_KEY]: history = [] } = await chrome.storage.local.get([DELETED_BOOKMARKS_KEY]);
      // 同じidが連続で入る重複を軽く防ぐ（1秒以内はスキップ）
      if (history.length > 0) {
        const last = history[0];
        if (last.id === entry.id && last.node && last.node.title === entry.node.title && (Date.now() - last.deletedAt) < 1000) {
          return;
        }
      }
      history.unshift(entry);
      if (history.length > DELETED_MAX) history.length = DELETED_MAX;
      await chrome.storage.local.set({ [DELETED_BOOKMARKS_KEY]: history });
    } catch (e) {
      console.warn('Failed to save deleted bookmark', e);
    }
  });
});

function initCache(){
  const p=(async()=>{ try{ const tabs=await chrome.tabs.query({}); for(const t of tabs) if(t.id!=null) tabCache[t.id]={url:t.url||t.pendingUrl||'', title:t.title||'', favIconUrl:t.favIconUrl||''}; }catch{} })();
  cacheReadyPromise=p;
}
initCache();
chrome.tabs.onCreated.addListener(tab=>{ if(tab.id!=null) tabCache[tab.id]={url:tab.pendingUrl||tab.url||'', title:tab.title||'', favIconUrl:tab.favIconUrl||''}; });
chrome.tabs.onUpdated.addListener((id,_,tab)=>{ const ex=tabCache[id]||{}; tabCache[id]={url:tab.url||tab.pendingUrl||ex.url||'', title:tab.title||ex.title||'', favIconUrl:tab.favIconUrl||ex.favIconUrl||''}; });
function isRecordable(u){ if(!u) return false; if(u==='about:blank') return false; if(u.startsWith('chrome://newtab')) return false; return /^(https?|chrome|chrome-extension|edge|file|about|moz-extension):/.test(u); }
async function fallback(){ try{ const rec=await chrome.sessions.getRecentlyClosed({maxResults:10}); for(const e of rec) if(e.tab?.url && isRecordable(e.tab.url)) return {url:e.tab.url, title:e.tab.title||e.tab.url, favIconUrl:e.tab.favIconUrl||''}; }catch{} return null; }
function enqueue(t){ saveQueue=saveQueue.then(t).catch(()=>{}); }
chrome.tabs.onRemoved.addListener(tabId=>{
  enqueue(async()=>{
    try{
      if(cacheReadyPromise) await Promise.race([cacheReadyPromise, new Promise(r=>setTimeout(r,1000))]);
      let info=tabCache[tabId];
      if(!info||!isRecordable(info.url)){ const fb=await fallback(); if(fb) info=fb; }
      if(info&&isRecordable(info.url)){
        const closed={url:info.url, title:info.title||info.url, favIconUrl:info.favIconUrl||'', closedAt:Date.now()};
        const {closedTabsHistory=[], lastClearedAt=0}=await chrome.storage.local.get(['closedTabsHistory','lastClearedAt']);
        const start=new Date().setHours(0,0,0,0);
        let filtered=closedTabsHistory.filter(t=>{ if(t.closedAt<start) return true; if(lastClearedAt&&t.closedAt<lastClearedAt) return false; return true; });
        filtered.unshift(closed); if(filtered.length>500) filtered.length=500;
        await chrome.storage.local.set({closedTabsHistory:filtered});
      }
    }finally{ delete tabCache[tabId]; }
  });
});

try{ chrome.storage.session.get(['isSidePanelOpen']).then(r=>{ isSidePanelOpen=!!r.isSidePanelOpen; }); }catch{}
function saveOpen(v){ isSidePanelOpen=v; try{ chrome.storage.session.set({isSidePanelOpen:v}); }catch{} }

chrome.runtime.onInstalled.addListener(()=>{ 
  chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:false}).catch(()=>{}); 
  restoreIfNeeded().catch(()=>{});
  setTimeout(()=>refreshBookmarkTreeCache().catch(()=>{}), 500);
});
// v1.0.9: 起動直後は bookmarks API が重いので遅延させる
chrome.runtime.onStartup.addListener(()=>{
  chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:false}).catch(()=>{});
  setTimeout(()=>{ 
    restoreIfNeeded().catch(()=>{}); 
    refreshBookmarkTreeCache().catch(()=>{});
  }, 1500);
});

let debounce=null;
function schedule(){ if(debounce) clearTimeout(debounce); debounce=setTimeout(()=>saveToBookmark().catch(()=>{}),600); }
chrome.storage.onChanged.addListener((ch,area)=>{
  if(area==='local' && [...OPTION_KEYS, META_KEY, ...UI_KEYS].some(k=>k in ch)) schedule();
  // sync変更はlocalに移行してから保存
  if(area==='sync' && [...OPTION_KEYS, META_KEY].some(k=>k in ch)){
    const toMigrate = {};
    for(const k of [...OPTION_KEYS, META_KEY]) if(k in ch) toMigrate[k]=ch[k].newValue;
    if(Object.keys(toMigrate).length){
      chrome.storage.local.set(toMigrate).catch(()=>{});
    }
    schedule();
  }
});

chrome.runtime.onConnect.addListener(port=>{ if(port.name==='sidepanel'){ saveOpen(true); port.onDisconnect.addListener(()=>saveOpen(false)); } });

chrome.runtime.onMessage.addListener((msg,_,sendResponse)=>{
  if(msg.type==='CLEAR_TODAY_CLOSED'){
    enqueue(async()=>{
      const now=new Date(); const start=new Date(now.getFullYear(),now.getMonth(),now.getDate()).getTime();
      const {closedTabsHistory=[]}=await chrome.storage.local.get(['closedTabsHistory']);
      const rem=closedTabsHistory.filter(t=>t.closedAt<start);
      await chrome.storage.local.set({closedTabsHistory:rem, lastClearedAt:Date.now()});
      sendResponse({ok:true});
    }); return true;
  }
  if(msg.type==='CLEAR_DELETED_BOOKMARKS'){
    enqueue(async()=>{
      await chrome.storage.local.set({[DELETED_BOOKMARKS_KEY]: []});
      sendResponse({ok:true});
    }); return true;
  }
  if(msg.type==='DELETE_DELETED_ENTRY'){
    enqueue(async()=>{
      try{
        const { [DELETED_BOOKMARKS_KEY]: history = [] } = await chrome.storage.local.get([DELETED_BOOKMARKS_KEY]);
        const filtered = history.filter(h => !(h.deletedAt === msg.deletedAt && h.id === msg.entryId));
        await chrome.storage.local.set({[DELETED_BOOKMARKS_KEY]: filtered});
        sendResponse({ok:true});
      }catch(e){ sendResponse({ok:false}); }
    }); return true;
  }
  if(msg.type==='SAVE_BACKUP'){ saveToBookmark().then(()=>sendResponse({ok:true})).catch(()=>sendResponse({ok:false})); return true; }
  if(msg.type==='RESTORE_SETTINGS'){ restoreIfNeeded().then(()=>sendResponse({ok:true})).catch(()=>sendResponse({ok:false})); return true; }
  if(msg.type==='GET_BOOKMARK_CACHE'){
    chrome.storage.local.get([BOOKMARK_CACHE_KEY]).then(r=>sendResponse({cache: r[BOOKMARK_CACHE_KEY]||null})).catch(()=>sendResponse({cache:null}));
    return true;
  }
  return false;
});

function closeP(){ chrome.runtime.sendMessage({type:'CLOSE_SIDEPANEL'}).catch(()=>{}); }
function openP(winId){ if(winId) chrome.sidePanel.open({windowId:winId}).catch(()=>{}); else chrome.windows.getCurrent().then(w=>chrome.sidePanel.open({windowId:w.id}).catch(()=>{})).catch(()=>{}); }
function toggle(winId){ if(isSidePanelOpen) closeP(); else openP(winId); }
chrome.action.onClicked.addListener(tab=>toggle(tab?.windowId));
chrome.commands.onCommand.addListener((_,tab)=>toggle(tab?.windowId));
