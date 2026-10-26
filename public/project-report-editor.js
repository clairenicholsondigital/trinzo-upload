// Lossless editing of report JSON. Display fallbacks are never implicit edits.
(function (root) {
  'use strict';
  const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const aliases = {
    actions: { action: ['meetingActionPoint'], owner: ['meetingActionPointOwner'], deadline: ['meetingActionPointDeadline'], relatedMilestone: ['related_milestone'] },
    milestones: { baseline_finish_date: ['baselineDeadline'], forecast_finish_date: ['forecastDeadline'], delivery_status: ['status'], agreed_rag_status: ['rag_status'] },
    risks: { suggestedMitigation: ['mitigation'] }
  };
  function apply(row, changes, kind) {
    const out = clone(row || {});
    for (const [key, value] of Object.entries(changes)) {
      out[key] = key === 'next_steps' ? value.split(/\r?\n/).map(s => s.trim()).filter(Boolean) : value;
      for (const alias of aliases[kind]?.[key] || []) if (Object.hasOwn(out, alias)) out[alias] = clone(out[key]);
    }
    return out;
  }
  function create(initial, sections, controls) {
    let baseline = clone(initial);
    const bindings = new WeakMap(), nodes = new Map();
    const values = row => Object.fromEntries(Array.from(row.querySelectorAll('[data-field]')).map(el => [el.dataset.field, el.value]));
    function bind(section) {
      const rows = Array.from(document.querySelectorAll(section.selector));
      nodes.set(section.key, rows);
      rows.forEach((row, index) => bindings.set(row, { index, values: values(row) }));
    }
    sections.forEach(bind);
    const topValues = new Map(controls.map(c => [c.key, c.node.value]));
    function sync(data) {
      const out = clone(data), updates = [], refresh = [];
      for (const c of controls) {
        const edited = c.node.value !== topValues.get(c.key);
        const jsonEdited = !equal(data[c.key], baseline[c.key]);
        if (edited && jsonEdited && !equal(data[c.key], c.node.value)) throw Error('Both the JSON and the form changed '+c.key+'. Keep one version, then retry.');
        if (edited) out[c.key] = c.node.value;
      }
      for (const section of sections) {
        const value = data[section.key];
        if (value !== undefined && (section.object ? !value || typeof value !== 'object' || Array.isArray(value) : !Array.isArray(value))) throw Error('The JSON field '+section.key+' has an invalid structure. Correct it before saving.');
        const rows = Array.from(document.querySelectorAll(section.selector));
        const previousNodes = nodes.get(section.key);
        const changes = rows.map(row => {
          const binding = bindings.get(row);
          const current = values(row);
          const fields = Object.fromEntries(Object.entries(current).filter(([key,value]) => (!binding || binding.index === null) ? Boolean(value) : value !== binding.values[key]));
          return { row, binding, fields, current };
        });
        const structureChanged = rows.length !== previousNodes.length || rows.some((row,i) => row !== previousNodes[i]);
        const edited = structureChanged || changes.some(c => Object.keys(c.fields).length);
        const jsonEdited = !equal(data[section.key], baseline[section.key]);
        if (edited && jsonEdited) throw Error('Both the JSON and the table changed '+section.key+'. Save one set of edits first, or reload and reapply them. Your edits have not been discarded.');
        if (jsonEdited) { refresh.push(section); continue; }
        if (!edited) continue;
        if (section.object) {
          const next = clone(data[section.key] || {});
          for (const c of changes) if (Object.keys(c.fields).length) next[c.row.dataset.healthAreaRow] = apply(next[c.row.dataset.healthAreaRow],c.fields,section.key);
          out[section.key] = next;
        } else {
          const next = [], mapped = [];
          for (const c of changes) {
            const isNew = !c.binding || c.binding.index === null;
            if (isNew && !Object.keys(c.fields).length) { mapped.push({ ...c, index: null }); continue; }
            const original = isNew ? {} : data[section.key][c.binding.index];
            mapped.push({ ...c, index: next.length });
            next.push(apply(original,c.fields,section.key));
          }
          out[section.key] = next;
          updates.push({ section, mapped, rows });
        }
      }
      // No DOM or baseline changes until every conflict check has passed.
      for (const c of controls) { if (out[c.key] !== undefined) c.node.value = out[c.key] ?? ''; topValues.set(c.key,c.node.value); }
      for (const section of refresh) { section.render(out[section.key]); bind(section); }
      for (const {section,mapped,rows} of updates) {
        nodes.set(section.key,rows);
        for (const c of mapped) bindings.set(c.row,{index:c.index,values:c.current});
      }
      for (const section of sections.filter(s => s.object && !refresh.includes(s))) bind(section);
      baseline = clone(out);
      return out;
    }
    return { sync };
  }
  root.ProjectReportEditor = { create, apply };
}(typeof window === 'undefined' ? globalThis : window));
