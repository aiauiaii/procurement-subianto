const state = {
  user: null,
  users: [],
  workflow: [],
  entries: [],
  selectedEntryId: null,
  adminArchiveFilter: 'active',
  visibleEntryDocs: new Set(),
  expandedAdminStageDocs: new Set(),
  selectedDashboardUserKey: null,
  pendingDeleteEntryId: null,
  expandedUserIds: new Set(),
  builderLevel1Id: null,
  collapsedLevel2Ids: new Set(),
  workflowDrafts: new Map(),
  isSavingWorkflow: false
};

const els = {
  loginScreen: document.querySelector('#loginScreen'),
  appShell: document.querySelector('#appShell'),
  loginForm: document.querySelector('#loginForm'),
  loginRole: document.querySelector('#loginRole'),
  loginEmail: document.querySelector('#loginEmail'),
  loginPassword: document.querySelector('#loginPassword'),
  userBadge: document.querySelector('#userBadge'),
  logoutButton: document.querySelector('#logoutButton'),
  workflowSummary: document.querySelector('#workflowSummary'),
  tabs: document.querySelectorAll('.tab'),
  views: document.querySelectorAll('.view'),
  entryForm: document.querySelector('#entryForm'),
  entryTitle: document.querySelector('#entryTitle'),
  entrySelect: document.querySelector('#entrySelect'),
  currentLevelTitle: document.querySelector('#currentLevelTitle'),
  entryStatus: document.querySelector('#entryStatus'),
  submissionForm: document.querySelector('#submissionForm'),
  adminEntries: document.querySelector('#adminEntries'),
  adminUsers: document.querySelector('#adminUsers'),
  userForm: document.querySelector('#userForm'),
  newUserName: document.querySelector('#newUserName'),
  newUserEmail: document.querySelector('#newUserEmail'),
  newUserNotificationEmail: document.querySelector('#newUserNotificationEmail'),
  newUserRole: document.querySelector('#newUserRole'),
  newUserEmailNotifications: document.querySelector('#newUserEmailNotifications'),
  newUserPassword: document.querySelector('#newUserPassword'),
  refreshUsers: document.querySelector('#refreshUsers'),
  workflowBuilder: document.querySelector('#workflowBuilder'),
  saveWorkflow: document.querySelector('#saveWorkflow'),
  addLevel1: document.querySelector('#addLevel1'),
  refreshAdmin: document.querySelector('#refreshAdmin'),
  refreshSubmitter: document.querySelector('#refreshSubmitter'),
  confirmModal: document.querySelector('#confirmModal'),
  confirmModalText: document.querySelector('#confirmModalText'),
  confirmModalInput: document.querySelector('#confirmModalInput'),
  confirmModalCancel: document.querySelector('#confirmModalCancel'),
  confirmModalConfirm: document.querySelector('#confirmModalConfirm'),
  toast: document.querySelector('#toast')
};

init();

async function init() {
  bindEvents();
  await checkAuth();
}

function bindEvents() {
  els.loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: {
        role: els.loginRole.value,
        email: els.loginEmail.value,
        password: els.loginPassword.value
      }
    });
    state.user = data.user;
    state.selectedEntryId = null;
    showApp();
    await refreshAll();
    toast(`Logged in as ${state.user.name}`);
  });

  document.querySelectorAll('[data-login-preset]').forEach((button) => {
    button.addEventListener('click', () => {
      const role = button.dataset.loginPreset;
      els.loginRole.value = role;
      els.loginEmail.value = role === 'admin' ? 'admin@procurement.local' : 'requester@procurement.local';
      els.loginPassword.value = role === 'admin' ? 'admin123' : 'requester123';
    });
  });

  els.logoutButton.addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST', body: {} });
    state.user = null;
    state.users = [];
    state.workflow = [];
    state.entries = [];
    state.adminArchiveFilter = 'active';
    state.visibleEntryDocs = new Set();
    state.expandedAdminStageDocs = new Set();
    state.selectedDashboardUserKey = null;
    state.pendingDeleteEntryId = null;
    state.expandedUserIds = new Set();
    state.selectedEntryId = null;
    showLogin();
    toast('Logged out');
  });

  els.tabs.forEach((tab) => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  els.entryForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const entry = await api('/api/entries', {
      method: 'POST',
      body: {
        title: els.entryTitle.value
      }
    });
    els.entryForm.reset();
    state.selectedEntryId = entry.id;
    await refreshEntries();
    await renderSelectedEntry();
    toast('Entry created');
  });

  els.entrySelect.addEventListener('change', async () => {
    state.selectedEntryId = Number(els.entrySelect.value) || null;
    await renderSelectedEntry();
  });

  els.submissionForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state.selectedEntryId) return;

    const submitButton = els.submissionForm.querySelector('[data-submit-entry]');
    const feedback = els.submissionForm.querySelector('[data-submit-feedback]');
    const progress = els.submissionForm.querySelector('[data-submit-progress]');
    setSubmitFeedback(feedback, '');
    setSubmitProgress(progress, 0, false);
    const missingDocuments = missingRequiredDocuments();
    if (missingDocuments.length > 0) {
      setSubmitFeedback(feedback, `Please upload: ${missingDocuments.join(', ')}`);
      const firstMissing = els.submissionForm.querySelector('input[type="file"][required]:not(:disabled)');
      firstMissing?.focus();
      return;
    }

    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = 'Submitting...';
    }

    try {
      const formData = new FormData(els.submissionForm);
      await uploadFormWithProgress(`/api/entries/${state.selectedEntryId}/submit-level`, formData, (percent) => {
        setSubmitProgress(progress, percent, true);
      });
      setSubmitProgress(progress, 100, true);
      await refreshEntries();
      await renderSelectedEntry();
      toast('Level submitted for approval');
    } catch (error) {
      setSubmitFeedback(feedback, error.message || 'Submit failed');
    } finally {
      if (submitButton && document.contains(submitButton)) {
        submitButton.disabled = false;
        submitButton.textContent = 'Submit';
      }
    }
  });

  els.addLevel1?.addEventListener('click', async () => {
    const level1 = await api('/api/admin/workflow/level1', {
      method: 'POST',
      body: { name: 'New Stage', description: '' }
    });
    state.builderLevel1Id = level1.id;
    await refreshWorkflow();
    toast('Stage added');
  });

  els.saveWorkflow?.addEventListener('click', saveVisibleWorkflow);
  els.userForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    await api('/api/admin/users', {
      method: 'POST',
      body: {
        name: els.newUserName.value,
        email: els.newUserEmail.value,
        notificationEmail: els.newUserNotificationEmail.value,
        role: els.newUserRole.value,
        emailNotifications: els.newUserEmailNotifications.checked,
        password: els.newUserPassword.value
      }
    });
    els.userForm.reset();
    await refreshUsers();
    toast('Account created');
  });

  els.refreshAdmin.addEventListener('click', refreshAll);
  els.refreshUsers.addEventListener('click', refreshUsers);
  els.refreshSubmitter.addEventListener('click', refreshAll);
  els.confirmModalCancel?.addEventListener('click', closeDeleteEntryModal);
  els.confirmModalInput?.addEventListener('input', () => {
    els.confirmModalConfirm.disabled = els.confirmModalInput.value.trim().toLowerCase() !== 'yes';
  });
  els.confirmModalConfirm?.addEventListener('click', confirmDeleteEntry);
}

