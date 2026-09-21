/* sidepanel.js v2.0 - 0ms cache display + local優先 + IntersectionObserver favicon */
const SYNC_DEFAULTS = {
  tabOpenPosition: 'end',
  tabActiveBehavior: 'keep',
  confirmDelete: true,
  fontSize: 14,
  lineHeight: 1,
};

const DEFAULT_SETTINGS = {
  ...SYNC_DEFAULTS,
  expandedFolders: {},
  lastSelectedFolderId: null,
};

// ---- Config file bookmark persistence ----
const CONFIG_TITLE = '⚙️ Better Bookmark Sidepanel Config - DO NOT DELETE';
const CONFIG_PREFIX = 'https://config.better-bookmark-sidepanel.local/#';
const PERSIST_OPTION_KEYS = ['tabOpenPosition','tabActiveBehavior','confirmDelete','fontSize','lineHeight'];

async function getParentId(){
  try{
    const local = await chrome.storage.local.get(['configBackupFolderId']).catch(()=>({}));
    let id = local.configBackupFolderId;
    if(!id){
      const sync = await chrome.storage.sync.get(['configBackupFolderId']).catch(()=>({}));
      id = sync.configBackupFolderId;
      if(id) await chrome.storage.local.set({configBackupFolderId: id}).catch(()=>{});
    }
    if(id){ const bms=await chrome.bookmarks.get(id); if(bms[0]&&!bms[0].url) return id; }
  }catch{} return '2';
}
async function findConfigBookmark(){
  try{
    const parentId=await getParentId();
    try{ const children=await chrome.bookmarks.getChildren(parentId); for(const bm of children) if(bm.title===CONFIG_TITLE && bm.url?.startsWith(CONFIG_PREFIX)) return bm; }catch{}
    const results=await chrome.bookmarks.search(CONFIG_TITLE);
    for(const bm of results) if(bm.title===CONFIG_TITLE && bm.url?.startsWith(CONFIG_PREFIX)) return bm;
    const tree=await chrome.bookmarks.getTree();
    const scan=(nodes)=>{ for(const n of nodes){ if(n.title===CONFIG_TITLE && n.url?.startsWith(CONFIG_PREFIX)) return n; if(n.children){ const f=scan(n.children); if(f) return f; } } return null; };
    return scan(tree);
  }catch{ return null; }
}
function encodeCfg(obj){ try{ return btoa(encodeURIComponent(JSON.stringify(obj))); }catch{ return null; } }
function decodeCfg(h){ try{ return JSON.parse(decodeURIComponent(atob(h))); }catch{ return null; } }
async function loadBackupFromBookmark(){
  const bm=await findConfigBookmark();
  if(!bm?.url?.startsWith(CONFIG_PREFIX)) return null;
  return decodeCfg(bm.url.substring(CONFIG_PREFIX.length));
}

// ---- Root bookmark guard ----
const ROOT_BOOKMARK_IDS = new Set(['0', '1', '2', '3']);
const isRootBookmarkId = (id) => ROOT_BOOKMARK_IDS.has(String(id ?? ''));
const isUnmodifiableNode = (node) => !!node?.unmodifiable || isRootBookmarkId(node?.id);

async function safeBookmarkMove(id, dest){
  try{
    const sid = String(id);
    let dParent = String(dest.parentId ?? '');
    if (!sid) return false;
    // 自分で作ったブックマーク以外（root）は移動禁止 - Chrome仕様
    if (isRootBookmarkId(sid)) {
      console.warn('Blocked: root folder itself cannot be moved:', sid);
      return false;
    }
    if (!dParent) return false;

    // root(0)直下はChromeが禁止。ユーザー操作は「その他のブックマーク」に逃がす
    if (dParent === '0') {
      console.warn('Parent 0 is forbidden, fallback to Other Bookmarks(2)');
      dParent = '2';
      dest = { ...dest, parentId: dParent };
    }

    // 移動元がunmodifiable(managed)なら禁止
    try{
      const [srcNode] = await chrome.bookmarks.get(sid);
      if (srcNode?.unmodifiable === 'managed') {
        console.warn('Blocked managed node:', sid);
        return false;
      }
      // rootフォルダ自体はunmodifiableでなくてもIDで弾く
      if (isRootBookmarkId(srcNode?.id)) return false;
    }catch{}

    // 移動先がunmodifiableなフォルダ自体への移動は、子として追加ならOK
    // ただし移動先自体が root(0) の場合は上記で2にフォールバック済み
    try{
      const [dstNode] = await chrome.bookmarks.get(dParent);
      // dstがブックマーク( urlあり )ならその親に置くべき
      if (dstNode?.url) {
        const p = dstNode.parentId || '2';
        if (String(p) === '0') dest.parentId = '2';
        else dest.parentId = p;
      }
    }catch{}

    await chrome.bookmarks.move(sid, dest);
    return true;
  }catch(e){
    const msg = String(e?.message || e);
    // Chromeのルート保護エラーは仕様通りなので握る
    if (msg.includes('root bookmark') || msg.includes("Can't modify the root") || msg.includes('root cannot be modified') || msg.includes('Bookmarks Bar') || msg.includes('Other Bookmarks')) {
      console.warn('Blocked by Chrome root policy (spec):', msg);
      return false;
    }
    console.warn('safeBookmarkMove failed', e);
    // エラーでもUIは壊さない
    return false;
  }
}

// 自分で作ったブックマークか判定 (root以外は全てユーザー作成扱い)
function isUserBookmark(node){
  if(!node) return false;
  return !isRootBookmarkId(node.id) && !node.unmodifiable;
}


let settings = { ...DEFAULT_SETTINGS };
let searchQuery = '';
let contextTarget = null;
let dragState = { draggedId: null, dropTarget: null, dropPosition: null };
let dialogCallback = null;
let sidePanelPort = null;
let currentView = 'bookmarks';
let checkedIds = new Set();

// ---- Performance: caches ----
const faviconMemoryCache = new Map();
function getFaviconUrl(targetUrl, size=32){
  try {
    return chrome.runtime.getURL("/_favicon/") + "?pageUrl=" + encodeURIComponent(targetUrl) + "&size=" + size;
  } catch { return ""; }
}
function isHttpUrl(u){
  try { const p = new URL(u); return p.protocol === 'http:' || p.protocol === 'https:'; } catch { return false; }
}

