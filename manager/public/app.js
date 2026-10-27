const $ = (selector) => document.querySelector(selector);
let packages = [];
let lists = [];
let settings = {};
let storage = { totalBytes: 0, packageBytes: {}, topPackages: [] };
let poller;
let activeJobId;
let lastJobRefs = [];
let catalogFocusRefs = new Set();
let catalogPage = 1;
let listPage = 1;
let listSelection = new Set();
let catalogSelection = new Set();

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { 'content-type': 'application/json' }, ...options });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}
function toast(message) { const el = $('#toast'); el.textContent = message; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 3500); }
function escapeHtml(value = '') { return String(value).replace(/[&<>"]/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' })[char]); }
function formatBytes(bytes = 0) { if (!bytes) return '۰ B'; const units = ['B','KB','MB','GB','TB']; const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1); return `${(bytes / 1024 ** index).toLocaleString('fa-IR', { maximumFractionDigits: 1 })} ${units[index]}`; }
function statusLabel(status) { return ({ ready:'آماده', error:'خطا', checking:'در حال بررسی', syncing:'در حال دریافت', cancelling:'در حال توقف', cancelled:'متوقف شد', update_available:'نسخهٔ جدید', not_cached:'دریافت نشده' })[status] || 'بررسی نشده'; }
const enc = encodeURIComponent;

function askConfirmation(message) {
  const modal = $('#confirm-modal');
  $('#confirm-message').textContent = message;
  modal.returnValue = 'cancel';
  modal.showModal();
  return new Promise((resolve) => modal.addEventListener('close', () => resolve(modal.returnValue === 'confirm'), { once: true }));
}

function renderStats() {
  const npmCount = packages.filter((item) => item.ecosystem === 'npm').length;
  const ready = packages.filter((item) => item.runtime?.status === 'ready').length;
  $('#stats').innerHTML = `<div class="stat"><b>${packages.length.toLocaleString('fa-IR')}</b><span>کل کاتالوگ</span></div><div class="stat"><b>${npmCount.toLocaleString('fa-IR')}</b><span>پکیج npm</span></div><div class="stat"><b>${(packages.length - npmCount).toLocaleString('fa-IR')}</b><span>artifact Maven/Kotlin</span></div><div class="stat"><b>${ready.toLocaleString('fa-IR')}</b><span>آمادهٔ آفلاین</span></div>`;
}

function filteredCatalog() {
  const term = $('#search').value.toLowerCase();
  const category = $('#category-filter').value;
  const ecosystem = $('#ecosystem-filter').value;
  const enabled = $('#enabled-filter').value;
  return packages.filter((item) =>
    (!category || item.category === category) &&
    (!ecosystem || item.ecosystem === ecosystem) &&
    (!enabled || (enabled === 'enabled' ? item.enabled !== false : item.enabled === false)) &&
    [item.name, item.category, ...(item.sources || [])].join(' ').toLowerCase().includes(term)
  );
}

function renderPackages() {
  const filtered = filteredCatalog();
  const pageSize = Number($('#page-size').value || 25);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  catalogPage = Math.min(catalogPage, pageCount);
  const visible = filtered.slice((catalogPage - 1) * pageSize, catalogPage * pageSize);
  $('#package-rows').innerHTML = visible.map((item) => {
    const runtime = item.runtime || {};
    const versions = runtime.managedVersions || item.requestedVersions || [];
    const sources = (item.sources || []).slice(0, 2).join('، ');
    return `<tr class="${catalogFocusRefs.has(item.ref) ? 'job-focus' : ''}"><td><input type="checkbox" class="row-select" data-select="${enc(item.ref)}" ${catalogSelection.has(item.ref) ? 'checked' : ''} aria-label="انتخاب ${escapeHtml(item.name)}"></td><td><button class="status-dot ${item.enabled !== false ? 'on' : 'off'}" data-toggle="${enc(item.ref)}" title="${item.enabled !== false ? 'فعال؛ برای غیرفعال‌کردن کلیک کنید' : 'غیرفعال؛ برای فعال‌کردن کلیک کنید'}" aria-label="تغییر وضعیت ${escapeHtml(item.name)}"><i></i></button></td><td><span class="pkg">${escapeHtml(item.name)}</span>${item.ecosystem === 'npm' ? `<button class="refresh-inline" data-check="${enc(item.ref)}" title="فقط بررسی این پکیج" aria-label="بررسی ${escapeHtml(item.name)}">↻</button>` : ''}</td><td><span class="badge ${item.ecosystem}">${escapeHtml(item.ecosystem)}</span></td><td><span class="badge">${escapeHtml(item.category)}</span><small>${escapeHtml(sources)}</small></td><td class="versions">${escapeHtml(runtime.latestAvailable || '—')}</td><td class="versions compact">${versions.slice(0, 6).map(escapeHtml).join(' · ') || '—'}</td><td class="versions">${formatBytes(storage.packageBytes[item.ref] || 0)}</td><td><span class="badge ${escapeHtml(runtime.status)}" title="${escapeHtml(runtime.error)}">${statusLabel(runtime.status)}</span></td><td>${item.ecosystem === 'npm' ? `<button class="icon download-action" data-sync="${enc(item.ref)}" title="بررسی و دریافت این پکیج" aria-label="بررسی و دریافت ${escapeHtml(item.name)}">⇩</button>` : ''}<button class="icon safe-delete" data-delete="${enc(item.ref)}" title="حذف ایمن؛ cache پاک نمی‌شود" aria-label="حذف ایمن ${escapeHtml(item.name)}">🗑</button></td></tr>`;
  }).join('') || '<tr><td colspan="9">موردی پیدا نشد.</td></tr>';
  $('#page-info').textContent = `صفحه ${catalogPage.toLocaleString('fa-IR')} از ${pageCount.toLocaleString('fa-IR')} — ${filtered.length.toLocaleString('fa-IR')} مورد`;
  $('#page-prev').disabled = catalogPage <= 1;
  $('#page-next').disabled = catalogPage >= pageCount;
  $('#catalog-selection-count').textContent = `${catalogSelection.size.toLocaleString('fa-IR')} انتخاب`;
  $('#select-page').checked = visible.length > 0 && visible.every((item) => catalogSelection.has(item.ref));
  $('#bulk-enable').disabled = !catalogSelection.size;
  $('#bulk-disable').disabled = !catalogSelection.size;
  if ($('#bulk-check')) $('#bulk-check').disabled = !catalogSelection.size;
  if ($('#bulk-sync')) $('#bulk-sync').disabled = !catalogSelection.size || !settings.downloadsEnabled;
}

function renderFilterOptions() {
  const categories = [...new Set(packages.map((item) => item.category).filter(Boolean))].sort();
  const selected = $('#category-filter').value;
  $('#category-filter').innerHTML = '<option value="">همهٔ دسته‌ها</option>' + categories.map((category) => `<option ${selected === category ? 'selected' : ''}>${escapeHtml(category)}</option>`).join('');
  const listSelected = $('#list-category').value;
  $('#list-category').innerHTML = '<option value="">همهٔ دسته‌ها</option>' + categories.map((category) => `<option ${listSelected === category ? 'selected' : ''}>${escapeHtml(category)}</option>`).join('');
}

function renderSettings() {
  $('#downloads-enabled').checked = Boolean(settings.downloadsEnabled);
  $('#scheduler-enabled').checked = Boolean(settings.schedulerEnabled);
  $('#default-keep').value = settings.defaultKeepVersions || 3;
  $('#default-days').value = settings.defaultSchedule?.everyDays || 1;
  $('#default-time').value = settings.defaultSchedule?.time || '03:00';
  $('#default-mode').value = settings.defaultSchedule?.mode || 'check';
  $('#list-days').value = settings.defaultSchedule?.everyDays || 1;
  $('#list-time').value = settings.defaultSchedule?.time || '03:00';
  $('#list-mode').value = settings.defaultSchedule?.mode || 'check';
  $('#registry-link').href = settings.registryUrl;
  $('#sync-all').disabled = !settings.downloadsEnabled;
  $('#safety-banner').className = `safety-banner ${settings.downloadsEnabled ? 'armed' : 'safe'}`;
  $('#safety-banner').textContent = settings.downloadsEnabled ? 'دانلود Manager فعال است؛ عملیات Sync می‌تواند tarball دریافت کند.' : 'دانلود خودکار Manager قفل است؛ Check فقط metadata را می‌بیند. دریافت پروژه‌ها جداگانه تابع حالت آنلاین/آفلاین Verdaccio است.';
}

function renderStorage() {
  $('#storage-summary').textContent = `حجم کل ذخیره‌شده: ${formatBytes(storage.totalBytes)} — اندازه‌گیری ${new Date(storage.measuredAt).toLocaleString('fa-IR')}`;
  const max = storage.topPackages[0]?.bytes || 1;
  $('#size-chart').innerHTML = storage.topPackages.slice(0, 10).map((item) => `<div class="bar-row"><span class="pkg">${escapeHtml(item.name)}</span><i><b style="width:${Math.max(2, item.bytes / max * 100)}%"></b></i><em>${formatBytes(item.bytes)}</em></div>`).join('') || '<p>هنوز tarball قابل‌اندازه‌گیری وجود ندارد.</p>';
  renderPackages();
}

function renderLists() {
  $('#list-cards').innerHTML = lists.map((list) => `<article class="list-card"><div><h3>${escapeHtml(list.name)}</h3><p>${(list.packageRefs || []).length.toLocaleString('fa-IR')} مورد</p><div class="inline-schedule"><label>هر <input type="number" min="1" max="365" value="${list.schedule.everyDays}" data-list-days="${list.id}"> روز</label><input type="time" value="${escapeHtml(list.schedule.time)}" data-list-time="${list.id}"><select data-list-mode="${list.id}"><option value="check" ${list.schedule.mode === 'check' ? 'selected' : ''}>فقط بررسی</option><option value="sync" ${list.schedule.mode === 'sync' ? 'selected' : ''}>بررسی و دریافت</option></select><button class="button secondary small" data-list-save="${list.id}">ذخیره برنامه</button></div></div><label class="mini-switch">زمان‌بندی <input class="switch" type="checkbox" data-list-toggle="${list.id}" ${list.schedule.enabled ? 'checked' : ''}></label><button class="button secondary small" data-list-check="${list.id}">بررسی الآن</button><button class="button primary small" data-list-sync="${list.id}" ${settings.downloadsEnabled ? '' : 'disabled'}>بررسی و دریافت الآن</button><button class="icon safe-delete" data-list-delete="${list.id}" title="حذف ایمن لیست؛ پکیج‌ها و cache باقی می‌مانند" aria-label="حذف ایمن لیست ${escapeHtml(list.name)}">🗑</button></article>`).join('');
  renderListPackagePage();
}

function filteredListCandidates() {
  const term = $('#list-package-search').value.toLowerCase();
  const category = $('#list-category').value;
  return packages.filter((item) => (!category || item.category === category) && `${item.name} ${item.category} ${item.ecosystem}`.toLowerCase().includes(term));
}
function renderListPackagePage() {
  const filtered = filteredListCandidates();
  const pageSize = 30;
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  listPage = Math.min(listPage, pageCount);
  const visible = filtered.slice((listPage - 1) * pageSize, listPage * pageSize);
  $('#list-packages').innerHTML = visible.map((item) => `<option value="${escapeHtml(item.ref)}" ${listSelection.has(item.ref) ? 'selected' : ''}>[${item.ecosystem}] ${escapeHtml(item.name)}</option>`).join('');
  $('#list-page-info').textContent = `صفحه ${listPage.toLocaleString('fa-IR')} از ${pageCount.toLocaleString('fa-IR')}`;
  $('#selection-count').textContent = `${listSelection.size.toLocaleString('fa-IR')} انتخاب`;
  $('#list-prev').disabled = listPage <= 1;
  $('#list-next').disabled = listPage >= pageCount;
}
function captureVisibleSelections() {
  for (const option of $('#list-packages').options) {
    if (option.selected) listSelection.add(option.value); else listSelection.delete(option.value);
  }
  $('#selection-count').textContent = `${listSelection.size.toLocaleString('fa-IR')} انتخاب`;
}

async function load() {
  const [data, config] = await Promise.all([api('/api/packages'), api('/api/settings')]);
  packages = data.packages; lists = data.lists; settings = config;
  renderStats(); renderFilterOptions(); renderSettings(); renderLists(); renderPackages();
  const last = data.lastSyncAt || data.lastCheckAt;
  $('#last-run').textContent = last ? `آخرین عملیات: ${new Date(last).toLocaleString('fa-IR')}` : 'هنوز بررسی نشده';
}
async function loadStorage() { $('#storage-summary').textContent = 'در حال اندازه‌گیری…'; storage = await api('/api/storage'); renderStorage(); }
async function startJob(path, refs) { lastJobRefs = refs || []; try { const job = await api(path, { method:'POST', body:JSON.stringify(refs ? { refs } : {}) }); toast('عملیات شروع شد'); watch(job.id); } catch (error) { toast(error.message); } }

async function watch(id) {
  activeJobId = id;
  document.querySelector('[data-tab="operations"]')?.click();
  clearInterval(poller); $('#job-panel').hidden = false; $('#sync-all').disabled = true; $('#check-all').disabled = true; $('#cancel-job').hidden = false; $('#job-summary').hidden = true; $('#view-job-packages').hidden = true;
  const tick = async () => {
    let job;
    try { job = await api(`/api/jobs/${id}`); } catch (error) { clearInterval(poller); activeJobId = null; $('#cancel-job').hidden = true; toast(`وضعیت عملیات خوانده نشد: ${error.message}`); return; }
    $('#job-title').textContent = job.currentPackage ? `${job.mode === 'sync' ? 'دریافت' : 'بررسی'} — ${job.current} از ${job.total}: ${job.currentPackage}` : statusLabel(job.status);
    $('#progress-bar').style.width = `${job.total ? job.current / job.total * 100 : 2}%`;
    $('#job-log').textContent = job.logs.slice(-80).map((line) => `${line.at}  ${line.message}`).join('\n'); $('#job-log').scrollTop = $('#job-log').scrollHeight;
    const active = ['queued', 'running', 'cancelling'].includes(job.status);
    $('#cancel-job').disabled = job.status === 'cancelling';
    if (!active) { clearInterval(poller); activeJobId = null; $('#cancel-job').hidden = true; $('#check-all').disabled = false; await Promise.all([load(), loadStorage()]); const ok = job.results.filter((result) => result.ok).length; const failed = job.results.filter((result) => !result.ok).length; $('#job-summary').hidden = false; $('#job-summary').textContent = job.status === 'cancelled' ? `عملیات متوقف شد — ${job.current || 0} از ${job.total} مورد پردازش شد.` : `نتیجه: ${ok.toLocaleString('fa-IR')} موفق، ${failed.toLocaleString('fa-IR')} خطادار، از ${job.total.toLocaleString('fa-IR')} پکیج.`; $('#view-job-packages').hidden = false; toast(job.status === 'cancelled' ? 'عملیات متوقف شد' : job.status === 'completed' ? 'عملیات کامل شد' : 'عملیات با خطا پایان یافت'); }
  };
  await tick(); poller = setInterval(tick, 1500);
}

$('#save-settings').addEventListener('click', async () => {
  if (!await askConfirmation('تنظیمات مرکزی ذخیره شود؟')) return;
  try { const registryUrl = settings.registryUrl; settings = await api('/api/settings', { method:'PATCH', body:JSON.stringify({ downloadsEnabled:$('#downloads-enabled').checked, schedulerEnabled:$('#scheduler-enabled').checked, defaultKeepVersions:Number($('#default-keep').value), defaultSchedule:{ everyDays:Number($('#default-days').value), time:$('#default-time').value, mode:$('#default-mode').value } }) }); settings.registryUrl = registryUrl; renderSettings(); renderLists(); toast('تنظیمات ذخیره شد'); } catch (error) { toast(error.message); }
});
$('#check-all').addEventListener('click', async () => { if (await askConfirmation('بررسی metadata همهٔ پکیج‌های فعال شروع شود؟')) startJob('/api/check'); });
$('#sync-all').addEventListener('click', async () => { if (await askConfirmation('دریافت همهٔ پکیج‌های فعال شروع شود؟ این عملیات می‌تواند حجیم باشد.')) startJob('/api/sync'); });
$('#refresh-storage').addEventListener('click', async () => { if (await askConfirmation('حجم مخزن دوباره اندازه‌گیری شود؟')) loadStorage().catch((error) => toast(error.message)); });
$('#cancel-job').addEventListener('click', async () => { if (!activeJobId || !await askConfirmation('عملیات جاری واقعاً متوقف شود؟')) return; $('#cancel-job').disabled = true; $('#job-title').textContent = 'در حال ارسال درخواست توقف…'; try { await api(`/api/jobs/${activeJobId}/cancel`, { method:'POST', body:'{}' }); toast('درخواست توقف ارسال شد'); } catch (error) { $('#cancel-job').disabled = false; toast(error.message); } });
document.querySelector('.bulk-actions')?.insertAdjacentHTML('beforeend', '<button class="button primary small" id="bulk-check">بررسی انتخاب‌ها</button><button class="button primary small" id="bulk-sync">بررسی و دریافت انتخاب‌ها</button>');
$('#bulk-check')?.addEventListener('click', async () => { if (!catalogSelection.size) return toast('ابتدا حداقل یک پکیج را انتخاب کنید'); if (await askConfirmation(`بررسی ${catalogSelection.size.toLocaleString('fa-IR')} پکیج شروع شود؟`)) startJob('/api/check', [...catalogSelection]); });
$('#bulk-sync')?.addEventListener('click', async () => { if (!catalogSelection.size) return toast('ابتدا حداقل یک پکیج را انتخاب کنید'); if (!settings.downloadsEnabled) return toast('دانلود در تنظیمات مرکزی خاموش است'); if (await askConfirmation(`بررسی و دریافت ${catalogSelection.size.toLocaleString('fa-IR')} پکیج شروع شود؟`)) startJob('/api/sync', [...catalogSelection]); });
for (const button of document.querySelectorAll('.copy-command')) button.addEventListener('click', async () => { try { await navigator.clipboard.writeText(button.dataset.command); button.textContent = 'کپی شد'; setTimeout(() => { button.textContent = 'کپی دستور'; }, 1600); } catch { toast('کپی خودکار در این مرورگر در دسترس نیست؛ دستور را دستی کپی کنید.'); } });

for (const selector of ['#search', '#category-filter', '#ecosystem-filter', '#enabled-filter', '#page-size']) $(selector).addEventListener(selector === '#search' ? 'input' : 'change', () => { catalogPage = 1; renderPackages(); });
$('#page-prev').addEventListener('click', () => { catalogPage--; renderPackages(); });
$('#page-next').addEventListener('click', () => { catalogPage++; renderPackages(); });
$('#select-page').addEventListener('change', () => { const visible = filteredCatalog().slice((catalogPage - 1) * Number($('#page-size').value || 25), catalogPage * Number($('#page-size').value || 25)); visible.forEach((item) => $('#select-page').checked ? catalogSelection.add(item.ref) : catalogSelection.delete(item.ref)); renderPackages(); });
$('#package-rows').addEventListener('change', (event) => { if (!event.target.dataset.select) return; if (event.target.checked) catalogSelection.add(decodeURIComponent(event.target.dataset.select)); else catalogSelection.delete(decodeURIComponent(event.target.dataset.select)); renderPackages(); });
async function bulkSetEnabled(enabled) { if (!catalogSelection.size || !await askConfirmation(`وضعیت ${catalogSelection.size.toLocaleString('fa-IR')} پکیج به «${enabled ? 'فعال' : 'غیرفعال'}» تغییر کند؟`)) return; try { await Promise.all([...catalogSelection].map((ref) => api(`/api/packages/${enc(ref)}`, { method:'PATCH', body:JSON.stringify({ enabled }) }))); catalogSelection.clear(); await load(); toast('وضعیت انتخاب‌ها به‌روزرسانی شد'); } catch (error) { toast(error.message); } }
$('#bulk-enable').addEventListener('click', () => bulkSetEnabled(true));
$('#bulk-disable').addEventListener('click', () => bulkSetEnabled(false));
$('#list-package-search').addEventListener('input', () => { captureVisibleSelections(); listPage = 1; renderListPackagePage(); });
$('#list-category').addEventListener('change', () => { captureVisibleSelections(); listPage = 1; renderListPackagePage(); });
$('#list-packages').addEventListener('change', captureVisibleSelections);
$('#list-prev').addEventListener('click', () => { captureVisibleSelections(); listPage--; renderListPackagePage(); });
$('#list-next').addEventListener('click', () => { captureVisibleSelections(); listPage++; renderListPackagePage(); });

$('#add-form').addEventListener('submit', async (event) => { event.preventDefault(); if (!await askConfirmation(`پکیج «${$('#package-name').value.trim()}» به کاتالوگ افزوده شود؟`)) return; try { await api('/api/packages', { method:'POST', body:JSON.stringify({ ecosystem:$('#ecosystem').value, name:$('#package-name').value.trim(), category:$('#category').value.trim() }) }); $('#package-name').value = ''; await load(); toast('پکیج افزوده شد'); } catch (error) { toast(error.message); } });
$('#list-form').addEventListener('submit', async (event) => { event.preventDefault(); captureVisibleSelections(); if (!await askConfirmation(`لیست جدید با ${listSelection.size.toLocaleString('fa-IR')} پکیج ساخته شود؟`)) return; try { await api('/api/lists', { method:'POST', body:JSON.stringify({ name:$('#list-name').value, packageRefs:[...listSelection], schedule:{ enabled:$('#list-enabled').checked, everyDays:Number($('#list-days').value), time:$('#list-time').value, mode:$('#list-mode').value } }) }); $('#list-name').value = ''; listSelection.clear(); await load(); toast('لیست ساخته شد'); } catch (error) { toast(error.message); } });

$('#package-rows').addEventListener('click', async (event) => {
  const check = event.target.dataset.check, sync = event.target.dataset.sync, del = event.target.dataset.delete, toggle = event.target.dataset.toggle;
  if (check && await askConfirmation('بررسی این پکیج شروع شود؟')) startJob('/api/check', [decodeURIComponent(check)]);
  if (sync && await askConfirmation('این پکیج و وابستگی‌هایش دریافت شوند؟')) startJob('/api/sync', [decodeURIComponent(sync)]);
  if (del && await askConfirmation('حذف ایمن انجام شود؟ فقط پکیج از کاتالوگ حذف می‌شود و فایل‌های cache دست‌نخورده می‌مانند.')) { try { await api(`/api/packages/${del}`, { method:'DELETE' }); await load(); toast('پکیج با موفقیت حذف ایمن شد'); } catch (error) { toast(error.message); } }
  if (toggle) { const ref = decodeURIComponent(toggle); const item = packages.find((entry) => entry.ref === ref); const enabled = item?.enabled === false; if (!await askConfirmation(`وضعیت فعال‌بودن این پکیج به «${enabled ? 'فعال' : 'غیرفعال'}» تغییر کند؟`)) return; try { await api(`/api/packages/${toggle}`, { method:'PATCH', body:JSON.stringify({ enabled }) }); await load(); } catch (error) { toast(error.message); } }
});
$('#package-rows').addEventListener('change', async (event) => {
  if (!event.target.dataset.toggle) return;
  const ref = decodeURIComponent(event.target.dataset.toggle); const item = packages.find((entry) => entry.ref === ref); const enabled = item?.enabled === false;
  if (!await askConfirmation(`وضعیت فعال‌بودن این پکیج به «${enabled ? 'فعال' : 'غیرفعال'}» تغییر کند؟`)) return;
  await api(`/api/packages/${event.target.dataset.toggle}`, { method:'PATCH', body:JSON.stringify({ enabled }) }); await load();
});

$('#list-cards').addEventListener('click', async (event) => {
  const check = event.target.dataset.listCheck, sync = event.target.dataset.listSync, save = event.target.dataset.listSave, del = event.target.dataset.listDelete;
  if (check && await askConfirmation('بررسی این لیست شروع شود؟')) { const job = await api(`/api/lists/${check}/run`, { method:'POST', body:'{"mode":"check"}' }); watch(job.id); }
  if (sync && await askConfirmation('تمام پکیج‌های npm این لیست دریافت شوند؟')) { try { const job = await api(`/api/lists/${sync}/run`, { method:'POST', body:'{"mode":"sync"}' }); watch(job.id); } catch (error) { toast(error.message); } }
  if (save && await askConfirmation('زمان‌بندی جدید این لیست ذخیره شود؟')) { const list = lists.find((item) => item.id === save); const everyDays = Number(document.querySelector(`[data-list-days="${save}"]`).value); const time = document.querySelector(`[data-list-time="${save}"]`).value; const mode = document.querySelector(`[data-list-mode="${save}"]`).value; await api(`/api/lists/${save}`, { method:'PATCH', body:JSON.stringify({ schedule:{ ...list.schedule, everyDays, time, mode } }) }); await load(); toast('برنامهٔ لیست ذخیره شد'); }
  if (del && await askConfirmation('این لیست حذف شود؟ خود پکیج‌ها باقی می‌مانند.')) { await api(`/api/lists/${del}`, { method:'DELETE' }); await load(); }
});
$('#list-cards').addEventListener('change', async (event) => {
  if (!event.target.dataset.listToggle) return;
  const list = lists.find((item) => item.id === event.target.dataset.listToggle);
  const accepted = await askConfirmation(`زمان‌بندی این لیست ${event.target.checked ? 'فعال' : 'غیرفعال'} شود؟`);
  if (!accepted) { event.target.checked = !event.target.checked; return; }
  await api(`/api/lists/${list.id}`, { method:'PATCH', body:JSON.stringify({ schedule:{ ...list.schedule, enabled:event.target.checked } }) }); await load();
});

for (const panel of document.querySelectorAll('.panel')) {
  const button = document.createElement('button');
  button.className = 'collapse-button'; button.type = 'button'; button.textContent = '−'; button.title = 'باز/بسته کردن';
  button.addEventListener('click', () => { panel.classList.toggle('collapsed'); button.textContent = panel.classList.contains('collapsed') ? '+' : '−'; });
  panel.prepend(button);
}
for (const button of document.querySelectorAll('.tab-button')) button.addEventListener('click', () => { document.querySelectorAll('.tab-button').forEach((item) => item.classList.toggle('active', item === button)); document.querySelectorAll('.tab-panel').forEach((panel) => panel.classList.toggle('active', panel.dataset.panel === button.dataset.tab)); });
$('#view-job-packages').addEventListener('click', () => { catalogFocusRefs = new Set(lastJobRefs); document.querySelector('[data-tab="catalog"]')?.click(); renderPackages(); document.querySelector('.job-focus')?.scrollIntoView({ behavior:'smooth', block:'center' }); });

Promise.all([load(), loadStorage()]).catch((error) => toast(error.message));
api('/api/jobs').then((data) => { if (data.activeJob) watch(data.activeJob.id); });