async function checkAuth() {
  const data = await api('/api/auth/me');
  state.user = data.user;
  if (!state.user) {
    showLogin();
    return;
  }
  showApp();
  await refreshAll();
}

function showLogin() {
  els.loginScreen.hidden = false;
  els.appShell.hidden = true;
  els.loginPassword.value = '';
}

function showApp() {
  els.loginScreen.hidden = true;
  els.appShell.hidden = false;
  els.userBadge.textContent = `${state.user.name} / ${state.user.role === 'admin' ? 'Procurement Admin' : 'Requester'}`;

  els.tabs.forEach((tab) => {
    const isRequesterTab = tab.dataset.tab === 'submitter';
    tab.hidden = state.user.role === 'admin' ? isRequesterTab : !isRequesterTab;
  });
  switchTab(state.user.role === 'admin' ? 'admin-dashboard' : 'submitter');
}

async function refreshAll() {
  if (!state.user) return;
  await refreshWorkflow();
  await refreshEntries();
  if (state.user.role === 'admin') await refreshUsers();
  if (state.user.role === 'requester') await renderSelectedEntry();
}

async function refreshWorkflow() {
  const data = await api('/api/workflow');
  state.workflow = data.levels;
  if (!state.workflow.some((level1) => level1.id === state.builderLevel1Id)) {
    state.builderLevel1Id = state.workflow[0]?.id || null;
  }
  renderWorkflowSummary();
  if (els.workflowBuilder) renderWorkflowBuilder();
}

async function refreshEntries() {
  const query = state.user?.role === 'admin' ? `?archived=${encodeURIComponent(state.adminArchiveFilter)}` : '';
  const data = await api(`/api/entries${query}`);
  state.entries = data.entries;
  if (!state.selectedEntryId && state.entries[0]) state.selectedEntryId = state.entries[0].id;
  if (state.selectedEntryId && !state.entries.some((entry) => entry.id === state.selectedEntryId)) {
    state.selectedEntryId = state.entries[0]?.id || null;
  }
  renderEntrySelect();
  renderAdminEntries();
}

async function refreshUsers() {
  if (!state.user || state.user.role !== 'admin') return;
  const data = await api('/api/admin/users');
  state.users = data.users;
  renderAdminUsers();
  renderAdminEntries();
}

function renderWorkflowSummary() {
  const level1Count = state.workflow.length;
  const level2Count = state.workflow.reduce((sum, level1) => sum + level1.level2s.length, 0);
  const level3Count = state.workflow.reduce(
    (sum, level1) => sum + level1.level2s.reduce((inner, level2) => inner + level2.level3s.length, 0),
    0
  );
  els.workflowSummary.textContent = `${level1Count} stages / ${level2Count} activities / ${level3Count} documents`;
}

function renderEntrySelect() {
  els.entrySelect.innerHTML = '';
  if (state.entries.length === 0) {
    const option = new Option('No entries yet', '');
    els.entrySelect.append(option);
    els.entrySelect.disabled = true;
    return;
  }

  els.entrySelect.disabled = false;
  state.entries.forEach((entry) => {
    const option = new Option(`#${entry.id} - ${entry.title}`, String(entry.id));
    option.selected = entry.id === state.selectedEntryId;
    els.entrySelect.append(option);
  });
}

async function renderSelectedEntry() {
  els.submissionForm.innerHTML = '';
  if (!state.selectedEntryId) {
    els.currentLevelTitle.textContent = 'Current Stage';
    setStatus(els.entryStatus, 'No entry', '');
    els.submissionForm.innerHTML = '<div class="empty">Create or select an entry.</div>';
    return;
  }

  const { entry } = await api(`/api/entries/${state.selectedEntryId}`);
  setStatus(els.entryStatus, entry.statusLabel, entry.status);

  if (entry.status === 'complete') {
    els.currentLevelTitle.textContent = 'Complete';
    els.submissionForm.innerHTML = `
      ${renderStageProgress(entry)}
      ${renderCompletionPanel(entry)}
      ${renderTimeline(entry)}
      ${renderRejectedNotices(entry)}
    `;
    return;
  }

  const level = entry.levels.find((item) => item.id === entry.current_level1_id);
  if (!level) {
    els.currentLevelTitle.textContent = 'Current Stage';
    els.submissionForm.innerHTML = '<div class="empty">No active workflow level.</div>';
    return;
  }

  els.currentLevelTitle.textContent = `Stage ${level.position}: ${escapeHtml(level.name)}`;
  if (entry.status === 'awaiting_approval') {
    els.submissionForm.innerHTML = `
      ${renderStageProgress(entry)}
      ${renderTimeline(entry)}
      ${renderRejectedNotices(entry)}
      <div class="empty">Waiting for admin approval.</div>
    `;
    return;
  }

  const disabled = entry.status === 'awaiting_approval';
  const currentDocuments = new Map(
    entry.documents
      .filter((document) => document.level1_id === level.id)
      .map((document) => [document.level3_id, document])
  );
  const rows = level.level2s.map((level2) => `
    <section class="subactivity">
      <h3>${escapeHtml(level2.name)}</h3>
      ${level2.description ? `<p class="meta">${escapeHtml(level2.description)}</p>` : ''}
      ${level2.level3s.length ? level2.level3s.map((level3) => renderRequesterLevel3Row(level3, currentDocuments.get(level3.id), disabled)).join('') : '<div class="empty">No required documents.</div>'}
    </section>
  `).join('');

  els.submissionForm.innerHTML = `
    ${renderStageProgress(entry)}
    ${renderTimeline(entry)}
      ${renderRejectedNotices(entry)}
    <section class="level-block">
      ${level.description ? `<p class="meta">${escapeHtml(level.description)}</p>` : ''}
      <p class="required-note">Accepted documents are saved. Upload only missing or rejected documents.</p>
      ${rows || '<div class="empty">No activities.</div>'}
    </section>
    <button type="submit" data-submit-entry ${disabled ? 'disabled' : ''}>Submit</button>
    <div class="submit-progress" data-submit-progress hidden>
      <div class="submit-progress-top">
        <span>Uploading documents</span>
        <strong data-submit-progress-label>0%</strong>
      </div>
      <div class="submit-progress-track">
        <div data-submit-progress-bar></div>
      </div>
    </div>
    <div class="submit-feedback" data-submit-feedback role="status" aria-live="polite"></div>
    ${entry.status === 'rejected' ? `<div class="empty">Rejected by admin. Upload the corrected documents and submit again.</div>` : ''}
  `;
}

