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
  lastCreatedFolderId: null,
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

// known: { source:移動元ノード(取得済), dstKnownFolder:trueで移動先フォルダ確認済 }
// →不要な bookmarks.get の往復を省いて高速化する
async function safeBookmarkMove(id, dest, known){
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
      known = null; // 移動先が変わったので再確認する
    }

    // 移動元がunmodifiable(managed)なら禁止
    let srcNode = known?.source || null;
    if (!srcNode) {
      try{ [srcNode] = await chrome.bookmarks.get(sid); }catch{}
    }
    if (srcNode?.unmodifiable === 'managed') {
      console.warn('Blocked managed node:', sid);
      return false;
    }
    // rootフォルダ自体はunmodifiableでなくてもIDで弾く
    if (isRootBookmarkId(srcNode?.id)) return false;

    // 移動先がunmodifiableなフォルダ自体への移動は、子として追加ならOK
    // ただし移動先自体が root(0) の場合は上記で2にフォールバック済み
    if (!known?.dstKnownFolder) {
      let dstNode = null;
      try{ [dstNode] = await chrome.bookmarks.get(dParent); }catch{}
      // dstがブックマーク( urlあり )ならその親に置くべき
      if (dstNode?.url) {
        const p = dstNode.parentId || '2';
        if (String(p) === '0') dest.parentId = '2';
        else dest.parentId = p;
      }
    }

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
let dragState = { draggedId: null, multi: false };
let dialogCallback = null;
let sidePanelPort = null;
let currentView = 'bookmarks';
let checkedIds = new Set();
let operationStatusTimer = null;
let lastRenderedTree = null;

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

function isConfigBookmark(node){
  return node?.title === CONFIG_TITLE && node.url?.startsWith(CONFIG_PREFIX);
}

function sameBookmarkTree(a, b){
  if(a === b) return true;
  if(!Array.isArray(a) || !Array.isArray(b)) return false;
  const visibleA = a.filter(node=>!isConfigBookmark(node));
  const visibleB = b.filter(node=>!isConfigBookmark(node));
  if(visibleA.length !== visibleB.length) return false;
  for(let i=0; i<visibleA.length; i++){
    const left = visibleA[i];
    const right = visibleB[i];
    if(left.id !== right.id || left.index !== right.index || left.parentId !== right.parentId ||
       left.title !== right.title || left.url !== right.url) return false;
    if(!sameBookmarkTree(left.children || [], right.children || [])) return false;
  }
  return true;
}

