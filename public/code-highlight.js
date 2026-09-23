// A display-only lexer: source text is always escaped, never evaluated or changed.
const sqlKeywords = new Set(('select from where join left right full inner outer cross on using as with recursive distinct all union intersect except group by having order asc desc nulls first last limit offset fetch over partition rows range between preceding following unbounded current row case when then else end and or not in is null true false exists like ilike rlike regexp escape any some into insert values update set delete merge matched create alter drop truncate table view database schema index if temporary temp replace materialized primary key foreign references constraint unique default check add column rename to comment explain analyze describe show use grant revoke commit rollback begin transaction cast try_cast interval date timestamp time int integer bigint smallint decimal numeric float double real boolean varchar char text string array map struct lateral unnest window qualify distribute cluster sort stored format location partitioned overwrite load data external purge cascade restrict returning pivot unpivot tablesample top only do conflict filter within rollup cube grouping sets exclude ties respect ignore nullif coalesce').split(' '));
const pythonKeywords = new Set(('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case type').split(' '));
const pythonBuiltins = new Set(('abs all any ascii bin bool breakpoint bytearray bytes callable chr classmethod compile complex delattr dict dir divmod enumerate eval exec filter float format frozenset getattr globals hasattr hash help hex id input int isinstance issubclass iter len list locals map max memoryview min next object oct open ord pow print property range repr reversed round set setattr slice sorted staticmethod str sum super tuple type vars zip __import__ self cls').split(' '));
const wordPattern = /[\p{L}_][\p{L}\p{N}_$]*/uy;
const numberPattern = /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.[\d_]+)(?:[eE][+-]?[\d_]+)?[jJ]?)/y;
const pythonQuote = /(?:[rRuUbBfF]{1,2})?(?:'''|"""|'|")/y;
const dollarQuote = /\$(?:[a-zA-Z_][\w]*)?\$/y;
const escapeHTML = text => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export function detectLanguage(path = '') {
  if (/\.(?:sql|hql|ddl|dml)$/i.test(path)) return 'sql';
  if (/\.(?:py|pyw|pyi)$/i.test(path)) return 'python';
  return 'text';
}

export function findCodeMatches(source, query) {
  const positions = [];
  if (!query) return positions;
  for (let at = source.indexOf(query); at >= 0; at = source.indexOf(query, at + query.length)) positions.push(at);
  return positions;
}

// Decorate text nodes only: preserve escaped source and existing syntax spans.
// Paint the viewport (plus the active match), so very large files stay editable.
export function markCodeMatches(root, positions, length, current, from = 0, to = Infinity) {
  const ranges = [];
  for (const start of positions) {
    if (start + length < from) continue;
    if (start > to || ranges.length >= 2000) break;
    ranges.push(start);
  }
  if (current >= 0 && !ranges.includes(current)) { ranges.push(current); ranges.sort((a, b) => a - b); }
  if (!ranges.length) return;
  const doc = root.ownerDocument, walker = doc.createTreeWalker(root, 4), nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  let offset = 0, match = 0;
  for (const node of nodes) {
    const text = node.data, end = offset + text.length;
    while (match < ranges.length && ranges[match] + length <= offset) match++;
    if (match >= ranges.length) break;
    if (ranges[match] < end) {
      const fragment = doc.createDocumentFragment(); let cursor = 0, index = match;
      while (index < ranges.length && ranges[index] < end) {
        const start = Math.max(0, ranges[index] - offset), stop = Math.min(text.length, ranges[index] + length - offset);
        fragment.append(doc.createTextNode(text.slice(cursor, start)));
        const mark = doc.createElement('mark'); mark.className = 'editor-search-match';
        if (ranges[index] === current) mark.dataset.searchCurrent = 'true';
        mark.textContent = text.slice(start, stop); fragment.append(mark); cursor = stop; index++;
      }
      fragment.append(doc.createTextNode(text.slice(cursor))); node.replaceWith(fragment);
    }
    offset = end;
  }
}

function matchAt(pattern, source, index) { pattern.lastIndex = index; return pattern.exec(source)?.[0]; }
function quotedEnd(source, start, quote, { doubled = false, multiline = false } = {}) {
  let index = start;
  while (index < source.length) {
    if (!multiline && source[index] === '\n') return index;
    if (source[index] === '\\') { index += 2; continue; }
    if (source.startsWith(quote, index)) {
      index += quote.length;
      if (doubled && source.startsWith(quote, index)) { index += quote.length; continue; }
      return index;
    }
    index++;
  }
  return source.length;
}

export function highlightCode(source, language) {
  // Keep the native editor responsive for unusually large files. Editing/saving remains available.
  if (!['sql', 'python'].includes(language) || source.length > 200_000) return { html: escapeHTML(source), limited: source.length > 200_000 && language !== 'text' };
  const sql = language === 'sql', pieces = [];
  let index = 0, plainStart = 0, definition = false;
  while (index < source.length) {
    const start = index, char = source[index];
    let kind = '', token;
    if (sql && source.startsWith('--', index) || !sql && char === '#') {
      index = source.indexOf('\n', index); if (index < 0) index = source.length;
      kind = 'comment';
    } else if (sql && source.startsWith('/*', index)) {
      let depth = 1; index += 2;
      while (index < source.length && depth) {
        if (source.startsWith('/*', index)) { depth++; index += 2; }
        else if (source.startsWith('*/', index)) { depth--; index += 2; }
        else index++;
      }
      kind = 'comment';
    } else if (sql && (char === "'" || char === '"' || char === '`' || char === '[')) {
      index = quotedEnd(source, index + 1, char === '[' ? ']' : char, { doubled: true, multiline: true });
      kind = char === "'" ? 'string' : 'identifier';
    } else if (sql && char === '$' && (token = matchAt(dollarQuote, source, index))) {
      const end = source.indexOf(token, index + token.length);
      index = end < 0 ? source.length : end + token.length; kind = 'string';
    } else if (!sql && (token = matchAt(pythonQuote, source, index))) {
      const quote = token.replace(/^[rRuUbBfF]+/, '');
      index = quotedEnd(source, index + token.length, quote, { multiline: quote.length === 3 }); kind = 'string';
    } else if ((token = matchAt(numberPattern, source, index))) {
      index += token.length; kind = 'number';
    } else if ((token = matchAt(wordPattern, source, index))) {
      index += token.length;
      if (sql) kind = sqlKeywords.has(token.toLowerCase()) ? 'keyword' : /^\s*\(/.test(source.slice(index, index + 80)) ? 'function' : '';
      else {
        kind = pythonKeywords.has(token) ? 'keyword' : definition ? 'function' : pythonBuiltins.has(token) ? 'builtin' : /^\s*\(/.test(source.slice(index, index + 80)) ? 'function' : '';
        definition = token === 'def' || token === 'class';
      }
    } else if (/[+*/%=<>!|&^~:@?-]/.test(char)) { index++; kind = 'operator'; }
    else { index++; }
    if (kind) {
      if (start > plainStart) pieces.push(escapeHTML(source.slice(plainStart, start)));
      pieces.push(`<span class="syntax-${kind}">${escapeHTML(source.slice(start, index))}</span>`);
      plainStart = index;
    }
  }
  if (plainStart < source.length) pieces.push(escapeHTML(source.slice(plainStart)));
  return { html: pieces.join(''), limited: false };
}