function renderRequesterLevel3Row(level3, document, disabled) {
  if (document?.review_status === 'approved') {
    return `
      <div class="doc-row doc-row-approved">
        <div class="doc-name">
          <strong>${escapeHtml(level3.name)}</strong>
          ${level3.instructions ? `<small>${escapeHtml(level3.instructions)}</small>` : ''}
          <small>Accepted file: ${escapeHtml(document.original_name)}</small>
        </div>
        <span class="doc-state accepted">Accepted</span>
      </div>
    `;
  }

  return `
    <div class="doc-row ${document?.review_status === 'rejected' ? 'doc-row-rejected' : ''}">
      <div class="doc-name">
        <strong>${escapeHtml(level3.name)}</strong>
        ${level3.instructions ? `<small>${escapeHtml(level3.instructions)}</small>` : ''}
        ${document?.review_status === 'rejected' ? `<small class="doc-inline-reject">Rejected: ${escapeHtml(document.review_notes || 'Please upload a corrected document.')}</small>` : ''}
      </div>
      <input type="file" name="doc_${level3.id}" required ${disabled ? 'disabled' : ''}>
    </div>
  `;
}

function renderCompletionPanel(entry) {
  return `
    <section class="completion-panel">
      <div>
        <h3>Completed. Congratulations!</h3>
        <p>All stages have been approved. Download a ZIP with documents separated by stage, activity, and document folders.</p>
      </div>
      ${renderDownloadZipButton(entry)}
    </section>
  `;
}

function renderDownloadZipButton(entry, compact = false) {
  if (entry.status !== 'complete') return '';
  return `
    <a class="download-all-docs ${compact ? 'compact' : ''}" href="/api/entries/${entry.id}/documents.zip" download>
      Download ZIP
    </a>
  `;
}

function renderRejectedNotices(entry) {
  const rejectedDocuments = entry.documents.filter((document) => document.review_status === 'rejected');
  if (rejectedDocuments.length === 0) return '';
  return `
    <section class="rejection-notice">
      <h3>Rejected documents</h3>
      <ul>
        ${rejectedDocuments.map((document) => `
          <li>
            <strong>${escapeHtml(document.level3_name)}</strong>
            <span>${escapeHtml(document.level1_name)} / ${escapeHtml(document.level2_name)}</span>
            <em>${escapeHtml(document.original_name)}</em>
            <div class="reject-note-text">
              <b>Reject note:</b>
              ${escapeHtml(document.review_notes || 'No reject note provided by admin.')}
            </div>
          </li>
        `).join('')}
      </ul>
    </section>
  `;
}

function renderTimeline(entry) {
  const items = entry.levels.map((level) => {
    const status = level.entryStatus?.status || (entry.current_level1_id === level.id ? entry.status : 'not_started');
    const label = statusLabel(status);
    return `<span class="status ${status}">Stage ${level.position}. ${escapeHtml(level.name)}: ${label}</span>`;
  }).join(' ');
  return `<div class="stack">${items}</div>`;
}

function renderStageProgress(entry) {
  return renderStageStepper(entry, entry.levels || state.workflow);
}

function renderEntryStageProgress(entry) {
  return renderStageStepper(entry, state.workflow, true);
}

function renderStageStepper(entry, levels, compact = false) {
  if (!levels?.length) return '';
  const current = levels.find((level) => level.id === entry.current_level1_id);
  const currentPosition = entry.status === 'complete' ? levels.length + 1 : (current?.position || 1);
  const completedPosition = entry.status === 'complete' ? levels.length : Math.max(0, currentPosition - 1);
  const activeLevel = current || levels.at(-1);
  const segments = Math.max(1, levels.length - 1);
  const linePercent = levels.length === 1 ? 100 : Math.max(0, Math.min(100, ((currentPosition - 1) / segments) * 100));
  const lineInset = 50 / levels.length;

  return `
    <section class="stage-stepper ${compact ? 'compact-stepper' : ''}" aria-label="Stage progress">
      <div class="stage-stepper-steps">
        <div class="stage-stepper-line" style="left: ${lineInset}%; right: ${lineInset}%">
          <div style="width: ${linePercent}%"></div>
        </div>
        ${levels.map((level) => {
          const isComplete = level.position <= completedPosition;
          const isCurrent = entry.status !== 'complete' && level.id === activeLevel?.id;
          const stateClass = isComplete ? 'is-complete' : (isCurrent ? 'is-current' : 'is-future');
          return `
            <div class="stage-step ${stateClass}">
              <div class="stage-node">${isComplete ? '✓' : level.position}</div>
              <div class="stage-pill">Stage ${level.position}</div>
            </div>
          `;
        }).join('')}
      </div>
      <div class="stage-stepper-caption">
        ${entry.status === 'complete'
          ? 'All stages complete'
          : `Current: Stage ${activeLevel?.position || 1}${activeLevel?.name ? ` - ${escapeHtml(activeLevel.name)}` : ''}`}
      </div>
    </section>
  `;
}

