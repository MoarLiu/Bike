import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = ts.createSourceFile('main.cjs',readFileSync(new URL('./main.cjs',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
const declarations = source.statements.flatMap(statement=>ts.isVariableStatement(statement)?[...statement.declarationList.declarations]:[]);
const names=['isRecord','allowedSyncMethodForPath','createSyncRequestUrl'];
const code=names.map(name=>`const ${name}=${declarations.find(item=>item.name.getText(source)===name).initializer.getText(source)};`).join('\n');
const build=vm.runInNewContext(`${code}\ncreateSyncRequestUrl`,{URL});

test('native Electron sync admits the exact engine negotiation on all v2 routes',()=>{
  for(const [pathname,method] of [['/api/v2/status','GET'],['/api/v2/enable','POST'],['/api/v2/operations','POST'],['/api/v2/operation-chunks/large%2Fedit/0','GET'],['/api/v2/receipts/id','GET']]){
    assert.equal(build({serverUrl:'https://fixture.invalid/prefix',pathname:pathname+'?bikeOrdering=2',method}).url,
      'https://fixture.invalid/prefix'+pathname+'?bikeOrdering=2');
  }
  assert.ok(build({serverUrl:'https://fixture.invalid',pathname:'/api/v2/events?after=4&bikeOrdering=2'}).url.includes('after=4'));
  for(const pathname of ['/api/v2/status?bikeOrdering=3','/api/v2/status?after=1','/api/v2/status?redirect=https://outside.invalid','/api/documents/a?bikeOrdering=2']){
    assert.throws(()=>build({serverUrl:'https://fixture.invalid',pathname}),/参数/);
  }
});