const TREE_CACHE_KEY = 'bookmarkTreeCacheV2';
const DELETED_BOOKMARKS_KEY = 'deletedBookmarksHistory';
const TREE_CACHE_TTL = 1000 * 60 * 10;
let faviconObserver = null;
const TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function initFaviconObserver(){
  try{ if(faviconObserver) faviconObserver.disconnect(); }catch{}
  // root null = viewport, rootMargin大きめで先読み
  faviconObserver = new IntersectionObserver((entries)=>{
    for(const entry of entries){
      if(entry.isIntersecting){
        const img = entry.target;
        const src = img.dataset.src;
        if(src){
          // キャッシュヒットチェック
          try{
            const u = new URL(img.dataset.originalUrl || src);
            const host = u.hostname;
            if(faviconMemoryCache.has(host) && faviconMemoryCache.get(host).failed){
              // 失敗履歴があればスキップ
              img.style.display='none';
            }else{
              img.src = src;
            }
          }catch{
            img.src = src;
          }
          img.removeAttribute('data-src');
        }
        faviconObserver.unobserve(img);
      }
    }
  }, { root: null, rootMargin: '800px 0px', threshold: 0.01 });
}
function observeFavicon(img){
  if(!img) return;
  if(!img.dataset.src) return;
  if(faviconObserver){
    faviconObserver.observe(img);
  }else{
    img.src = img.dataset.src;
    img.removeAttribute('data-src');
  }
}

const i18n = (key, substitutions) => {
  try {
    if (substitutions !== undefined) {
      const subs = Array.isArray(substitutions) ? substitutions : [String(substitutions)];
      const msg = chrome.i18n.getMessage(key, subs);
      if (msg) return msg;
    } else {
      const msg = chrome.i18n.getMessage(key);
      if (msg) return msg;
    }
  } catch(e) {}
  return key;
};

function connectToBackground() {
  try {
    sidePanelPort = chrome.runtime.connect({ name: 'sidepanel' });
    sidePanelPort.onDisconnect.addListener(() => {
      sidePanelPort = null;
      setTimeout(connectToBackground, 200);
    });
  } catch(e) {
    setTimeout(connectToBackground, 500);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'CLOSE_SIDEPANEL') {
    document.getElementById('dialog-overlay')?.classList.add('hidden');
    document.getElementById('context-menu')?.classList.add('hidden');
    sendResponse({ closed: true });
    setTimeout(() => window.close(), 20);
    return true;
  }
  if (msg.type === 'PING_SIDEPANEL') {
    sendResponse({ open: true });
    return true;
  }
  return false;
});

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const k = el.getAttribute('data-i18n');
    const m = chrome.i18n.getMessage(k);
    if (m) el.textContent = m;
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const k = el.getAttribute('data-i18n-placeholder');
    const m = chrome.i18n.getMessage(k);
    if (m) el.placeholder = m;
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const k = el.getAttribute('data-i18n-title');
    const m = chrome.i18n.getMessage(k);
    if (m) el.title = m;
  });
  const fallbackTitles = {
    'btn-new-folder': 'newFolder',
    'btn-search': 'search',
    'btn-bulk-delete': 'delete',
    'btn-clear-closed': 'clearClosedTitle',
    'btn-clear-deleted': 'clearDeletedTitle',
    'btn-options': 'optionsTitle'
  };
  for (const [id, key] of Object.entries(fallbackTitles)) {
    const el = document.getElementById(id);
    if (el && !el.title) {
      el.title = i18n(key);
    }
  }
  document.title = i18n('extName');
}

function applySettingsToCSS() {
  document.documentElement.style.setProperty('--font-size', settings.fontSize + 'px');
  document.documentElement.style.setProperty('--line-height', String(settings.lineHeight));
}

// storage.local優先のloadSettings
async function loadSettings() {
  try{
    const localKeys = [...PERSIST_OPTION_KEYS, 'expandedFolders','lastSelectedFolderId','configBackupFolderId'];
    const localData = await chrome.storage.local.get(localKeys).catch(()=>({}));
    const hasLocalOpt = PERSIST_OPTION_KEYS.some(k=> localData[k]!==undefined);
    let merged = {...DEFAULT_SETTINGS, ...localData};

    if(!hasLocalOpt){
      // sync fallback
      try{
        const syncData = await chrome.storage.sync.get(SYNC_DEFAULTS).catch(()=>({}));
        if(syncData && Object.keys(syncData).length){
          // localへ移行
          await chrome.storage.local.set(syncData).catch(()=>{});
          merged = {...DEFAULT_SETTINGS, ...syncData, expandedFolders: localData.expandedFolders||{}, lastSelectedFolderId: localData.lastSelectedFolderId||null, configBackupFolderId: localData.configBackupFolderId||syncData.configBackupFolderId||null};
        }
      }catch{}
    }

    // バックアップ復元
    const hasOpt = PERSIST_OPTION_KEYS.some(k=> merged[k]!==undefined);
    const hasUI = merged.expandedFolders && Object.keys(merged.expandedFolders).length>0;
    if(!hasOpt && !hasUI){
      try{
        const backup = await loadBackupFromBookmark();
        if(backup?.options){
          await chrome.storage.local.set(backup.options).catch(()=>{});
          if(backup.meta?.configBackupFolderId) await chrome.storage.local.set({configBackupFolderId: backup.meta.configBackupFolderId}).catch(()=>{});
          if(backup.ui?.expandedFolders) await chrome.storage.local.set({expandedFolders: backup.ui.expandedFolders}).catch(()=>{});
          if(backup.ui?.lastSelectedFolderId) await chrome.storage.local.set({lastSelectedFolderId: backup.ui.lastSelectedFolderId}).catch(()=>{});
          merged = {...merged, ...backup.options, expandedFolders: backup.ui?.expandedFolders||merged.expandedFolders, lastSelectedFolderId: backup.ui?.lastSelectedFolderId||merged.lastSelectedFolderId};
        }
      }catch{}
    }

    settings = {...DEFAULT_SETTINGS, ...merged};
    applySettingsToCSS();
    return settings;
  }catch(e){
    settings = {...DEFAULT_SETTINGS};
    applySettingsToCSS();
    return settings;
  }
}

async function getTree(){
  const tree = await chrome.bookmarks.getTree();
  return tree;
}