function renderAdminEntries() {
  if (state.user?.role !== 'admin') return;
  const groups = dashboardUserGroups();
  if (groups.length === 0) {
    els.adminEntries.innerHTML = '<div class="empty">No accounts yet.</div>';
    return;
  }

  ensureSelectedDashboardUser(groups);
  const selectedGroup = groups.find((group) => group.key === state.selectedDashboardUserKey) || groups[0];

  els.adminEntries.innerHTML = `
    <section class="dashboard-user-filter">
      <label>
        Requester account
        <select data-dashboard-user-select>
          ${groups.map((group) => `
            <option value="${escapeAttr(group.key)}" ${group.key === selectedGroup.key ? 'selected' : ''}>
              ${escapeHtml(group.name)} - ${escapeHtml(group.email)} (${group.entries.length} entr${group.entries.length === 1 ? 'y' : 'ies'})
            </option>
          `).join('')}
        </select>
      </label>
      <label>
        Entry view
        <select data-admin-archive-filter>
          <option value="active" ${state.adminArchiveFilter === 'active' ? 'selected' : ''}>Active entries</option>
          <option value="archived" ${state.adminArchiveFilter === 'archived' ? 'selected' : ''}>Archived entries</option>
          <option value="all" ${state.adminArchiveFilter === 'all' ? 'selected' : ''}>All entries</option>
        </select>
      </label>
      <div class="dashboard-user-filter-meta">
        <span class="status ${selectedGroup.role === 'admin' ? 'pending' : 'in_progress'}">${escapeHtml(selectedGroup.roleLabel)}</span>
        <span>${selectedGroup.entries.length} entr${selectedGroup.entries.length === 1 ? 'y' : 'ies'}</span>
      </div>
    </section>
    <div class="dashboard-user-entries">
      ${selectedGroup.entries.length ? selectedGroup.entries.map(renderAdminEntryCard).join('') : '<div class="empty">No procurement entries for this account yet.</div>'}
    </div>
  `;

  els.adminEntries.querySelector('[data-dashboard-user-select]').addEventListener('change', (event) => {
    state.selectedDashboardUserKey = event.target.value;
    state.visibleEntryDocs = new Set();
    state.expandedAdminStageDocs = new Set();
    renderAdminEntries();
  });

  els.adminEntries.querySelector('[data-admin-archive-filter]').addEventListener('change', async (event) => {
    state.adminArchiveFilter = event.target.value;
    state.visibleEntryDocs = new Set();
    state.expandedAdminStageDocs = new Set();
    state.selectedDashboardUserKey = null;
    await refreshEntries();
  });

  els.adminEntries.querySelectorAll('[data-entry-view]').forEach((button) => {
    button.addEventListener('click', () => toggleEntryDocuments(Number(button.dataset.entryView)));
  });
  els.adminEntries.querySelectorAll('[data-entry-archive]').forEach((button) => {
    button.addEventListener('click', () => archiveEntry(Number(button.dataset.entryArchive)));
  });
  els.adminEntries.querySelectorAll('[data-entry-unarchive]').forEach((button) => {
    button.addEventListener('click', () => unarchiveEntry(Number(button.dataset.entryUnarchive)));
  });
  els.adminEntries.querySelectorAll('[data-entry-delete]').forEach((button) => {
    button.addEventListener('click', () => openDeleteEntryModal(Number(button.dataset.entryDelete)));
  });

  state.visibleEntryDocs.forEach((entryId) => renderEntryDocuments(entryId));
}

function renderAdminEntryCard(entry) {
  return `
    <article class="entry-card ${entry.isArchived ? 'is-archived' : ''}">
      <header>
        <div>
          <h3>#${entry.id} ${escapeHtml(entry.title)}</h3>
          <div class="meta">
            ${escapeHtml(entry.requester)}
            ${entry.isArchived ? ` / Archived${entry.archivedBy ? ` by ${escapeHtml(entry.archivedBy)}` : ''}${entry.archivedAt ? ` at ${new Date(entry.archivedAt).toLocaleString()}` : ''}` : ''}
          </div>
        </div>
        <div class="entry-status-stack">
          <span class="status ${entry.status}">${escapeHtml(entry.statusLabel)}</span>
          ${entry.isArchived ? '<span class="status archived">Archived</span>' : ''}
        </div>
      </header>
      ${renderEntryStageProgress(entry)}
      <div class="document-slot" data-entry-docs="${entry.id}"></div>
      <div class="entry-actions">
        ${renderDownloadZipButton(entry, true)}
        <button class="ghost compact" data-entry-view="${entry.id}">
          ${state.visibleEntryDocs.has(entry.id) ? 'Hide docs' : 'Show docs'}
        </button>
        ${entry.isArchived
          ? `<button class="ghost compact" data-entry-unarchive="${entry.id}">Unarchive</button>`
          : `<button class="ghost compact" data-entry-archive="${entry.id}">Archive</button>`}
        <button class="danger compact" data-entry-delete="${entry.id}">Delete permanently</button>
      </div>
    </article>
  `;
}

function dashboardUserGroups() {
  const userGroups = state.users.map((account) => ({
    key: `user-${account.id}`,
    userId: account.id,
    name: account.name,
    email: account.email,
    role: account.role,
    roleLabel: account.role === 'admin' ? 'Admin' : 'Requester',
    entries: []
  }));
  const byUserId = new Map(userGroups.map((group) => [group.userId, group]));
  const unknownGroups = new Map();

  for (const entry of state.entries) {
    const group = byUserId.get(entry.requester_user_id);
    if (group) {
      group.entries.push(entry);
      continue;
    }
    const key = `legacy-${entry.requester || 'Unknown requester'}`;
    if (!unknownGroups.has(key)) {
      unknownGroups.set(key, {
        key,
        userId: null,
        name: entry.requester || 'Unknown requester',
        email: 'No linked account',
        role: 'requester',
        roleLabel: 'Unlinked',
        entries: []
      });
    }
    unknownGroups.get(key).entries.push(entry);
  }

  return [...userGroups, ...unknownGroups.values()].sort((a, b) => {
    if (b.entries.length !== a.entries.length) return b.entries.length - a.entries.length;
    return a.name.localeCompare(b.name);
  });
}

function ensureSelectedDashboardUser(groups) {
  if (groups.some((group) => group.key === state.selectedDashboardUserKey)) return;
  state.selectedDashboardUserKey = (groups.find((group) => group.entries.length > 0) || groups[0])?.key || null;
}

async function archiveEntry(entryId) {
  await api(`/api/admin/entries/${entryId}/archive`, { method: 'POST', body: {} });
  state.visibleEntryDocs.delete(entryId);
  [...state.expandedAdminStageDocs]
    .filter((key) => key.startsWith(`${entryId}:`))
    .forEach((key) => state.expandedAdminStageDocs.delete(key));
  await refreshEntries();
  toast('Entry archived');
}

