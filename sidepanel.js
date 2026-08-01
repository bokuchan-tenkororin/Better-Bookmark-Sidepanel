/* sidepanel.js v1.3.0 - stable: bulk delete + favicon simple + i18n */
const DEFAULT_SETTINGS = {
  tabOpenPosition: 'end',
  tabActiveBehavior: 'keep',
  confirmDelete: true,
  fontSize: 14,
  lineHeight: 1,
  expandedFolders: {},
  lastSelectedFolderId: null,
};

let settings = { ...DEFAULT_SETTINGS };
let searchQuery = '';
let contextTarget = null;
let dragState = { draggedId: null, dropTarget: null, dropPosition: null };
let dialogCallback = null;
let sidePanelPort = null;
let currentView = 'bookmarks';
let tabContextTarget = null;
let checkedIds = new Set();
let sessionLastSelectedFolderId = null; // Current session only, reset on open

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
    document.getElementById('tab-context-menu')?.classList.add('hidden');
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

async function loadSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const local = await chrome.storage.local.get(['expandedFolders', 'lastSelectedFolderId']);
  settings = { 
    ...DEFAULT_SETTINGS, 
    ...stored, 
    expandedFolders: local.expandedFolders || {},
    lastSelectedFolderId: local.lastSelectedFolderId || null
  };
  if (typeof settings.confirmDelete !== 'boolean') settings.confirmDelete = true;
  applySettingsToCSS();
  console.log('[init] lastSelectedFolderId:', settings.lastSelectedFolderId);
}

function saveExpanded() {
  chrome.storage.local.set({ expandedFolders: settings.expandedFolders });
}
function saveLastSelectedFolderId(id) {
  if (!id) return;
  settings.lastSelectedFolderId = id;
  chrome.storage.local.set({ lastSelectedFolderId: id });
  console.log('[folder] lastSelectedFolderId saved:', id);
}

async function getTree() {
  return await chrome.bookmarks.getTree();
}

function filterTree(nodes, query) {
  if (!query) return nodes;
  const lower = query.toLowerCase();
  function filterNode(node) {
    const matchSelf = (node.title && node.title.toLowerCase().includes(lower)) || (node.url && node.url.toLowerCase().includes(lower));
    if (node.children) {
      const filteredChildren = node.children.map(filterNode).filter(Boolean);
      if (filteredChildren.length > 0 || matchSelf) {
        return { ...node, children: filteredChildren, _forceExpanded: true };
      }
      return null;
    }
    return matchSelf ? node : null;
  }
  return nodes.map(filterNode).filter(Boolean);
}

function updateBulkDeleteButton() {
  const btn = document.getElementById('btn-bulk-delete');
  const badge = document.getElementById('delete-count');
  if (!btn) return;
  const count = checkedIds.size;
  btn.disabled = count === 0;
  if (badge) {
    badge.textContent = String(count);
    badge.classList.toggle('hidden', count === 0);
  }
}

function createFaviconImg(url, fallback='🔖') {
  const img = document.createElement('img');
  img.className = 'favicon';
  img.loading = 'lazy';
  try {
    const hostname = new URL(url).hostname;
    img.src = `https://www.google.com/s2/favicons?domain=${hostname}&sz=32`;
  } catch {
    img.style.display = 'none';
  }
  img.onerror = () => {
    img.style.display = 'none';
    // fallback will be shown via parent text
  };
  return img;
}

