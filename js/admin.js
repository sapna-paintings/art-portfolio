// ================================================================
// ATELIER — Admin Panel
//
// This is a static site (GitHub Pages, no backend). "Admin" here
// means: a client-side login gate (convenience only — see README)
// that unlocks a UI which commits changes directly to this repo's
// `articles/` folder via the GitHub REST API, using a Personal
// Access Token you provide once. Pushing to `main` re-triggers the
// existing deploy workflow, which regenerates manifest.json and
// republishes the site.
// ================================================================

// ---------- CONFIG ----------
const REPO_OWNER  = 'sapna-paintings';
const REPO_NAME   = 'art-portfolio';
const REPO_BRANCH = 'main';
const API_BASE    = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}`;

// Fixed credentials, stored as SHA-256("username:password") so the
// plaintext isn't sitting in the page source. This is a convenience
// gate only — anyone who reads this file can brute-force it offline.
// Real protection comes from the GitHub token, which only you hold.
//
// To change the username/password, run in any browser console:
//   crypto.subtle.digest('SHA-256', new TextEncoder().encode('newuser:newpass'))
//     .then(b => console.log([...new Uint8Array(b)].map(x => x.toString(16).padStart(2,'0')).join('')))
// and paste the result below.
//
// Default: admin / changeme123 — CHANGE THIS before relying on it.
const CREDENTIAL_SHA256 = '6b9e4c1a3e58b8ea7e82db84ab650daf6a4706efa8c33761cafaffa05405cfb9';

const SESSION_KEY = 'atelier_admin_authed';
const TOKEN_KEY   = 'atelier_admin_gh_token';

// ---------- DOM ----------
const $ = id => document.getElementById(id);

const loginScreen = $('loginScreen');
const tokenScreen = $('tokenScreen');
const dashboard   = $('dashboard');

// ---------- NAV TOGGLE ----------
const navToggle = document.querySelector('.nav-toggle');
const navLinks  = document.querySelector('.nav-links');
if (navToggle && navLinks) {
  navToggle.addEventListener('click', () => navLinks.classList.toggle('open'));
}

// ================================================================
// AUTH
// ================================================================

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function showScreen(which) {
  loginScreen.classList.toggle('admin-hidden', which !== 'login');
  tokenScreen.classList.toggle('admin-hidden', which !== 'token');
  dashboard.classList.toggle('admin-hidden', which !== 'dashboard');
}

function checkAuthAndRoute() {
  const authed = sessionStorage.getItem(SESSION_KEY) === '1';
  if (!authed) { showScreen('login'); return; }
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) { showScreen('token'); return; }
  showScreen('dashboard');
  initDashboard();
}

$('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const user = $('loginUser').value.trim();
  const pass = $('loginPass').value;
  const hash = await sha256Hex(`${user}:${pass}`);
  if (hash === CREDENTIAL_SHA256) {
    sessionStorage.setItem(SESSION_KEY, '1');
    $('loginError').textContent = '';
    checkAuthAndRoute();
  } else {
    $('loginError').textContent = 'Invalid username or password.';
  }
});

$('tokenForm').addEventListener('submit', async e => {
  e.preventDefault();
  const token = $('tokenInput').value.trim();
  $('tokenError').textContent = '';
  try {
    const res = await fetch(`${API_BASE}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`GitHub rejected this token (HTTP ${res.status}). Check the token has Contents: Read & write access to ${REPO_OWNER}/${REPO_NAME}.`);
    localStorage.setItem(TOKEN_KEY, token);
    checkAuthAndRoute();
  } catch (err) {
    $('tokenError').textContent = err.message;
  }
});

$('logoutBtn').addEventListener('click', () => {
  sessionStorage.removeItem(SESSION_KEY);
  location.reload();
});

$('forgetTokenBtn').addEventListener('click', () => {
  if (!confirm('Remove the stored GitHub token from this browser?')) return;
  localStorage.removeItem(TOKEN_KEY);
  location.reload();
});

// ================================================================
// GITHUB API HELPERS
// ================================================================

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

async function ghRequest(path, options = {}) {
  const token = localStorage.getItem(TOKEN_KEY);
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      ...(options.headers || {})
    }
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).message || ''; } catch {}
    throw new Error(`GitHub API error ${res.status}${detail ? ': ' + detail : ''}`);
  }
  return res.status === 204 ? null : res.json();
}