async function unarchiveEntry(entryId) {
  await api(`/api/admin/entries/${entryId}/archive`, { method: 'DELETE', body: {} });
  await refreshEntries();
  toast('Entry restored');
}

function openDeleteEntryModal(entryId) {
  const entry = state.entries.find((item) => item.id === entryId);
  state.pendingDeleteEntryId = entryId;
  els.confirmModalText.textContent = `This will permanently delete entry #${entryId}${entry ? ` ${entry.title}` : ''}, including approval records and uploaded document files.`;
  els.confirmModalInput.value = '';
  els.confirmModalConfirm.disabled = true;
  els.confirmModal.hidden = false;
  els.confirmModalInput.focus();
}

function closeDeleteEntryModal() {
  state.pendingDeleteEntryId = null;
  els.confirmModal.hidden = true;
}

async function confirmDeleteEntry() {
  if (!state.pendingDeleteEntryId) return;
  const entryId = state.pendingDeleteEntryId;
  await api(`/api/admin/entries/${entryId}`, {
    method: 'DELETE',
    body: { confirm: els.confirmModalInput.value.trim() }
  });
  closeDeleteEntryModal();
  state.visibleEntryDocs.delete(entryId);
  [...state.expandedAdminStageDocs]
    .filter((key) => key.startsWith(`${entryId}:`))
    .forEach((key) => state.expandedAdminStageDocs.delete(key));
  await refreshEntries();
  toast('Entry permanently deleted');
}

function renderAdminUsers() {
  if (!els.adminUsers) return;
  if (state.users.length === 0) {
    els.adminUsers.innerHTML = '<div class="empty">No accounts yet.</div>';
    return;
  }

  els.adminUsers.innerHTML = state.users.map((account) => {
    const isSelf = state.user?.id === account.id;
    const isExpanded = state.expandedUserIds.has(account.id);
    return `
      <article class="user-card ${isExpanded ? 'is-expanded' : ''}" data-user-id="${account.id}">
        <header>
          <div>
            <h3>${escapeHtml(account.name)}</h3>
            <div class="meta">${escapeHtml(account.email)}</div>
          </div>
          <div class="user-card-head-actions">
            <span class="status ${account.isActive ? 'complete' : 'rejected'}">${account.isActive ? 'Active' : 'Disabled'}</span>
            <button class="ghost compact" data-user-expand="${account.id}">${isExpanded ? 'Hide details' : 'Edit details'}</button>
          </div>
        </header>
        <div class="meta">${account.role === 'admin' ? 'Procurement Admin' : 'Requester'} / ${account.entryCount} entries${account.emailNotifications ? ' / Email on' : ' / Email off'}${account.lastLoginAt ? ` / Last login ${new Date(account.lastLoginAt).toLocaleString()}` : ''}${isSelf ? ' / Current account' : ''}</div>
        ${isExpanded ? `
          <div class="user-details">
            <div class="user-fields">
              <label>
                Name
                <input data-user-field="name" value="${escapeAttr(account.name)}">
              </label>
              <label>
                Email
                <input data-user-field="email" type="email" value="${escapeAttr(account.email)}">
              </label>
              <label>
                Notification email
                <input data-user-field="notificationEmail" type="email" value="${escapeAttr(account.notificationEmail || account.email)}">
              </label>
              <label>
                Role
                <select data-user-field="role" ${isSelf ? 'disabled' : ''}>
                  <option value="requester" ${account.role === 'requester' ? 'selected' : ''}>Requester</option>
                  <option value="admin" ${account.role === 'admin' ? 'selected' : ''}>Procurement Admin</option>
                </select>
              </label>
              <label>
                New password
                <input data-user-field="password" type="password" placeholder="Leave blank to keep">
              </label>
            </div>
            <div class="user-actions">
              <label class="inline-check">
                <input data-user-field="isActive" type="checkbox" ${account.isActive ? 'checked' : ''} ${isSelf ? 'disabled' : ''}>
                Active account
              </label>
              <label class="inline-check">
                <input data-user-field="emailNotifications" type="checkbox" ${account.emailNotifications ? 'checked' : ''}>
                Email notifications
              </label>
              <button class="compact" data-user-save="${account.id}">Save</button>
              <button class="ghost compact" data-user-role="${account.id}" data-role="${account.role === 'admin' ? 'requester' : 'admin'}" ${isSelf ? 'disabled' : ''}>
                ${account.role === 'admin' ? 'Make requester' : 'Make admin'}
              </button>
              <button class="danger compact" data-user-toggle="${account.id}" ${isSelf ? 'disabled' : ''}>
                ${account.isActive ? 'Disable' : 'Enable'}
              </button>
            </div>
          </div>
        ` : ''}
      </article>
    `;
  }).join('');

  els.adminUsers.querySelectorAll('[data-user-expand]').forEach((button) => {
    button.addEventListener('click', () => toggleUserDetails(Number(button.dataset.userExpand)));
  });
  els.adminUsers.querySelectorAll('[data-user-save]').forEach((button) => {
    button.addEventListener('click', () => saveUserFromCard(Number(button.dataset.userSave)));
  });
  els.adminUsers.querySelectorAll('[data-user-role]').forEach((button) => {
    button.addEventListener('click', () => updateUser(Number(button.dataset.userRole), { role: button.dataset.role }));
  });
  els.adminUsers.querySelectorAll('[data-user-toggle]').forEach((button) => {
    const account = state.users.find((item) => item.id === Number(button.dataset.userToggle));
    button.addEventListener('click', () => updateUser(account.id, { isActive: !account.isActive }));
  });
}

function toggleUserDetails(userId) {
  if (state.expandedUserIds.has(userId)) {
    state.expandedUserIds.delete(userId);
  } else {
    state.expandedUserIds.add(userId);
  }
  renderAdminUsers();
}

async function saveUserFromCard(userId) {
  const card = els.adminUsers.querySelector(`[data-user-id="${userId}"]`);
  if (!card) return;
  const field = (name) => card.querySelector(`[data-user-field="${name}"]`);
  const body = {
    name: field('name').value,
    email: field('email').value,
    notificationEmail: field('notificationEmail').value,
    role: field('role').value,
    isActive: field('isActive').checked,
    emailNotifications: field('emailNotifications').checked
  };
  const password = field('password').value;
  if (password) body.password = password;
  await updateUser(userId, body);
}

async function updateUser(userId, body) {
  await api(`/api/admin/users/${userId}`, {
    method: 'PUT',
    body
  });
  await refreshUsers();
  toast('Account updated');
}

