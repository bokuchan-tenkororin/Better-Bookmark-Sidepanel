const DEFAULTS = {
  tabOpenPosition: 'end',
  tabActiveBehavior: 'keep',
  confirmDelete: true,
  panelWidth: 360,
  fontSize: 14,
  lineHeight: 1
};

const i18n = (k) => chrome.i18n.getMessage(k) || k;

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const msg = chrome.i18n.getMessage(key);
    if (msg) el.textContent = msg;
  });
}

async function load() {
  const data = await chrome.storage.sync.get(DEFAULTS);
  document.querySelectorAll('input[name="tabOpenPosition"]').forEach(r => {
    r.checked = r.value === data.tabOpenPosition;
  });
  document.querySelectorAll('input[name="tabActiveBehavior"]').forEach(r => {
    r.checked = r.value === data.tabActiveBehavior;
  });
  const show = data.confirmDelete !== false;
  document.querySelectorAll('input[name="confirmDelete"]').forEach(r => {
    r.checked = (r.value === 'show' && show) || (r.value === 'hide' && !show);
  });
  const fontSize = document.getElementById('fontSize');
  const fontSizeNum = document.getElementById('fontSizeNum');
  if (fontSize) fontSize.value = data.fontSize;
  if (fontSizeNum) fontSizeNum.value = data.fontSize;
  const lineHeight = document.getElementById('lineHeight');
  const lineHeightNum = document.getElementById('lineHeightNum');
  if (lineHeight) lineHeight.value = data.lineHeight;
  if (lineHeightNum) lineHeightNum.value = data.lineHeight;
}

function showToast() {
  const toast = document.getElementById('toast');
  toast.textContent = i18n('optionsSaved');
  toast.classList.remove('hidden');
  setTimeout(()=> toast.classList.add('hidden'), 1500);
}

function bind() {
  document.querySelectorAll('input[name="tabOpenPosition"]').forEach(r => {
    r.addEventListener('change', async () => {
      await chrome.storage.sync.set({ tabOpenPosition: r.value });
      showToast();
    });
  });
  document.querySelectorAll('input[name="tabActiveBehavior"]').forEach(r => {
    r.addEventListener('change', async () => {
      await chrome.storage.sync.set({ tabActiveBehavior: r.value });
      showToast();
    });
  });
  document.querySelectorAll('input[name="confirmDelete"]').forEach(r => {
    r.addEventListener('change', async () => {
      const show = r.value === 'show';
      await chrome.storage.sync.set({ confirmDelete: show });
      showToast();
    });
  });

  const fontSize = document.getElementById('fontSize');
  const fontSizeNum = document.getElementById('fontSizeNum');
  const syncFont = async (v) => { await chrome.storage.sync.set({ fontSize: parseInt(v) }); showToast(); };
  if (fontSize && fontSizeNum) {
    fontSize.addEventListener('input', () => { fontSizeNum.value = fontSize.value; });
    fontSize.addEventListener('change', () => syncFont(fontSize.value));
    fontSizeNum.addEventListener('change', () => { fontSize.value = fontSizeNum.value; syncFont(fontSizeNum.value); });
  }

  const lineHeight = document.getElementById('lineHeight');
  const lineHeightNum = document.getElementById('lineHeightNum');
  const syncLine = async (v) => { await chrome.storage.sync.set({ lineHeight: parseFloat(v) }); showToast(); };
  if (lineHeight && lineHeightNum) {
    lineHeight.addEventListener('input', () => { lineHeightNum.value = lineHeight.value; });
    lineHeight.addEventListener('change', () => syncLine(lineHeight.value));
    lineHeightNum.addEventListener('change', () => { lineHeight.value = lineHeightNum.value; syncLine(lineHeightNum.value); });
  }
}

applyI18n();
load().then(bind);
