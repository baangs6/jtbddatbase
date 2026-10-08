const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
function linkedInUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    const host = url.hostname.toLowerCase();
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !(host === 'linkedin.com' || host.endsWith('.linkedin.com'))) return '';
    url.protocol = 'https:';
    return url.href;
  } catch { return ''; }
}
const state = { token: sessionStorage.getItem('review-token'), config: {}, page: 1, filter: '', companyId: null, detail: null, selected: new Set(), candidates: [], moveIds: [] };
let toastTimer, searchTimer, listRequest = 0, detailRequest = 0;
async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, { ...options, headers: { 'x-auth-token': state.token || '', ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...options.headers } });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== '/login') signOut();
    throw new Error(result.message || 'The operation could not be completed.');
  }
  return result;
}
function toast(message, bad = false) { $('#toast').textContent = message; $('#toast').classList.toggle('bad', bad); $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').hidden = true, 6500); }
async function busy(button, work) {
  const original = button.textContent; button.disabled = true; button.textContent = 'Working…';
  try { return await work(); } catch(error) { toast(error.message, true); } finally { if (button.isConnected) { button.disabled = false; button.textContent = original; } }
}
const labels = { no_hiring: 'No Hiring', verify_later: 'Verify Later', pending: 'To review', existing: 'Linked to CRM', new: 'New company', transferred: 'Transferred', duplicate: 'Duplicate', skipped: 'Skipped' };
const badge = value => `<span class="badge ${esc(value)}">${esc(labels[value] || value)}</span>`;
function signOut() { state.token = null; sessionStorage.removeItem('review-token'); $('#workspace').hidden = true; $('#login').hidden = false; $('#login-password').value = ''; }
async function enter() {
  $('#login').hidden = true; $('#workspace').hidden = false;
  $('#demo-banner').hidden = !state.config.demo;
  $('#logout').hidden = Boolean(state.config.demo);
  $('#connection').textContent = state.config.demo ? 'Demo CRM' : state.config.crmConnected ? 'CRM connection configured' : 'CRM not connected';
  $('#connection').classList.toggle('live', Boolean(state.config.crmConnected || state.config.demo));
  await loadCompanies();
}
$('#login-form').addEventListener('submit', async event => {
  event.preventDefault(); $('#login-error').textContent = '';
  await busy($('#login-form button'), async () => {
    try { const result = await api('/login', { method: 'POST', body: JSON.stringify({ email: $('#login-email').value, password: $('#login-password').value }) }); state.token = result.token; sessionStorage.setItem('review-token', state.token); await enter(); }
    catch(error) { $('#login-error').textContent = error.message; }
  });
});
$('#logout').addEventListener('click', signOut);
async function loadCompanies() {
  const request = ++listRequest;
  try {
    const data = await api(`/contact-review/companies?search=${encodeURIComponent($('#company-search').value)}&status=${state.filter}&page=${state.page}`);
    if (request !== listRequest) return;
    const stats = data.stats, total = Object.values(stats).reduce((sum, x) => sum + x, 0);
    $('#stats').innerHTML = [['Total contacts', total, '≡'], ['Waiting for review', (stats.pending || 0) + (stats.duplicate || 0), '◷'], ['Moved to CRM', stats.transferred || 0, '↗'], ['Skipped', stats.skipped || 0, '−']].map(([label, count, icon]) => `<div class="stat"><div><span>${label}</span><strong>${count.toLocaleString()}</strong></div><div class="stat-icon">${icon}</div></div>`).join('');
    $('#company-total').textContent = data.total;
    $('#company-list').innerHTML = data.companies.length ? data.companies.map(c => `<button class="company-item ${state.companyId === c._id ? 'active' : ''}" data-company="${esc(c._id)}"><span class="initial">${esc(c.name.slice(0, 1).toUpperCase())}</span><span><b>${esc(c.name)}</b><small>${c.counts.total} contacts · ${c.counts.remaining} to review</small>${badge(c.reviewStatus && c.reviewStatus !== 'pending' ? c.reviewStatus : c.decision)}</span></button>`).join('') : '<div class="empty"><p>No companies found.</p></div>';
    const pages = Math.max(1, Math.ceil(data.total / 40));
    $('#pagination').innerHTML = `<button class="quiet" id="prev-page" ${state.page === 1 ? 'disabled' : ''}>← Previous</button><form id="page-jump" class="page-jump"><input id="jump-page" type="number" min="1" max="${pages}" step="1" value="${state.page}" aria-label="Company page number" required><span>/ ${pages}</span><button class="quiet" type="submit">Go</button></form><button class="quiet" id="next-page" ${state.page >= pages ? 'disabled' : ''}>Next →</button>`;
    $('#prev-page').onclick = () => { state.page--; loadCompanies(); };
    $('#page-jump').onsubmit = event => {
      event.preventDefault();
      const page = Number($('#jump-page').value);
      if (!Number.isInteger(page) || page < 1 || page > pages) { toast(`Enter a page between 1 and ${pages}.`, true); return; }
      state.page = page; loadCompanies();
    };
    $('#next-page').onclick = () => { state.page++; loadCompanies(); };
    if (!state.companyId && data.companies.length) await loadDetail(data.companies[0]._id);
  } catch(error) { toast(error.message, true); }
}
$('#company-list').addEventListener('click', event => { const button = event.target.closest('[data-company]'); if (button) loadDetail(button.dataset.company); });
$('#company-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.page = 1; loadCompanies(); }, 250); });
document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
  state.filter = button.dataset.filter; state.page = 1;
  document.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('active', b === button)); loadCompanies();
}));
async function loadDetail(companyId, contactPage = 1) {
  const request = ++detailRequest; state.companyId = companyId; state.selected.clear();
  $('#detail').innerHTML = '<div class="loading">Checking companies and contact matches…</div>';
  document.querySelectorAll('[data-company]').forEach(b => b.classList.toggle('active', b.dataset.company === companyId));
  try {
    const detail = await api(`/contact-review/companies/${encodeURIComponent(companyId)}?contactPage=${contactPage}`);
    if (request !== detailRequest) return;
    state.detail = detail; state.candidates = detail.candidates;
    if (detail.selectedLead && !state.candidates.some(c => c._id === detail.selectedLead._id)) state.candidates.unshift({ ...detail.selectedLead, score: 1 });
    state.users = state.config.demo || !detail.crmConnected ? [] : await api('/contact-review/crm-users');
    renderDetail();
  } catch(error) { if (request === detailRequest) $('#detail').innerHTML = `<div class="empty"><h2>Unable to open company</h2><p>${esc(error.message)}</p><button id="retry-detail" class="secondary">Try again</button></div>`; $('#retry-detail')?.addEventListener('click', () => loadDetail(companyId)); }
}
function renderMatches() {
  const c = state.detail.company;
  $('#matches').innerHTML = state.candidates.length ? state.candidates.map(lead => `<label class="match-card"><input type="radio" name="company-choice" value="${esc(lead._id)}" ${c.decision === 'existing' && c.crmLeadId === lead._id ? 'checked' : ''}><span class="match-info"><strong>${esc(lead.company_name)}</strong><small>${esc(lead.website_url || 'No website in CRM')} · ${esc(lead.stage || 'New')} · ${esc(lead.status || 'approved')}</small></span><span class="match-score">${Math.round(lead.score * 100)}% name similarity</span></label>`).join('') : `<p class="match-hint">${state.detail.crmConnected ? 'No similar companies found. Search another spelling or verify a new company.' : 'Connect the CRM to search existing companies and check contact duplicates.'}</p>`;
  syncWebsiteOption();
}
function syncWebsiteOption() {
  const choice = $('input[name="company-choice"]:checked')?.value;
  const input = $('#update-website');
  if (!input) return;
  input.disabled = !choice || choice === 'new';
  if (input.disabled) input.checked = false;
  input.closest('label').hidden = input.disabled;
}
function renderDetail() {
  state.companyDirty = false; state.destinationDirty = new Set();
  const { company: c, contacts, crmConnected } = state.detail;
  const totalContacts = state.detail.totalContacts ?? contacts.length, contactPage = state.detail.contactPage || 1, contactPages = Math.max(1, Math.ceil(totalContacts / 100));
  const available = contacts.filter(x => !['transferred', 'skipped'].includes(x.status));
  const duplicateCount = contacts.filter(x => x.duplicates.length).length;
  $('#detail').innerHTML = `<div class="detail-head"><div><h2>${esc(c.name)}</h2><p>${totalContacts} contacts in your import · ${available.length} waiting on this page</p></div>${badge(c.reviewStatus && c.reviewStatus !== "pending" ? c.reviewStatus : c.decision)}<div class="company-status-actions"><button class="secondary" id="another-company">Move to another company</button><button class="secondary" data-review-status="no_hiring">No Hiring</button><button class="secondary" data-review-status="verify_later">Verify Later</button>${c.reviewStatus && c.reviewStatus !== "pending" ? '<button class="quiet" data-review-status="pending">Restore to review</button>' : ""}</div></div>
  <section class="company-review"><div class="section-label"><span>1</span> CONFIRM THE COMPANY</div><p class="match-hint">Similar names are suggestions. Confirm the correct company before moving contacts.</p>
  ${!crmConnected ? '<div class="warning">CRM is not connected. You can review imports and save websites; transfers stay disabled.</div>' : ''}
  <div class="inline-search"><input class="field" id="crm-search" aria-label="Search CRM company names" placeholder="Try another company name"><button class="secondary" id="crm-search-button" ${!crmConnected ? 'disabled' : ''}>Search CRM</button></div><div id="matches"></div>
  <label class="new-option"><input type="radio" name="company-choice" value="new" ${c.decision === 'new' ? 'checked' : ''}>This is a new company</label>
  <div class="website-row"><input class="field" id="website" aria-label="Verified company website" placeholder="Verified website, e.g. company.com" value="${esc(c.verifiedWebsite || '')}"><a href="https://www.google.com/search?q=${encodeURIComponent(c.name + ' official website')}" target="_blank" rel="noopener noreferrer">Find website ↗</a></div>
  <label class="update-option"><input type="checkbox" id="update-website">Also update the selected company's website in CRM</label>
  <div class="review-actions"><button class="primary" id="save-company">Save company decision</button><span class="muted">${c.decision === 'pending' ? 'No decision saved yet' : 'Decision saved for all contacts in this company'}</span></div><p id="company-error" class="error" role="alert"></p></section>
  <section class="contacts-section"><div class="section-label"><span>2</span> REVIEW & MOVE CONTACTS</div><div class="contacts-toolbar"><div><h3>Contacts <span class="count">${totalContacts}</span></h3><p>${duplicateCount ? `${duplicateCount} contacts on this page have matching details.` : 'No email or phone matches on this page.'}${!crmConnected ? ' CRM checks are pending.' : ''}</p></div><button id="move-selected" class="primary" disabled>Move selected (0) ↗</button></div>
  <div id="transfer-results"></div><div class="table-wrap"><table><thead><tr><th><input id="select-all" type="checkbox" aria-label="Select all eligible contacts"></th><th>Contact</th><th>Email / phone</th><th>Review status</th><th></th></tr></thead><tbody>${contacts.map(row => {
    const crmDuplicate = row.duplicates.some(d => d.source === 'CRM');
    const eligible = !['transferred', 'skipped'].includes(row.status) && !crmDuplicate;
    const profileUrl = linkedInUrl(row.linkedin_url);
    const profile = profileUrl ? `<a class="linkedin-link" href="${esc(profileUrl)}" target="_blank" rel="noopener noreferrer" aria-label="LinkedIn profile for ${esc(row.name || 'contact')}">LinkedIn profile ↗</a>` : `<small>${row.linkedin_url ? 'LinkedIn URL needs review' : 'No LinkedIn link'}</small>`;
    const altPhones = [row.alternate_phone, ...(row.additionalPhones || [])].filter(Boolean).map(phone => `<small class="alternative-phone">Alternative: ${esc(phone)}</small>`).join('');
    return `<tr><td><input type="checkbox" data-contact="${esc(row._id)}" aria-label="Select ${esc(row.name || row.email || 'contact')}" ${eligible ? '' : 'disabled'}></td><td><strong>${esc(row.name || 'Unnamed contact')}</strong><small>${esc(row.designation || 'No designation')}</small>${profile}
    ${row.status === 'transferred' ? '' : `<details><summary>Company &amp; owner</summary><label>New company name<input class="field" data-destination-name="${esc(row._id)}" aria-label="New company name for ${esc(row.name)}" value="${esc(row.destinationName || '')}" placeholder="Leave blank to use company above"></label><label>Verified website<input class="field" data-destination-website="${esc(row._id)}" aria-label="New company website for ${esc(row.name)}" value="${esc(row.destinationWebsite || '')}"></label><label>Assign to active CRM user<select class="field" data-owner="${esc(row._id)}" aria-label="Owner for ${esc(row.name)}"><option value="">Use default company ownership</option>${(state.users || []).map(u => `<option value="${esc(u._id)}" ${row.ownerId === u._id ? 'selected' : ''}>${esc(u.name)} (${esc(u.email)})</option>`).join('')}</select></label><small>CRM ownership is at company level. Existing company owners are retained.</small><button class="secondary" data-save-destination="${esc(row._id)}">Save contact destination</button></details>`}</td><td><div class="contact-email">${esc(row.email || 'No email')}</div><small>${esc(row.phone || 'No phone')}</small>${altPhones}</td><td>${badge(row.status === 'pending' && crmDuplicate ? 'duplicate' : row.status)}${row.duplicates.map(d => `<span class="duplicate-note">${esc(d.source)}: ${esc(d.reason)}<br>${esc(d.name || 'Contact')} · ${esc(d.company_name)}</span>`).join('')}${!row.email && !row.phone ? '<span class="duplicate-note">Name only — verify identity manually.</span>' : ''}</td><td>${row.status === 'transferred' ? '' : `<button class="quiet" data-skip="${esc(row._id)}" data-next="${row.status === 'skipped' ? 'pending' : 'skipped'}">${row.status === 'skipped' ? 'Restore' : 'Skip'}</button>`}</td></tr>`;
  }).join('')}</tbody></table></div><div class="pagination"><button id="contact-prev" class="quiet" ${contactPage <= 1 ? 'disabled' : ''}>← Previous</button><span>Page ${contactPage} / ${contactPages} · up to 100 contacts</span><button id="contact-next" class="quiet" ${contactPage >= contactPages ? 'disabled' : ''}>Next →</button></div><div class="table-bottom">Email and phone matches block transfers. Import matches stay visible for review.</div></section>`;
  renderMatches();
  document.querySelectorAll('[data-review-status]').forEach(button => button.onclick = () => busy(button, async () => {
    await api('/contact-review/companies/' + state.companyId + '/review-status', { method: 'PATCH', body: JSON.stringify({ reviewStatus: button.dataset.reviewStatus }) });
    await refresh(); toast('Company review status saved.');
  }));
  $('#contact-prev').onclick = () => loadDetail(state.companyId, contactPage - 1);
  $('#contact-next').onclick = () => loadDetail(state.companyId, contactPage + 1);
  $('.company-review').addEventListener('input', event => {
    if (event.target.id === 'crm-search') return;
    if (event.target.name === 'company-choice') syncWebsiteOption();
    state.companyDirty = true; updateSelected();
    $('.review-actions .muted').textContent = 'Save the changed decision before moving contacts';
  });
  $('#save-company').onclick = () => busy($('#save-company'), saveCompany);
  $('#another-company').onclick = () => {
    $('#crm-search').value = '';
    $('#crm-search').placeholder = 'Enter the destination company name';
    $('#company-error').textContent = 'Search for the destination company, select its match, and save the company decision. Then select the contacts to move. Already transferred contacts must be moved within the CRM.';
    $('#crm-search').scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('#crm-search').focus();
  };
  $('#crm-search-button').onclick = () => busy($('#crm-search-button'), async () => {
    state.candidates = await api(`/contact-review/crm-search?name=${encodeURIComponent($('#crm-search').value || c.name)}`); renderMatches();
  });
  $('#crm-search').addEventListener('keydown', event => { if (event.key === 'Enter') $('#crm-search-button').click(); });
  $('#select-all').onchange = event => { document.querySelectorAll('[data-contact]:not(:disabled)').forEach(input => { input.checked = event.target.checked; if (input.checked) state.selected.add(input.dataset.contact); else state.selected.delete(input.dataset.contact); }); updateSelected(); };
  document.querySelectorAll('[data-contact]').forEach(input => input.onchange = () => { if (input.checked) state.selected.add(input.dataset.contact); else state.selected.delete(input.dataset.contact); updateSelected(); });
  document.querySelectorAll('[data-skip]').forEach(button => button.onclick = () => busy(button, async () => { await api(`/contact-review/contacts/${button.dataset.skip}`, { method: 'PATCH', body: JSON.stringify({ status: button.dataset.next }) }); await refresh(); }));
  document.querySelectorAll('[data-destination-name], [data-destination-website], [data-owner]').forEach(input => input.addEventListener('input', () => { state.destinationDirty.add(input.dataset.destinationName || input.dataset.destinationWebsite || input.dataset.owner); updateSelected(); }));
  document.querySelectorAll('[data-save-destination]').forEach(button => button.onclick = () => busy(button, async () => {
    const contactId = button.dataset.saveDestination;
    await api('/contact-review/contacts/' + contactId, { method: 'PATCH', body: JSON.stringify({ destinationName: $('[data-destination-name="' + contactId + '"]').value, destinationWebsite: $('[data-destination-website="' + contactId + '"]').value, ownerId: $('[data-owner="' + contactId + '"]').value }) });
    toast('Contact destination saved.'); await refresh();
  }));
  $('#move-selected').onclick = () => {
    state.moveIds = [...state.selected];
    const destinations = state.detail.contacts.filter(row => state.moveIds.includes(row._id)).map(row => row.destinationName || state.detail.selectedLead?.company_name || c.name);
    $('#move-summary').textContent = `${state.config.demo ? 'Demo: simulate moving' : 'Move'} ${state.moveIds.length} contacts to ${[...new Set(destinations)].join(', ')}?`;
    $('#move-dialog').showModal();
  };
}
function updateSelected() {
  const button = $('#move-selected'); button.textContent = `Move selected (${state.selected.size}) ↗`;
  button.disabled = !state.selected.size || !state.detail.crmConnected || (state.detail.company.decision === 'pending' && [...state.selected].some(id => !state.detail.contacts.find(row => row._id === id)?.destinationName)) || state.companyDirty || [...state.selected].some(id => state.destinationDirty.has(id));
  const inputs = [...document.querySelectorAll('[data-contact]:not(:disabled)')];
  $('#select-all').checked = Boolean(inputs.length) && inputs.every(x => x.checked);
  $('#select-all').indeterminate = state.selected.size > 0 && !$('#select-all').checked;
}
async function saveCompany() {
  const choice = $('input[name="company-choice"]:checked')?.value;
  if (!choice) { $('#company-error').textContent = 'Select “This is a new company” above, or select an existing CRM match.'; $('input[name="company-choice"][value="new"]').focus(); throw new Error('Select “This is a new company” before saving.'); }
  if (choice === 'new' && !$('#website').value.trim()) throw new Error('Find and verify the company website before saving a new company.');
  await api(`/contact-review/companies/${state.companyId}`, { method: 'PUT', body: JSON.stringify({ decision: choice === 'new' ? 'new' : 'existing', crmLeadId: choice === 'new' ? undefined : choice, website: $('#website').value.trim(), updateCrmWebsite: choice !== 'new' && $('#update-website').checked }) });
  toast('Company decision saved. Review the contacts below.'); await refresh();
}
async function refresh() { await loadDetail(state.companyId, state.detail?.contactPage || 1); await loadCompanies(); }
$('#move-close').onclick = $('#move-cancel').onclick = () => $('#move-dialog').close();
$('#move-confirm').onclick = () => busy($('#move-confirm'), async () => {
  const results = [];
  for (let offset = 0; offset < state.moveIds.length; offset += 100) {
    const response = await api('/contact-review/transfer', { method: 'POST', body: JSON.stringify({ contactIds: state.moveIds.slice(offset, offset + 100) }) }); results.push(...response.results);
  }
  $('#move-dialog').close(); await refresh();
  const moved = results.filter(x => x.status === 'transferred').length;
  $('#transfer-results').innerHTML = `<div class="result-box"><strong>${state.config.demo ? 'Demo: ' : ''}${moved} contacts moved · ${results.length - moved} stayed in review</strong>${results.some(x => x.status !== 'transferred') ? `<ul>${results.filter(x => x.status !== 'transferred').map(x => `<li>${esc(state.detail.contacts.find(c => c._id === x.id)?.name || 'Contact')}: ${esc(x.message)}</li>`).join('')}</ul>` : ''}</div>`;
  toast(`${state.config.demo ? 'Demo: ' : ''}${moved} contacts moved.`, moved === 0);
});
const openImport = () => { $('#import-error').textContent = ''; $('#import-dialog').showModal(); };
$('#import-open').onclick = openImport; $('#empty-import').onclick = openImport; $('#import-close').onclick = () => $('#import-dialog').close();
const fields = { company_name: 'Company name *', name: 'Contact name', email: 'Email', phone: 'Phone', designation: 'Designation', linkedin_url: 'LinkedIn URL', alternate_phone: 'Alternative phone' };
const aliases = { company_name: ['company', 'companyname', 'organization', 'organisation', 'employer'], name: ['name', 'contactname', 'fullname', 'personname'], email: ['email', 'emailaddress', 'emailid', 'workemail'], phone: ['phone', 'phonenumber', 'mobile', 'mobilenumber', 'contactnumber'], designation: ['designation', 'jobtitle', 'title', 'role'], linkedin_url: ['linkedin', 'linkedinurl', 'linkedinprofile'], alternate_phone: ['alternativephone', 'alternatephone', 'mobilephonenumber', 'mobile'] };
$('#csv-file').addEventListener('change', async () => {
  $('#mapping-section').hidden = true; $('#import-error').textContent = '';
  const file = $('#csv-file').files[0]; if (!file) return;
  try {
    const form = new FormData(); form.append('file', file); const result = await api('/contact-review/import/preview', { method: 'POST', body: form });
    $('#import-count').textContent = `${result.count.toLocaleString()} rows found. Company name and at least one contact identifier are required.`;
    $('#column-mapping').innerHTML = Object.entries(fields).map(([field, label]) => {
      const guess = result.headers.find(header => aliases[field].includes(header.toLowerCase().replace(/[^a-z]/g, '')));
      return `<label>${label}<select class="field" data-map="${field}"><option value="">${field === 'company_name' ? 'Choose a column' : 'Not included'}</option>${result.headers.map(header => `<option value="${esc(header)}" ${header === guess ? 'selected' : ''}>${esc(header)}</option>`).join('')}</select></label>`;
    }).join('');
    $('#import-sample').innerHTML = `<table><thead><tr>${result.headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${result.sample.slice(0, 3).map(row => `<tr>${result.headers.map(h => `<td>${esc(row[h])}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    $('#mapping-section').hidden = false;
  } catch(error) { $('#import-error').textContent = error.message; }
});
$('#import-submit').onclick = () => busy($('#import-submit'), async () => {
  $('#import-error').textContent = '';
  const mapping = Object.fromEntries([...document.querySelectorAll('[data-map]')].map(select => [select.dataset.map, select.value]));
  if (!mapping.company_name) { $('#import-error').textContent = 'Choose the company name column.'; return; }
  if (!mapping.name && !mapping.email && !mapping.phone) { $('#import-error').textContent = 'Choose at least one contact identifier: name, email, or phone.'; return; }
  const form = new FormData(); form.append('file', $('#csv-file').files[0]); form.append('mapping', JSON.stringify(mapping));
  try {
    const result = await api('/contact-review/import', { method: 'POST', body: form });
    const summary = `${result.inserted} imported · ${result.alreadyImported} already imported · ${result.merged || 0} combined · ${result.invalidCount} invalid rows`;
    if (result.invalidCount) {
      $('#import-error').textContent = `${summary}\n${result.invalid.map(x => `Row ${x.row}: ${x.reason}`).join('\n')}`;
      $('#mapping-section').hidden = true;
    } else $('#import-dialog').close();
    toast(summary); state.page = 1; $('#company-search').value = ''; state.filter = ''; document.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('active', !b.dataset.filter)); await loadCompanies();
  } catch(error) { $('#import-error').textContent = error.message; }
});
async function boot() {
  try { state.config = await api('/config'); if (state.config.demo) state.token = 'demo'; if (state.token) await enter(); else signOut(); }
  catch(error) { signOut(); $('#login-error').textContent = error.message; }
}
boot();