function createNodeElement(node) {
  const isFolder = !node.url;
  const wrapper = document.createElement('div');
  wrapper.className = 'tree-node';
  wrapper.dataset.id = node.id;

  const row = document.createElement('div');
  row.className = `node-row ${isFolder ? 'folder' : 'bookmark'}`;
  row.draggable = true;
  row.dataset.id = node.id;
  if (isFolder) {
    const expanded = settings.expandedFolders[node.id] || node._forceExpanded;
    if (expanded) row.classList.add('expanded');
  }

  const chevron = document.createElement('span');
  chevron.className = 'chevron';
  chevron.textContent = isFolder ? '▶' : '';
  row.appendChild(chevron);

  const icon = document.createElement('span');
  icon.className = 'icon';
  if (isFolder) {
    icon.textContent = '📁';
  } else {
    const img = createFaviconImg(node.url, '🔖');
    icon.appendChild(img);
    // fallback emoji if img fails - will show when img hidden
    const fb = document.createElement('span');
    fb.textContent = '🔖';
    fb.style.display = 'none';
    img.addEventListener('error', ()=>{ fb.style.display=''; });
    img.addEventListener('load', ()=>{ fb.style.display='none'; });
    icon.appendChild(fb);
  }
  row.appendChild(icon);

  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = node.title || node.url || '(no title)';
  title.title = node.title + (node.url ? '\n' + node.url : '');
  row.appendChild(title);

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'node-checkbox';
  checkbox.dataset.id = node.id;
  checkbox.checked = checkedIds.has(node.id);
  checkbox.addEventListener('click', e=>e.stopPropagation());
  checkbox.addEventListener('change', e=>{
    e.stopPropagation();
    if (checkbox.checked) checkedIds.add(node.id);
    else checkedIds.delete(node.id);
    updateBulkDeleteButton();
  });
  row.appendChild(checkbox);

  row.addEventListener('click', (e)=>{
    if (e.target.classList.contains('node-checkbox')) return;
    handleClick(e, node);
  });
  row.addEventListener('contextmenu', e=>handleContextMenu(e, node));
  row.addEventListener('dragstart', e=>handleDragStart(e, node));
  row.addEventListener('dragover', e=>handleDragOver(e, node));
  row.addEventListener('dragleave', e=>handleDragLeave(e, node));
  row.addEventListener('drop', e=>handleDrop(e, node));
  row.addEventListener('dragend', handleDragEnd);

  wrapper.appendChild(row);

  if (isFolder && node.children && node.children.length > 0) {
    const childrenDiv = document.createElement('div');
    childrenDiv.className = 'children';
    const isExpanded = settings.expandedFolders[node.id] || node._forceExpanded || (searchQuery !== '');
    if (!isExpanded) childrenDiv.classList.add('collapsed');
    for (const child of node.children) {
      childrenDiv.appendChild(createNodeElement(child));
    }
    wrapper.appendChild(childrenDiv);
  }

  return wrapper;
}

function renderTree(tree) {
  const container = document.getElementById('tree-container');
  if (!container) return;
  container.innerHTML = '';
  let rootNodes = [];
  if (tree.length > 0 && tree[0].children) rootNodes = tree[0].children;
  else rootNodes = tree;
  const filtered = searchQuery ? filterTree(rootNodes, searchQuery) : rootNodes;
  const emptyEl = document.getElementById('empty');
  if (filtered.length === 0) {
    if (emptyEl) {
      emptyEl.classList.remove('hidden');
      const span = emptyEl.querySelector('span');
      if (span) span.textContent = searchQuery ? (i18n('noResults')||'No results') : (i18n('noBookmarks')||'No bookmarks');
    }
  } else {
    if (emptyEl) emptyEl.classList.add('hidden');
  }
  for (const node of filtered) container.appendChild(createNodeElement(node));
  updateBulkDeleteButton();
}

async function refresh() {
  if (currentView !== 'bookmarks') return;
  try {
    const tree = await getTree();
    renderTree(tree);
  } catch(e){ console.error('refresh failed', e); }
}

async function getActiveTabInfo() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function openSingleBookmark(url, event) {
  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  const modifier = isMac ? event.metaKey : event.ctrlKey;
  if (!modifier) {
    const activeTab = await getActiveTabInfo();
    if (activeTab) await chrome.tabs.update(activeTab.id, { url });
    else await chrome.tabs.create({ url });
    return;
  }
  const activeTab = await getActiveTabInfo();
  let createProps = { url, active: (settings.tabActiveBehavior === 'activate') };
  if (settings.tabOpenPosition === 'afterActive' && activeTab) createProps.index = activeTab.index + 1;
  await chrome.tabs.create(createProps);
}

function collectUrls(node) {
  let urls = [];
  if (node.url) urls.push(node.url);
  if (node.children) for (const c of node.children) urls = urls.concat(collectUrls(c));
  return urls;
}