function initFaviconObserver(){
  // 毎回 new し直さず、既存の observer を使い回す（生成コストと破棄オーバーヘッドを避ける）
  try{
    if(faviconObserver){ faviconObserver.disconnect(); return; }
  }catch{}
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
    document.getElementById('folder-overlay')?.classList.add('hidden');
    document.getElementById('context-menu')?.classList.add('hidden');
    sendResponse({ closed: true });
    setTimeout(() => window.close(), 20);
    return true;
  }
  if (msg.type === 'PING_SIDEPANEL') {
    sendResponse({ open: true });
    return true;
  }
  if(msg.type === 'DELETED_BOOKMARK_SAVE_FAILED'){
    setOperationStatus('deletedBookmarkSaveFailed');
    sendResponse({received: true});
    return true;
  }
  if(msg.type === 'DELETED_BOOKMARK_HISTORY_PRUNED'){
    setOperationStatus('deletedBookmarkHistoryPruned');
    sendResponse({received: true});
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
    const localKeys = [...PERSIST_OPTION_KEYS, 'expandedFolders','lastSelectedFolderId','lastCreatedFolderId','configBackupFolderId'];
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
      if(isNodeMatchingSearch(n, query)){
        // フォルダ名が一致した場合は中身もそのまま表示する
        out.push(n);
      }else if(filteredChildren.length>0){
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
  lastRenderedTree = tree;
  initFaviconObserver();

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

  // フラグメントに作り込んでから一括で差し替え（レイアウトを1回だけ起こす）
  const fragment = document.createDocumentFragment();
  if(nodes.length===0){
    document.getElementById('empty')?.classList.remove('hidden');
  }else{
    document.getElementById('empty')?.classList.add('hidden');
    for(const node of nodes){
      const el = createTreeNode(node);
      if(el) fragment.appendChild(el);
    }
  }

  const scrollTop = container.scrollTop;
  container.replaceChildren(fragment);
  // 再描画後もスクロール位置を維持（検索時は先頭から）
  if(resetScrollOnRender){
    resetScrollOnRender = false;
    container.scrollTop = 0;
  }else{
    container.scrollTop = scrollTop;
  }

  updateBulkDeleteButton();
}

// ブックマーク一覧の再表示。
// force=false: 既に取得済みのツリー(lastRenderedTree)から即時再描画（検索入力時などに使用）
// force=true : 最新のツリーを取得してから再描画（作成・削除・改名・移動後に使用）
// 高速化: 同じツリーなら再描画しない / 同時進行の再取得は1回に束ねる
let renderDirty = false;          // 一覧以外のビュー中に変更が来た → ブックマーク表示に戻るとき再描画
let refreshInFlight = null;
let refreshQueued = false;
let refreshTimer = null;
let resetScrollOnRender = false;
let savedTreeScroll = 0;

function renderCurrent(tree){
  if(currentView === 'bookmarks'){
    try{ renderTree(tree); renderDirty = false; }
    catch(e){ console.warn('render failed', e); }
  }else{
    // 一覧以外を表示中は DOM を作り直さず、最新の状態だけ保持して次に戻るときに描画する
    lastRenderedTree = tree;
    renderDirty = true;
  }
}

function refresh(force){
  if(!force){
    if(currentView !== 'bookmarks'){ renderDirty = true; return Promise.resolve(); }
    if(lastRenderedTree){
      try{ renderTree(lastRenderedTree); renderDirty = false; }catch(e){ console.warn('refresh failed', e); }
    }
    return Promise.resolve();
  }
  // 同時に複数の更新が来たら1回の取得に束ねる（末尾の1回で取り直す）
  if(refreshInFlight){
    refreshQueued = true;
    return refreshInFlight;
  }
  refreshInFlight = getTree().then(tree=>{
    // 取得結果が表示済みと同一なら再描画しない（DOM構築・favicon再読込を省く）
    if(lastRenderedTree && sameBookmarkTree(lastRenderedTree, tree)) return;
    renderCurrent(tree);
  }).catch(e=>{ console.warn('refresh failed', e); }).finally(()=>{
    refreshInFlight = null;
    if(refreshQueued){ refreshQueued = false; refresh(true); }
  });
  return refreshInFlight;
}

// 変更イベント用のデバウンス再取得（自分の操作と外部の変更を1回にまとめる）
function scheduleRefresh(delay = 50){
  if(refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(()=>{
    refreshTimer = null;
    refresh(true);
  }, delay);
}

function setOperationStatus(key, subs){
  const status = document.getElementById('operation-status');
  if(!status) return;
  // 選択バーと重ならないよう、選択バー表示中は一覧エリア内の直上にずらして表示する
  const bar = document.getElementById('selection-bar');
  status.classList.toggle('above-selection-bar', !!bar && !bar.classList.contains('hidden'));
  status.textContent = (subs !== undefined) ? i18n(key, subs) : i18n(key);
  status.classList.add('visible');
  clearTimeout(operationStatusTimer);
  operationStatusTimer = setTimeout(()=>status.classList.remove('visible'), 2400);
}

function populateFolderChildren(childrenDiv, children){
  const fragment = document.createDocumentFragment();
  for(const child of children || []){
    if(isConfigBookmark(child)) continue;
    const childEl = createTreeNode(child);
    if(childEl) fragment.appendChild(childEl);
  }
  childrenDiv.appendChild(fragment);
  childrenDiv.dataset.populated = 'true';
}

async function performBookmarkDrop(draggedId, targetId, position){
  if(!draggedId || !targetId || String(draggedId) === String(targetId)) return false;
  if(isRootBookmarkId(draggedId)) return false;

  try{
    const [sourceArr, targetArr] = await Promise.all([
      chrome.bookmarks.get(String(draggedId)).catch(()=>null),
      chrome.bookmarks.get(String(targetId)).catch(()=>null)
    ]);
    const source = sourceArr && sourceArr[0];
    const target = targetArr && targetArr[0];
    if(!source || !target || source.unmodifiable === 'managed'){
      setOperationStatus('bookmarkMoveFailed');
      return false;
    }

    let parentId;
    let moveIndex;          // undefined なら末尾に追加
    const dstKnownFolder = true;

    if(position === 'inside'){
      if(target.url || target.unmodifiable === 'managed'){
        setOperationStatus('bookmarkMoveFailed');
        return false;
      }
      parentId = String(target.id);
      if(!source.url){
        const subtree = await chrome.bookmarks.getSubTree(String(source.id));
        const containsTarget = (nodes)=>nodes.some(item=>
          String(item.id) === String(target.id) || (item.children && containsTarget(item.children))
        );
        if(containsTarget(subtree)){
          setOperationStatus('bookmarkMoveFailed');
          return false;
        }
      }
    }else{
      parentId = String(target.parentId || '');
      if(!parentId || parentId === '0'){
        setOperationStatus('bookmarkMoveFailed');
        return false;
      }
      const siblings = await chrome.bookmarks.getChildren(parentId);
      const remaining = siblings.filter(item=>String(item.id) !== String(source.id));
      const targetIndex = remaining.findIndex(item=>String(item.id) === String(target.id));
      if(targetIndex < 0){
        setOperationStatus('bookmarkMoveFailed');
        return false;
      }
      // ★移動「後」の最終位置（ソースを除いた並びでのindex）
      const finalIndex = targetIndex + (position === 'after' ? 1 : 0);

      // ★Chromeの index は「移動前」の並びを基準にした位置として解釈される。
      //   chromium: BookmarkModel::Move() が同一親で index > old_index のとき
      //   「index--」してから挿入する（また index==old / old+1 は無操作）。
      //   つまり最終位置 F を渡したいときは、old_index より大きい場合だけ +1 する必要がある。
      //   （この補正がないと「1つ下」が無操作、「nつ下」が「n-1つ下」になる）
      const sameParent = String(source.parentId || '') === parentId;
      const oldIndex = typeof source.index === 'number'
        ? source.index
        : siblings.findIndex(item=>String(item.id) === String(source.id));
      moveIndex = (sameParent && oldIndex >= 0 && finalIndex > oldIndex)
        ? finalIndex + 1
        : finalIndex;
    }

    const moved = await safeBookmarkMove(
      source.id,
      {parentId, ...(moveIndex === undefined ? {} : {index: moveIndex})},
      {source, dstKnownFolder}
    );
    if(moved){
      // できればDOMとキャッシュ木をその場で並べ替え、再描画なしで即時表示する
      if(applyLocalMove(source.id, targetId, position)){
        scheduleRefresh(60);   // 裏で整合性を確認するだけ（変化がなければ再描画しない）
      }else{
        await refresh(true);   // 通常の全体再描画
      }
      setOperationStatus('bookmarkMoveComplete');
    }else{
      setOperationStatus('bookmarkMoveFailed');
    }
    return moved;
  }catch(error){
    console.warn('Bookmark drop failed', error);
    setOperationStatus('bookmarkMoveFailed');
    return false;
  }
}

// ---- チェックした項目をまとめてドラッグ移動する ----
// ドラッグ元がチェック済みで、チェックが2件以上あるときだけ一括移動になる
function isBulkDrag(draggedId){
  if(!dragState.multi || !draggedId) return false;
  return checkedIds.has(String(draggedId)) && checkedIds.size > 1;
}

async function performBulkDrop(draggedId, targetId, position){
  if(!draggedId || !targetId || String(draggedId) === String(targetId)) return false;
  if(isRootBookmarkId(draggedId)) return false;
  if(!isBulkDrag(draggedId)) return performBookmarkDrop(draggedId, targetId, position);

  try{
    const raw = await collectCheckedNodes();
    const checkedSet = new Set(raw.map(n=>String(n.id)));

    // 移動先がチェックした項目そのもの／その子孫なら入れ子になるので不可
    if(checkedSet.has(String(targetId)) || await isDescendantOfAny(targetId, checkedSet)){
      setOperationStatus('bulkMoveFailed');
      return false;
    }

    // root・管理ブックマークは移動できない
    const movable = raw.filter(n=>!isRootBookmarkId(n.id) && n.unmodifiable !== 'managed');
    // 親もチェック済みの子は親に従って移動する（単独では動かさない）
    const nodes = await filterNestedNodes(movable);
    if(nodes.length === 0){
      setOperationStatus('bulkMoveFailed');
      return false;
    }

    let target = null;
    try{ [target] = await chrome.bookmarks.get(String(targetId)); }catch{}
    if(!target){
      setOperationStatus('bulkMoveFailed');
      return false;
    }

    let parentId;
    if(position === 'inside'){
      if(target.url || target.unmodifiable === 'managed'){
        setOperationStatus('bulkMoveFailed');
        return false;
      }
      parentId = String(targetId);
    }else{
      parentId = String(target.parentId || '');
      if(!parentId || parentId === '0'){
        setOperationStatus('bulkMoveFailed');
        return false;
      }
    }

    let moved = 0, failed = 0, skipped = 0;

    if(position === 'inside'){
      // 末尾へツリー順に追加する（既に移動先にいるものは位置を変えない）
      let destChildren = new Set();
      try{
        const sibs = await chrome.bookmarks.getChildren(parentId);
        destChildren = new Set(sibs.map(n=>String(n.id)));
      }catch{}
      for(const n of nodes){
        const sid = String(n.id);
        if(destChildren.has(sid)){ skipped++; continue; }
        const ok = await safeBookmarkMove(sid, {parentId}, {source: n, dstKnownFolder: true});
        if(ok) moved++; else failed++;
      }
    }else{
      let arr;
      try{
        const sibs = await chrome.bookmarks.getChildren(parentId);
        arr = sibs.map(n=>String(n.id));
      }catch{
        setOperationStatus('bulkMoveFailed');
        return false;
      }
      const tIdx = arr.findIndex(id=>String(id) === String(targetId));
      if(tIdx < 0){
        setOperationStatus('bulkMoveFailed');
        return false;
      }
      // ★最終的な並びを先に作り、左から1つずつ正しい位置へ置く方式にする。
      //   「各ノードをターゲットの直前/直後に毎回挿入」すると、グループの一部が
      //   既にターゲットを越えている場合に順序が入れ替わってしまうため。
      const movingIds = nodes.map(n=>String(n.id));
      const without = arr.filter(id=>!movingIds.includes(id)); // チェック項目を除いた並び
      const tPos = without.findIndex(id=>String(id) === String(targetId));
      const insertAt = tPos + (position === 'after' ? 1 : 0);
      const finalArr = without.slice();
      finalArr.splice(insertAt, 0, ...movingIds);

      for(let i = 0; i < finalArr.length; i++){
        if(arr[i] === finalArr[i]) continue;
        const sid = finalArr[i];
        const oldIndex = arr.indexOf(sid);        // -1 = 他フォルダから移動
        const sameParent = oldIndex >= 0;
        // 配置しようとしている位置は「そのノードを除いた並び」基準。
        // 同一親で後ろ側へ動く場合のみ Chromium の index-- 補正のため +1 する
        const apiIndex = (sameParent && i > oldIndex) ? i + 1 : i;
        let ok = false;
        try{
          await chrome.bookmarks.move(sid, {parentId, index: apiIndex});
          ok = true;
        }catch(e){
          console.warn('bulk drag move failed', e);
        }
        if(ok){
          const next = sameParent ? arr.filter(x=>x !== sid) : arr.slice();
          next.splice(i, 0, sid);
          arr = next;
          moved++;
        }else{
          failed++;
        }
      }
    }

    if(moved > 0){
      if(position === 'inside'){
        // 結果が見えるよう移動先フォルダを展開しておく
        settings.expandedFolders[String(targetId)] = true;
        try{
          await chrome.storage.local.set({expandedFolders: settings.expandedFolders});
        }catch{}
      }
      await refresh(true);
      setOperationStatus('bulkMoveComplete', String(moved));
      return true;
    }
    if(failed > 0) setOperationStatus('bulkMoveFailed');
    return false;
  }catch(error){
    console.warn('Bulk drop failed', error);
    setOperationStatus('bulkMoveFailed');
    return false;
  }
}

// ---- 即時反映: 移動結果をDOMとキャッシュ木に直接適用し、再描画を省いて高速化する ----
function findNodeElement(id){
  const container = document.getElementById('tree-container');
  if(!container || id===undefined || id===null) return null;
  const sid = String(id).replace(/["\\]/g, '\\$&');
  try{ return container.querySelector('.tree-node[data-id="' + sid + '"]'); }catch{ return null; }
}

function locateNodeInTree(nodes, id){
  if(!Array.isArray(nodes)) return null;
  const sid = String(id);
  for(let i=0; i<nodes.length; i++){
    const n = nodes[i];
    if(String(n.id) === sid) return {node:n, list:nodes, index:i};
    if(n.children && n.children.length){
      const hit = locateNodeInTree(n.children, id);
      if(hit) return hit;
    }
  }
  return null;
}

// ドロップ直後に再描画せずに並べ替える。true を返したら再描画不要。
// 失敗した場合は false を返し、呼び出し側の全体再描画にフォールバックする。
function applyLocalMove(draggedId, targetId, position){
  if(position !== 'before' && position !== 'after') return false; // inside は通常再描画
  const tree = lastRenderedTree;
  if(!tree) return false;
  const draggedInfo = locateNodeInTree(tree, draggedId);
  const targetInfo = locateNodeInTree(tree, targetId);
  if(!draggedInfo || !targetInfo) return false;
  if(draggedInfo.node === targetInfo.node) return false;
  if(draggedInfo.list !== targetInfo.list) return false; // 異なるフォルダ間の移動は全体再描画

  // 1) キャッシュ木を並べ替え、同じ親の index を振り直す
  try{
    const list = draggedInfo.list;
    const from = list.indexOf(draggedInfo.node);
    if(from < 0) return false;
    list.splice(from, 1);
    let to = list.findIndex(n=>String(n.id) === String(targetId));
    if(to < 0) return false;
    if(position === 'after') to += 1;
    list.splice(to, 0, draggedInfo.node);
    for(let i=0; i<list.length; i++) list[i].index = i;
  }catch(e){
    lastRenderedTree = null; // 木が壊れたので次回は必ず再描画する
    return false;
  }

  // 2) DOM を同じ順に並べ替える（1要素の移動だけなので高速）
  try{
    const draggedEl = findNodeElement(draggedId);
    const targetEl = findNodeElement(targetId);
    if(!draggedEl || !targetEl) throw new Error('row not found');
    const parent = targetEl.parentNode;
    if(!parent || draggedEl.parentNode !== parent) throw new Error('parent mismatch');
    if(position === 'after') parent.insertBefore(draggedEl, targetEl.nextSibling);
    else parent.insertBefore(draggedEl, targetEl);
  }catch(e){
    lastRenderedTree = null; // DOMだけ食い違ったので再描画で作り直す
    return false;
  }
  return true;
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
  checkbox.checked = checkedIds.has(String(node.id));
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
      if(childrenDiv){
        if(expanded){
          childrenDiv.classList.add('collapsed');
        }else{
          if(childrenDiv.dataset.populated !== 'true'){
            populateFolderChildren(childrenDiv, node.children);
          }
          childrenDiv.classList.remove('collapsed');
        }
      }
      if(!expanded && node.id){
        try{ chrome.storage.local.set({lastSelectedFolderId: node.id}).catch(()=>{}); }catch{}
      }
    }else{
      // 通常クリック: 今開いているタブで開く
      // Cmd( Mac ) / Ctrl( Win ) + クリック: 新しいタブで開く
      if(node.url){
        const isNewTab = e.metaKey || e.ctrlKey;
        if(isNewTab){
          const pos = settings.tabOpenPosition || 'end';
          const active = settings.tabActiveBehavior || 'keep';
          chrome.tabs.create({url: node.url, active: active==='activate'}).catch(()=>{});
        }else{
          chrome.tabs.query({active:true, currentWindow:true}).then(tabs=>{
            if(tabs && tabs[0]){
              chrome.tabs.update(tabs[0].id, {url: node.url}).catch(()=>{});
            }else{
              chrome.tabs.update({url: node.url}).catch(()=>{
                chrome.tabs.create({url: node.url}).catch(()=>{});
              });
            }
          }).catch(()=>{
            chrome.tabs.update({url: node.url}).catch(()=>{});
          });
        }
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
    // ドラッグ元がチェック済みなら、チェックした項目全まとめて移動する
    dragState.multi = checkedIds.has(String(node.id)) && checkedIds.size > 1;
    e.dataTransfer.setData('text/plain', node.id);
    e.dataTransfer.effectAllowed = 'move';
  });
  row.addEventListener('dragend', ()=>{
    dragState.draggedId = null;
    dragState.multi = false;
    row.classList.remove('drop-before','drop-after','drop-inside');
  });
  row.addEventListener('dragover', (e)=>{
    const draggedId = dragState.draggedId || e.dataTransfer.getData('text/plain');
    if (!draggedId || isRootBookmarkId(draggedId) || String(draggedId) === String(node.id)) {
      e.dataTransfer.dropEffect = 'none';
      return;
    }
    if(!isFolder && String(node.parentId || '') === '0'){
      e.dataTransfer.dropEffect = 'none';
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const rect = row.getBoundingClientRect();
    const ratio = (e.clientY - rect.top) / Math.max(rect.height, 1);
    let position = 'before';
    if(isFolder && ratio >= 0.3 && ratio <= 0.7) position = 'inside';
    else if(ratio > 0.7) position = 'after';
    row.classList.toggle('drop-before', position === 'before');
    row.classList.toggle('drop-after', position === 'after');
    row.classList.toggle('drop-inside', position === 'inside');
    row.dataset.dropPosition = position;
    e.dataTransfer.dropEffect = 'move';
  });
  row.addEventListener('dragleave', (e)=>{
    if(e.relatedTarget && row.contains(e.relatedTarget)) return;
    row.classList.remove('drop-before','drop-after','drop-inside');
    delete row.dataset.dropPosition;
  });
  row.addEventListener('drop', async (e)=>{
    e.preventDefault();
    e.stopPropagation();
    row.classList.remove('drop-before','drop-after','drop-inside');
    const draggedId = e.dataTransfer.getData('text/plain') || dragState.draggedId;
    const position = row.dataset.dropPosition;
    delete row.dataset.dropPosition;
    if(position){
      if(isBulkDrag(draggedId)) await performBulkDrop(draggedId, node.id, position);
      else await performBookmarkDrop(draggedId, node.id, position);
    }
  });

  wrapper.appendChild(row);

  if(isFolder){
    const childrenDiv = document.createElement('div');
    childrenDiv.className = 'children' + (settings.expandedFolders[node.id] ? '' : ' collapsed');
    const shouldPopulate = !!settings.expandedFolders[node.id] || !!searchQuery;
    if(searchQuery) childrenDiv.classList.remove('collapsed');
    if(shouldPopulate){
      populateFolderChildren(childrenDiv, node.children);
    }
    childrenDiv.addEventListener('dragover', (e)=>{
      const draggedId = dragState.draggedId || e.dataTransfer.getData('text/plain');
      if(!draggedId || isRootBookmarkId(draggedId) || String(draggedId) === String(node.id)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
    });
    childrenDiv.addEventListener('drop', async (e)=>{
      e.preventDefault();
      e.stopPropagation();
      const draggedId = e.dataTransfer.getData('text/plain') || dragState.draggedId;
      if(isBulkDrag(draggedId)) await performBulkDrop(draggedId, node.id, 'inside');
      else await performBookmarkDrop(draggedId, node.id, 'inside');
    });
    wrapper.appendChild(childrenDiv);
  }

  return wrapper;
}

function toggleCheck(id, checked){
  const sid = String(id);
  if(checked) checkedIds.add(sid);
  else checkedIds.delete(sid);
  updateBulkDeleteButton();
}
function clearSelection(){
  if(checkedIds.size === 0) return;
  checkedIds.clear();
  document.querySelectorAll('.node-checkbox:checked').forEach(cb=>{ cb.checked = false; });
  updateBulkDeleteButton();
}
// 選択肢として使えないID（消えたノード・root）を取り除く
function pruneCheckedIds(){
  if(checkedIds.size === 0) return;
  for(const id of Array.from(checkedIds)){
    if(isRootBookmarkId(id)) checkedIds.delete(id);
  }
  if(!lastRenderedTree || checkedIds.size === 0) return;
  const live = new Set();
  const walk = (ns)=>{ for(const n of (ns||[])){ live.add(String(n.id)); if(n.children) walk(n.children); } };
  walk(lastRenderedTree);
  for(const id of Array.from(checkedIds)){
    if(!live.has(id)) checkedIds.delete(id);
  }
}
function updateBulkDeleteButton(){
  pruneCheckedIds();
  const btn = document.getElementById('btn-bulk-delete');
  const badge = document.getElementById('delete-count');
  const bar = document.getElementById('selection-bar');
  const count = checkedIds.size;
  if(btn){
    if(badge){
      if(count>0){
        badge.textContent = String(count);
        badge.classList.remove('hidden');
      }else{
        badge.classList.add('hidden');
      }
    }
  }
  if(bar){
    bar.classList.toggle('hidden', count===0);
    const label = document.getElementById('selection-count');
    if(label) label.textContent = count>0 ? i18n('selectedCount', String(count)) : '';
    // 表示中のステータス表示も選択バーに被らない位置へ追従させる
    const status = document.getElementById('operation-status');
    if(status) status.classList.toggle('above-selection-bar', count>0);
  }
}
function showContextMenu(x,y){
  const menu = document.getElementById('context-menu');
  if(!menu) return;
  const openAllBtn = document.getElementById('ctx-openAll');
  if(openAllBtn){
    const isFolder = contextTarget && !contextTarget.url;
    openAllBtn.style.display = isFolder ? '' : 'none';
  }
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.classList.remove('hidden');
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
  refresh(true);
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
    // 修正: キャンセルボタンのテキストが空になる不具合を修正
    cancelBtn.textContent = i18n('cancel') || 'キャンセル';
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
    refresh(true);
  }
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
// ノードが「作成先に使えるフォルダ」かどうか（ブックマークや管理下のノードは除外）
function isUsableFolderNode(node){
  return !!node && !node.url && node.unmodifiable !== 'managed';
}

// ノード配下にある、表示順で一番下のフォルダを返す（無ければ null）
function findBottomMostFolder(node){
  let bottom = null;
  const walk = (n)=>{
    for(const child of (n.children || [])){
      if(!child.url) bottom = child;
      if(child.children && child.children.length) walk(child);
    }
  };
  walk(node);
  return bottom;
}

function findNodeById(nodes, id){
  if(id === undefined || id === null) return null;
  let hit = null;
  const walk = (list)=>{
    for(const n of (list || [])){
      if(String(n.id) === String(id)){ hit = n; return; }
      if(n.children && n.children.length) walk(n.children);
      if(hit) return;
    }
  };
  walk(nodes);
  return hit;
}

// 新規フォルダの作成先を決める。
// 1. 現在開いている（展開中の）フォルダがあれば → その中の一番下のフォルダの下
//    （中にフォルダが無ければ、開いているフォルダ自身の直下）
// 2. 何も開いていなければ → 「その他のブックマーク」の中の一番下のフォルダの下
// 3. ただし直前に作ったフォルダが作成先になる場合（連続して作成しているとき）は
//    入れ子にせず、そのフォルダと同じ階層の末尾に並べる
async function resolveNewFolderParentId(){
  let tree = null;
  try{ tree = (await chrome.bookmarks.getTree())[0] || null; }catch{}
  let parentId = null;

  if(tree){
    const isExpanded = (id)=> !!settings.expandedFolders[String(id)];

    // 現在開いているフォルダ（複数開いていれば最後に開いたもの、それが閉じていれば表示順で一番下のもの）
    let openNode = isExpanded(settings.lastSelectedFolderId)
      ? findNodeById(tree.children, settings.lastSelectedFolderId)
      : null;
    if(!openNode){
      let bottom = null;
      const walk = (nodes)=>{
        for(const n of (nodes || [])){
          if(!n.url && isExpanded(n.id)) bottom = n;
          if(n.children && n.children.length) walk(n.children);
        }
      };
      walk(tree.children);
      openNode = bottom;
    }
    if(isUsableFolderNode(openNode)){
      const inner = findBottomMostFolder(openNode);
      parentId = String(isUsableFolderNode(inner) ? inner.id : openNode.id);
    }

    // 何も開いていない → 「その他のブックマーク」→「ブックマークバー」の中の一番下のフォルダ
    if(!parentId){
      for(const rootId of ['2', '1']){
        const rootNode = findNodeById(tree.children, rootId);
        if(!isUsableFolderNode(rootNode)) continue;
        const bottom = findBottomMostFolder(rootNode);
        parentId = String(isUsableFolderNode(bottom) ? bottom.id : rootNode.id);
        break;
      }
    }
  }
  if(!parentId) return '2';

  // 連続して作成している場合（作成先が直前に作ったフォルダの場合）は入れ子にせず、
  // そのフォルダと同じ階層の末尾に並べる
  const lastCreatedId = settings.lastCreatedFolderId ? String(settings.lastCreatedFolderId) : null;
  if(lastCreatedId && lastCreatedId === String(parentId)){
    try{
      const [bottom] = await chrome.bookmarks.get(lastCreatedId);
      if(bottom && bottom.parentId && String(bottom.parentId) !== '0') return String(bottom.parentId);
    }catch{}
  }
  return parentId;
}

// 指定したフォルダから上へたどった祖先フォルダのID一覧を返す（rootは含めない）
async function collectFolderChain(id){
  const ids = [];
  let cur = id;
  for(let i=0; i<50 && cur; i++){
    const sid = String(cur);
    if(sid === '0') break;
    ids.push(sid);
    try{
      const [bm] = await chrome.bookmarks.get(sid);
      cur = bm?.parentId;
    }catch{ break; }
  }
  return ids;
}

async function showNewFolderDialog(){
  const name = await showDialog(i18n('createFolderTitle'), '', i18n('create'));
  if(!name) return;
  const parentId = await resolveNewFolderParentId();
  let created = null;
  try{
    created = await chrome.bookmarks.create({parentId, title: name});
  }catch(e){
    console.error('create folder failed', e);
    setOperationStatus('folderCreateFailed');
    return;
  }
  // 作成したフォルダがすぐに見えるよう、祖先フォルダ・作成先・新規フォルダを展開しておく
  try{
    const chain = await collectFolderChain(parentId);
    for(const id of chain) settings.expandedFolders[id] = true;
    if(created?.id) settings.expandedFolders[created.id] = true;
    settings.lastCreatedFolderId = created?.id || null;
    await chrome.storage.local.set({
      expandedFolders: settings.expandedFolders,
      lastCreatedFolderId: settings.lastCreatedFolderId
    });
  }catch{}
  await refresh(true);
  setOperationStatus('folderCreateComplete');
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
  refresh(true);
}

// ===================== 複数選択のまとめ処理 =====================

// チェック中のノードを「表示順（ツリー順）」で取得する。
// ツリーに無いID（取り消し済み等）は Chrome から取り直す。
async function collectCheckedNodes(){
  const out = [];
  if(checkedIds.size===0) return out;
  const seen = new Set();
  const walk = (nodes)=>{
    for(const n of (nodes||[])){
      const sid = String(n.id);
      if(checkedIds.has(sid)){ out.push(n); seen.add(sid); }
      if(n.children) walk(n.children);
    }
  };
  if(lastRenderedTree) walk(lastRenderedTree);
  const missing = Array.from(checkedIds).filter(id=>!seen.has(id));
  if(missing.length){
    const got = await Promise.all(missing.map(id=>
      chrome.bookmarks.get(id).then(a=>a&&a[0]).catch(()=>null)
    ));
    for(const g of got) if(g) out.push(g);
  }
  return out;
}

function groupCheckedByParent(nodes){
  const groups = new Map();
  for(const n of nodes){
    const pid = String(n.parentId || '');
    if(!pid || pid==='0') continue; // root 直下は並べ替え不可
    if(!groups.has(pid)) groups.set(pid, []);
    groups.get(pid).push(n);
  }
  return groups;
}

// 同一親内で from → to へ1つ移動する。arr は実配列の写し（結果を追従させる）
async function moveSiblingIndex(id, parentId, arr, from, to){
  if(from===to) return true;
  // Chrome の index は「移動前」の並び基準。下方向(to>from)は +1 補正が要る
  // （Chromium BookmarkModel::Move() が index > old_index のとき index-- するため）
  const apiIndex = to > from ? to + 1 : to;
  try{
    await chrome.bookmarks.move(id, {parentId, index: apiIndex});
  }catch(e){
    console.warn('shift move failed', e);
    return false;
  }
  arr.splice(from, 1);
  arr.splice(to, 0, id);
  return true;
}

// direction < 0: 上へ / direction > 0: 下へ
// 選択項目は互いの位置を越えない（先頭・末尾で止まる）ように1つずつずらす
async function shiftSiblings(parentId, nodes, direction){
  let siblings;
  try{ siblings = await chrome.bookmarks.getChildren(parentId); }catch{ return 0; }
  const arr = siblings.map(n=>String(n.id));
  const picked = new Set(nodes.map(n=>String(n.id)));
  let moved = 0;
  if(direction < 0){
    for(let i=1; i<arr.length; i++){
      if(!picked.has(arr[i]) || picked.has(arr[i-1])) continue;
      const ok = await moveSiblingIndex(arr[i], parentId, arr, i, i-1);
      if(!ok) break;
      moved++;
    }
  }else{
    for(let i=arr.length-2; i>=0; i--){
      if(!picked.has(arr[i]) || picked.has(arr[i+1])) continue;
      const ok = await moveSiblingIndex(arr[i], parentId, arr, i, i+1);
      if(!ok) break;
      moved++;
    }
  }
  return moved;
}

async function handleBulkShift(direction){
  if(checkedIds.size===0) return;
  const nodes = await collectCheckedNodes();
  const groups = groupCheckedByParent(nodes);
  let moved = 0;
  for(const [parentId, list] of groups){
    moved += await shiftSiblings(parentId, list, direction);
  }
  if(moved>0){
    await refresh(true);
    setOperationStatus('bulkMoveComplete', String(moved));
  }else{
    setOperationStatus('bulkMoveFailed');
  }
}

// id が idSet のいずれかの子孫（または自身）なら true
async function isDescendantOfAny(id, idSet){
  let cur = id;
  for(let i=0; i<64 && cur; i++){
    const sid = String(cur);
    if(idSet.has(sid)) return true;
    if(sid==='0') break;
    try{
      const [n] = await chrome.bookmarks.get(sid);
      cur = n?.parentId;
    }catch{ break; }
  }
  return false;
}

function collectDescendantIds(node, out){
  out.add(String(node.id));
  for(const c of (node.children||[])) collectDescendantIds(c, out);
}

// 親（＝別のチェック項目）の子孫であるノードを取り除く。
// 親も一緒に移動するので、子は親に従って移動する（単独で動かすと親から引き剥がされる）
async function filterNestedNodes(nodes){
  const ids = new Set(nodes.map(n=>String(n.id)));
  const parentMap = new Map();   // id → 親ノード
  if(lastRenderedTree){
    const walk = (list, parent)=>{
      for(const n of (list||[])){
        parentMap.set(String(n.id), parent);
        if(n.children) walk(n.children, n);
      }
    };
    walk(lastRenderedTree, null);
  }
  const out = [];
  for(const n of nodes){
    const sid = String(n.id);
    let nested = false;
    if(parentMap.has(sid)){
      let cur = parentMap.get(sid);
      let steps = 0;
      while(cur && steps++ < 64){
        if(ids.has(String(cur.id))){ nested = true; break; }
        const cid = String(cur.id);
        cur = parentMap.has(cid) ? parentMap.get(cid) : null;
      }
    }else{
      // 描画済みツリーに無いノードは API で先祖をたどる
      const others = new Set(Array.from(ids).filter(id=>id !== sid));
      if(others.size) nested = await isDescendantOfAny(sid, others);
    }
    if(!nested) out.push(n);
  }
  return out;
}

// チェックした項目を dest フォルダへ移動する。移動件数を返す（-1 = 移動先不正）
async function moveCheckedToFolder(destId){
  const dest = String(destId || '');
  if(!dest || dest==='0') return -1;
  const nodes = await collectCheckedNodes();
  if(nodes.length===0) return -1;

  // 移動先がチェックしたフォルダ自身／その子孫なら入れ子になるので不可
  const checkedFolders = new Set(nodes.filter(n=>!n.url).map(n=>String(n.id)));
  if(checkedFolders.has(dest)) return -1;
  if(await isDescendantOfAny(dest, checkedFolders)) return -1;

  // root・管理ブックマークは移動できない。親もチェック済みの子は親に従う
  const movable = await filterNestedNodes(
    nodes.filter(n=>!isRootBookmarkId(n.id) && n.unmodifiable !== 'managed')
  );
  if(movable.length===0) return -1;

  let destNode = null;
  try{ [destNode] = await chrome.bookmarks.get(dest); }catch{}
  if(!destNode || destNode.url || destNode.unmodifiable==='managed') return -1;

  let moved = 0;
  let alreadyThere = 0;
  let failed = 0;
  for(const n of movable){
    const sid = String(n.id);
    if(sid===dest) continue;
    if(String(n.parentId||'')===dest){ alreadyThere++; continue; } // 既に移動先なら位置を変えない
    const ok = await safeBookmarkMove(sid, {parentId: dest}, {source: n, dstKnownFolder: true});
    if(ok) moved++; else failed++;
  }
  // 何も移動できず、既存の移動先揃いでもなければ失敗扱い
  if(moved===0 && failed>0) return -1;
  if(moved===0 && alreadyThere===0) return -1;

  if(moved>0){
    // 結果が見えるよう移動先を展開しておく
    try{
      const chain = await collectFolderChain(dest);
      for(const id of chain) settings.expandedFolders[id] = true;
      settings.expandedFolders[dest] = true;
      settings.lastSelectedFolderId = dest;
      await chrome.storage.local.set({
        expandedFolders: settings.expandedFolders,
        lastSelectedFolderId: settings.lastSelectedFolderId
      });
    }catch{}
    await refresh(true);
  }
  return moved;
}

function hideFolderPicker(){
  document.getElementById('folder-overlay')?.classList.add('hidden');
}

async function showFolderPicker(){
  const overlay = document.getElementById('folder-overlay');
  const listEl = document.getElementById('folder-list');
  if(!overlay || !listEl) return;

  const nodes = await collectCheckedNodes();
  if(nodes.length===0) return;

  // 移動先にできないフォルダ：チェックしたフォルダ自身とその子孫
  const forbidden = new Set(nodes.filter(n=>!n.url).map(n=>String(n.id)));
  if(lastRenderedTree){
    for(const fid of Array.from(forbidden)){
      const hit = locateNodeInTree(lastRenderedTree, fid);
      if(hit) collectDescendantIds(hit.node, forbidden);
    }
  }

  let tree = lastRenderedTree;
  if(!tree){
    try{ tree = await chrome.bookmarks.getTree(); }catch{ tree = null; }
  }

  const options = [];
  const walk = (list, depth)=>{
    for(const n of (list||[])){
      if(n.url) continue;
      const id = String(n.id);
      if(id==='0'){ walk(n.children, depth); continue; } // root 自体は移動先にしない
      if(n.unmodifiable==='managed') continue;
      if(!forbidden.has(id)) options.push({id, title: n.title || id, depth});
      walk(n.children, depth + 1);
    }
  };
  walk(tree, 0);

  listEl.textContent = '';
  if(options.length===0){
    const empty = document.createElement('div');
    empty.id = 'folder-empty';
    empty.textContent = i18n('noFoldersAvailable');
    listEl.appendChild(empty);
  }
  for(const opt of options){
    const btn = document.createElement('button');
    btn.className = 'folder-option';
    btn.dataset.id = opt.id;
    btn.style.paddingLeft = (6 + opt.depth * 14) + 'px';
    const ico = document.createElement('span');
    ico.textContent = '📁';
    const name = document.createElement('span');
    name.className = 'folder-name';
    name.textContent = opt.title;
    name.title = opt.title;
    btn.append(ico, name);
    btn.addEventListener('click', async ()=>{
      hideFolderPicker();
      const moved = await moveCheckedToFolder(opt.id);
      if(moved>=0) setOperationStatus('bulkMoveComplete', String(moved));
      else setOperationStatus('bulkMoveFailed');
    });
    listEl.appendChild(btn);
  }
  overlay.classList.remove('hidden');
}
function switchView(view){
  const prevView = currentView;
  if(prevView==='bookmarks' && view!=='bookmarks'){
    const c = document.getElementById('tree-container');
    if(c) savedTreeScroll = c.scrollTop;
  }
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
  if(view==='bookmarks'){
    // 一覧以外の表示中にブックマークが変更された場合は戻ったとき再描画する
    if(renderDirty && lastRenderedTree){
      try{ renderTree(lastRenderedTree); }catch(e){ console.warn('render failed', e); }
      renderDirty = false;
    }
    const c = document.getElementById('tree-container');
    if(c) c.scrollTop = savedTreeScroll;
  }
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
    // Remove the history item through the background queue.
    try{
      const response = await chrome.runtime.sendMessage({
        type: 'DELETE_DELETED_ENTRY',
        entryId: entry.id,
        deletedAt: entry.deletedAt
      });
      if(!response?.ok) setOperationStatus('deletedBookmarkHistoryUpdateFailed');
    }catch{ setOperationStatus('deletedBookmarkHistoryUpdateFailed'); }
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
    let sessionInfo = null;
    try{
      sessionInfo = await chrome.runtime.sendMessage({type:'GET_DELETED_SESSION'});
    }catch{}

    // Read history only after the background has completed session initialization.
    const storageData = await chrome.storage.local.get([DELETED_BOOKMARKS_KEY, 'deletedBookmarksHistory', 'deletedBookmarksSessionStart']);
    let history = storageData[DELETED_BOOKMARKS_KEY] || storageData['deletedBookmarksHistory'] || [];
    let sessionStart = sessionInfo?.sessionStart || storageData['deletedBookmarksSessionStart'] || 0;

    // セッション開始以降のものだけをフィルタ（起動〜終了までの削除のみ表示）
    if(sessionStart){
      history = history.filter(h => (h.deletedAt||0) >= sessionStart);
    }

    container.innerHTML = '';
    const title = document.createElement('div');
    title.className='section-title';
    title.textContent = i18n('todayDeletedBookmarks', String(history.length)) || `Deleted this session (${history.length})`;
    container.appendChild(title);

    // セッション開始時刻の表示（任意）
    if(sessionStart && history.length>0){
      const info = document.createElement('div');
      info.style.fontSize='10px';
      info.style.color='#9aa0a6';
      info.style.padding='0 10px 4px';
      try{
        const t = new Date(sessionStart).toLocaleTimeString();
        const msg = i18n('deletedSessionInfo', t) || `Session started: ${t}`;
        info.textContent = msg;
      }catch{}
      if(info.textContent) container.appendChild(info);
    }

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

      row.addEventListener('click', ()=>{
        if(node.url){
          chrome.tabs.create({url: node.url}).catch(()=>{});
        }else{
          restoreDeletedEntry(item);
        }
      });

      row.addEventListener('contextmenu', async (e)=>{
        e.preventDefault();
        try{
          const response = await chrome.runtime.sendMessage({
            type:'DELETE_DELETED_ENTRY',
            entryId: item.id,
            deletedAt: item.deletedAt
          });
          if(!response?.ok) setOperationStatus('deletedBookmarkHistoryUpdateFailed');
        }catch{ setOperationStatus('deletedBookmarkHistoryUpdateFailed'); }
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
  const execBtn = document.getElementById('btn-search-execute');
  if(!btn||!wrapper||!input) return;
  
  // 既にリスナーが付いている場合の二重登録を防止
  if(btn.dataset.searchBound) return;
  btn.dataset.searchBound = '1';

  const doSearch = ()=>{
    searchQuery = input.value.trim();
    resetScrollOnRender = true; // 検索結果は先頭から表示する
    refresh();
  };
  
  btn.addEventListener('click', ()=>{
    // 既に検索バーを開いている場合は検索を実行
    if(!wrapper.classList.contains('hidden')){
      doSearch();
      return;
    }
    wrapper.classList.remove('hidden');
    input.focus();
    // 検索ボタンを隠すのではなく、検索実行ボタンとして再利用できるようにする
    // 元のUIを維持するため、ここでは非表示のままにするが、検索は即時可能
    btn.style.display='none';
  });
  
  let timer=null;
  input.addEventListener('input', ()=>{
    if(timer) clearTimeout(timer);
    timer=setTimeout(doSearch, 200);
  });
  
  // 明示的な検索実行（Enterキー）
  input.addEventListener('keydown', (e)=>{
    if(e.key==='Enter'){
      e.preventDefault();
      doSearch();
    }
    if(e.key==='Escape'){
      wrapper.classList.add('hidden');
      input.value='';
      searchQuery='';
      resetScrollOnRender = true;
      document.getElementById('btn-search').style.display='flex';
      refresh();
    }
  });

  closeBtn?.addEventListener('click', ()=>{
    wrapper.classList.add('hidden');
    input.value='';
    searchQuery='';
    document.getElementById('btn-search').style.display='flex';
    refresh();
  });
  
  // 追加: 検索実行ボタンのクリック
  execBtn?.addEventListener('click', ()=>{
    doSearch();
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
    const response = await chrome.runtime.sendMessage({ type: 'CLEAR_DELETED_BOOKMARKS' });
    if(!response?.ok) setOperationStatus('deletedBookmarkHistoryUpdateFailed');
  } catch (e) {
    console.warn('CLEAR_DELETED_BOOKMARKS failed', e);
    setOperationStatus('deletedBookmarkHistoryUpdateFailed');
  }
});
document.getElementById('btn-options')?.addEventListener('click', ()=>chrome.runtime.openOptionsPage());
document.getElementById('btn-bulk-delete')?.addEventListener('click', handleBulkDelete);
document.getElementById('sel-move-up')?.addEventListener('click', ()=>handleBulkShift(-1));
document.getElementById('sel-move-down')?.addEventListener('click', ()=>handleBulkShift(1));
document.getElementById('sel-move-folder')?.addEventListener('click', showFolderPicker);
document.getElementById('sel-delete')?.addEventListener('click', handleBulkDelete);
document.getElementById('sel-clear')?.addEventListener('click', clearSelection);
document.getElementById('folder-cancel')?.addEventListener('click', hideFolderPicker);
document.getElementById('folder-overlay')?.addEventListener('click', (e)=>{
  if(e.target && e.target.id==='folder-overlay') hideFolderPicker();
});
document.getElementById('ctx-delete')?.addEventListener('click', ()=>{ const t=contextTarget; hideContextMenu(true); deleteNodeWithTarget(t); });
document.getElementById('ctx-openAll')?.addEventListener('click', async ()=>{
  const target=contextTarget; hideContextMenu(true); if(!target) return;
  try{
    const subTree=await chrome.bookmarks.getSubTree(target.id);
    if(subTree[0]) openBookmarksInFolder(subTree[0]);
  }catch(e){ console.error(e); }
});
document.getElementById('ctx-rename')?.addEventListener('click', ()=>{ const t=contextTarget; hideContextMenu(true); showRenameDialogWithTarget(t); });

document.addEventListener('click', e=>{
  if(!e.target.closest('#context-menu')){ const m=document.getElementById('context-menu'); if(m && !m.classList.contains('hidden')) hideContextMenu(false); }
});
document.addEventListener('keydown', e=>{ if(e.key==='Escape'){ hideContextMenu(true); hideFolderPicker(); if(dialogCallback) dialogCallback(); } });

document.querySelectorAll('.view-tab').forEach(btn=>{
  btn.addEventListener('click', ()=>switchView(btn.dataset.view));
});

chrome.tabs.onCreated.addListener(()=>{ if(currentView==='tabs') renderOpenTabs(); });
chrome.tabs.onUpdated.addListener(()=>{ if(currentView==='tabs') renderOpenTabs(); });
chrome.tabs.onRemoved.addListener(()=>{ if(currentView==='tabs') renderOpenTabs(); if(currentView==='closed') renderClosedTabs(); });
chrome.tabs.onActivated.addListener(()=>{ if(currentView==='tabs') renderOpenTabs(); });

// ブックマークの変更をサイドパネル自身が直接受け取る。
// （backgroundの storage キャッシュ書き出しを待たないので更新が速い）
const onBookmarkChanged = (id, changeInfo)=>{
  // 設定バックアップ用ブックマークの書き換えは表示に影響しないので無視する
  // （フォルダ展開のたびに設定を保存するため、これは頻繁に発生する）
  if(changeInfo && changeInfo.title === CONFIG_TITLE && String(changeInfo.url || '').startsWith(CONFIG_PREFIX)) return;
  scheduleRefresh();
};
[
  chrome.bookmarks.onCreated,
  chrome.bookmarks.onChanged,
  chrome.bookmarks.onRemoved,
  chrome.bookmarks.onMoved,
  chrome.bookmarks.onChildrenReordered,
  chrome.bookmarks.onImportEnd
].forEach(ev=>{ try{ ev?.addListener(onBookmarkChanged); }catch(e){ console.warn('bookmark listener failed', e); } });

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
      if(k==='lastCreatedFolderId') settings.lastCreatedFolderId = changes[k].newValue || null;
    }
    if(needCSS) applySettingsToCSS();
    if (changes.closedTabsHistory && currentView==='closed') {
      renderClosedTabs();
    }
    if ((changes[DELETED_BOOKMARKS_KEY] || changes.deletedBookmarksHistory || changes.deletedBookmarksSessionStart) && currentView==='deleted') {
      renderDeletedBookmarks();
    }
    if(changes[TREE_CACHE_KEY] && changes[TREE_CACHE_KEY].newValue?.tree && currentView==='bookmarks'){
      const nextTree = changes[TREE_CACHE_KEY].newValue.tree;
      if(!lastRenderedTree || !sameBookmarkTree(lastRenderedTree, nextTree)) renderTree(nextTree);
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
  try{ applyI18n(); }catch{}
  try{ connectToBackground(); }catch{}
  try{ initSearch(); }catch{}

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
      // Avoid allocating full JSON copies just to compare the cache.
      const cacheMatches = !!cachedTree && sameBookmarkTree(freshTree, cachedTree);
      if (!cacheMatches) {
        renderTree(freshTree);
        // キャッシュが古くなっているときだけ全件ツリーを書き出す（重い処理）
        try{
          await chrome.storage.local.set({[TREE_CACHE_KEY]: {tree: freshTree, ts: Date.now()}});
        }catch{}
      }
    }
  } catch(e) {
    console.error('initial render failed', e);
    if (!cachedTree && container) container.innerHTML = '<div style="padding:16px;color:#d93025;">Failed to load bookmarks</div>';
  }
  updateBulkDeleteButton();
})();