async function getFile(path) {
  return ghRequest(`/contents/${encodePath(path)}?ref=${REPO_BRANCH}`);
}

async function listDir(path) {
  const res = await ghRequest(`/contents/${encodePath(path)}?ref=${REPO_BRANCH}`);
  return Array.isArray(res) ? res : [];
}

async function putFile(path, contentB64, message, sha) {
  const body = { message, content: contentB64, branch: REPO_BRANCH };
  if (sha) body.sha = sha;
  return ghRequest(`/contents/${encodePath(path)}`, { method: 'PUT', body: JSON.stringify(body) });
}

async function deleteFile(path, message, sha) {
  return ghRequest(`/contents/${encodePath(path)}`, {
    method: 'DELETE',
    body: JSON.stringify({ message, sha, branch: REPO_BRANCH })
  });
}

function b64ToUtf8(b64) {
  const binary = atob(b64.replace(/\n/g, ''));
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  bytes.forEach(b => binary += String.fromCharCode(b));
  return btoa(binary);
}

function fileToB64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const binary = new Uint8Array(reader.result);
      let str = '';
      const chunk = 0x8000;
      for (let i = 0; i < binary.length; i += chunk) {
        str += String.fromCharCode.apply(null, binary.subarray(i, i + chunk));
      }
      resolve(btoa(str));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

async function readMeta(articleId) {
  const file = await getFile(`articles/${articleId}/meta.json`);
  if (!file) return null;
  return { meta: JSON.parse(b64ToUtf8(file.content)), sha: file.sha };
}

async function writeMeta(articleId, meta, sha, message) {
  const content = utf8ToB64(JSON.stringify(meta, null, 2));
  const result = await putFile(`articles/${articleId}/meta.json`, content, message, sha);
  return result.content.sha;
}

// ================================================================
// STATUS HELPERS
// ================================================================

function setStatus(el, msg, type) {
  el.textContent = msg || '';
  el.className = 'admin-status' + (type ? ' ' + type : '');
}

// ================================================================
// DASHBOARD STATE
// ================================================================

let articles = []; // [{ id, meta, sha }] in display order
let orderDirty = false;
let editingId = null;   // null = creating a new piece
let editingMeta = null;
let editingSha  = null;

const CATEGORY_LABEL = { painting: 'Painting', textile: 'Textile', sculpture: 'Sculpture', mixed: 'Mixed Media' };

async function initDashboard() {
  await loadArticleList();
  showListPanel();
}

async function loadArticleList() {
  const listEl = $('articleList');
  setStatus($('globalStatus'), 'Loading pieces from GitHub…', 'busy');
  listEl.innerHTML = '';
  try {
    const dirs = (await listDir('articles')).filter(e => e.type === 'dir');
    const loaded = [];
    for (const dir of dirs) {
      const result = await readMeta(dir.name);
      if (result) loaded.push({ id: dir.name, meta: result.meta, sha: result.sha });
    }
    // Same ordering rule as .github/scripts/generate-manifest.js
    const withOrder    = loaded.filter(a => typeof a.meta.order === 'number').sort((a, b) => a.meta.order - b.meta.order);
    const withoutOrder = loaded.filter(a => typeof a.meta.order !== 'number').sort((a, b) => a.id < b.id ? 1 : -1);
    articles = [...withOrder, ...withoutOrder];
    orderDirty = false;
    renderArticleList();
    setStatus($('globalStatus'), `${articles.length} piece(s) loaded.`, 'ok');
  } catch (err) {
    setStatus($('globalStatus'), err.message, 'error');
  }
}

