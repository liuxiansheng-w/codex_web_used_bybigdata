import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueryHistory } from '../public/query-history.js';
import { filterRows } from '../public/sql-query.js';
import { EventEmitter } from 'node:events';
import { Workspace } from '../lib/workspace.mjs';
test('file search automatically continues sparse batches and pages abundant matches without dropping late files', async t=>{
  const {JSDOM}=await import('jsdom'),{readFile}=await import('node:fs/promises'),{createFileTree}=await import('../public/file-tree.js');
  const dom=new JSDOM(await readFile(new URL('../public/index.html',import.meta.url),'utf8')),previous=globalThis.document;
  globalThis.document=dom.window.document;t.after(()=>{globalThis.document=previous;dom.window.close();});
  const $=id=>document.getElementById(id),calls=[];
  const tree=createFileTree({api:async route=>{
    if(!route.startsWith('/api/project/search'))return {entries:[],nextOffset:null};
    const url=new URL(route,'http://localhost'),cursor=url.searchParams.get('cursor'),query=url.searchParams.get('query');calls.push({cursor,query});
    if(query==='target')return cursor?{results:[{path:'late/target.sql'}],scanned:6000,complete:true,nextCursor:null}:{results:[],scanned:2000,complete:false,nextCursor:'continue'};
    const count=cursor?5:200,offset=cursor?200:0;
    return {results:Array.from({length:count},(_,i)=>({path:'match-'+(i+offset)+'.sql'})),scanned:205,complete:!!cursor,nextCursor:cursor?null:'page2'};
  },onOpen:()=>{},onAttach:()=>{},hasAttachment:()=>false,notice:()=>{}});
  const search=query=>{$('fileSearch').value=query;$('fileSearch').dispatchEvent(new dom.window.Event('input'));};
  const until=async fn=>{for(let i=0;i<200;i++){if(fn())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('search did not finish');};
  tree.setProject('/project');search('target');await until(()=>$('projectFileTree').textContent.includes('late/target.sql'));
  assert.equal(calls.filter(call=>call.query==='target').length,2);assert.doesNotMatch($('projectFileTree').textContent,/扫描上限|没有匹配/);
  search('match');await until(()=>[...$('projectFileTree').querySelectorAll('button')].some(button=>button.textContent==='下一页'));
  assert.equal($('projectFileTree').querySelectorAll('.file-leaf').length,200);
  [...$('projectFileTree').querySelectorAll('button')].find(button=>button.textContent==='下一页').click();
  await until(()=>$('projectFileTree').textContent.includes('match-204.sql'));
  assert.equal($('projectFileTree').querySelectorAll('.file-leaf').length,5);
  [...$('projectFileTree').querySelectorAll('button')].find(button=>button.textContent==='上一页').click();
  assert.equal($('projectFileTree').querySelectorAll('.file-leaf').length,200);assert.equal(calls.filter(call=>call.query==='match').length,2);
  tree.setProject('/done');
});
test('project filename search ignores stale responses after changing projects or search terms', async t => {
  const {JSDOM} = await import('jsdom'), {readFile} = await import('node:fs/promises'), {createFileTree} = await import('../public/file-tree.js');
  const dom = new JSDOM(await readFile(new URL('../public/index.html',import.meta.url),'utf8')), previous = globalThis.document;
  globalThis.document = dom.window.document; t.after(()=>{globalThis.document=previous;dom.window.close();});
  const $=id=>document.getElementById(id), requests=[];
  const tree = createFileTree({api:async route=>route.startsWith('/api/project/search')?new Promise(resolve=>requests.push({route,resolve})):{entries:[],nextOffset:null},onOpen:()=>{},onAttach:()=>{},hasAttachment:()=>false,notice:()=>{}});
  const search = value=>{$('fileSearch').value=value;$('fileSearch').dispatchEvent(new dom.window.Event('input'));};
  const wait = async n=>{for(let i=0;i<100&&requests.length<n;i++) await new Promise(resolve=>setTimeout(resolve,5));assert.equal(requests.length,n);};
  tree.setProject('/one');search('first');await wait(1);tree.setProject('/two');search('second');await wait(2);
  requests[0].resolve({results:[{path:'wrong.sql'}]});await new Promise(resolve=>setImmediate(resolve));assert.doesNotMatch($('projectFileTree').textContent,/wrong/);
  requests[1].resolve({results:[{path:'deep/unopened.sql'}]});await new Promise(resolve=>setImmediate(resolve));assert.match($('projectFileTree').textContent,/deep\/unopened.sql/);
  search('later');await wait(3);search('');requests[2].resolve({results:[{path:'stale.sql'}]});await new Promise(resolve=>setImmediate(resolve));assert.doesNotMatch($('projectFileTree').textContent,/stale/);tree.setProject('/three');
});

function memory() { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }; }
function record(id, cwd = '/project', count = 4) { return { id, name: '结果 ' + id, page: 2, pageSize: 50, filter: '', filters: [{ column: 'value', op: 'gt', value: '1' }], sort: { column: 'value', direction: -1 }, result: { cwd, path: 'demo.sql', sql: 'SELECT value FROM demo', engine: 'huawei', parameters: { date: '20260918' }, columns: ['value'], rows: Array.from({length:count}, (_, n) => [n]), rowCount: count, startedAt: id, durationMs: 500, ok: true } }; }

