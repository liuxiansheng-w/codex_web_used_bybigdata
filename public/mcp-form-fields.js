import { describeMcpForm, validateMcpForm } from './mcp-form-schema.js';

let nextForm = 0;
export function renderMcpFields(parent, schema, options = {}) {
  const form = describeMcpForm(schema, options), doc = parent.ownerDocument, readers = [], prefix = `mcp-field-${++nextForm}`;
  if (!form.supported) return { ...form, read: () => { throw new Error(form.error); } };
  const node = (tag, className, text) => { const el = doc.createElement(tag); if (className) el.className = className; if (text != null) el.textContent = text; return el; };
  if (form.confirmation) {
    const { presentation } = form.confirmation, details = node('section', 'mcp-confirmation');
    details.append(node('h4', '', presentation.title));
    if (presentation.destructive) details.append(node('p', 'field-hint', '插件标记此操作为破坏性操作，请核对以下内容。'));
    const list = node('dl'); for (const field of presentation.fields || []) list.append(node('dt', '', field.label), node('dd', '', field.value));
    details.append(list); parent.append(details);
  }
  for (const [index, field] of form.fields.entries()) {
    const { key, spec, title, description, required, resource, suggestions } = field, id = `${prefix}-${index}`, choices = field.options;
    const wrapper = node('fieldset', 'mcp-field'), legend = node('legend', '', `${title}${required ? ' *' : ''}`);
    wrapper.append(legend); parent.append(wrapper);
    if (description) wrapper.append(node('p', 'mcp-field-hint', description));
    let read;
    if (choices) {
      const group = node('div', 'mcp-choices'), multiple = spec.type === 'array', selected = new Set(multiple ? spec.default || [] : spec.default === undefined ? [] : [spec.default]);
      const inputs = choices.map((choice, choiceIndex) => {
        const label = node('label', 'mcp-choice'), input = node('input'); input.type = multiple ? 'checkbox' : 'radio'; input.name = `${prefix}:${key}`; input.value = choice.value; input.checked = selected.has(choice.value); input.id = `${id}-${choiceIndex}`;
        if (!multiple) input.required = required;
        const content = node('span', 'mcp-choice-content'); content.append(node('strong', '', choice.title));
        if (choice.description) content.append(node('small', '', choice.description));
        if (resource) content.append(node('small', 'mcp-resource-uri', choice.value));
        label.append(input, content); group.append(label); return input;
      });
      wrapper.append(group);
      if (!required && !multiple) { const clear = node('button', 'text-button mcp-clear', '清除选择'); clear.type = 'button'; clear.addEventListener('click', () => { for (const input of inputs) input.checked = false; }); wrapper.append(clear); }
      if (multiple) {
        const count = node('small', 'mcp-field-hint');
        const update = () => { count.textContent = `已选 ${inputs.filter(input => input.checked).length} 项${spec.minItems ? ` · 至少 ${spec.minItems} 项` : ''}${spec.maxItems != null ? ` · 最多 ${spec.maxItems} 项` : ''}`; };
        group.addEventListener('change', update); update(); wrapper.append(count);
      }
      read = () => multiple ? inputs.filter(input => input.checked).map(input => input.value) : inputs.find(input => input.checked)?.value;
    } else if (spec.type === 'array') {
      const list = node('div', 'mcp-list'), rows = [], add = node('button', 'secondary-button', '添加一项'); add.type = 'button';
      const maximum = Math.min(spec.maxItems ?? 100, 100);
      const append = (value = '') => {
        const row = node('div', 'mcp-list-row'), input = node('input'), remove = node('button', 'text-button', '移除');
        input.name = key; input.type = 'text'; input.autocomplete = 'off'; input.maxLength = Math.min(spec.items?.maxLength ?? 10000, 10000); input.value = value; input.setAttribute('aria-label', `${title}：列表项`);
        remove.type = 'button'; remove.setAttribute('aria-label', `移除${title}列表项`);
        remove.addEventListener('click', () => { rows.splice(rows.indexOf(input), 1); row.remove(); add.disabled = rows.length >= maximum; });
        rows.push(input); row.append(input, remove); list.append(row); add.disabled = rows.length >= maximum;
      };
      for (const value of spec.default || []) append(value);
      add.addEventListener('click', () => { if (rows.length < maximum) { append(); rows.at(-1).focus(); } });
      add.disabled = rows.length >= maximum;
      wrapper.append(list, add); read = () => rows.map(input => input.value);
    } else {
      const multiline = field.extended && spec.type === 'string' && !spec.format && !/secret|token|password/i.test(key) && !suggestions;
      const input = node(multiline ? 'textarea' : 'input'); input.name = key; input.id = id; input.autocomplete = 'off'; input.required = required; input.setAttribute('aria-label', title);
      if (multiline) input.rows = 3;
      else input.type = spec.type === 'boolean' ? 'checkbox' : ['integer', 'number'].includes(spec.type) ? 'number' : /secret|token|password/i.test(key) ? 'password' : spec.format === 'email' ? 'email' : spec.format === 'date' ? 'date' : 'text';
      if (spec.type === 'boolean') { input.required = false; input.checked = spec.default === true; }
      else {
        if (spec.default !== undefined) input.value = String(spec.default);
        if (['number', 'integer'].includes(spec.type)) { input.step = spec.type === 'integer' ? '1' : 'any'; if (spec.minimum != null) input.min = spec.minimum; if (spec.maximum != null) input.max = spec.maximum; }
        else { input.maxLength = Math.min(spec.maxLength ?? 10000, 10000); if (spec.minLength) input.minLength = spec.minLength; }
      }
      if (suggestions) { const list = node('datalist'); list.id = `${id}-suggestions`; input.setAttribute('list', list.id); for (const choice of suggestions) { const option = node('option'); option.value = choice.value; option.label = choice.title; list.append(option); } wrapper.append(list); }
      wrapper.append(input);
      read = () => spec.type === 'boolean' ? input.checked : input.value === '' ? undefined : ['number', 'integer'].includes(spec.type) ? Number(input.value) : input.value;
    }
    readers.push([key, read]);
  }
  return { supported: true, read() {
    const content = Object.fromEntries(readers.map(([key, read]) => [key, read()]).filter(([, value]) => value !== undefined));
    validateMcpForm(schema, content, options); return content;
  } };
}