function renderArticleList() {
  const listEl = $('articleList');
  listEl.innerHTML = '';
  if (articles.length === 0) {
    listEl.innerHTML = '<p class="admin-hint">No pieces yet — click "+ New piece" to add one.</p>';
    return;
  }
  articles.forEach((a, i) => {
    const cover = (a.meta.images || [])[0];
    const coverStyle = cover && cover.file
      ? `background-image:url('articles/${a.id}/${cover.file}')`
      : '';
    const row = document.createElement('div');
    row.className = 'admin-article-row';
    row.innerHTML = `
      <div class="admin-article-thumb" style="${coverStyle}"></div>
      <div class="admin-article-meta">
        <div class="title">${a.meta.title || '(untitled)'}</div>
        <div class="sub">${a.id} · ${CATEGORY_LABEL[a.meta.category] || a.meta.category || ''} · ${a.meta.price || ''}</div>
      </div>
      <div class="admin-article-actions">
        <button class="admin-btn admin-btn--ghost admin-btn--small" data-act="up" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="admin-btn admin-btn--ghost admin-btn--small" data-act="down" ${i === articles.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="admin-btn admin-btn--ghost admin-btn--small" data-act="edit">Edit</button>
      </div>`;
    row.querySelector('[data-act="up"]').addEventListener('click', () => moveArticle(i, -1));
    row.querySelector('[data-act="down"]').addEventListener('click', () => moveArticle(i, 1));
    row.querySelector('[data-act="edit"]').addEventListener('click', () => openEditor(a.id));
    listEl.appendChild(row);
  });
  $('saveOrderBtn').classList.toggle('admin-hidden', !orderDirty);
}

function moveArticle(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= articles.length) return;
  [articles[index], articles[target]] = [articles[target], articles[index]];
  orderDirty = true;
  renderArticleList();
}

$('saveOrderBtn').addEventListener('click', async () => {
  setStatus($('globalStatus'), 'Saving order…', 'busy');
  try {
    for (let i = 0; i < articles.length; i++) {
      const a = articles[i];
      if (a.meta.order === i) continue;
      a.meta.order = i;
      setStatus($('globalStatus'), `Saving order… (${a.id})`, 'busy');
      a.sha = await writeMeta(a.id, a.meta, a.sha, `Reorder: set ${a.id} to position ${i}`);
    }
    orderDirty = false;
    renderArticleList();
    setStatus($('globalStatus'), 'Order saved. The live site will update in a minute or two once the deploy finishes.', 'ok');
  } catch (err) {
    setStatus($('globalStatus'), err.message, 'error');
  }
});

$('newArticleBtn').addEventListener('click', () => openEditor(null));
$('backToList').addEventListener('click', showListPanel);

function showListPanel() {
  $('listPanel').classList.remove('admin-hidden');
  $('editorPanel').classList.add('admin-hidden');
}

function showEditorPanel() {
  $('listPanel').classList.add('admin-hidden');
  $('editorPanel').classList.remove('admin-hidden');
}

// ================================================================
// EDITOR
// ================================================================

function blankMeta() {
  return {
    title: '', medium: '', dimensions: '', year: '', price: '',
    category: 'painting', status: 'available', description: '',
    images: [], videos: []
  };
}

function openEditor(id) {
  editingId = id;
  $('editorError').textContent = '';
  setStatus($('editorStatus'), '', '');

  if (id === null) {
    editingMeta = blankMeta();
    editingSha  = null;
    $('editorHeading').textContent = 'New piece';
    $('fieldId').value = '';
    $('fieldId').disabled = false;
    $('deleteArticleBtn').classList.add('admin-hidden');
    setMediaSectionsEnabled(false);
  } else {
    const a = articles.find(a => a.id === id);
    editingMeta = JSON.parse(JSON.stringify(a.meta));
    editingSha  = a.sha;
    $('editorHeading').textContent = `Edit: ${editingMeta.title || id}`;
    $('fieldId').value = id;
    $('fieldId').disabled = true;
    $('deleteArticleBtn').classList.remove('admin-hidden');
    setMediaSectionsEnabled(true);
  }
  populateForm(editingMeta);
  renderMediaGrids();
  showEditorPanel();
}

function setMediaSectionsEnabled(enabled) {
  ['uploadImageBtn', 'uploadVideoBtn', 'imageFileInput', 'videoFileInput'].forEach(id => {
    $(id).disabled = !enabled;
  });
  if (!enabled) {
    setStatus($('editorStatus'), 'Save details first to create this piece, then you can add images/videos.', '');
  }
}

function populateForm(meta) {
  $('fieldTitle').value       = meta.title || '';
  $('fieldMedium').value      = meta.medium || '';
  $('fieldDimensions').value  = meta.dimensions || '';
  $('fieldYear').value        = meta.year || '';
  $('fieldPrice').value       = meta.price || '';
  $('fieldCategory').value    = meta.category || 'painting';
  $('fieldStatus').value      = meta.status || 'available';
  $('fieldDescription').value = meta.description || '';
}