async function toggleEntryDocuments(entryId) {
  if (state.visibleEntryDocs.has(entryId)) {
    state.visibleEntryDocs.delete(entryId);
    [...state.expandedAdminStageDocs]
      .filter((key) => key.startsWith(`${entryId}:`))
      .forEach((key) => state.expandedAdminStageDocs.delete(key));
    renderAdminEntries();
    return;
  }
  state.visibleEntryDocs.add(entryId);
  renderAdminEntries();
}

async function renderEntryDocuments(entryId) {
  const { entry } = await api(`/api/entries/${entryId}`);
  const slot = els.adminEntries.querySelector(`[data-entry-docs="${entryId}"]`);
  if (!slot) return;
  if (entry.documents.length === 0) {
    slot.innerHTML = '<div class="empty">No documents uploaded.</div>';
    return;
  }

  slot.innerHTML = `
    <div class="admin-doc-review" data-entry-review="${entryId}">
      ${renderAdminDocumentsByLevel(entry)}
      <div class="entry-actions">
        <button class="compact" data-save-doc-reviews="${entryId}">Save document approvals</button>
      </div>
    </div>
  `;

  slot.querySelectorAll('.icon-choice').forEach((button) => {
    button.addEventListener('click', () => {
      const controls = button.closest('.doc-review-controls');
      controls.querySelectorAll('.icon-choice').forEach((item) => item.classList.remove('is-selected'));
      button.classList.add('is-selected');
      if (button.dataset.reviewStatus === 'approved') {
        controls.querySelector('[data-review-notes]').value = '';
      }
    });
  });
  slot.querySelectorAll('[data-admin-stage-toggle]').forEach((button) => {
    button.addEventListener('click', () => toggleAdminStageDocs(entryId, Number(button.dataset.adminStageToggle)));
  });
  slot.querySelector(`[data-save-doc-reviews="${entryId}"]`).addEventListener('click', () => saveDocumentReviews(entryId));
}

function toggleAdminStageDocs(entryId, stageId) {
  const key = `${entryId}:${stageId}`;
  if (state.expandedAdminStageDocs.has(key)) {
    state.expandedAdminStageDocs.delete(key);
  } else {
    state.expandedAdminStageDocs.add(key);
  }
  renderEntryDocuments(entryId);
}

function renderAdminDocumentsByLevel(entry) {
  const grouped = [];
  for (const document of entry.documents) {
    let level = grouped.find((item) => item.id === document.level1_id);
    if (!level) {
      level = { id: document.level1_id, name: document.level1_name, position: document.level1_position, documents: [] };
      grouped.push(level);
    }
    level.documents.push(document);
  }

  return grouped.map((level) => {
    const key = `${entry.id}:${level.id}`;
    const isCurrent = level.id === entry.current_level1_id;
    const isExpanded = isCurrent || state.expandedAdminStageDocs.has(key);
    const pendingCount = level.documents.filter((document) => document.review_status === 'pending').length;
    const rejectedCount = level.documents.filter((document) => document.review_status === 'rejected').length;
    const approvedCount = level.documents.filter((document) => document.review_status === 'approved').length;
    return `
    <section class="admin-level-docs ${isExpanded ? 'is-expanded' : 'is-collapsed'}">
      <div class="admin-level-docs-head">
        <div>
          <span>${isCurrent ? 'Current Stage' : `Stage ${level.position}`}</span>
          <strong>${escapeHtml(level.name)}</strong>
          <div class="meta">${approvedCount} approved / ${pendingCount} pending / ${rejectedCount} rejected</div>
        </div>
        ${isCurrent ? '<span class="status in_progress">Current</span>' : `<button class="ghost compact" data-admin-stage-toggle="${level.id}">${isExpanded ? 'Collapse' : 'Expand'}</button>`}
      </div>
      ${isExpanded ? `
      <div class="document-list">
        ${level.documents.map((document) => `
          <article class="admin-doc-item" data-document-id="${document.id}">
            <div>
              <a href="/api/documents/${document.id}/download">${escapeHtml(document.original_name)}</a>
              <div class="meta">Activity: ${escapeHtml(document.level2_name)} / Document: ${escapeHtml(document.level3_name)}</div>
              ${document.review_notes ? `<div class="doc-review-note">${escapeHtml(document.review_notes)}</div>` : ''}
            </div>
            <div class="doc-review-controls" role="group" aria-label="Review ${escapeAttr(document.level3_name)}">
              <button class="icon-choice ${document.review_status === 'approved' ? 'is-selected' : ''}" data-review-status="approved" type="button" title="Approve">✓</button>
              <button class="icon-choice danger-choice ${document.review_status === 'rejected' ? 'is-selected' : ''}" data-review-status="rejected" type="button" title="Reject">×</button>
              <input data-review-notes type="text" value="${escapeAttr(document.review_notes || '')}" placeholder="Reject note">
            </div>
          </article>
        `).join('')}
      </div>
      ` : ''}
    </section>
  `;
  }).join('');
}

async function saveDocumentReviews(entryId) {
  const reviewRoot = els.adminEntries.querySelector(`[data-entry-review="${entryId}"]`);
  if (!reviewRoot) return;
  const decisions = [];
  for (const item of [...reviewRoot.querySelectorAll('[data-document-id]')]) {
    const selected = item.querySelector('.icon-choice.is-selected');
    const status = selected?.dataset.reviewStatus || 'pending';
    const notesInput = item.querySelector('[data-review-notes]');
    const notes = status === 'approved' ? '' : notesInput.value.trim();
    if (status === 'rejected' && !notes) {
      notesInput.focus();
      toast('Reject note is required for rejected documents');
      return;
    }
    decisions.push({
      documentId: Number(item.dataset.documentId),
      status,
      notes
    });
  }

  await api(`/api/admin/entries/${entryId}/document-reviews`, {
    method: 'POST',
    body: { decisions }
  });
  await refreshEntries();
  if (state.selectedEntryId === entryId) await renderSelectedEntry();
  toast('Document approvals saved');
}

