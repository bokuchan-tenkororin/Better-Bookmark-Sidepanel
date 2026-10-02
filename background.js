// background.js v4 - 同期openで gesture を保持する版
let isSidePanelOpen = false;
let tabCache = {};
let saveQueue = Promise.resolve();
let cacheReadyPromise = null;
let bookmarkCacheTimer = null;
let scheduledCacheRefresh = null;
let resolveScheduledCacheRefresh = null;

const CONFIG_TITLE = '⚙️ Better Bookmark Sidepanel Config - DO NOT DELETE';
const CONFIG_PREFIX = 'https://config.better-bookmark-sidepanel.local/#';
const OPTION_KEYS = ['tabOpenPosition','tabActiveBehavior','confirmDelete','fontSize','lineHeight'];
const UI_KEYS = ['expandedFolders','lastSelectedFolderId'];
const META_KEY = 'configBackupFolderId';
const BOOKMARK_CACHE_KEY = 'bookmarkTreeCacheV2';
const DELETED_BOOKMARKS_KEY = 'deletedBookmarksHistory';
const DELETED_SESSION_KEY = 'deletedBookmarksSessionStart';

// ★ 重要: トップレベルで同期的に設定。openPanelOnActionClickはfalseにして手動で同期openする
try{
  chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: false}).catch(()=>{});
}catch{}

async function initializeDeletedBookmarkSession(){
  try {
    const now = Date.now();
    if(chrome.storage.session){
      const sess = await chrome.storage.session.get(['sessionActive']);
      if(sess.sessionActive) return;
      await enqueue(()=>chrome.storage.local.set({
        [DELETED_BOOKMARKS_KEY]: [],
        [DELETED_SESSION_KEY]: now
      }));
      await chrome.storage.session.set({sessionActive: true});
      return;
    }

    const data = await chrome.storage.local.get([DELETED_SESSION_KEY]);
    const sessionStart = data[DELETED_SESSION_KEY] || 0;
    if(!sessionStart || now - sessionStart > 12 * 60 * 60 * 1000){
      await enqueue(()=>chrome.storage.local.set({
        [DELETED_BOOKMARKS_KEY]: [],
        [DELETED_SESSION_KEY]: now
      }));
    }
  }catch(error){
    console.warn('[DeletedBookmarks] session initialization failed', error);
  }
}
let deletedBookmarkSessionReady = initializeDeletedBookmarkSession();

function reportDeletedBookmarkSaveFailure(error){
  console.warn('[DeletedBookmarks] save failed', error);
  try{
    chrome.runtime.sendMessage({type: 'DELETED_BOOKMARK_SAVE_FAILED'}).catch(()=>{});
  }catch{}
}

function reportDeletedBookmarkHistoryPruned(){
  try{
    chrome.runtime.sendMessage({type: 'DELETED_BOOKMARK_HISTORY_PRUNED'}).catch(()=>{});
  }catch{}
}

async function saveDeletedBookmarkEntry(entry){
  const data = await chrome.storage.local.get([DELETED_BOOKMARKS_KEY]);
  const history = data[DELETED_BOOKMARKS_KEY] || [];
  history.unshift(entry);
  if(history.length > 200) history.length = 200;
  let prunedForQuota = false;

  while(true){
    try{
      await chrome.storage.local.set({[DELETED_BOOKMARKS_KEY]: history});
      return prunedForQuota;
    }catch(error){
      const isQuotaError = /quota/i.test(String(error?.message || error));
      if(!isQuotaError || history.length <= 1) throw error;
      history.pop();
      prunedForQuota = true;
    }
  }
}