async function openBookmarksInFolder(folderNode) {
  const urls = collectUrls(folderNode);
  if (urls.length === 0) return;
  const activeTab = await getActiveTabInfo();
  let baseIndex = null;
  if (settings.tabOpenPosition === 'afterActive' && activeTab) baseIndex = activeTab.index + 1;
  for (let i = 0; i < urls.length; i++) {
    let props = { url: urls[i], active: false };
    if (baseIndex !== null) props.index = baseIndex + i;
    if (i === urls.length - 1 && settings.tabActiveBehavior === 'activate') props.active = true;
    if (urls.length === 1 && settings.tabActiveBehavior === 'activate') props.active = true;
    await chrome.tabs.create(props);
  }
}

function handleClick(e, node) {
  if (e.button !== 0) return;
  const isFolder = !node.url;
  if (isFolder) {
    sessionLastSelectedFolderId = node.id;
    saveLastSelectedFolderId(node.id);
    const expanded = !!settings.expandedFolders[node.id];
    settings.expandedFolders[node.id] = !expanded;
    saveExpanded();
    const row = document.querySelector(`.node-row[data-id="${node.id}"]`);
    const wrapper = row?.parentElement;
    const children = wrapper?.querySelector(':scope > .children');
    if (children) {
      if (!expanded) { children.classList.remove('collapsed'); row.classList.add('expanded'); }
      else { children.classList.add('collapsed'); row.classList.remove('expanded'); }
    } else if (row) row.classList.toggle('expanded');
  } else {
    openSingleBookmark(node.url, e);
  }
}

function handleDragStart(e, node) {
  dragState.draggedId = node.id;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', node.id);
  setTimeout(() => e.target.classList.add('drag-ghost'), 0);
}
function handleDragOver(e, targetNode) {
  e.preventDefault();
  const draggedId = dragState.draggedId;
  if (!draggedId || draggedId === targetNode.id) return;
  const row = e.currentTarget;
  const rect = row.getBoundingClientRect();
  const offsetY = e.clientY - rect.top;
  const isFolder = !targetNode.url;
  let position = 'before';
  if (isFolder && offsetY > rect.height * 0.25 && offsetY < rect.height * 0.75) position = 'inside';
  else if (offsetY > rect.height / 2) position = 'after';
  document.querySelectorAll('.node-row.drag-over, .node-row.drag-over-inside').forEach(el => el.classList.remove('drag-over','drag-over-inside'));
  if (position === 'inside') row.classList.add('drag-over-inside'); else row.classList.add('drag-over');
  dragState.dropTarget = targetNode;
  dragState.dropPosition = position;
  e.dataTransfer.dropEffect = 'move';
}
function handleDragLeave(e) { e.currentTarget.classList.remove('drag-over','drag-over-inside'); }
async function handleDrop(e, targetNode) {
  e.preventDefault(); e.stopPropagation();
  const draggedId = dragState.draggedId;
  const targetId = targetNode.id;
  if (!draggedId || draggedId === targetId) { cleanupDrag(); return; }
  const position = dragState.dropPosition;
  try {
    if (position === 'inside' && !targetNode.url) {
      await chrome.bookmarks.move(draggedId, { parentId: targetId });
      settings.expandedFolders[targetId] = true; saveExpanded();
    } else {
      const targetBm = (await chrome.bookmarks.get(targetId))[0];
      const parentId = targetBm.parentId;
      const siblings = await chrome.bookmarks.getChildren(parentId);
      let targetIndex = siblings.findIndex(b => b.id === targetId);
      if (position === 'after') targetIndex += 1;
      const draggedBm = (await chrome.bookmarks.get(draggedId))[0];
      if (draggedBm.parentId === parentId) {
        const draggedIndex = siblings.findIndex(b => b.id === draggedId);
        if (draggedIndex < targetIndex) targetIndex -= 1;
      }
      await chrome.bookmarks.move(draggedId, { parentId, index: targetIndex });
    }
  } catch (err) { console.error('move failed', err); }
  cleanupDrag();
}
function handleDragEnd(e) { cleanupDrag(); }
function cleanupDrag() {
  document.querySelectorAll('.node-row.drag-over, .node-row.drag-over-inside, .drag-ghost').forEach(el => el.classList.remove('drag-over','drag-over-inside','drag-ghost'));
  dragState = { draggedId: null, dropTarget: null, dropPosition: null };
}

