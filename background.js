// background.js v3.5 - include internal pages + unlimited + race-safe (ASCII only)
let isSidePanelOpen = false;
let tabCache = {};

async function initTabCache() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (t.id != null) {
        tabCache[t.id] = {
          url: t.url || t.pendingUrl || '',
          title: t.title || '',
          favIconUrl: t.favIconUrl || ''
        };
      }
    }
  } catch (e) {
    console.warn('[bg] initTabCache failed', e);
  }
}
initTabCache();

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id != null) {
    tabCache[tab.id] = {
      url: tab.pendingUrl || tab.url || '',
      title: tab.title || '',
      favIconUrl: tab.favIconUrl || ''
    };
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const existing = tabCache[tabId] || {};
  tabCache[tabId] = {
    url: tab.url || tab.pendingUrl || existing.url || '',
    title: tab.title || changeInfo.title || existing.title || '',
    favIconUrl: tab.favIconUrl || existing.favIconUrl || ''
  };
});

function isRecordableUrl(url) {
  if (!url) return false;
  if (url === 'about:blank') return false;
  if (url.startsWith('chrome://newtab/')) return false;
  return /^(https?|chrome|chrome-extension|edge|file|about|moz-extension):/.test(url);
}

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  try {
    const info = tabCache[tabId];
    if (info && isRecordableUrl(info.url)) {
      const closed = {
        url: info.url,
        title: info.title || info.url,
        favIconUrl: info.favIconUrl || '',
        closedAt: Date.now()
      };
      const { closedTabsHistory = [], lastClearedAt = 0 } = await chrome.storage.local.get(['closedTabsHistory', 'lastClearedAt']);
      const startOfToday = new Date().setHours(0, 0, 0, 0);
      let filtered = closedTabsHistory.filter(t => {
        if (t.closedAt < startOfToday) return true;
        if (lastClearedAt && t.closedAt < lastClearedAt) return false;
        return true;
      });
      filtered.unshift(closed);
      if (filtered.length > 500) filtered.length = 500;
      await chrome.storage.local.set({ closedTabsHistory: filtered });
    }
  } catch (e) {
    console.warn('[bg] onRemoved save failed', e);
  } finally {
    delete tabCache[tabId];
  }
});

try {
  chrome.storage.session.get(['isSidePanelOpen']).then(r => { isSidePanelOpen = !!r.isSidePanelOpen; });
} catch (e) {}

function saveOpenState(v) {
  isSidePanelOpen = v;
  try { chrome.storage.session.set({ isSidePanelOpen: v }); } catch (e) {}
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
});

chrome.runtime.onConnect.addListener(port => {
  if (port.name === 'sidepanel') {
    saveOpenState(true);
    port.onDisconnect.addListener(() => saveOpenState(false));
  }
});

function closePanel() {
  chrome.runtime.sendMessage({ type: 'CLOSE_SIDEPANEL' }).catch(() => {});
}

function openPanelSync(windowId) {
  if (windowId) {
    chrome.sidePanel.open({ windowId }).catch(e => console.error('[bg] open failed', e));
  } else {
    chrome.windows.getCurrent().then(w => {
      chrome.sidePanel.open({ windowId: w.id }).catch(e => console.error('[bg] open failed', e));
    }).catch(() => {});
  }
}

function togglePanel(windowId) {
  if (isSidePanelOpen) {
    closePanel();
  } else {
    openPanelSync(windowId);
  }
}

chrome.action.onClicked.addListener(tab => togglePanel(tab?.windowId));
chrome.commands.onCommand.addListener((cmd, tab) => togglePanel(tab?.windowId));
