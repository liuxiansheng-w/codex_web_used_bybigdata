import test from 'node:test';
import assert from 'node:assert/strict';
import { detectLanguage, highlightCode } from '../public/code-highlight.js';
import { fitEditorRect, resizeEditorRect } from '../public/editor-window.js';

const plain = html => html.replace(/<\/?span\b[^>]*>/g, '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');

test('language detection covers SQL, Hive, Python stubs and case-insensitive extensions', () => {
  for (const path of ['query.sql', 'sql/script.HQL', 'schema.ddl', 'load.DML']) assert.equal(detectLanguage(path), 'sql');
  for (const path of ['etl.py', 'PYTHON.PY', 'types.pyi', 'window.pyw']) assert.equal(detectLanguage(path), 'python');
  for (const path of ['README.md', 'package.json', 'folder.py/file.txt', '', undefined]) assert.equal(detectLanguage(path), 'text');
});

test('SQL highlights keywords, functions, quoted identifiers, literals and nested comments without changing source', () => {
  const source = '-- SELECT 注释\nWITH 数据 AS (SELECT SUM(amount), 1.2e-3, \'it\'\'s <x>\' AS "列" FROM `表`)\n/* outer /* inner */ still comment */\nSELECT [a]]b], $body$<script> & \'hi\'$body$ FROM 数据 WHERE id >= 5;\n';
  const { html, limited } = highlightCode(source, 'sql');
  assert.equal(limited, false); assert.equal(plain(html), source);
  assert.match(html, /syntax-keyword">WITH/); assert.match(html, /syntax-function">SUM/);
  assert.match(html, /syntax-comment">\/\* outer \/\* inner \*\/ still comment \*\//);
  assert.match(html, /syntax-number">1\.2e-3/); assert.match(html, /syntax-identifier/);
  assert.doesNotMatch(html, /<script>/);
});

test('Python highlights definitions, builtins, decorators, strings and Unicode while retaining indentation', () => {
  const source = '@staticmethod\nasync def 计算(value: int = 0xFF):\n\t"""doc\nSELECT # not a comment\n"""\n    text = r\'a\\\'b\'\n    print(f"结果 {value}") # 注释\n    return True and value > 1.5e-2\n';
  const { html } = highlightCode(source, 'python');
  assert.equal(plain(html), source);
  assert.match(html, /syntax-keyword">async/); assert.match(html, /syntax-function">计算/);
  assert.match(html, /syntax-builtin">print/); assert.match(html, /syntax-string">&quot;&quot;&quot;doc\nSELECT # not a comment/);
  assert.match(html, /syntax-comment"># 注释/); assert.match(html, /syntax-number">0xFF/);
});

test('highlighting escapes executable markup in all modes and tolerates unfinished code', () => {
  for (const source of ['</pre><img src=x onerror="alert(1)">&amp;', "SELECT '未闭合\\", '/* unfinished', '"""unfinished\n', 'r"unfinished\nprint(1)', '\n\t😀 & < > \' " \n']) {
    for (const language of ['sql', 'python', 'text']) {
      const { html } = highlightCode(source, language);
      assert.equal(plain(html), source); assert.doesNotMatch(html, /<(?:img|script|\/pre)/);
    }
  }
  const large = 'select 1;\n'.repeat(25_000);
  const result = highlightCode(large, 'sql');
  assert.equal(result.limited, true); assert.equal(plain(result.html), large);
});

test('window geometry clamps every resize edge on desktop, mobile and short viewports', () => {
  for (const area of [{ width: 1424, height: 884 }, { width: 359, height: 650 }, { width: 700, height: 260 }]) {
    const initial = fitEditorRect({ x: 100, y: 70, width: 600, height: 500 }, area);
    for (const edge of ['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw']) {
      for (const [dx, dy] of [[-10_000, -10_000], [10_000, 10_000], [80, -90]]) {
        const rect = resizeEditorRect(initial, edge, dx, dy, area);
        assert.ok(rect.x >= 8 && rect.y >= 8);
        assert.ok(rect.x + rect.width <= area.width + 8);
        assert.ok(rect.y + rect.height <= area.height + 8);
        assert.ok(rect.width >= Math.min(420, area.width)); assert.ok(rect.height >= Math.min(360, area.height));
        if (edge.includes('w')) assert.equal(rect.x + rect.width, initial.x + initial.width);
        if (edge.includes('n')) assert.equal(rect.y + rect.height, initial.y + initial.height);
      }
    }
  }
});
