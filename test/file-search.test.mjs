import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileTools } from '../lib/file-tools.mjs';
import { ProjectFiles } from '../lib/project-files.mjs';

async function allNames(tools, options) {
  let cursor, page, pages=0; const results=[];
  do { page=await tools.search({...options,filenames:true,cursor});pages++;results.push(...page.results);cursor=page.nextCursor;assert.equal(page.limited,false);assert.ok(page.results.length<=200);assert.ok(pages<200); } while(cursor);
  return {...page,results,pages};
}
test('filename search reaches past 4000 entries and resumes rather than rescanning from the root',async t=>{
  let visits=0,closed=false;
  const tools=new FileTools({resolve:async cwd=>({root:cwd}),async *walk(){try{for(let i=0;i<6005;i++){visits++;yield {kind:'file',path:i===6004?'deep/target.sql':'file-'+i+'.txt'};}}finally{closed=true;}}});
  t.after(()=>tools.close());
  const result=await allNames(tools,{cwd:'/project',query:'target'});
  assert.deepEqual(result.results.map(hit=>hit.path),['deep/target.sql']);assert.equal(result.scanned,6005);assert.equal(visits,6005);assert.ok(result.pages>=4);assert.equal(closed,true);assert.equal(result.complete,true);
});
test('file name pagination is replayable, scoped to the query/project, and preserves every match',async t=>{
  let visits=0;
  const tools=new FileTools({resolve:async cwd=>({root:cwd}),async *walk(){for(let i=0;i<651;i++){visits++;yield {kind:'file',path:'match-'+i+'.sql'};}}});
  t.after(()=>tools.close());
  const options={cwd:'/project',query:'MATCH',filenames:true}, first=await tools.search(options);
  await assert.rejects(tools.search({...options,cwd:'/other',cursor:first.nextCursor}),{status:409});
  await assert.rejects(tools.search({...options,query:'different',cursor:first.nextCursor}),{status:409});
  const next=await tools.search({...options,cursor:first.nextCursor}), count=visits;
  assert.deepEqual(await tools.search({...options,cursor:first.nextCursor}),next);assert.equal(visits,count);
  const hits=[...first.results,...next.results];let cursor=next.nextCursor;
  while(cursor){const page=await tools.search({...options,cursor});hits.push(...page.results);cursor=page.nextCursor;}
  assert.equal(hits.length,651);assert.equal(new Set(hits.map(hit=>hit.path)).size,651);assert.equal(visits,651);
});
test('cancelled filename searches release their iterator and never return partial results as complete',async t=>{
  const controller=new AbortController();let closed=false;
  const tools=new FileTools({resolve:async cwd=>({root:cwd}),async *walk(){try{yield {kind:'file',path:'one.sql'};controller.abort();yield {kind:'file',path:'two.sql'};}finally{closed=true;}}});
  t.after(()=>tools.close());
  await assert.rejects(tools.search({cwd:'/project',query:'.sql',filenames:true,signal:controller.signal}),{name:'AbortError'});
  assert.equal(closed,true);assert.equal(tools.searches.size,0);
});
test('filename search traverses a directory larger than the old 10000-entry ceiling without hidden or symlink traversal',async t=>{
  const cwd=await realpath(await mkdtemp(path.join(tmpdir(),'lemon-full-search-'))), files=new ProjectFiles(), tools=new FileTools(files);
  t.after(()=>tools.close());
  await mkdir(path.join(cwd,'many'));await mkdir(path.join(cwd,'AIdata'));await mkdir(path.join(cwd,'node_modules'));await mkdir(path.join(cwd,'.private'));
  for(const dir of ['AIdata','node_modules','.private']) await writeFile(path.join(cwd,dir,'match-secret.sql'),'not visible');
  await symlink(path.join(cwd,'many'),path.join(cwd,'alias'));
  for(let start=0;start<10005;start+=200) await Promise.all(Array.from({length:Math.min(200,10005-start)},(_,n)=>writeFile(path.join(cwd,'many','match-'+(start+n)+'.sql'),'')));
  const result=await allNames(tools,{cwd,query:'match-'});
  assert.equal(result.results.length,10005);assert.equal(result.skipped,0);
  assert.ok(result.results.every(hit=>hit.path.startsWith('many/match-')));assert.ok(result.results.some(hit=>hit.path==='many/match-10004.sql'));
});