function showContextMenu(x, y, target) {
  contextTarget = target;
  const menu = document.getElementById('context-menu');
  if (!menu) return;
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.classList.remove('hidden');
  const openAllBtn = document.getElementById('ctx-openAll');
  if (openAllBtn) {
    if (!target.url) {
      const urls = collectUrls(target);
      openAllBtn.style.display = urls.length > 0 ? 'block' : 'none';
    } else {
      openAllBtn.style.display = 'none';
    }
  }
}
function hideContextMenu(force) {
  const menu = document.getElementById('context-menu');
  if (menu) menu.classList.add('hidden');
  if (force) contextTarget = null;
}
function handleContextMenu(e, node) {
  e.preventDefault();
  showContextMenu(e.pageX, e.pageY, node);
}
async function deleteNodeWithTarget(target) {
  if (!target) return;
  if (settings.confirmDelete) {
    const msg = (i18n('confirmDelete')||'Delete {title}?').replace('{title}', target.title || target.url || '');
    if (!confirm(msg)) return;
  }
  try { await chrome.bookmarks.removeTree(target.id); }
  catch(e) { try { await chrome.bookmarks.remove(target.id); } catch(e2){ console.error(e2); } }
}

function openDialog({ title, value, placeholder, okText, onConfirm }) {
  const overlay = document.getElementById('dialog-overlay');
  const titleEl = document.getElementById('dialog-title');
  const input = document.getElementById('dialog-input');
  const okBtn = document.getElementById('dialog-ok');
  const cancelBtn = document.getElementById('dialog-cancel');
  if (!overlay || !titleEl || !input || !okBtn || !cancelBtn) return;
  titleEl.textContent = title;
  input.value = value || '';
  input.placeholder = placeholder || '';
  okBtn.textContent = okText;
  overlay.classList.remove('hidden');
  setTimeout(()=> { input.focus(); input.select(); }, 50);
  dialogCallback = onConfirm;
  function handleOk() {
    const val = input.value.trim();
    close();
    const cb = dialogCallback; dialogCallback = null;
    if (cb) cb(val);
  }
  function handleCancel() { close(); dialogCallback = null; }
  function close() {
    overlay.classList.add('hidden');
    okBtn.removeEventListener('click', handleOk);
    cancelBtn.removeEventListener('click', handleCancel);
    input.removeEventListener('keydown', keyHandler);
    overlay.onclick = null;
  }
  function keyHandler(e) { if (e.key === 'Enter') handleOk(); if (e.key === 'Escape') handleCancel(); }
  okBtn.addEventListener('click', handleOk);
  cancelBtn.addEventListener('click', handleCancel);
  input.addEventListener('keydown', keyHandler);
  overlay.onclick = (e) => { if (e.target === overlay) handleCancel(); };
}

function showRenameDialogWithTarget(target) {
  if (!target) return;
  openDialog({
    title: i18n('rename')||'Rename',
    value: target.title || '',
    placeholder: i18n('bookmarkNamePlaceholder')||'',
    okText: i18n('save')||'Save',
    onConfirm: async (newTitle) => {
      if (!newTitle || newTitle === target.title) return;
      try { await chrome.bookmarks.update(target.id, { title: newTitle }); refresh(); }
      catch (e) { console.error(e); alert('Rename failed: ' + e.message); }
    }
  });
}

async function getDefaultParentId() {
  // 1. If folder was selected in current session (opened or closed), use it
  if (sessionLastSelectedFolderId) {
    try {
      const bms = await chrome.bookmarks.get(sessionLastSelectedFolderId);
      if (bms[0] && !bms[0].url) {
        console.log('[new-folder] using sessionLastSelectedFolderId:', bms[0].id, bms[0].title);
        return bms[0].id;
      }
    } catch {
      console.log('[new-folder] sessionLastSelectedFolderId not found, clearing');
      sessionLastSelectedFolderId = null;
      settings.lastSelectedFolderId = null;
      chrome.storage.local.set({ lastSelectedFolderId: null });
    }
  }
  // 2. Initial state - nothing selected in this session, create at top level
  // Top level = bookmarks bar (id 1) at index 0
  try {
    const tree = await chrome.bookmarks.getTree();
    if (tree[0] && tree[0].children) {
      const bar = tree[0].children.find(c => c.id === '1');
      if (bar) {
        console.log('[new-folder] initial state (no selection), using bookmark bar top:', bar.id);
        return bar.id;
      }
      const other = tree[0].children.find(c => c.id === '2');
      if (other) return other.id;
      return tree[0].children[0].id;
    }
  } catch (e) { console.warn(e); }
  return '1';
}