function isNodeMatchingSearch(node, query){
  if(!query) return true;
  const q = query.toLowerCase();
  if((node.title||'').toLowerCase().includes(q)) return true;
  if((node.url||'').toLowerCase().includes(q)) return true;
  return false;
}
function filterTreeNodes(nodes, query){
  if(!query) return nodes;
  const out = [];
  for(const n of nodes){
    if(n.title===CONFIG_TITLE && n.url?.startsWith(CONFIG_PREFIX)) continue;
    if(!n.url){ // folder
      const filteredChildren = n.children ? filterTreeNodes(n.children, query) : [];
      if(filteredChildren.length>0 || isNodeMatchingSearch(n, query)){
        out.push({...n, children: filteredChildren});
      }
    }else{
      if(isNodeMatchingSearch(n, query)) out.push(n);
    }
  }
  return out;
}

function renderTree(tree){
  const container = document.getElementById('tree-container');
  if(!container) return;
  // 既存observerの監視解除は新しいobserverで自動的に切れるが、念のため
  // containerクリア前にunobserveは不要（disconnectでOKだが、再生成する）
  container.innerHTML = '';
  let nodes = tree;
  if(Array.isArray(tree) && tree.length===1 && tree[0].children){
    nodes = tree[0].children;
  }
  // config除外
  nodes = nodes.filter(n=> !(n.title===CONFIG_TITLE && n.url?.startsWith(CONFIG_PREFIX)));

  // 検索フィルタ
  if(searchQuery){
    nodes = filterTreeNodes(nodes, searchQuery);
  }

  if(nodes.length===0){
    document.getElementById('empty')?.classList.remove('hidden');
  }else{
    document.getElementById('empty')?.classList.add('hidden');
    for(const node of nodes){
      const el = createTreeNode(node);
      if(el) container.appendChild(el);
    }
  }

  // キャッシュ保存（0ms表示用に裏で更新）
  try{
    chrome.storage.local.set({[TREE_CACHE_KEY]: {tree, ts: Date.now()}}).catch(()=>{});
  }catch{}

  updateBulkDeleteButton();
}

function createTreeNode(node){
  const isFolder = !node.url;
  const wrapper = document.createElement('div');
  wrapper.className = 'tree-node';
  wrapper.dataset.id = node.id;

  const row = document.createElement('div');
  row.className = 'node-row' + (isFolder ? ' folder' : ' bookmark');
  if(isFolder && settings.expandedFolders[node.id]) row.classList.add('expanded');

  const chev = document.createElement('span');
  chev.className = 'chevron';
  chev.textContent = isFolder ? '▶' : '';
  row.appendChild(chev);

  const iconSpan = document.createElement('span');
  iconSpan.className = 'icon';
  if(isFolder){
    iconSpan.textContent = '📁';
  }else{
    const img = document.createElement('img');
    img.className = 'favicon';
    img.alt = '';
    img.src = TRANSPARENT_PIXEL;
    if(isHttpUrl(node.url)){
      img.dataset.src = getFaviconUrl(node.url);
      img.dataset.originalUrl = node.url;
      observeFavicon(img);
      img.onerror = ()=>{
        try{ const host = new URL(node.url).hostname; faviconMemoryCache.set(host, {failed:true}); }catch{}
        img.style.display='none';
      };
    }else{
      img.style.display='none';
    }
    iconSpan.appendChild(img);
  }
  row.appendChild(iconSpan);

  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = node.title || node.url || '';
  title.title = node.title || node.url || '';
  row.appendChild(title);

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'node-checkbox';
  checkbox.dataset.id = node.id;
  checkbox.checked = checkedIds.has(node.id);
  checkbox.addEventListener('click', (e)=>{ e.stopPropagation(); toggleCheck(node.id, checkbox.checked); });
  row.appendChild(checkbox);

  row.addEventListener('click', (e)=>{
    if(e.target.closest('.node-checkbox')) return;
    if(isFolder){
      const expanded = !!settings.expandedFolders[node.id];
      if(expanded) delete settings.expandedFolders[node.id];
      else settings.expandedFolders[node.id] = true;
      row.classList.toggle('expanded', !expanded);
      chrome.storage.local.set({expandedFolders: settings.expandedFolders}).catch(()=>{});
      const childrenDiv = wrapper.querySelector(':scope > .children');
      if(childrenDiv) childrenDiv.classList.toggle('collapsed', expanded);
      if(!expanded && node.id){
        try{ chrome.storage.local.set({lastSelectedFolderId: node.id}).catch(()=>{}); }catch{}
      }
    }else{
      const pos = settings.tabOpenPosition || 'end';
      const active = settings.tabActiveBehavior || 'keep';
      // chrome.bookmarksから直接開く
      if(node.url){
        chrome.tabs.create({url: node.url, active: active==='activate'}).catch(()=>{});
        // 必要なら位置調整はbackground側でやる想定だが、ここではシンプルに
      }
    }
  });

  row.addEventListener('contextmenu', (e)=>{
    e.preventDefault();
    contextTarget = node;
    showContextMenu(e.clientX, e.clientY);
  });

  // rootフォルダはドラッグ不可
  row.draggable = !isUnmodifiableNode(node);
  row.addEventListener('dragstart', (e)=>{
    if (isUnmodifiableNode(node)) { e.preventDefault(); return; }
    dragState.draggedId = node.id;
    e.dataTransfer.setData('text/plain', node.id);
    e.dataTransfer.effectAllowed = 'move';
  });
  row.addEventListener('dragover', (e)=>{
    const draggedId = dragState.draggedId || e.dataTransfer.getData('text/plain');
    if (draggedId && isRootBookmarkId(draggedId)) { e.dataTransfer.dropEffect = 'none'; return; }
    e.preventDefault();
    const rect = row.getBoundingClientRect();
    const mid = rect.top + rect.height/2;
    if(e.clientY < mid){
      dragState.dropPosition = 'before';
      row.style.borderTop = '2px solid #1a73e8';
      row.style.borderBottom = '';
    }else{
      dragState.dropPosition = 'after';
      row.style.borderBottom = '2px solid #1a73e8';
      row.style.borderTop = '';
    }
    dragState.dropTarget = node.id;
  });
  row.addEventListener('dragleave', ()=>{
    row.style.borderTop = '';
    row.style.borderBottom = '';
  });
  row.addEventListener('drop', async (e)=>{
    e.preventDefault();
    row.style.borderTop = '';
    row.style.borderBottom = '';
    const draggedId = e.dataTransfer.getData('text/plain') || dragState.draggedId;
    if(!draggedId || draggedId===node.id) return;
    if(isRootBookmarkId(draggedId)) return;
    try{
      if(dragState.dropPosition==='before' || dragState.dropPosition==='after'){
        const parent = await chrome.bookmarks.get(node.id).then(b=>b[0]?.parentId).catch(()=>null);
        if(parent){
          if(String(parent) === '0'){ console.warn('Blocked: cannot reorder root folders (parent 0) - Chrome spec'); return; }
          const siblings = await chrome.bookmarks.getChildren(parent);
          const idx = siblings.findIndex(s=>s.id===node.id);
          const newIdx = dragState.dropPosition==='before' ? idx : idx+1;
          await safeBookmarkMove(draggedId, {parentId: parent, index: newIdx});
        }
      }else{
        // folderに移動はchildren側で処理
      }
    }catch(err){ console.warn(err); }
  });

  wrapper.appendChild(row);

  if(isFolder && node.children && node.children.length){
    const childrenDiv = document.createElement('div');
    childrenDiv.className = 'children' + (settings.expandedFolders[node.id] ? '' : ' collapsed');
    // 検索時は強制展開
    if(searchQuery) childrenDiv.classList.remove('collapsed');
    for(const child of node.children){
      if(child.title===CONFIG_TITLE && child.url?.startsWith(CONFIG_PREFIX)) continue;
      const childEl = createTreeNode(child);
      if(childEl) childrenDiv.appendChild(childEl);
    }
    childrenDiv.addEventListener('dragover', (e)=>{ 
      const draggedId = dragState.draggedId || e.dataTransfer.getData('text/plain');
      if(draggedId && isRootBookmarkId(draggedId)){ e.dataTransfer.dropEffect='none'; return; }
      // 1,2はrootだが、中にブックマークを入れるのは許可 (Chrome仕様ではOK)
      if(String(node.id) === '0'){ e.dataTransfer.dropEffect='none'; return; }
      if(node.unmodifiable === 'managed'){ e.dataTransfer.dropEffect='none'; return; }
      e.preventDefault(); 
      childrenDiv.style.background='rgba(26,115,232,0.08)'; 
    });
    childrenDiv.addEventListener('dragleave', ()=>{ childrenDiv.style.background=''; });
    childrenDiv.addEventListener('drop', async (e)=>{
      e.preventDefault();
      childrenDiv.style.background='';
      const draggedId = e.dataTransfer.getData('text/plain') || dragState.draggedId;
      if(!draggedId || draggedId===node.id) return;
      if(isRootBookmarkId(draggedId)) return;
      if(String(node.id) === '0') return;
      if(node.unmodifiable === 'managed') return;
      try{ await safeBookmarkMove(draggedId, {parentId: node.id}); }catch(err){ console.warn(err); }
    });
    wrapper.appendChild(childrenDiv);
  }

  return wrapper;
}