async function getParentId(){
  try{
    const local = await chrome.storage.local.get([META_KEY]);
    let id = local[META_KEY];
    if(!id){
      const sync = await chrome.storage.sync.get([META_KEY]).catch(()=>({}));
      id = sync[META_KEY];
      if(id) await chrome.storage.local.set({[META_KEY]: id}).catch(()=>{});
    }
    if(id){ const bms=await chrome.bookmarks.get(id); if(bms[0]&&!bms[0].url) return id; }
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
function encode(o){ try{ return btoa(encodeURIComponent(JSON.stringify(o))); }catch{ return null; } }
function decode(h){ try{ return JSON.parse(decodeURIComponent(atob(h))); }catch{ return null; } }
async function loadFromBookmark(){
  const bm=await findBookmark();
  if(!bm?.url?.startsWith(CONFIG_PREFIX)) return null;
  return decode(bm.url.substring(CONFIG_PREFIX.length));
}
async function getAllSettings(){
  const allKeys = [...OPTION_KEYS, META_KEY, ...UI_KEYS];
  const local = await chrome.storage.local.get(allKeys).catch(()=>({}));
  let syncPart = {};
  const missingOpt = [...OPTION_KEYS, META_KEY].filter(k=> !(k in local));
  if (missingOpt.length){
    try{ syncPart = await chrome.storage.sync.get(missingOpt); }catch{}
    if (Object.keys(syncPart).length) await chrome.storage.local.set(syncPart).catch(()=>{});
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
  const checkKeys = [...OPTION_KEYS, ...UI_KEYS];
  const local = await chrome.storage.local.get(checkKeys).catch(()=>({}));
  const hasOpt=OPTION_KEYS.some(k=>local[k]!==undefined);
  const hasUI=local.expandedFolders && Object.keys(local.expandedFolders).length>0;
  if(hasOpt||hasUI){ await saveToBookmark(); return; }
  try{
    const sync=await chrome.storage.sync.get(OPTION_KEYS).catch(()=>({}));
    if(OPTION_KEYS.some(k=>sync[k]!==undefined)){
      await chrome.storage.local.set(sync).catch(()=>{});
      await saveToBookmark(); return;
    }
  }catch{}
  try{
    const fromBm=await loadFromBookmark();
    if(fromBm){
      const opt=fromBm.options||{}; const ui=fromBm.ui||{}; const meta=fromBm.meta||{};
      const toLocal={...opt};
      if(ui.expandedFolders) toLocal.expandedFolders=ui.expandedFolders;
      if(ui.lastSelectedFolderId) toLocal.lastSelectedFolderId=ui.lastSelectedFolderId;
      if(meta.configBackupFolderId) toLocal.configBackupFolderId=meta.configBackupFolderId;
      await chrome.storage.local.set(toLocal).catch(()=>{});
    }
  }catch{}
}
function refreshBookmarkTreeCache(){
  if(bookmarkCacheTimer) clearTimeout(bookmarkCacheTimer);
  if(!scheduledCacheRefresh){
    scheduledCacheRefresh = new Promise(resolve=>{ resolveScheduledCacheRefresh = resolve; });
  }
  bookmarkCacheTimer = setTimeout(async()=>{
    bookmarkCacheTimer = null;
    const resolveRefresh = resolveScheduledCacheRefresh;
    scheduledCacheRefresh = null;
    resolveScheduledCacheRefresh = null;
    cacheReadyPromise = (async()=>{
      try{
        const tree = await chrome.bookmarks.getTree();
        await chrome.storage.local.set({[BOOKMARK_CACHE_KEY]: {tree, ts: Date.now()}}).catch(()=>{});
      }catch{}
    })();
    await cacheReadyPromise;
    resolveRefresh?.();
  }, 60);
  return scheduledCacheRefresh;
}
function isConfigNode(node){
  if(!node) return false;
  return node.title===CONFIG_TITLE && (node.url||'').startsWith(CONFIG_PREFIX);
}
function stripConfigFromNode(node){
  if(!node) return null;
  if(isConfigNode(node)) return null;
  if(node.children && node.children.length){
    const filtered = [];
    for(const ch of node.children){
      const cleaned = stripConfigFromNode({...ch, children: ch.children ? [...ch.children] : undefined});
      if(cleaned) filtered.push(cleaned);
    }
    return {...node, children: filtered};
  }
  return {...node};
}
chrome.bookmarks.onChanged.addListener(()=>{ refreshBookmarkTreeCache().catch(()=>{}); });
chrome.bookmarks.onCreated.addListener(()=>{ refreshBookmarkTreeCache().catch(()=>{}); });
chrome.bookmarks.onRemoved.addListener((id, removeInfo)=>{
  try{
    const node = removeInfo && removeInfo.node;
    if(!node){
      refreshBookmarkTreeCache().catch(()=>{});
      return;
    }
    if(isConfigNode(node)){
      refreshBookmarkTreeCache().catch(()=>{});
      return;
    }
    if(['0','1','2','3'].includes(String(id))){
      refreshBookmarkTreeCache().catch(()=>{});
      return;
    }
    const cleanedNode = stripConfigFromNode(JSON.parse(JSON.stringify(node)));
    if(!cleanedNode){
      refreshBookmarkTreeCache().catch(()=>{});
      return;
    }
    enqueue(async()=>{
      try{
        await deletedBookmarkSessionReady;
        const data = await chrome.storage.local.get([DELETED_SESSION_KEY]);
        let sessionStart = data[DELETED_SESSION_KEY];
        if(!sessionStart){
          sessionStart = Date.now();
          await chrome.storage.local.set({[DELETED_SESSION_KEY]: sessionStart});
        }
        const now = Date.now();
        const entry = {
          id: String(id),
          parentId: removeInfo.parentId,
          index: typeof removeInfo.index==='number' ? removeInfo.index : 0,
          node: cleanedNode,
          deletedAt: now
        };
        const pruned = await saveDeletedBookmarkEntry(entry);
        if(pruned) reportDeletedBookmarkHistoryPruned();
      }catch(error){ reportDeletedBookmarkSaveFailure(error); }
    });
  }catch(e){ console.warn('[DeletedBookmarks] onRemoved handler error', e); }
  refreshBookmarkTreeCache().catch(()=>{});
});
chrome.bookmarks.onMoved.addListener(()=>{ refreshBookmarkTreeCache().catch(()=>{}); });

chrome.tabs.onUpdated.addListener((id,_,tab)=>{ const ex=tabCache[id]||{}; tabCache[id]={url:tab.url||tab.pendingUrl||ex.url||'', title:tab.title||ex.title||'', favIconUrl:tab.favIconUrl||ex.favIconUrl||''}; });
function isRecordable(u){ if(!u) return false; if(u==='about:blank') return false; if(u.startsWith('chrome://newtab')) return false; return /^(https?|chrome|chrome-extension|edge|file|about|moz-extension):/.test(u); }
async function fallback(){ try{ const rec=await chrome.sessions.getRecentlyClosed({maxResults:10}); for(const e of rec) if(e.tab?.url && isRecordable(e.tab.url)) return {url:e.tab.url, title:e.tab.title||e.tab.url, favIconUrl:e.tab.favIconUrl||''}; }catch{} return null; }
function enqueue(t){
  const task = saveQueue.catch(()=>{}).then(t);
  saveQueue = task.catch(()=>{});
  return task;
}
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
chrome.runtime.onStartup.addListener(()=>{
  chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:false}).catch(()=>{});
  setTimeout(()=>{ restoreIfNeeded().catch(()=>{}); refreshBookmarkTreeCache().catch(()=>{}); }, 1500);
});

let debounce=null;
function schedule(){ if(debounce) clearTimeout(debounce); debounce=setTimeout(()=>saveToBookmark().catch(()=>{}),600); }
chrome.storage.onChanged.addListener((ch,area)=>{
  if(area==='local' && [...OPTION_KEYS, META_KEY, ...UI_KEYS].some(k=>k in ch)) schedule();
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
      try{
        await chrome.storage.local.set({[DELETED_BOOKMARKS_KEY]: []});
        sendResponse({ok:true});
      }catch(error){
        reportDeletedBookmarkSaveFailure(error);
        sendResponse({ok:false});
      }
    });
    return true;
  }
  if(msg.type==='GET_DELETED_SESSION'){
    Promise.resolve(deletedBookmarkSessionReady)
      .then(()=>chrome.storage.local.get([DELETED_SESSION_KEY, DELETED_BOOKMARKS_KEY]))
      .then(r=>{
        const history = r[DELETED_BOOKMARKS_KEY] || [];
        sendResponse({
          sessionStart: r[DELETED_SESSION_KEY] || Date.now(),
          count: history.length
        });
      })
      .catch(()=>sendResponse({sessionStart: Date.now(), count: 0}));
    return true;
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
    chrome.storage.local.get([BOOKMARK_CACHE_KEY]).then(r=>sendResponse({cache: r[BOOKMARK_CACHE_KEY]||null})).catch(()=>sendResponse({cache:null})); return true;
  }
  return false;
});