async function createFolderRobust(title) {
  const parentId = await getDefaultParentId();
  console.log('[new-folder] creating folder', title, 'under parent', parentId, 'at index 0');
  try {
    const f = await chrome.bookmarks.create({parentId: parentId, title, index: 0});
    console.log('[new-folder] created:', f.id);
    return f;
  } catch (err) {
    console.warn('[new-folder] create at index 0 failed, trying without index', err);
    const candidates = [parentId, '1', '2'];
    try {
      const tree = await chrome.bookmarks.getTree();
      function collectFolders(nodes){ for(const n of nodes){ if(!n.url) candidates.push(n.id); if(n.children) collectFolders(n.children); } }
      collectFolders(tree);
    } catch {}
    const unique = [...new Set(candidates)];
    let lastError = null;
    for (const pid of unique) {
      try { 
        const f = await chrome.bookmarks.create({parentId: pid, title, index: 0}); 
        return f; 
      } catch (e) {
        try {
          const f = await chrome.bookmarks.create({parentId: pid, title});
          return f;
        } catch (err2) {
          lastError = err2; continue;
        }
      }
    }
    throw lastError || new Error('No valid parent');
  }
}


function showNewFolderDialog() {
  openDialog({
    title: i18n('createFolderTitle')||'New folder',
    value: '',
    placeholder: i18n('folderNamePlaceholder')||'Folder name',
    okText: i18n('create')||'Create',
    onConfirm: async (name) => {
      const folderName = name || (i18n('newFolder')||'New folder');
      try {
        const newFolder = await createFolderRobust(folderName);
        settings.expandedFolders[newFolder.parentId] = true;
        settings.expandedFolders[newFolder.id] = true;
        saveExpanded();
        refresh();
      } catch (e) {
        console.error('create failed', e);
        alert('Failed: ' + (e && e.message ? e.message : e));
      }
    }
  });
}

function initSearch() {
  const btn = document.getElementById('btn-search');
  const wrapper = document.getElementById('search-wrapper');
  const input = document.getElementById('search-input');
  const closeBtn = document.getElementById('btn-search-close');
  if (!btn || !wrapper || !input || !closeBtn) return;
  btn.addEventListener('click', () => {
    if (currentView !== 'bookmarks') switchView('bookmarks');
    wrapper.classList.toggle('hidden');
    if (!wrapper.classList.contains('hidden')) input.focus();
  });
  closeBtn.addEventListener('click', () => { wrapper.classList.add('hidden'); input.value=''; searchQuery=''; refresh(); });
  input.addEventListener('input', () => { searchQuery = input.value.trim(); refresh(); });
}

async function getTopLevelIds(ids) {
  const idSet = new Set(ids);
  const topLevel = [];
  for (const id of ids) {
    let cur = id;
    let hasAncestor = false;
    try {
      while (true) {
        const [bm] = await chrome.bookmarks.get(cur);
        if (!bm || !bm.parentId) break;
        if (idSet.has(bm.parentId)) { hasAncestor = true; break; }
        cur = bm.parentId;
        if (cur === '0' || cur === '1' || cur === '2') break;
      }
    } catch {}
    if (!hasAncestor) topLevel.push(id);
  }
  return topLevel;
}

async function handleBulkDelete() {
  if (checkedIds.size === 0) return;
  const count = checkedIds.size;
  if (settings.confirmDelete) {
    if (!confirm(i18n('confirmBulkDelete', count))) return;
  }
  const ids = Array.from(checkedIds);
  const topLevelIds = await getTopLevelIds(ids);
  for (const id of topLevelIds) {
    try { await chrome.bookmarks.removeTree(id); }
    catch { try { await chrome.bookmarks.remove(id); } catch(e){ console.error(e); } }
  }
  checkedIds.clear();
  updateBulkDeleteButton();
  refresh();
}