test('query cache is opt-in, keeps project/query identity and filter state, and clears on opt-out', () => {
  const storage = memory(), history = createQueryHistory(storage), records = [record(1), record(2, '/other')];
  history.write(records); assert.equal(storage.getItem('lemon:queryResults:v1'), null);
  history.setEnabled(true); history.write(records);
  const restored = history.read(); assert.equal(restored.length, 2); assert.equal(restored[0].result.cwd, '/other'); assert.equal(restored[1].result.parameters.date, '20260918');
  assert.equal(restored[1].page, 0); assert.equal(restored[1].result.restored, true);
  assert.deepEqual(filterRows(restored[1].result, restored[1].filter, restored[1].sort, restored[1].filters), [[3], [2]]);
  history.setEnabled(false); assert.deepEqual(history.read(), []); assert.equal(storage.getItem('lemon:queryResults:v1'), null); assert.equal(records[0].result.rows.length, 4);
});

test('bounded cache labels truncated previews and never pretends restored in-flight work completed', () => {
  const storage = memory(), history = createQueryHistory(storage); history.setEnabled(true);
  const records = Array.from({length:22}, (_, n) => record(n+1, '/project', 1002));
  records[21].result.loading = true; records[21].result.downloadUrl = 'javascript:alert(1)';
  history.write(records); const restored = history.read();
  assert.equal(restored.length, 20); assert.equal(restored[0].result.uncertain, true); assert.equal(restored[0].result.loading, false); assert.equal(restored[0].result.ok, false); assert.equal(restored[0].result.downloadUrl, null);
  assert.equal(restored[1].result.rows.length, 1000); assert.equal(restored[1].result.rowCount, 1002); assert.equal(restored[1].result.truncated, true); assert.equal(records[20].result.rows.length, 1002);
  const large = record(23); large.result.rows = [['x'.repeat(3_900_000)]]; history.write([large]);
  assert.equal(history.read()[0].result.truncated, true); assert.equal(history.read()[0].result.rows.length, 0);
});

test('malformed stored filters and records cannot crash result rendering', () => {
  const storage = memory(), history = createQueryHistory(storage); history.setEnabled(true);
  const tab = record(1); tab.filters = [null, {}, {column:'value',op:'arbitrary',value:2}]; tab.sort = {column:'missing',direction:4}; tab.pageSize = -5;
  storage.setItem('lemon:queryResults:v1', JSON.stringify([null, tab, tab, {id:2}]));
  const restored = history.read(); assert.equal(restored.length, 1); assert.deepEqual(restored[0].filters, []); assert.equal(restored[0].sort, null); assert.equal(restored[0].pageSize, 50);
  storage.setItem('lemon:queryResults:v1', 'broken'); assert.deepEqual(history.read(), []);
});

test('content search reads every paged thread without resuming tasks, ignores commands and other projects', async () => {
  const bridge = new EventEmitter(), calls = [], cwd = '/private/tmp';
  const data = Array.from({length:9}, (_, n) => ({id:'t'+n,name:'会话 '+n,cwd,updatedAt:n+1}));
  let active = 0, maximum = 0;
  bridge.request = async (method, params) => {
    calls.push({method,params});
    if (method === 'thread/list') return {data,nextCursor:'next-page'};
    assert.equal(method, 'thread/read'); active++; maximum = Math.max(maximum, active); await new Promise(resolve => setImmediate(resolve)); active--;
    if (params.threadId === 't7') throw new Error('offline');
    const index = Number(params.threadId.slice(1));
    return {thread:{id:params.threadId,cwd:index===6?'/other':cwd,turns:index===5?undefined:[{items:[{type:index===0?'commandExecution':'agentMessage',text:index<3||index===6||index===8?'需要 needle 指标':'无匹配'}]}]}};
  };
  const workspace = new Workspace(bridge, cwd);
  const result = await workspace.list(cwd, 'page-one', {search:'needle',scope:'content'});
  assert.deepEqual(result.threads.map(thread => thread.id), ['t1','t2','t8']); assert.equal(result.nextCursor, 'next-page'); assert.equal(result.partial, true); assert.equal(result.searched, 9);
  assert.ok(maximum <= 4); assert.equal(calls.filter(call => call.method === 'thread/read').length, 9); assert.equal(calls[0].params.searchTerm, undefined); assert.equal(workspace.threads.size, 0);
  assert.match(result.threads[0].preview, /needle/);
});

test('opt-in result cache restores exact checkbox values, including an empty selection, and rejects malformed selections', () => {
  const storage = memory(), history = createQueryHistory(storage); history.setEnabled(true);
  const first = record(1); first.filter = ''; first.filters = [{column:'value', op:'in', values:['number:2', 'number:3']}];
  const empty = record(2); empty.filters = [{column:'value', op:'in', values:[]}];
  const invalid = record(3); invalid.filters = [{column:'value', op:'in', values:[null, {}]}, {column:'value', op:'in', values:'number:1'}];
  history.write([first, empty, invalid]); const restored = history.read();
  assert.deepEqual(restored[0].filters, []);
  assert.deepEqual(filterRows(restored[1].result, '', null, restored[1].filters), []);
  assert.deepEqual(filterRows(restored[2].result, '', null, restored[2].filters), [[2], [3]]);
});