// === 修正: 同期でジェスチャーを保持したまま開閉 ===
function closeSidePanelMsg(){
  try{ chrome.runtime.sendMessage({type:'CLOSE_SIDEPANEL'}).catch(()=>{}); }catch{}
}

// アイコンクリック: 同期判定で即時 open/close（awaitを挟まない）
chrome.action.onClicked.addListener((tab)=>{
  const winId = tab?.windowId;
  if(isSidePanelOpen){
    // 開いている -> 閉じる（closeはジェスチャー不要）
    closeSidePanelMsg();
  }else{
    // 閉じている -> 同期で開く（awaitなしでジェスチャー保持）
    try{
      if(winId){
        chrome.sidePanel.open({windowId: winId}).catch(e=>console.warn('[bg] open failed', e));
      }else{
        chrome.windows.getCurrent().then(w=>{
          chrome.sidePanel.open({windowId: w.id}).catch(e=>console.warn('[bg] open failed', e));
        });
      }
    }catch(e){ console.warn(e); }
  }
});

// ショートカット: 同期判定で即時 open/close
chrome.commands.onCommand.addListener((command, tab)=>{
  if(command !== 'toggle-panel') return;
  const winId = tab?.windowId;
  if(isSidePanelOpen){
    closeSidePanelMsg();
  }else{
    try{
      if(winId){
        chrome.sidePanel.open({windowId: winId}).catch(e=>console.warn('[bg] open failed', e));
      }else{
        // tabが無い場合でも同期的にgetCurrentを呼ばず、まず現在のウィンドウで試す
        // getCurrentは非同期なので、ここではopenを遅延させずに試すために
        // chrome.windows.getCurrent()のPromiseを待たずに実行する必要があるが、
        // windowIdが無い場合は一瞬遅れる。ジェスチャーを保持するため、
        // 最後にフォールバックとしてgetCurrentを使う
        chrome.windows.getCurrent().then(w=>{
          chrome.sidePanel.open({windowId: w.id}).catch(()=>{});
        }).catch(()=>{});
      }
    }catch(e){ console.warn(e); }
  }
});
