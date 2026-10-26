// Settings page: edit the People list and the Glossary the agent uses.
(function () {
  'use strict';

  const state = { canEdit: false, people: [], terms: [], tab: 'people', editing: null };
  const $ = (id) => document.getElementById(id);

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs)) {
      if (value == null || value === false) continue;
      if (name === 'text') node.textContent = value;
      else if (name === 'className') node.className = value;
      else if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
      else node.setAttribute(name, value === true ? '' : value);
    }
    for (const child of [].concat(children)) if (child) node.append(child);
    return node;
  }

  function showMessage(text, kind = '') {
    const box = $('settingsMessage');
    box.textContent = text || '';
    box.className = `message${kind ? ` ${kind}` : ''}`;
    box.hidden = !text;
  }

  async function api(path, options = {}) {
    const response = await fetch(`/api/settings${path}`, {
      method: options.method || 'GET',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      credentials: 'same-origin'
    });
    if (response.status === 401) {
      location.href = `/auth/login?returnTo=${encodeURIComponent(location.pathname + location.hash)}`;
      throw new Error('Please sign in again.');
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) throw new Error(data.error || 'Something went wrong. Try again.');
    return data;
  }

  function lines(value) {
    return String(value || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  }

  function matches(query, ...values) {
    const q = query.trim().toLowerCase();
    return !q || values.flat().some((value) => String(value || '').toLowerCase().includes(q));
  }

  // ---- tabs -----------------------------------------------------------------

  function selectTab(tab) {
    state.tab = tab === 'terms' ? 'terms' : 'people';
    for (const button of document.querySelectorAll('.settings-tab')) {
      button.setAttribute('aria-selected', String(button.dataset.tab === state.tab));
    }
    $('peoplePanel').hidden = state.tab !== 'people';
    $('termsPanel').hidden = state.tab !== 'terms';
    if (location.hash !== `#${state.tab}`) history.replaceState(null, '', `#${state.tab}`);
  }

  // ---- people ---------------------------------------------------------------

  function personRow(person) {
    const sideLabel = person.side === 'client' ? 'Client' : 'Internal';
    const sub = person.spellings.length ? `Also written: ${person.spellings.join(', ')}` : '';
    return el('li', { className: 'settings-row', 'data-side': person.side }, [
      el('div', { className: 'row-main' }, [
        el('span', { className: 'row-title', text: person.name }),
        sub ? el('span', { className: 'row-sub', text: sub }) : null
      ]),
      state.canEdit
        ? el('button', {
          className: 'secondary row-edit', type: 'button', text: 'Edit',
          'aria-label': `Edit ${person.name} (${sideLabel})`,
          onclick: () => openPersonForm(person)
        })
        : null
    ]);
  }

  function renderPeople() {
    $('peopleCount').textContent = String(state.people.length);
    const query = $('peopleSearch').value;
    const shown = state.people.filter((person) => matches(query, person.name, person.spellings));
    const list = $('peopleList');
    list.replaceChildren();
    if (!shown.length) {
      list.append(el('p', { className: 'empty-state', text: query ? 'No one matches that search.' : 'No people yet.' }));
      return;
    }
    for (const [side, title] of [['internal', 'Internal'], ['client', 'Client']]) {
      const group = shown.filter((person) => person.side === side)
        .sort((a, b) => a.name.localeCompare(b.name));
      if (!group.length) continue;
      list.append(el('h2', { className: 'group-title' }, [title, el('span', { className: 'group-count', text: String(group.length) })]));
      list.append(el('ul', { className: 'settings-list' }, group.map(personRow)));
    }
  }

  function sideChoice(current) {
    const option = (value, label) => el('label', {}, [
      el('input', { type: 'radio', name: 'side', value, checked: current === value }),
      el('span', { text: label })
    ]);
    return el('fieldset', { className: 'side-choice' }, [
      el('legend', { text: 'Side' }),
      option('internal', 'Internal'),
      option('client', 'Client')
    ]);
  }

  function formActions({ onCancel, onDelete, saveLabel }) {
    return el('div', { className: 'form-actions' }, [
      el('button', { className: 'button', type: 'submit', text: saveLabel }),
      el('button', { className: 'secondary', type: 'button', text: 'Cancel', onclick: onCancel }),
      onDelete ? el('button', { className: 'button danger delete', type: 'button', text: 'Delete', onclick: onDelete }) : null
    ]);
  }

  function closeForm(containerId) {
    const box = $(containerId);
    box.hidden = true;
    box.replaceChildren();
    state.editing = null;
  }

  function openPersonForm(person = null) {
    closeForm('termsForm');
    state.editing = person ? `person:${person.id}` : 'person:new';
    const box = $('peopleForm');
    const error = el('p', { className: 'message error form-error', hidden: true });
    const name = el('input', { type: 'text', name: 'name', value: person?.name || '', maxlength: '120', autocomplete: 'off', required: true });
    const spellings = el('textarea', { name: 'spellings', rows: '3' });
    spellings.value = (person?.spellings || []).join('\n');
    const form = el('form', { className: 'settings-form', novalidate: true }, [
      el('h2', { text: person ? `Edit ${person.name}` : 'Add a person' }),
      el('label', {}, ['Name', name]),
      sideChoice(person?.side || 'internal'),
      el('label', {}, [
        'Other spellings',
        el('p', { className: 'field-hint', text: 'One per line. How Teams or a directory sometimes writes this name, for example "Smith, Stuart M". Full-name spellings are corrected in new minutes.' }),
        spellings
      ]),
      error,
      formActions({
        saveLabel: person ? 'Save changes' : 'Add person',
        onCancel: () => closeForm('peopleForm'),
        onDelete: person ? () => removeItem('people', person.id, person.name) : null
      })
    ]);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      error.hidden = true;
      const side = form.querySelector('input[name="side"]:checked')?.value;
      try {
        await api(person ? `/people/${person.id}` : '/people', {
          method: person ? 'PUT' : 'POST',
          body: { name: name.value, side, spellings: lines(spellings.value) }
        });
        closeForm('peopleForm');
        await load();
        showMessage(person ? `Saved ${name.value.trim()}.` : `Added ${name.value.trim()}.`, 'success');
      } catch (failure) {
        error.textContent = failure.message;
        error.hidden = false;
      }
    });
    box.replaceChildren(form);
    box.hidden = false;
    box.scrollIntoView({ block: 'nearest' });
    name.focus();
  }

  // ---- glossary -------------------------------------------------------------

  function termRow(term) {
    return el('li', { className: 'settings-row' }, [
      el('div', { className: 'row-main' }, [
        el('span', { className: 'row-title', text: term.term }),
        term.meaning ? el('span', { className: 'row-sub', text: term.meaning }) : null,
        term.heardAs.length ? el('span', { className: 'row-sub', text: `Corrects: ${term.heardAs.join(', ')}` }) : null
      ]),
      state.canEdit
        ? el('button', {
          className: 'secondary row-edit', type: 'button', text: 'Edit',
          'aria-label': `Edit ${term.term}`,
          onclick: () => openTermForm(term)
        })
        : null
    ]);
  }

  function renderTerms() {
    $('termsCount').textContent = String(state.terms.length);
    const query = $('termsSearch').value;
    const shown = state.terms.filter((term) => matches(query, term.term, term.meaning, term.heardAs))
      .sort((a, b) => a.term.localeCompare(b.term, undefined, { sensitivity: 'base' }));
    const list = $('termsList');
    list.replaceChildren();
    if (!shown.length) {
      list.append(el('p', { className: 'empty-state', text: query ? 'No terms match that search.' : 'No terms yet.' }));
      return;
    }
    list.append(el('ul', { className: 'settings-list' }, shown.map(termRow)));
  }

  function openTermForm(term = null) {
    closeForm('peopleForm');
    state.editing = term ? `term:${term.id}` : 'term:new';
    const box = $('termsForm');
    const error = el('p', { className: 'message error form-error', hidden: true });
    const termInput = el('input', { type: 'text', name: 'term', value: term?.term || '', maxlength: '80', autocomplete: 'off', required: true });
    const meaning = el('input', { type: 'text', name: 'meaning', value: term?.meaning || '', maxlength: '300', autocomplete: 'off' });
    const heardAs = el('textarea', { name: 'heardAs', rows: '3' });
    heardAs.value = (term?.heardAs || []).join('\n');
    const form = el('form', { className: 'settings-form', novalidate: true }, [
      el('h2', { text: term ? `Edit ${term.term}` : 'Add a term' }),
      el('label', {}, ['Term', el('p', { className: 'field-hint', text: 'Written exactly as it should appear, for example CAPA or Cognidocs.' }), termInput]),
      el('label', {}, ['Meaning', el('p', { className: 'field-hint', text: 'Optional, for example Corrective and Preventive Action.' }), meaning]),
      el('label', {}, [
        'Teams sometimes writes',
        el('p', { className: 'field-hint', text: 'One per line, at least 3 letters. Each one is changed to the term in new minutes, so only add spellings that are always wrong.' }),
        heardAs
      ]),
      error,
      formActions({
        saveLabel: term ? 'Save changes' : 'Add term',
        onCancel: () => closeForm('termsForm'),
        onDelete: term ? () => removeItem('terms', term.id, term.term) : null
      })
    ]);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      error.hidden = true;
      try {
        await api(term ? `/terms/${term.id}` : '/terms', {
          method: term ? 'PUT' : 'POST',
          body: { term: termInput.value, meaning: meaning.value, heardAs: lines(heardAs.value) }
        });
        closeForm('termsForm');
        await load();
        showMessage(term ? `Saved ${termInput.value.trim()}.` : `Added ${termInput.value.trim()}.`, 'success');
      } catch (failure) {
        error.textContent = failure.message;
        error.hidden = false;
      }
    });
    box.replaceChildren(form);
    box.hidden = false;
    box.scrollIntoView({ block: 'nearest' });
    termInput.focus();
  }

  // ---- shared ---------------------------------------------------------------

  async function removeItem(kind, id, label) {
    if (!window.confirm(`Delete ${label}? New minutes will no longer use it.`)) return;
    try {
      await api(`/${kind}/${id}`, { method: 'DELETE' });
      closeForm(kind === 'people' ? 'peopleForm' : 'termsForm');
      await load();
      showMessage(`Deleted ${label}.`, 'success');
    } catch (failure) {
      showMessage(failure.message, 'error');
    }
  }

  function describeChange(change) {
    const item = change.after || change.before || {};
    const label = item.name || item.term || 'an item';
    const who = change.userEmail || 'Someone';
    if (change.action === 'added') return `${who} added ${label}`;
    if (change.action === 'deleted') return `${who} deleted ${label}`;
    const before = change.before || {};
    if (change.itemType === 'person' && before.side && before.side !== item.side) {
      return `${who} moved ${label} to ${item.side === 'client' ? 'Client' : 'Internal'}`;
    }
    if (before.name && before.name !== item.name) return `${who} renamed ${before.name} to ${label}`;
    return `${who} changed ${label}`;
  }

  async function loadHistory() {
    const list = $('historyList');
    list.replaceChildren(el('li', { text: 'Loading…' }));
    try {
      const { changes } = await api('/history?limit=30');
      list.replaceChildren(...(changes.length ? changes.map((change) => el('li', {}, [
        describeChange(change), ' · ',
        el('time', { datetime: change.createdAt, text: new Date(change.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) })
      ])) : [el('li', { text: 'No changes yet.' })]));
    } catch (failure) {
      list.replaceChildren(el('li', { text: failure.message }));
    }
  }

  async function load() {
    const data = await api('');
    state.canEdit = Boolean(data.canEdit);
    state.people = data.people || [];
    state.terms = data.terms || [];
    $('addPerson').hidden = !state.canEdit;
    $('addTerm').hidden = !state.canEdit;
    $('historyPanel').hidden = !state.canEdit;
    if (!state.canEdit) {
      showMessage(data.source === 'database'
        ? 'Only admins can change these lists.'
        : 'These are the built-in lists. Editing needs the database to be connected.', 'warning');
    }
    renderPeople();
    renderTerms();
    if ($('history').open) loadHistory();
  }

  function start() {
    for (const button of document.querySelectorAll('.settings-tab')) {
      button.addEventListener('click', () => selectTab(button.dataset.tab));
    }
    $('peopleSearch').addEventListener('input', renderPeople);
    $('termsSearch').addEventListener('input', renderTerms);
    $('addPerson').addEventListener('click', () => openPersonForm());
    $('addTerm').addEventListener('click', () => openTermForm());
    $('history').addEventListener('toggle', () => { if ($('history').open) loadHistory(); });
    selectTab(location.hash === '#terms' ? 'terms' : 'people');
    load().catch((failure) => {
      showMessage(failure.message, 'error');
      $('peopleList').replaceChildren();
      $('termsList').replaceChildren();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