function readForm() {
  return {
    title:       $('fieldTitle').value.trim(),
    medium:      $('fieldMedium').value.trim(),
    dimensions:  $('fieldDimensions').value.trim(),
    year:        $('fieldYear').value.trim(),
    price:       $('fieldPrice').value.trim(),
    category:    $('fieldCategory').value,
    status:      $('fieldStatus').value.trim() || 'available',
    description: $('fieldDescription').value.trim()
  };
}

$('editorForm').addEventListener('submit', async e => {
  e.preventDefault();
  $('editorError').textContent = '';
  const slug = $('fieldId').value.trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(slug)) {
    $('editorError').textContent = 'Folder id may only contain letters, numbers, dot, dash and underscore.';
    return;
  }

  const formValues = readForm();
  const submitBtn = e.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  setStatus($('editorStatus'), 'Saving…', 'busy');

  try {
    if (editingId === null) {
      const existing = await getFile(`articles/${slug}/meta.json`);
      if (existing) throw new Error(`"${slug}" already exists — pick a different folder id.`);
      editingMeta = { ...blankMeta(), ...formValues, images: [], videos: [] };
      editingSha = await writeMeta(slug, editingMeta, null, `Add piece: ${slug}`);
      editingId = slug;
      $('fieldId').disabled = true;
      $('deleteArticleBtn').classList.remove('admin-hidden');
      $('editorHeading').textContent = `Edit: ${editingMeta.title || slug}`;
      setMediaSectionsEnabled(true);
      setStatus($('editorStatus'), 'Piece created. You can now add images/videos below.', 'ok');
    } else {
      editingMeta = { ...editingMeta, ...formValues };
      editingSha = await writeMeta(editingId, editingMeta, editingSha, `Update details: ${editingId}`);
      setStatus($('editorStatus'), 'Saved.', 'ok');
    }
    await loadArticleList();
  } catch (err) {
    setStatus($('editorStatus'), '', '');
    $('editorError').textContent = err.message;
  } finally {
    submitBtn.disabled = false;
  }
});

$('deleteArticleBtn').addEventListener('click', async () => {
  if (editingId === null) return;
  if (!confirm(`Permanently delete "${editingMeta.title || editingId}" and all its images/videos? This cannot be undone.`)) return;
  setStatus($('editorStatus'), 'Deleting…', 'busy');
  try {
    const files = await listDir(`articles/${editingId}`);
    for (const f of files) {
      setStatus($('editorStatus'), `Deleting ${f.name}…`, 'busy');
      await deleteFile(f.path, `Delete piece: ${editingId} (${f.name})`, f.sha);
    }
    await loadArticleList();
    showListPanel();
    setStatus($('globalStatus'), `Deleted "${editingId}".`, 'ok');
  } catch (err) {
    setStatus($('editorStatus'), '', '');
    $('editorError').textContent = err.message;
  }
});

// ---------- Media grids ----------

function renderMediaGrids() {
  renderMediaGrid('imageGrid', editingMeta.images || [], 'images');
  renderMediaGrid('videoGrid', editingMeta.videos || [], 'videos');
}

function renderMediaGrid(gridId, items, kind) {
  const grid = $(gridId);
  grid.innerHTML = '';
  items.forEach((item, i) => {
    const src = `articles/${editingId}/${item.file}`;
    const card = document.createElement('div');
    card.className = 'admin-media-card';
    const mediaTag = kind === 'videos'
      ? `<video src="${src}" muted></video>`
      : `<img src="${src}" alt="${item.label || ''}" />`;
    card.innerHTML = `
      ${mediaTag}
      <div class="admin-media-card-body">
        <input type="text" value="${(item.label || '').replace(/"/g, '&quot;')}" placeholder="Label" />
        <div class="admin-media-card-actions">
          <button data-act="up" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button data-act="down" ${i === items.length - 1 ? 'disabled' : ''}>↓</button>
          <button data-act="del">Delete</button>
        </div>
      </div>`;
    const labelInput = card.querySelector('input');
    labelInput.addEventListener('change', () => saveMediaEdit(kind, i, { label: labelInput.value.trim() }));
    card.querySelector('[data-act="up"]').addEventListener('click', () => moveMedia(kind, i, -1));
    card.querySelector('[data-act="down"]').addEventListener('click', () => moveMedia(kind, i, 1));
    card.querySelector('[data-act="del"]').addEventListener('click', () => deleteMedia(kind, i));
    grid.appendChild(card);
  });
}