function switchView(view) {
  currentView = view;
  document.querySelectorAll('.view-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });
  const bmView = document.getElementById('view-bookmarks');
  const tabsView = document.getElementById('view-tabs-list');
  const closedView = document.getElementById('view-closed');
  if (bmView) bmView.classList.toggle('hidden', view !== 'bookmarks');
  if (tabsView) tabsView.classList.toggle('hidden', view !== 'tabs');
  if (closedView) closedView.classList.toggle('hidden', view !== 'closed');

  const newFolderBtn = document.getElementById('btn-new-folder');
  const searchBtn = document.getElementById('btn-search');
  const bulkDelBtn = document.getElementById('btn-bulk-delete');
  const clearClosedBtn = document.getElementById('btn-clear-closed');
  if (newFolderBtn) newFolderBtn.style.display = (view === 'bookmarks') ? 'flex' : 'none';
  if (searchBtn) searchBtn.style.display = (view === 'bookmarks') ? 'flex' : 'none';
  if (bulkDelBtn) bulkDelBtn.style.display = (view === 'bookmarks') ? 'flex' : 'none';
  if (clearClosedBtn) clearClosedBtn.style.display = (view === 'closed') ? 'flex' : 'none';

  if (view === 'bookmarks') refresh();
  if (view === 'tabs') renderOpenTabs();
  if (view === 'closed') renderClosedTabs();
}

async function renderOpenTabs() {
  const container = document.getElementById('tabs-container');
  if (!container) return;
  container.innerHTML = `<div class="section-title">${i18n('currentlyOpenTabs')}</div>`;
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    tabs.sort((a,b) => a.index - b.index);
    for (const tab of tabs) {
      const row = document.createElement('div');
      row.className = 'tab-row' + (tab.active ? ' active' : '');
      row.title = tab.title + '\n' + tab.url;
      const iconSpan = document.createElement('span');
      iconSpan.className = 'icon';
      const fav = document.createElement('img');
      fav.className = 'favicon';
      try {
        fav.src = tab.favIconUrl || `https://www.google.com/s2/favicons?domain=${new URL(tab.url).hostname}&sz=32`;
      } catch { fav.src=''; }
      fav.onerror = ()=>{ fav.style.display='none'; };
      iconSpan.appendChild(fav);
      const title = document.createElement('span');
      title.className = 'tab-title';
      title.textContent = tab.title || tab.url;
      const closeBtn = document.createElement('button');
      closeBtn.className = 'tab-close';
      closeBtn.textContent = '✕';
      closeBtn.addEventListener('click', e=>{ e.stopPropagation(); chrome.tabs.remove(tab.id); });
      row.appendChild(iconSpan);
      row.appendChild(title);
      row.appendChild(closeBtn);
      row.addEventListener('click', async ()=>{
        await chrome.tabs.update(tab.id, {active:true});
        await chrome.windows.update(tab.windowId, {focused:true});
      });
      container.appendChild(row);
    }
  } catch(e){ console.error(e); }
}

