export function createAgendaController(deps) {
    const {
        getContext,
        createEmptyMeta,
        normalizeAgendaType,
        t,
        escapeHtml,
        showToast,
        closeEditModal,
        preventModalBubble,
        commitAgendaMeta,
        refreshAgendaDisplays,
    } = deps;

    let agendaMultiSelectMode = false;
    let selectedAgendaIndices = new Set();
    let agendaLongPressTimer = null;

    const PLAN_TYPE = '计划';
    const MYSTERY_TYPE = '悬念';

    function normalizeAgendaTypeSafe(rawType) {
        if (typeof normalizeAgendaType === 'function') {
            return normalizeAgendaType(rawType);
        }

        const token = String(rawType || '').trim();
        if (!token) return PLAN_TYPE;
        if (token === MYSTERY_TYPE || token === '懸念') return MYSTERY_TYPE;

        const lower = token.toLowerCase();
        if (['hook', 'hooks', 'mystery', 'mysteries', 'suspense'].includes(lower)) {
            return MYSTERY_TYPE;
        }

        return PLAN_TYPE;
    }

    function getAgendaTypeMeta(rawType) {
        const type = normalizeAgendaTypeSafe(rawType);
        if (type === MYSTERY_TYPE) {
            return {
                type,
                className: 'mystery',
                label: t('timeline.mystery'),
                icon: 'fa-solid fa-circle-question',
                groupIcon: 'fa-solid fa-eye',
            };
        }

        return {
            type: PLAN_TYPE,
            className: 'plan',
            label: t('timeline.plan'),
            icon: 'fa-solid fa-calendar-check',
            groupIcon: 'fa-solid fa-list-check',
        };
    }

    function getAgendaTypeOptionsHtml(selectedType = PLAN_TYPE) {
        const normalizedType = normalizeAgendaTypeSafe(selectedType);
        return `
            <option value="${PLAN_TYPE}" ${normalizedType === PLAN_TYPE ? 'selected' : ''}>${t('timeline.plan')}</option>
            <option value="${MYSTERY_TYPE}" ${normalizedType === MYSTERY_TYPE ? 'selected' : ''}>${t('timeline.mystery')}</option>
        `;
    }

    function getUserAgenda() {
        const context = getContext();
        if (!context?.chat?.length) return [];

        const firstMessage = context.chat[0];
        if (firstMessage?.horae_meta?.agenda) {
            return firstMessage.horae_meta.agenda;
        }
        return [];
    }

    function ensureAgendaMeta(messageId) {
        const context = getContext();
        if (!context?.chat?.[messageId]) return null;

        if (!context.chat[messageId].horae_meta) {
            context.chat[messageId].horae_meta = createEmptyMeta();
        }
        return context.chat[messageId].horae_meta;
    }

    function commitAgendaMessageMeta(messageId, meta) {
        if (!Number.isInteger(messageId) || messageId < 0 || !meta) return;

        if (typeof commitAgendaMeta === 'function') {
            commitAgendaMeta(messageId, meta);
            return;
        }

        const context = getContext();
        if (!context?.chat?.[messageId]) return;
        context.chat[messageId].horae_meta = meta;
    }

    function commitChangedAgendaMessages(messageIds) {
        const context = getContext();
        if (!context?.chat) return [];

        const uniqueIds = [...new Set((messageIds || []).filter((id) => Number.isInteger(id) && id >= 0))];
        for (const messageId of uniqueIds) {
            const meta = context.chat[messageId]?.horae_meta;
            if (meta) commitAgendaMessageMeta(messageId, meta);
        }
        return uniqueIds;
    }

    function refreshAgendaUi() {
        if (typeof refreshAgendaDisplays === 'function') {
            refreshAgendaDisplays();
            return;
        }
        updateAgendaDisplay();
    }

    function setUserAgenda(agenda, options = {}) {
        const context = getContext();
        if (!context?.chat?.length) return null;
        const { save = true } = options;

        const meta = ensureAgendaMeta(0);
        if (!meta) return null;

        meta.agenda = agenda;
        commitAgendaMessageMeta(0, meta);

        if (save) {
            getContext().saveChat();
        }
        return meta;
    }

    function normalizeAgendaText(text) {
        return String(text || '').trim();
    }

    function isExactAgendaTextMatch(leftText, rightText) {
        const left = normalizeAgendaText(leftText);
        const right = normalizeAgendaText(rightText);
        if (!left || !right) return false;
        return left === right;
    }

    function isAgendaTextMatch(leftText, rightText) {
        const left = normalizeAgendaText(leftText);
        const right = normalizeAgendaText(rightText);
        if (!left || !right) return false;
        return left === right || left.includes(right) || right.includes(left);
    }

    function removeAgendaItemsByExactText(agenda, targetText) {
        if (!Array.isArray(agenda)) return false;

        let changed = false;
        for (let i = agenda.length - 1; i >= 0; i--) {
            if (!isExactAgendaTextMatch(agenda[i]?.text, targetText)) continue;
            agenda.splice(i, 1);
            changed = true;
        }
        return changed;
    }

    function updateAgendaItemsByExactText(agenda, targetText, nextItem) {
        if (!Array.isArray(agenda)) return false;

        let changed = false;
        for (const item of agenda) {
            if (!isExactAgendaTextMatch(item?.text, targetText)) continue;
            item.type = nextItem.type;
            item.text = nextItem.text;
            item.date = nextItem.date;
            item.done = !!nextItem.done;
            changed = true;
        }
        return changed;
    }

    function isAgendaDeletedByText(text) {
        const context = getContext();
        const deletedTexts = context?.chat?.[0]?.horae_meta?._deletedAgendaTexts || [];
        return deletedTexts.some((deletedText) => isAgendaTextMatch(text, deletedText));
    }

    function getAllAgenda() {
        const all = [];

        const userItems = getUserAgenda();
        for (const item of userItems) {
            if (item._deleted || isAgendaDeletedByText(item.text)) continue;
            const sourceMsgIndex = Number.isInteger(item._msgIndex) ? item._msgIndex : null;
            all.push({
                type: normalizeAgendaTypeSafe(item.type),
                text: item.text,
                date: item.date || '',
                source: item.source || 'user',
                done: !!item.done,
                createdAt: item.createdAt || 0,
                _store: 'user',
                _msgIndex: sourceMsgIndex,
                _index: all.length,
            });
        }

        const context = getContext();
        if (context?.chat) {
            for (let i = 1; i < context.chat.length; i++) {
                const meta = context.chat[i].horae_meta;
                if (meta?.agenda?.length > 0) {
                    for (const item of meta.agenda) {
                        if (item._deleted || isAgendaDeletedByText(item.text)) continue;
                        const isDupe = all.some(a => a.text === item.text);
                        if (!isDupe) {
                            all.push({
                                type: normalizeAgendaTypeSafe(item.type),
                                text: item.text,
                                date: item.date || '',
                                source: 'ai',
                                done: !!item.done,
                                createdAt: item.createdAt || 0,
                                _store: 'msg',
                                _msgIndex: i,
                                _index: all.length,
                            });
                        }
                    }
                }
            }
        }

        return all;
    }

    function toggleAgendaDone(agendaItem, done) {
        const context = getContext();
        if (!context?.chat) return;

        if (agendaItem._store === 'user') {
            const agenda = getUserAgenda();
            const found = agenda.find(a => a.text === agendaItem.text);
            if (found) {
                found.done = done;
                setUserAgenda(agenda);
            }
        } else if (agendaItem._store === 'msg') {
            const msg = context.chat[agendaItem._msgIndex];
            if (msg?.horae_meta?.agenda) {
                const found = msg.horae_meta.agenda.find(a => a.text === agendaItem.text);
                if (found) {
                    found.done = done;
                    getContext().saveChat();
                }
            }
        }
    }

    function deleteAgendaItem(agendaItem) {
        const context = getContext();
        if (!context?.chat) return [];
        const targetText = normalizeAgendaText(agendaItem?.text);
        if (!targetText) return [];

        const changedMessageIds = [];
        const userMeta = ensureAgendaMeta(0);
        if (removeAgendaItemsByExactText(userMeta?.agenda, targetText)) {
            changedMessageIds.push(0);
        }

        for (let i = 1; i < context.chat.length; i++) {
            const meta = context.chat[i]?.horae_meta;
            if (removeAgendaItemsByExactText(meta?.agenda, targetText)) {
                changedMessageIds.push(i);
            }
        }

        commitChangedAgendaMessages(changedMessageIds);
        return changedMessageIds;
    }

    function renderAgendaItem(item, index) {
        const typeMeta = getAgendaTypeMeta(item.type);
        const sourceIcon = item.source === 'ai'
            ? `<i class="fa-solid fa-robot horae-agenda-source-ai" title="${t('badge.aiRecord')}"></i>`
            : `<i class="fa-solid fa-user horae-agenda-source-user" title="${t('badge.userAdded')}"></i>`;
        const floorDisplay = Number.isInteger(item._msgIndex)
            ? `<span class="horae-agenda-floor"><i class="fa-solid fa-layer-group"></i> ${t('ui.messageLabel', { id: item._msgIndex })}</span>`
            : '';
        const dateDisplay = item.date
            ? `<span class="horae-agenda-date"><i class="fa-regular fa-calendar"></i> ${escapeHtml(item.date)}</span>`
            : '';
        const typeBadge = `
            <span class="horae-agenda-type-badge ${typeMeta.className}">
                <i class="${typeMeta.icon}"></i>
                ${typeMeta.label}
            </span>
        `;
        const checkboxHtml = agendaMultiSelectMode
            ? `<label class="horae-agenda-select-check"><input type="checkbox" ${selectedAgendaIndices.has(index) ? 'checked' : ''} data-agenda-select="${index}"></label>`
            : '';
        const selectedClass = agendaMultiSelectMode && selectedAgendaIndices.has(index) ? ' selected' : '';

        return `
            <div class="horae-agenda-item horae-agenda-item-${typeMeta.className}${selectedClass}" data-agenda-idx="${index}" data-agenda-type="${typeMeta.type}">
                ${checkboxHtml}
                <div class="horae-agenda-body">
                    <div class="horae-agenda-meta">${typeBadge}${sourceIcon}${floorDisplay}${dateDisplay}</div>
                    <div class="horae-agenda-text">${escapeHtml(item.text)}</div>
                </div>
            </div>
        `;
    }

    function updateAgendaDisplay() {
        const listEl = document.getElementById('horae-agenda-list');
        if (!listEl) return;

        const agenda = getAllAgenda();

        if (agenda.length === 0) {
            listEl.innerHTML = `<div class="horae-empty-hint">${t('timeline.noAgenda')}</div>`;
            if (agendaMultiSelectMode) exitAgendaMultiSelect();
            return;
        }

        const groupedAgenda = [
            {
                type: PLAN_TYPE,
                className: 'plan',
                label: t('timeline.plan'),
                icon: getAgendaTypeMeta(PLAN_TYPE).groupIcon,
                items: [],
            },
            {
                type: MYSTERY_TYPE,
                className: 'mystery',
                label: t('timeline.mystery'),
                icon: getAgendaTypeMeta(MYSTERY_TYPE).groupIcon,
                items: [],
            },
        ];

        agenda.forEach((item, index) => {
            const type = normalizeAgendaTypeSafe(item.type);
            const group = type === MYSTERY_TYPE ? groupedAgenda[1] : groupedAgenda[0];
            group.items.push({ item, index });
        });

        listEl.innerHTML = groupedAgenda
            .filter(group => group.items.length > 0)
            .map(group => `
                <div class="horae-agenda-group horae-agenda-group-${group.className}">
                    <div class="horae-agenda-group-header">
                        <div class="horae-agenda-group-title">
                            <i class="${group.icon}"></i>
                            <span>${group.label}</span>
                        </div>
                        <span class="horae-agenda-group-count">${group.items.length}</span>
                    </div>
                    <div class="horae-agenda-group-list">
                        ${group.items.map(({ item, index }) => renderAgendaItem(item, index)).join('')}
                    </div>
                </div>
            `)
            .join('');

        const currentAgenda = agenda;

        listEl.querySelectorAll('.horae-agenda-item').forEach(el => {
            const idx = parseInt(el.dataset.agendaIdx);

            if (agendaMultiSelectMode) {
                el.addEventListener('click', (e) => {
                    e.stopPropagation();
                    toggleAgendaSelection(idx);
                });
            } else {
                el.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const item = currentAgenda[idx];
                    if (item) openAgendaEditModal(item);
                });

                el.addEventListener('mousedown', (e) => startAgendaLongPress(e, idx));
                el.addEventListener('touchstart', (e) => startAgendaLongPress(e, idx), { passive: true });
                el.addEventListener('mouseup', cancelAgendaLongPress);
                el.addEventListener('mouseleave', cancelAgendaLongPress);
                el.addEventListener('touchmove', cancelAgendaLongPress, { passive: true });
                el.addEventListener('touchend', cancelAgendaLongPress);
                el.addEventListener('touchcancel', cancelAgendaLongPress);
            }
        });
    }

    function startAgendaLongPress(e, agendaIdx) {
        if (agendaMultiSelectMode) return;
        agendaLongPressTimer = setTimeout(() => {
            enterAgendaMultiSelect(agendaIdx);
        }, 800);
    }

    function cancelAgendaLongPress() {
        if (agendaLongPressTimer) {
            clearTimeout(agendaLongPressTimer);
            agendaLongPressTimer = null;
        }
    }

    function enterAgendaMultiSelect(initialIdx) {
        agendaMultiSelectMode = true;
        selectedAgendaIndices.clear();
        if (initialIdx !== undefined && initialIdx !== null) {
            selectedAgendaIndices.add(initialIdx);
        }

        const bar = document.getElementById('horae-agenda-multiselect-bar');
        if (bar) bar.style.display = 'flex';

        const addBtn = document.getElementById('horae-btn-add-agenda');
        if (addBtn) addBtn.style.display = 'none';

        updateAgendaDisplay();
        updateAgendaSelectedCount();
        showToast(t('toast.agendaMultiSelect'), 'info');
    }

    function exitAgendaMultiSelect() {
        agendaMultiSelectMode = false;
        selectedAgendaIndices.clear();

        const bar = document.getElementById('horae-agenda-multiselect-bar');
        if (bar) bar.style.display = 'none';

        const addBtn = document.getElementById('horae-btn-add-agenda');
        if (addBtn) addBtn.style.display = '';

        updateAgendaDisplay();
    }

    function toggleAgendaSelection(idx) {
        if (selectedAgendaIndices.has(idx)) {
            selectedAgendaIndices.delete(idx);
        } else {
            selectedAgendaIndices.add(idx);
        }

        const item = document.querySelector(`#horae-agenda-list .horae-agenda-item[data-agenda-idx="${idx}"]`);
        if (item) {
            const cb = item.querySelector('input[type="checkbox"]');
            if (cb) cb.checked = selectedAgendaIndices.has(idx);
            item.classList.toggle('selected', selectedAgendaIndices.has(idx));
        }

        updateAgendaSelectedCount();
    }

    function selectAllAgenda() {
        const items = document.querySelectorAll('#horae-agenda-list .horae-agenda-item');
        items.forEach(item => {
            const idx = parseInt(item.dataset.agendaIdx);
            if (!isNaN(idx)) selectedAgendaIndices.add(idx);
        });
        updateAgendaDisplay();
        updateAgendaSelectedCount();
    }

    function updateAgendaSelectedCount() {
        const countEl = document.getElementById('horae-agenda-selected-count');
        if (countEl) countEl.textContent = selectedAgendaIndices.size;
    }

    async function deleteSelectedAgenda() {
        if (selectedAgendaIndices.size === 0) {
            showToast(t('toast.insufficientEvents'), 'warning');
            return;
        }

        const confirmed = confirm(t('confirm.deleteAgenda', { n: selectedAgendaIndices.size }));
        if (!confirmed) return;

        const agenda = getAllAgenda();
        const sortedIndices = Array.from(selectedAgendaIndices).sort((a, b) => b - a);

        for (const idx of sortedIndices) {
            const item = agenda[idx];
            if (item) {
                deleteAgendaItem(item);
            }
        }

        await getContext().saveChat();
        showToast(t('toast.saveSuccess'), 'success');

        exitAgendaMultiSelect();
        refreshAgendaUi();
    }

    function openAgendaEditModal(agendaItem = null) {
        const isEdit = agendaItem !== null;
        const currentType = isEdit ? normalizeAgendaTypeSafe(agendaItem.type) : PLAN_TYPE;
        const currentText = isEdit ? (agendaItem.text || '') : '';
        const currentDate = isEdit ? (agendaItem.date || '') : '';
        const title = isEdit ? t('ui.editAgenda') : t('ui.addAgenda');

        closeEditModal();

        const deleteBtn = isEdit ? `
                        <button id="agenda-modal-delete" class="horae-btn danger">
                            <i class="fa-solid fa-trash"></i> ${t('common.delete')}
                        </button>` : '';

        const modalHtml = `
            <div id="horae-edit-modal" class="horae-modal">
                <div class="horae-modal-content">
                    <div class="horae-modal-header">
                        <i class="fa-solid fa-list-check"></i> ${title}
                    </div>
                    <div class="horae-modal-body horae-edit-modal-body">
                        <div class="horae-edit-field">
                            <label>${t('label.agendaType')}</label>
                            <select id="agenda-edit-type">
                                ${getAgendaTypeOptionsHtml(currentType)}
                            </select>
                        </div>
                        <div class="horae-edit-field">
                            <label>${t('label.agendaDate')}</label>
                            <input type="text" id="agenda-edit-date" value="${escapeHtml(currentDate)}" placeholder="${t('placeholder.agendaDate')}">
                        </div>
                        <div class="horae-edit-field">
                            <label>${t('label.content')}</label>
                            <textarea id="agenda-edit-text" rows="3" placeholder="${t('placeholder.agendaText')}">${escapeHtml(currentText)}</textarea>
                        </div>
                    </div>
                    <div class="horae-modal-footer">
                        <button id="agenda-modal-save" class="horae-btn primary">
                            <i class="fa-solid fa-check"></i> ${t('common.save')}
                        </button>
                        <button id="agenda-modal-cancel" class="horae-btn">
                            <i class="fa-solid fa-xmark"></i> ${t('common.cancel')}
                        </button>
                        ${deleteBtn}
                    </div>
                </div>
            </div>
        `;

        document.body.insertAdjacentHTML('beforeend', modalHtml);
        preventModalBubble();

        setTimeout(() => {
            const textarea = document.getElementById('agenda-edit-text');
            if (textarea) textarea.focus();
        }, 100);

        document.getElementById('horae-edit-modal').addEventListener('click', (e) => {
            if (e.target.id === 'horae-edit-modal') closeEditModal();
        });

        document.getElementById('agenda-modal-save').addEventListener('click', async (e) => {
            e.stopPropagation();
            e.stopImmediatePropagation();
            const type = normalizeAgendaTypeSafe(document.getElementById('agenda-edit-type')?.value || currentType);
            const text = document.getElementById('agenda-edit-text').value.trim();
            const date = document.getElementById('agenda-edit-date').value.trim();
            if (!text) {
                showToast(t('toast.contentEmpty'), 'warning');
                return;
            }

            if (isEdit) {
                const context = getContext();
                if (agendaItem._store === 'user') {
                    const agenda = getUserAgenda();
                    updateAgendaItemsByExactText(agenda, agendaItem.text, { type, text, date, done: false });
                    setUserAgenda(agenda, { save: false });
                } else if (agendaItem._store === 'msg' && context?.chat) {
                    const changedMessageIds = [];
                    for (let i = 1; i < context.chat.length; i++) {
                        const msg = context.chat[i];
                        if (updateAgendaItemsByExactText(msg?.horae_meta?.agenda, agendaItem.text, { type, text, date, done: false })) {
                            changedMessageIds.push(i);
                        }
                    }
                    commitChangedAgendaMessages(changedMessageIds);
                }
            } else {
                const agenda = getUserAgenda();
                const context = getContext();
                const lastMsgIndex = (context?.chat?.length || 0) - 1;
                const sourceMsgIndex = lastMsgIndex >= 1 ? lastMsgIndex : null;
                agenda.push({
                    type,
                    text,
                    date,
                    source: 'user',
                    done: false,
                    createdAt: Date.now(),
                    ...(sourceMsgIndex !== null ? { _msgIndex: sourceMsgIndex } : {}),
                });
                setUserAgenda(agenda, { save: false });
            }

            await getContext().saveChat();
            closeEditModal();
            refreshAgendaUi();
            showToast(t('toast.saveSuccess'), 'success');
        });

        document.getElementById('agenda-modal-cancel').addEventListener('click', (e) => {
            e.stopPropagation();
            e.stopImmediatePropagation();
            closeEditModal();
        });

        const deleteEl = document.getElementById('agenda-modal-delete');
        if (deleteEl && isEdit) {
            deleteEl.addEventListener('click', async (e) => {
                e.stopPropagation();
                e.stopImmediatePropagation();

                if (!confirm(t('confirm.deleteAgenda', { n: 1 }))) return;

                deleteAgendaItem(agendaItem);
                await getContext().saveChat();
                closeEditModal();
                refreshAgendaUi();
                showToast(t('toast.saveSuccess'), 'info');
            });
        }
    }

    return {
        getUserAgenda,
        setUserAgenda,
        getAllAgenda,
        toggleAgendaDone,
        deleteAgendaItem,
        updateAgendaDisplay,
        selectAllAgenda,
        deleteSelectedAgenda,
        exitAgendaMultiSelect,
        openAgendaEditModal,
    };
}
