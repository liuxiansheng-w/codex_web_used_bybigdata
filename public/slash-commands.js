export function createSlashCommands({ input, commands, notify = () => {} }) {
  const doc = input.ownerDocument, win = doc.defaultView;
  const popup = doc.createElement('div'); popup.className = 'slash-commands'; popup.id = 'slashCommands'; popup.hidden = true; popup.setAttribute('role', 'listbox'); popup.setAttribute('aria-label', '斜杠命令');
  input.parentNode.append(popup); input.setAttribute('aria-controls', popup.id); input.setAttribute('aria-autocomplete', 'list');
  let matches = [], index = 0, dismissed = null, running = false;
  const close = () => { popup.hidden = true; input.removeAttribute('aria-activedescendant'); input.setAttribute('aria-expanded', 'false'); };
  function render() {
    if (running || input.disabled || input.selectionStart !== input.value.length || !/^\/[\w-]*$/.test(input.value) || dismissed === input.value) { close(); return; }
    const query = input.value.slice(1).toLowerCase();
    matches = commands.filter(command => command.name.startsWith(query) && command.available?.() !== false);
    index = Math.min(index, Math.max(0, matches.length - 1)); popup.replaceChildren();
    if (!matches.length) { close(); return; }
    matches.forEach((command, at) => {
      const item = doc.createElement('button'); item.type = 'button'; item.id = `slash-${command.name}`; item.setAttribute('role', 'option'); item.setAttribute('aria-selected', String(at === index)); item.tabIndex = -1;
      const name = doc.createElement('strong'), detail = doc.createElement('span'); name.textContent = `/${command.name}`; detail.textContent = command.label; item.append(name, detail);
      item.addEventListener('mousedown', event => event.preventDefault()); item.addEventListener('click', () => execute(command)); popup.append(item);
    });
    popup.hidden = false; input.setAttribute('aria-expanded', 'true'); input.setAttribute('aria-activedescendant', `slash-${matches[index].name}`); popup.children[index]?.scrollIntoView?.({ block: 'nearest' });
  }
  async function execute(command) {
    if (running || command.available?.() === false) return;
    const original = input.value;
    running = true; close(); input.value = ''; input.dispatchEvent(new win.Event('input', { bubbles: true }));
    try { const ok = await command.run(); if (ok === false && !input.value) input.value = original; }
    catch (error) { if (!input.value) input.value = original; notify(error.message); }
    finally { running = false; input.dispatchEvent(new win.Event('input', { bubbles: true })); }
  }
  input.addEventListener('input', () => { if (dismissed !== input.value) dismissed = null; index = 0; render(); });
  input.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229 || event.metaKey || event.ctrlKey || event.altKey) return;
    if (popup.hidden) return;
    if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.key === 'Escape') { dismissed = input.value; close(); }
    else if (event.key === 'Enter' || event.key === 'Tab') void execute(matches[index]);
    else { index = (index + (event.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length; render(); }
  }, true);
  input.addEventListener('compositionstart', close); input.addEventListener('compositionend', render);
  doc.addEventListener('pointerdown', event => { if (event.target !== input && !popup.contains(event.target)) { dismissed = input.value; close(); } });
  input.addEventListener('focus', render);
  return { close, refresh: render };
}