function toggleCheck(id, checked){
  if(checked) checkedIds.add(id);
  else checkedIds.delete(id);
  updateBulkDeleteButton();
}
function updateBulkDeleteButton(){
  const btn = document.getElementById('btn-bulk-delete');
  const badge = document.getElementById('delete-count');
  if(!btn) return;
  const count = checkedIds.size;
  if(count>0){
    btn.disabled = false;
    if(badge){ badge.textContent = String(count); badge.classList.remove('hidden'); }
  }else{
    btn.disabled = false; // 元実装は常に有効だがbadgeで表示
    if(badge){ badge.classList.add('hidden'); }
  }
}
function showContextMenu(x,y){
  const menu = document.getElementById('context-menu');
  if(!menu) return;
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.classList.remove('hidden');
  // 画面外補正
  setTimeout(()=>{
    const rect = menu.getBoundingClientRect();
    if(rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
    if(rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + 'px';
  },0);
}
function hideContextMenu(force){
  const menu = document.getElementById('context-menu');
  if(menu) menu.classList.add('hidden');
  if(force) contextTarget = null;
}
async function deleteNodeWithTarget(target){
  const t = target || contextTarget;
  if(!t) return;
  if(settings.confirmDelete){
    const msgKey = t.url ? 'confirmDeleteBookmark' : 'confirmDeleteFolder';
    const msg = i18n(msgKey, t.title||t.url||'') || `Delete "${t.title||t.url}"?`;
    if(!confirm(msg)) return;
  }
  try{ await chrome.bookmarks.removeTree(t.id); }catch(e){
    try{ await chrome.bookmarks.remove(t.id); }catch(err){ console.error(err); }
  }
}
function showDialog(title, defaultValue, okText){
  return new Promise(resolve=>{
    const overlay = document.getElementById('dialog-overlay');
    const titleEl = document.getElementById('dialog-title');
    const input = document.getElementById('dialog-input');
    const okBtn = document.getElementById('dialog-ok');
    const cancelBtn = document.getElementById('dialog-cancel');
    titleEl.textContent = title;
    input.value = defaultValue||'';
    okBtn.textContent = okText||i18n('save');
    overlay.classList.remove('hidden');
    input.focus();
    input.select();
    const cleanup = ()=>{
      overlay.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKey);
      dialogCallback = null;
    };
    const onOk = ()=>{ const v = input.value.trim(); cleanup(); resolve(v||null); };
    const onCancel = ()=>{ cleanup(); resolve(null); };
    const onKey = (e)=>{ if(e.key==='Enter') onOk(); if(e.key==='Escape') onCancel(); };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    input.addEventListener('keydown', onKey);
    dialogCallback = onCancel;
  });
}
async function showRenameDialogWithTarget(target){
  const t = target || contextTarget;
  if(!t) return;
  const newName = await showDialog(i18n('rename'), t.title, i18n('save'));
  if(newName && newName!==t.title){
    try{ await chrome.bookmarks.update(t.id, {title: newName}); }catch(e){ console.error(e); }
  }
}
async function showNewFolderDialog(){
  const name = await showDialog(i18n('createFolderTitle'), '', i18n('create'));
  if(!name) return;
  let parentId = settings.lastSelectedFolderId || '1';
  // 親がフォルダか確認
  try{
    const bm = await chrome.bookmarks.get(parentId);
    if(bm[0]?.url) parentId='1';
  }catch{ parentId='1'; }
  try{ await chrome.bookmarks.create({parentId, title: name}); }catch(e){ console.error(e); }
}
function openBookmarksInFolder(folderNode){
  const urls = [];
  const collect = (n)=>{
    if(n.url) urls.push(n.url);
    if(n.children) n.children.forEach(collect);
  };
  collect(folderNode);
  if(urls.length===0) return;
  if(urls.length>10){
    if(!confirm(i18n('confirmOpenMany', String(urls.length)))) return;
  }
  urls.forEach(u=> chrome.tabs.create({url: u}).catch(()=>{}));
}
async function handleBulkDelete(){
  if(checkedIds.size===0) return;
  if(settings.confirmDelete){
    if(!confirm(i18n('confirmBulkDelete', String(checkedIds.size)))) return;
  }
  const ids = Array.from(checkedIds);
  checkedIds.clear();
  updateBulkDeleteButton();
  for(const id of ids){
    try{ await chrome.bookmarks.removeTree(id); }catch{ try{ await chrome.bookmarks.remove(id); }catch{} }
  }
}
function refresh(){
  if(currentView==='bookmarks'){
    getTree().then(t=>{ renderTree(t); }).catch(()=>{});
  }
}
function switchView(view){
  currentView = view;
  document.querySelectorAll('.view-tab').forEach(btn=>{
    btn.classList.toggle('active', btn.dataset.view===view);
  });
  document.getElementById('view-bookmarks')?.classList.toggle('hidden', view!=='bookmarks');
  document.getElementById('view-tabs-list')?.classList.toggle('hidden', view!=='tabs');
  document.getElementById('view-closed')?.classList.toggle('hidden', view!=='closed');
  document.getElementById('view-deleted')?.classList.toggle('hidden', view!=='deleted');
  const newFolderBtn = document.getElementById('btn-new-folder');
  const searchBtn = document.getElementById('btn-search');
  const bulkDelBtn = document.getElementById('btn-bulk-delete');
  const clearClosedBtn = document.getElementById('btn-clear-closed');
  const clearDeletedBtn = document.getElementById('btn-clear-deleted');
  if(newFolderBtn) newFolderBtn.style.display = view==='bookmarks' ? 'flex' : 'none';
  if(searchBtn) searchBtn.style.display = view==='bookmarks' ? 'flex' : 'none';
  if(bulkDelBtn) bulkDelBtn.style.display = view==='bookmarks' ? 'flex' : 'none';
  if(clearClosedBtn) clearClosedBtn.style.display = view==='closed' ? 'flex' : 'none';
  if(clearDeletedBtn) clearDeletedBtn.style.display = view==='deleted' ? 'flex' : 'none';
  if(view==='tabs') renderOpenTabs();
  if(view==='closed') renderClosedTabs();
  if(view==='deleted') renderDeletedBookmarks();
}
async function renderOpenTabs(){
  const container = document.getElementById('tabs-container');
  if(!container) return;
  container.innerHTML = '<div style="padding:16px;color:#9aa0a6;font-size:12px;">'+i18n('loading')+'</div>';
  try{
    const tabs = await chrome.tabs.query({});
    container.innerHTML = '';
    if(tabs.length===0){
      container.innerHTML = '<div style="padding:16px;color:#5f6368;">No open tabs</div>';
      return;
    }
    const title = document.createElement('div');
    title.className='section-title';
    title.textContent = i18n('currentlyOpenTabs');
    container.appendChild(title);
    for(const tab of tabs){
      const row = document.createElement('div');
      row.className='tab-row';
      if(tab.active) row.classList.add('active');
      const iconSpan = document.createElement('span');
      iconSpan.className='icon';
      const img = document.createElement('img');
      img.className='favicon';
      img.src = TRANSPARENT_PIXEL;
      if(tab.url && isHttpUrl(tab.url)){
        img.dataset.src = getFaviconUrl(tab.url);
        img.dataset.originalUrl = tab.url;
        observeFavicon(img);
      }else if(tab.favIconUrl){
        img.src = tab.favIconUrl;
      }else{
        img.style.display='none';
      }
      iconSpan.appendChild(img);
      const t = document.createElement('span');
      t.className='tab-title';
      t.textContent = tab.title||tab.url||'';
      t.title = tab.title||tab.url||'';
      const closeBtn = document.createElement('button');
      closeBtn.className='tab-close';
      closeBtn.textContent='✕';
      closeBtn.title = i18n('tabClose');
      closeBtn.addEventListener('click', (e)=>{ e.stopPropagation(); chrome.tabs.remove(tab.id).catch(()=>{}); });
      row.appendChild(iconSpan);
      row.appendChild(t);
      row.appendChild(closeBtn);
      row.addEventListener('click', ()=>{ chrome.tabs.update(tab.id, {active:true}).catch(()=>{}); });
      row.addEventListener('contextmenu', (e)=>{
        e.preventDefault();
        // 簡易: 他を閉じる
        if(confirm(i18n('tabCloseOthers'))){
          chrome.tabs.query({}).then(all=>{
            const others = all.filter(at=> at.id!==tab.id && !at.pinned);
            chrome.tabs.remove(others.map(o=>o.id)).catch(()=>{});
          });
        }
      });
      container.appendChild(row);
    }
  }catch(e){ console.error(e); container.innerHTML = '<div style="color:red;padding:8px;">Failed to load tabs</div>'; }
}
async function renderClosedTabs(){
  const container = document.getElementById('closed-container');
  if(!container) return;
  container.innerHTML = '<div style="padding:16px;color:#9aa0a6;font-size:12px;">'+i18n('loading')+'</div>';
  try{
    const {closedTabsHistory=[]} = await chrome.storage.local.get(['closedTabsHistory']);
    container.innerHTML = '';
    const today = new Date(); today.setHours(0,0,0,0);
    const todays = closedTabsHistory.filter(h=> h.closedAt >= today.getTime());
    const title = document.createElement('div');
    title.className='section-title';
    title.textContent = i18n('todayClosedTabs', String(todays.length)) || `Today Closed (${todays.length})`;
    container.appendChild(title);
    if(todays.length===0){
      const empty = document.createElement('div');
      empty.style.padding='16px';
      empty.style.color='#5f6368';
      empty.style.fontSize='12px';
      empty.textContent = i18n('noClosedTabs');
      container.appendChild(empty);
      const hint = document.createElement('div');
      hint.style.padding='0 16px';
      hint.style.color='#9aa0a6';
      hint.style.fontSize='11px';
      hint.textContent = i18n('closedTabsHint');
      container.appendChild(hint);
      return;
    }
    for(const item of todays){
      const row = document.createElement('div');
      row.className='closed-row';
      const iconSpan = document.createElement('span');
      iconSpan.className='icon';
      const img = document.createElement('img');
      img.className='favicon';
      img.src = TRANSPARENT_PIXEL;
      if(item.url && isHttpUrl(item.url)){
        img.dataset.src = getFaviconUrl(item.url);
        img.dataset.originalUrl = item.url;
        observeFavicon(img);
      }else if(item.favIconUrl){
        img.src = item.favIconUrl;
      }else{
        img.style.display='none';
      }
      iconSpan.appendChild(img);
      const titleEl = document.createElement('span');
      titleEl.className='tab-title';
      titleEl.textContent = item.title||item.url;
      titleEl.title = item.title||item.url;
      const timeBadge = document.createElement('span');
      timeBadge.style.fontSize='10px';
      timeBadge.style.color='#9aa0a6';
      timeBadge.textContent = new Date(item.closedAt).toLocaleTimeString();
      const restoreBtn = document.createElement('button');
      restoreBtn.className='restore-btn';
      restoreBtn.textContent = i18n('restore');
      restoreBtn.addEventListener('click', (e)=>{
        e.stopPropagation();
        chrome.tabs.create({url: item.url});
      });
      row.appendChild(iconSpan);
      row.appendChild(titleEl);
      row.appendChild(timeBadge);
      row.appendChild(restoreBtn);
      row.addEventListener('click', ()=>chrome.tabs.create({url: item.url}));
      row.addEventListener('contextmenu', async (e)=>{
        e.preventDefault();
        try {
          const { closedTabsHistory = [] } = await chrome.storage.local.get(['closedTabsHistory']);
          const idx = closedTabsHistory.findIndex(h => h.closedAt === item.closedAt && h.url === item.url);
          if (idx >= 0) {
            closedTabsHistory.splice(idx, 1);
            await chrome.storage.local.set({ closedTabsHistory });
            renderClosedTabs();
          }
        } catch {}
      });
      container.appendChild(row);
    }
  }catch(e){ console.error(e); }
}


async function restoreDeletedEntry(entry){
  if(!entry || !entry.node) return false;
  let targetParentId = entry.parentId || '2';
  // parentが存在するか確認
  try{
    const parentNodes = await chrome.bookmarks.get(targetParentId);
    if(!parentNodes[0] || parentNodes[0].url){
      throw new Error('parent not folder');
    }
  }catch{
    // フォールバック: その他のブックマーク
    targetParentId = '2';
  }

  async function createRecursive(node, parentId, index){
    try{
      if(node.url){
        const created = await chrome.bookmarks.create({
          parentId: parentId,
          title: node.title || node.url,
          url: node.url,
          index: typeof index === 'number' ? index : undefined
        });
        return created;
      }else{
        const folder = await chrome.bookmarks.create({
          parentId: parentId,
          title: node.title || 'Untitled folder',
          index: typeof index === 'number' ? index : undefined
        });
        if(node.children && node.children.length){
          for(let i=0;i<node.children.length;i++){
            await createRecursive(node.children[i], folder.id);
          }
        }
        return folder;
      }
    }catch(e){
      // 親が無効なら fallback で再試行
      if(parentId !== '2'){
        try{
          return await createRecursive(node, '2');
        }catch{}
      }
      throw e;
    }
  }

  try{
    await createRecursive(entry.node, targetParentId, entry.index);
    // 復元成功したら履歴から削除
    try{
      const { [DELETED_BOOKMARKS_KEY]: history = [] } = await chrome.storage.local.get([DELETED_BOOKMARKS_KEY]);
      const filtered = history.filter(h => !(h.deletedAt === entry.deletedAt && h.id === entry.id));
      await chrome.storage.local.set({ [DELETED_BOOKMARKS_KEY]: filtered });
    }catch{}
    return true;
  }catch(e){
    console.error('restore failed', e);
    // 失敗時は その他のブックマークにフォールバックで1回だけ再試行済み
    try{
      // 最終手段: 通知
      alert(i18n('restoreFailed'));
    }catch{}
    return false;
  }
}

async function renderDeletedBookmarks(){
  const container = document.getElementById('deleted-container');
  if(!container) return;
  container.innerHTML = '<div style="padding:16px;color:#9aa0a6;font-size:12px;">'+i18n('loading')+'</div>';
  try{
    const { [DELETED_BOOKMARKS_KEY]: deletedHistory = [] } = await chrome.storage.local.get([DELETED_BOOKMARKS_KEY]);
    // 下位互換: 旧キー名 deletedBookmarksHistory も読む
    let history = deletedHistory;
    if(!history || history.length===0){
      const alt = await chrome.storage.local.get(['deletedBookmarksHistory']);
      if(alt.deletedBookmarksHistory && alt.deletedBookmarksHistory.length){
        history = alt.deletedBookmarksHistory;
      }
    }
    container.innerHTML = '';
    const title = document.createElement('div');
    title.className='section-title';
    title.textContent = i18n('todayDeletedBookmarks', String(history.length)) || `Deleted today (${history.length})`;
    container.appendChild(title);
    if(history.length===0){
      const empty = document.createElement('div');
      empty.style.padding='16px';
      empty.style.color='#5f6368';
      empty.style.fontSize='12px';
      empty.textContent = i18n('noDeletedBookmarks');
      container.appendChild(empty);
      const hint = document.createElement('div');
      hint.style.padding='0 16px';
      hint.style.color='#9aa0a6';
      hint.style.fontSize='11px';
      hint.textContent = i18n('deletedBookmarksHint');
      container.appendChild(hint);
      return;
    }
    for(const item of history){
      const node = item.node || {};
      const isFolder = !node.url;
      const row = document.createElement('div');
      row.className='deleted-row';
      
      const iconSpan = document.createElement('span');
      iconSpan.className='icon';
      if(isFolder){
        iconSpan.textContent = '📁';
      }else{
        const img = document.createElement('img');
        img.className='favicon';
        img.src = TRANSPARENT_PIXEL;
        if(node.url && isHttpUrl(node.url)){
          img.dataset.src = getFaviconUrl(node.url);
          img.dataset.originalUrl = node.url;
          observeFavicon(img);
        }else{
          img.style.display='none';
        }
        iconSpan.appendChild(img);
      }

      const titleEl = document.createElement('span');
      titleEl.className='tab-title';
      const displayTitle = node.title || node.url || '(no title)';
      titleEl.textContent = displayTitle;
      titleEl.title = displayTitle + (node.url ? '\n' + node.url : '');

      const badge = document.createElement('span');
      badge.className='badge ' + (isFolder ? 'folder' : '');
      badge.textContent = isFolder ? i18n('deletedBadgeFolder') || 'Folder' : i18n('deletedBadgeBookmark') || '';
      if(!badge.textContent) badge.style.display='none';

      const countInfo = document.createElement('span');
      countInfo.style.fontSize='10px';
      countInfo.style.color='#9aa0a6';
      countInfo.style.flexShrink='0';
      if(isFolder && node.children){
        const total = (function count(n){ let c=0; if(!n.children) return 0; for(const ch of n.children){ c++; if(!ch.url) c+=count(ch); } return c; })(node);
        if(total>0) countInfo.textContent = `(${total})`;
      }

      const timeBadge = document.createElement('span');
      timeBadge.className='time-badge';
      timeBadge.textContent = new Date(item.deletedAt).toLocaleTimeString();

      const restoreBtn = document.createElement('button');
      restoreBtn.className='restore-btn';
      restoreBtn.textContent = i18n('restore');
      restoreBtn.addEventListener('click', async (e)=>{
        e.stopPropagation();
        restoreBtn.disabled = true;
        restoreBtn.textContent = '...';
        const ok = await restoreDeletedEntry(item);
        if(ok){
          // renderはstorage.onChangedで走る
        }else{
          restoreBtn.disabled = false;
          restoreBtn.textContent = i18n('restore');
        }
      });

      row.appendChild(iconSpan);
      row.appendChild(titleEl);
      if(badge.textContent) row.appendChild(badge);
      if(countInfo.textContent) row.appendChild(countInfo);
      row.appendChild(timeBadge);
      row.appendChild(restoreBtn);

      // クリックでURLがあれば開く、フォルダなら復元
      row.addEventListener('click', ()=>{
        if(node.url){
          chrome.tabs.create({url: node.url}).catch(()=>{});
        }else{
          // フォルダは復元を促す
          restoreDeletedEntry(item);
        }
      });

      // 右クリックで履歴から削除
      row.addEventListener('contextmenu', async (e)=>{
        e.preventDefault();
        try{
          const { [DELETED_BOOKMARKS_KEY]: hist = [] } = await chrome.storage.local.get([DELETED_BOOKMARKS_KEY]);
          const idx = hist.findIndex(h => h.deletedAt === item.deletedAt && h.id === item.id);
          if(idx>=0){
            hist.splice(idx,1);
            await chrome.storage.local.set({[DELETED_BOOKMARKS_KEY]: hist});
            renderDeletedBookmarks();
          }else{
            // background経由も試す
            chrome.runtime.sendMessage({type:'DELETE_DELETED_ENTRY', entryId: item.id, deletedAt: item.deletedAt}).catch(()=>{});
          }
        }catch{}
      });

      container.appendChild(row);
    }
  }catch(e){ console.error(e); container.innerHTML = '<div style="color:red;padding:8px;">Failed to load deleted bookmarks</div>'; }
}

function initSearch(){

  const btn = document.getElementById('btn-search');
  const wrapper = document.getElementById('search-wrapper');
  const input = document.getElementById('search-input');
  const closeBtn = document.getElementById('btn-search-close');
  if(!btn||!wrapper||!input) return;
  btn.addEventListener('click', ()=>{
    wrapper.classList.remove('hidden');
    input.focus();
    btn.style.display='none';
  });
  const doSearch = ()=>{
    searchQuery = input.value.trim();
    refresh();
  };
  let timer=null;
  input.addEventListener('input', ()=>{
    if(timer) clearTimeout(timer);
    timer=setTimeout(doSearch, 200);
  });
  closeBtn?.addEventListener('click', ()=>{
    wrapper.classList.add('hidden');
    input.value='';
    searchQuery='';
    document.getElementById('btn-search').style.display='flex';
    refresh();
  });
  input.addEventListener('keydown', (e)=>{
    if(e.key==='Escape'){
      wrapper.classList.add('hidden');
      input.value='';
      searchQuery='';
      document.getElementById('btn-search').style.display='flex';
      refresh();
    }
  });
}

// ---- Event Listeners ----
document.getElementById('btn-new-folder')?.addEventListener('click', showNewFolderDialog);
document.getElementById('btn-clear-closed')?.addEventListener('click', async ()=>{
  if (settings.confirmDelete) {
    if (!confirm(i18n('confirmClearClosed'))) return;
  }
  try {
    await chrome.runtime.sendMessage({ type: 'CLEAR_TODAY_CLOSED' });
  } catch (e) {
    console.warn('CLEAR_TODAY_CLOSED failed', e);
  }
});
document.getElementById('btn-clear-deleted')?.addEventListener('click', async ()=>{
  if (settings.confirmDelete) {
    if (!confirm(i18n('confirmClearDeleted'))) return;
  }
  try {
    await chrome.runtime.sendMessage({ type: 'CLEAR_DELETED_BOOKMARKS' });
  } catch (e) {
    console.warn('CLEAR_DELETED_BOOKMARKS failed', e);
    // フォールバック: 直接消す
    try{ await chrome.storage.local.set({[DELETED_BOOKMARKS_KEY]: []}); renderDeletedBookmarks(); }catch{}
  }
});
document.getElementById('btn-options')?.addEventListener('click', ()=>chrome.runtime.openOptionsPage());
document.getElementById('btn-bulk-delete')?.addEventListener('click', handleBulkDelete);
document.getElementById('ctx-delete')?.addEventListener('click', ()=>{ const t=contextTarget; hideContextMenu(true); deleteNodeWithTarget(t); });
document.getElementById('ctx-rename')?.addEventListener('click', ()=>{ const t=contextTarget; hideContextMenu(true); showRenameDialogWithTarget(t); });
document.getElementById('ctx-openAll')?.addEventListener('click', async ()=>{
  const target=contextTarget; hideContextMenu(true); if(!target) return;
  try{ const subTree=await chrome.bookmarks.getSubTree(target.id); if(subTree[0]) openBookmarksInFolder(subTree[0]); }catch(e){ console.error(e); }
});
document.addEventListener('click', e=>{
  if(!e.target.closest('#context-menu')){ const m=document.getElementById('context-menu'); if(m && !m.classList.contains('hidden')) hideContextMenu(false); }
});
document.addEventListener('keydown', e=>{ if(e.key==='Escape'){ hideContextMenu(true); if(dialogCallback) dialogCallback(); } });

document.querySelectorAll('.view-tab').forEach(btn=>{
  btn.addEventListener('click', ()=>switchView(btn.dataset.view));
});

chrome.bookmarks.onChanged.addListener(refresh);
chrome.bookmarks.onCreated.addListener(refresh);
chrome.bookmarks.onRemoved.addListener(refresh);
chrome.bookmarks.onMoved.addListener(refresh);
if (chrome.bookmarks.onChildrenReordered) chrome.bookmarks.onChildrenReordered.addListener(refresh);
chrome.tabs.onCreated.addListener(()=>{ if(currentView==='tabs') renderOpenTabs(); });
chrome.tabs.onUpdated.addListener(()=>{ if(currentView==='tabs') renderOpenTabs(); });
chrome.tabs.onRemoved.addListener(()=>{ if(currentView==='tabs') renderOpenTabs(); if(currentView==='closed') renderClosedTabs(); });
chrome.tabs.onActivated.addListener(()=>{ if(currentView==='tabs') renderOpenTabs(); });

chrome.storage.onChanged.addListener((changes, area)=>{
  // local優先
  if(area==='local'){
    let needCSS=false;
    for(const k in changes){
      if(PERSIST_OPTION_KEYS.includes(k)){
        settings[k]=changes[k].newValue;
        needCSS=true;
      }
      if(k==='expandedFolders') settings.expandedFolders = changes[k].newValue || {};
      if(k==='lastSelectedFolderId') settings.lastSelectedFolderId = changes[k].newValue || null;
    }
    if(needCSS) applySettingsToCSS();
    if (changes.closedTabsHistory && currentView==='closed') {
      renderClosedTabs();
    }
    if (changes[DELETED_BOOKMARKS_KEY] && currentView==='deleted') {
      renderDeletedBookmarks();
    }
    if (changes.deletedBookmarksHistory && currentView==='deleted') {
      renderDeletedBookmarks();
    }
    if (changes[TREE_CACHE_KEY] && currentView==='bookmarks' && !searchQuery){
      // 他タブでキャッシュ更新されたら差分反映
      // ただし自分がgetTreeで更新した場合は無視するため、tsチェックは省略
    }
  }
  if(area==='sync'){
    // sync -> localへ移行
    const toMigrate={};
    for(const k in changes){
      if(PERSIST_OPTION_KEYS.includes(k) || k==='configBackupFolderId'){
        toMigrate[k]=changes[k].newValue;
        settings[k]=changes[k].newValue;
      }
    }
    if(Object.keys(toMigrate).length){
      chrome.storage.local.set(toMigrate).catch(()=>{});
      applySettingsToCSS();
    }
  }
});

(async function init(){
  applyI18n();
  initFaviconObserver();
  connectToBackground();
  initSearch();
  const container = document.getElementById('tree-container');
  if (container) {
    container.innerHTML = '<div style="padding:16px;color:#9aa0a6;font-size:12px;text-align:center;">'+i18n('loading')+'</div>';
  }

  // 設定は裏で読み込みつつ、キャッシュは0msで即表示
  const settingsPromise = loadSettings();

  // 0msキャッシュ表示
  let cachedTree = null;
  try {
    const cacheResult = await chrome.storage.local.get([TREE_CACHE_KEY]);
    const cached = cacheResult[TREE_CACHE_KEY];
    if (cached && cached.tree) {
      cachedTree = cached.tree;
      // TTL無視で即表示（0ms）
      try{
        currentView = 'bookmarks';
        document.querySelectorAll('.view-tab').forEach(btn => {
          btn.classList.toggle('active', btn.dataset.view === 'bookmarks');
        });
        document.getElementById('view-bookmarks')?.classList.remove('hidden');
        document.getElementById('view-tabs-list')?.classList.add('hidden');
        document.getElementById('view-closed')?.classList.add('hidden');
        document.getElementById('view-deleted')?.classList.add('hidden');
        renderTree(cachedTree);
        // キャッシュ表示できたのでLoadingは消える
      }catch(e){ console.warn(e); }
    }
  } catch {}

  // 裏で最新ツリー取得して差分更新
  const treePromise = getTree().catch(e => { console.error('getTree failed', e); return null; });

  // 設定適用は待つが、キャッシュ表示をブロックしない
  await settingsPromise;

  currentView = 'bookmarks';
  document.querySelectorAll('.view-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === 'bookmarks');
  });
  document.getElementById('view-bookmarks')?.classList.remove('hidden');
  document.getElementById('view-tabs-list')?.classList.add('hidden');
  document.getElementById('view-closed')?.classList.add('hidden');
  document.getElementById('view-deleted')?.classList.add('hidden');
  const newFolderBtn = document.getElementById('btn-new-folder');
  const searchBtn = document.getElementById('btn-search');
  const bulkDelBtn = document.getElementById('btn-bulk-delete');
  const clearClosedBtn = document.getElementById('btn-clear-closed');
  const clearDeletedBtn = document.getElementById('btn-clear-deleted');
  if (newFolderBtn) newFolderBtn.style.display = 'flex';
  if (searchBtn) searchBtn.style.display = 'flex';
  if (bulkDelBtn) bulkDelBtn.style.display = 'flex';
  if (clearClosedBtn) clearClosedBtn.style.display = 'none';
  if (clearDeletedBtn) clearDeletedBtn.style.display = 'none';

  try {
    const freshTree = await treePromise;
    if(freshTree){
      // 差分チェック: 簡易的にJSON長さとtsで比較、違えば再描画
      const freshStr = JSON.stringify(freshTree);
      const cachedStr = cachedTree ? JSON.stringify(cachedTree) : '';
      if (!cachedTree || freshStr.length !== cachedStr.length || freshStr !== cachedStr) {
        renderTree(freshTree);
      }
      // 最新をキャッシュ
      try{
        await chrome.storage.local.set({[TREE_CACHE_KEY]: {tree: freshTree, ts: Date.now()}});
      }catch{}
    }
  } catch(e) {
    console.error('initial render failed', e);
    if (!cachedTree && container) container.innerHTML = '<div style="padding:16px;color:#d93025;">Failed to load bookmarks</div>';
  }
  updateBulkDeleteButton();
})();