function renderWorkflowBuilder() {
  if (state.workflow.length === 0) {
    els.workflowBuilder.innerHTML = '<div class="empty">No stages.</div>';
    return;
  }

  const selectedLevel1 = state.workflow.find((level1) => level1.id === state.builderLevel1Id) || state.workflow[0];
  state.builderLevel1Id = selectedLevel1.id;

  els.workflowBuilder.innerHTML = `
    <div class="builder-shell">
      <aside class="builder-nav" aria-label="Stage navigation">
        <div class="builder-nav-title">Stages</div>
        <div class="builder-nav-list">
          ${state.workflow.map((level1) => {
            const level3Count = level1.level2s.reduce((sum, level2) => sum + level2.level3s.length, 0);
            return `
              <button class="builder-nav-item ${level1.id === selectedLevel1.id ? 'is-active' : ''}" data-level1-select="${level1.id}">
                <span>${level1.position}. ${escapeHtml(level1.name)}</span>
                <small>${level1.level2s.length} activities / ${level3Count} documents</small>
              </button>
            `;
          }).join('')}
        </div>
      </aside>
      <div class="builder-detail">
        ${renderSelectedLevel1(selectedLevel1)}
      </div>
    </div>
  `;

  wireBuilderButtons();
  wireBuilderDraftInputs();
}

function renderSelectedLevel1(level1) {
  const name = draftValue('level1', level1.id, 'name', level1.name);
  return `
    <section class="builder-level level-1" data-level1="${level1.id}">
      ${renderBuilderTitle('Stage', level1.position, name, [
        moveButton('level1', level1.id, 'up'),
        moveButton('level1', level1.id, 'down'),
        actionButton('add-level2', level1.id, 'Add Activity'),
        collapseAllButton(level1, false),
        collapseAllButton(level1, true),
        actionButton('delete-level1', level1.id, 'Delete', 'danger')
      ])}
      ${renderLevelFields('level1', level1.id, level1.name, level1.description)}
      <div class="builder-groups">
        ${level1.level2s.length ? level1.level2s.map(renderLevel2Group).join('') : '<div class="empty">No activities in this stage.</div>'}
      </div>
    </section>
  `;
}

function renderLevel2Group(level2) {
  const collapsed = state.collapsedLevel2Ids.has(level2.id);
  const name = draftValue('level2', level2.id, 'name', level2.name);
  return `
    <section class="builder-level level-2 ${collapsed ? 'is-collapsed' : ''}" data-level2="${level2.id}">
      ${renderBuilderTitle('Activity', level2.position, name, [
        collapseButton(level2.id, collapsed),
        moveButton('level2', level2.id, 'up'),
        moveButton('level2', level2.id, 'down'),
        actionButton('add-level3', level2.id, 'Add Document'),
        actionButton('delete-level2', level2.id, 'Delete', 'danger')
      ])}
      ${collapsed ? `<div class="collapsed-summary">${level2.level3s.length} document${level2.level3s.length === 1 ? '' : 's'}</div>` : `
        ${renderLevelFields('level2', level2.id, level2.name, level2.description)}
        <div class="builder-documents">
          ${level2.level3s.length ? level2.level3s.map((level3) => `
            <section class="builder-level level-3" data-level3="${level3.id}">
              ${renderBuilderTitle('Document', level3.position, draftValue('level3', level3.id, 'name', level3.name), [
                moveButton('level3', level3.id, 'up'),
                moveButton('level3', level3.id, 'down'),
                actionButton('delete-level3', level3.id, 'Delete', 'danger')
              ])}
              ${renderLevelFields('level3', level3.id, level3.name, level3.instructions)}
            </section>
          `).join('') : '<div class="empty">No documents in this activity.</div>'}
        </div>
      `}
    </section>
  `;
}

function renderBuilderTitle(type, position, name, buttons) {
  return `
    <div class="builder-title">
      <div>
        <h3>${type} ${position}</h3>
        <div class="meta">${escapeHtml(name)}</div>
      </div>
      <div class="row-actions">${buttons.join('')}</div>
    </div>
  `;
}

function renderLevelFields(type, id, name, detail) {
  const detailLabel = type === 'level3' ? 'Instructions' : 'Description';
  return `
    <div class="builder-fields">
      <label>
        Name
        <input data-edit="${type}" data-id="${id}" data-field="name" value="${escapeAttr(draftValue(type, id, 'name', name))}">
      </label>
      <label>
        ${detailLabel}
        <input data-edit="${type}" data-id="${id}" data-field="detail" value="${escapeAttr(draftValue(type, id, 'detail', detail || ''))}">
      </label>
      <div class="save-hint">Changes are saved only when you press Save Changes at the top.</div>
    </div>
  `;
}

function moveButton(type, id, direction) {
  return `<button class="ghost compact" data-move-type="${type}" data-move-id="${id}" data-direction="${direction}">${direction === 'up' ? 'Up' : 'Down'}</button>`;
}

function collapseButton(id, collapsed) {
  return `<button class="ghost compact" data-collapse-level2="${id}">${collapsed ? 'Show' : 'Hide'}</button>`;
}

function collapseAllButton(level1, collapse) {
  const action = collapse ? 'collapse-all' : 'expand-all';
  return `<button class="ghost compact" data-action="${action}" data-id="${level1.id}">${collapse ? 'Hide all' : 'Show all'}</button>`;
}

function actionButton(action, id, label, variant = 'ghost') {
  return `<button class="${variant} compact" data-action="${action}" data-id="${id}">${label}</button>`;
}

function wireBuilderButtons() {
  els.workflowBuilder.querySelectorAll('[data-level1-select]').forEach((button) => {
    button.addEventListener('click', () => {
      captureVisibleDrafts();
      state.builderLevel1Id = Number(button.dataset.level1Select);
      renderWorkflowBuilder();
    });
  });

  els.workflowBuilder.querySelectorAll('[data-collapse-level2]').forEach((button) => {
    button.addEventListener('click', () => {
      captureVisibleDrafts();
      const id = Number(button.dataset.collapseLevel2);
      if (state.collapsedLevel2Ids.has(id)) {
        state.collapsedLevel2Ids.delete(id);
      } else {
        state.collapsedLevel2Ids.add(id);
      }
      renderWorkflowBuilder();
    });
  });

  els.workflowBuilder.querySelectorAll('[data-move-type]').forEach((button) => {
    button.addEventListener('click', async () => {
      captureVisibleDrafts();
      await api(`/api/admin/workflow/${button.dataset.moveType}/${button.dataset.moveId}/move`, {
        method: 'POST',
        body: { direction: button.dataset.direction }
      });
      if (button.dataset.moveType === 'level1') {
        state.builderLevel1Id = Number(button.dataset.moveId);
      }
      await refreshWorkflow();
    });
  });

  els.workflowBuilder.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', async () => {
      captureVisibleDrafts();
      const action = button.dataset.action;
      const id = Number(button.dataset.id);
      if (action === 'add-level2') {
        state.builderLevel1Id = id;
        await api('/api/admin/workflow/level2', { method: 'POST', body: { level1Id: id, name: 'New Activity', description: '' } });
      }
      if (action === 'add-level3') {
        state.collapsedLevel2Ids.delete(id);
        await api('/api/admin/workflow/level3', { method: 'POST', body: { level2Id: id, name: 'Required Document', instructions: '' } });
      }
      if (action === 'expand-all' || action === 'collapse-all') {
        const level1 = state.workflow.find((item) => item.id === id);
        level1?.level2s.forEach((level2) => {
          if (action === 'collapse-all') state.collapsedLevel2Ids.add(level2.id);
          else state.collapsedLevel2Ids.delete(level2.id);
        });
        renderWorkflowBuilder();
        return;
      }
      if (action.startsWith('delete-')) {
        const type = action.replace('delete-', '');
        await api(`/api/admin/workflow/${type}/${id}`, { method: 'DELETE' });
        clearDraftsForItem(type, id);
        if (type === 'level2') state.collapsedLevel2Ids.delete(id);
        if (type === 'level1' && state.builderLevel1Id === id) state.builderLevel1Id = null;
      }
      await refreshWorkflow();
    });
  });
}