let _closedRenderGen = 0;
async function renderClosedTabs() {
  const myGen = ++_closedRenderGen;
  const container = document.getElementById('closed-container');
  if (!container) return;
  container.innerHTML = `<div class="section-title">${i18n('todayClosedTabs', 0)}</div><div style="padding:16px;color:#5f6368;text-align:center;">${i18n('loading')}</div>`;
  try {
    const now = new Date();
    const startOfTodayMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

    let todayTabs = [];
    try {
      const result = await chrome.storage.local.get(['closedTabsHistory']);
      if (myGen !== _closedRenderGen) return;
      const closedTabsHistory = result.closedTabsHistory || [];
      todayTabs = closedTabsHistory
        .filter(t => t.closedAt >= startOfTodayMs)
        .map(t => ({ ...t }));
    } catch {}

    if (myGen !== _closedRenderGen) return;
    todayTabs.sort((a, b) => b.closedAt - a.closedAt);

    container.innerHTML = '';
    const titleEl = document.createElement('div');
    titleEl.className = 'section-title';
    titleEl.textContent = i18n('todayClosedTabs', todayTabs.length);
    container.appendChild(titleEl);

    if (todayTabs.length === 0){
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:16px;color:#5f6368;text-align:center;';
      empty.textContent = i18n('noClosedTabs');
      container.appendChild(empty);
      const hint = document.createElement('div');
      hint.style.cssText = 'padding:0 16px 16px;color:#9aa0a6;font-size:11px;text-align:center;';
      hint.textContent = i18n('closedTabsHint');
      container.appendChild(hint);
      return;
    }

    for (const item of todayTabs) {
      if (myGen !== _closedRenderGen) return;
      const row = document.createElement('div');
      row.className = 'closed-row';
      const closedTime = new Date(item.closedAt);
      const timeStr = closedTime.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'});
      row.title = `${item.title}\n${item.url}\n${i18n('closedTime', timeStr)}`;
      const iconSpan = document.createElement('span');
      iconSpan.className='icon';
      const fav = document.createElement('img');
      fav.className='favicon';
      try{
        if (item.favIconUrl) fav.src = item.favIconUrl;
        else fav.src=`https://www.google.com/s2/favicons?domain=${new URL(item.url).hostname}&sz=32`;
      }catch{ fav.src=''; }
      fav.onerror=()=>{ fav.style.display='none'; };
      iconSpan.appendChild(fav);
      const title = document.createElement('span');
      title.className='tab-title';
      title.textContent=item.title||item.url;
      const timeBadge = document.createElement('span');
      timeBadge.style.cssText = 'font-size:10px;color:#5f6368;flex-shrink:0;margin-right:4px;';
      timeBadge.textContent = timeStr.slice(0,5);

      const restoreBtn = document.createElement('button');
      restoreBtn.className='restore-btn';
      restoreBtn.textContent=i18n('restore');
      restoreBtn.addEventListener('click', e=>{
        e.stopPropagation();
        chrome.tabs.create({url: item.url});
      });
      row.appendChild(iconSpan);
      row.appendChild(title);
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
          }
        } catch {}
      });
      container.appendChild(row);
    }
  } catch(e){ console.error(e); }
}

async function clearTodayClosedTabs() {
  try {
    const now = new Date();
    const startOfTodayMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const result = await chrome.storage.local.get(['closedTabsHistory']);
    const closedTabsHistory = result.closedTabsHistory || [];
    const remaining = closedTabsHistory.filter(t => t.closedAt < startOfTodayMs);
    const lastClearedAt = Date.now();
    await chrome.storage.local.set({ closedTabsHistory: remaining, lastClearedAt });
  } catch (e) {
    console.error('clearTodayClosedTabs failed', e);
  }
}



document.getElementById('btn-new-folder')?.addEventListener('click', showNewFolderDialog);
document.getElementById('btn-clear-closed')?.addEventListener('click', async ()=>{
  if (settings.confirmDelete) {
    if (!confirm(i18n('confirmClearClosed'))) return;
  }
  await clearTodayClosedTabs();
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
  if(!e.target.closest('#tab-context-menu')){ const m=document.getElementById('tab-context-menu'); if(m && !m.classList.contains('hidden')){ m.classList.add('hidden'); tabContextTarget=null; } }
});
document.addEventListener('keydown', e=>{ if(e.key==='Escape'){ hideContextMenu(true); const m=document.getElementById('tab-context-menu'); if(m) m.classList.add('hidden'); } });

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
  if(area==='sync'){
    let need=false;
    for(const k in changes) if(DEFAULT_SETTINGS.hasOwnProperty(k)){ settings[k]=changes[k].newValue; need=true; }
    if(need) applySettingsToCSS();
  }
  if(area==='local'){
    if (changes.expandedFolders) settings.expandedFolders = changes.expandedFolders.newValue || {};
    if (changes.lastSelectedFolderId !== undefined) settings.lastSelectedFolderId = changes.lastSelectedFolderId.newValue || null;
    if (changes.closedTabsHistory && currentView==='closed') {
      renderClosedTabs();
    }
  }
});

(async function init(){
  sessionLastSelectedFolderId = null; // Reset on open, so initial new folder goes to top
  applyI18n();
  connectToBackground();
  await loadSettings();
  initSearch();
  switchView('bookmarks');
  await refresh();
  updateBulkDeleteButton();
})();