async function saveMediaMeta(message) {
  editingSha = await writeMeta(editingId, editingMeta, editingSha, message);
}

async function saveMediaEdit(kind, index, patch) {
  Object.assign(editingMeta[kind][index], patch);
  setStatus($('editorStatus'), 'Saving…', 'busy');
  try {
    await saveMediaMeta(`Edit ${kind.slice(0, -1)} label: ${editingId}`);
    setStatus($('editorStatus'), 'Saved.', 'ok');
  } catch (err) {
    setStatus($('editorStatus'), '', '');
    $('editorError').textContent = err.message;
  }
}

async function moveMedia(kind, index, delta) {
  const arr = editingMeta[kind];
  const target = index + delta;
  if (target < 0 || target >= arr.length) return;
  [arr[index], arr[target]] = [arr[target], arr[index]];
  renderMediaGrids();
  setStatus($('editorStatus'), 'Saving order…', 'busy');
  try {
    await saveMediaMeta(`Reorder ${kind}: ${editingId}`);
    setStatus($('editorStatus'), 'Saved.', 'ok');
  } catch (err) {
    setStatus($('editorStatus'), '', '');
    $('editorError').textContent = err.message;
  }
}

async function deleteMedia(kind, index) {
  const item = editingMeta[kind][index];
  if (!confirm(`Delete "${item.label || item.file}"? This cannot be undone.`)) return;
  setStatus($('editorStatus'), 'Deleting…', 'busy');
  try {
    const path = `articles/${editingId}/${item.file}`;
    const fileInfo = await getFile(path);
    if (fileInfo) await deleteFile(path, `Delete ${kind.slice(0, -1)}: ${editingId}/${item.file}`, fileInfo.sha);
    editingMeta[kind].splice(index, 1);
    await saveMediaMeta(`Remove ${kind.slice(0, -1)} from meta: ${editingId}`);
    renderMediaGrids();
    setStatus($('editorStatus'), 'Deleted.', 'ok');
  } catch (err) {
    setStatus($('editorStatus'), '', '');
    $('editorError').textContent = err.message;
  }
}

const MAX_UPLOAD_BYTES = 40 * 1024 * 1024; // 40MB — practical ceiling for base64 JSON commits via the Contents API

async function uploadMedia(kind, fileInputId, labelInputId, buttonId) {
  const fileInput  = $(fileInputId);
  const labelInput = $(labelInputId);
  const button     = $(buttonId);
  const file = fileInput.files[0];
  if (!file) { $('editorError').textContent = 'Choose a file first.'; return; }
  if (file.size > MAX_UPLOAD_BYTES) { $('editorError').textContent = 'File is too large (max 40MB).'; return; }

  $('editorError').textContent = '';
  button.disabled = true;
  setStatus($('editorStatus'), 'Uploading…', 'busy');
  try {
    const ext = (file.name.split('.').pop() || 'bin').toLowerCase();
    const prefix = kind === 'videos' ? 'vid' : 'img';
    const filename = `${prefix}-${Date.now()}.${ext}`;
    const b64 = await fileToB64(file);
    await putFile(`articles/${editingId}/${filename}`, b64, `Add ${kind.slice(0, -1)}: ${editingId}/${filename}`);
    editingMeta[kind] = editingMeta[kind] || [];
    editingMeta[kind].push({ file: filename, label: labelInput.value.trim() });
    await saveMediaMeta(`Attach ${kind.slice(0, -1)} to meta: ${editingId}`);
    fileInput.value = '';
    labelInput.value = '';
    renderMediaGrids();
    setStatus($('editorStatus'), 'Uploaded.', 'ok');
  } catch (err) {
    setStatus($('editorStatus'), '', '');
    $('editorError').textContent = err.message;
  } finally {
    button.disabled = false;
  }
}

$('uploadImageBtn').addEventListener('click', () => uploadMedia('images', 'imageFileInput', 'imageLabelInput', 'uploadImageBtn'));
$('uploadVideoBtn').addEventListener('click', () => uploadMedia('videos', 'videoFileInput', 'videoLabelInput', 'uploadVideoBtn'));

// ================================================================
checkAuthAndRoute();