function wireBuilderDraftInputs() {
  els.workflowBuilder.querySelectorAll('[data-edit]').forEach((field) => {
    field.addEventListener('input', () => {
      state.workflowDrafts.set(draftKey(field.dataset.edit, Number(field.dataset.id), field.dataset.field), field.value);
    });
  });
}

async function saveVisibleWorkflow() {
  captureVisibleDrafts();
  const editableItems = new Map();
  els.workflowBuilder.querySelectorAll('[data-edit]').forEach((field) => {
    editableItems.set(`${field.dataset.edit}:${field.dataset.id}`, {
      type: field.dataset.edit,
      id: Number(field.dataset.id)
    });
  });

  if (editableItems.size === 0) {
    toast('Nothing to save');
    return;
  }

  state.isSavingWorkflow = true;
  try {
    for (const item of editableItems.values()) {
      await saveBuilderItem(item.type, item.id, false);
      clearDraftsForItem(item.type, item.id);
    }
    await refreshWorkflow();
  } finally {
    state.isSavingWorkflow = false;
  }
  toast('Workflow saved');
}

function captureVisibleDrafts() {
  els.workflowBuilder.querySelectorAll?.('[data-edit]').forEach((field) => {
    state.workflowDrafts.set(draftKey(field.dataset.edit, Number(field.dataset.id), field.dataset.field), field.value);
  });
}

function draftValue(type, id, field, fallback) {
  const key = draftKey(type, id, field);
  return state.workflowDrafts.has(key) ? state.workflowDrafts.get(key) : fallback;
}

function draftKey(type, id, field) {
  return `${type}:${id}:${field}`;
}

function clearDraftsForItem(type, id) {
  state.workflowDrafts.delete(draftKey(type, id, 'name'));
  state.workflowDrafts.delete(draftKey(type, id, 'detail'));
}

async function saveBuilderItem(type, id, refresh = true) {
  const fields = [...els.workflowBuilder.querySelectorAll(`[data-edit="${type}"][data-id="${id}"]`)];
  const name = fields.find((field) => field.dataset.field === 'name')?.value || '';
  const detail = fields.find((field) => field.dataset.field === 'detail')?.value || '';
  const body = type === 'level3' ? { name, instructions: detail } : { name, description: detail };
  await api(`/api/admin/workflow/${type}/${id}`, { method: 'PUT', body });
  if (refresh) {
    await refreshWorkflow();
    toast('Workflow saved');
  }
}

function switchTab(tabName) {
  els.tabs.forEach((tab) => tab.classList.toggle('is-active', tab.dataset.tab === tabName));
  els.views.forEach((view) => view.classList.toggle('is-active', view.id === tabName));
}

async function api(url, options = {}) {
  const response = await fetchChecked(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  return response.json();
}

async function fetchChecked(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    let message = 'Request failed';
    try {
      const payload = await response.json();
      message = payload.error || payload.details || message;
    } catch {
      message = await response.text();
    }
    if (response.status === 401) {
      state.user = null;
      showLogin();
    }
    toast(message);
    throw new Error(message);
  }
  return response;
}

function setStatus(element, label, status) {
  element.className = `status ${status || ''}`;
  element.textContent = label;
}

function setSubmitFeedback(element, message) {
  if (!element) return;
  element.textContent = message;
  element.hidden = !message;
}

function setSubmitProgress(element, percent, visible) {
  if (!element) return;
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  element.hidden = !visible;
  element.querySelector('[data-submit-progress-label]').textContent = `${clamped}%`;
  element.querySelector('[data-submit-progress-bar]').style.width = `${clamped}%`;
}

function missingRequiredDocuments() {
  return [...els.submissionForm.querySelectorAll('input[type="file"][required]:not(:disabled)')]
    .filter((input) => input.files.length === 0)
    .map((input) => input.closest('.doc-row')?.querySelector('.doc-name strong')?.textContent?.trim() || 'required document');
}

function uploadFormWithProgress(url, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', url);

    request.upload.addEventListener('loadstart', () => onProgress(0));
    request.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable) return;
      onProgress((event.loaded / event.total) * 100);
    });

    request.addEventListener('load', () => {
      if (request.status >= 200 && request.status < 300) {
        resolve();
        return;
      }
      let message = 'Submit failed';
      try {
        const payload = JSON.parse(request.responseText);
        message = payload.error || payload.details || message;
      } catch {
        message = request.responseText || message;
      }
      reject(new Error(message));
    });

    request.addEventListener('error', () => reject(new Error('Network error while uploading documents')));
    request.addEventListener('abort', () => reject(new Error('Upload canceled')));
    request.send(formData);
  });
}

function statusLabel(status) {
  const labels = {
    in_progress: 'In progress',
    awaiting_approval: 'Waiting approval',
    rejected: 'Rejected',
    complete: 'Complete',
    pending: 'Pending',
    approved: 'Approved',
    not_started: 'Not started'
  };
  return labels[status] || status;
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add('is-visible');
  window.clearTimeout(toast.timeout);
  toast.timeout = window.setTimeout(() => els.toast.classList.remove('is-visible'), 2600);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll('`', '&#096;');
}
