import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTypescript} from './helpers/typescript.mjs';
const {markdownInlineTokens}=loadTypescript('src/markdownInline.ts');
const {xmlText}=loadTypescript('src/xmlText.ts');
test('unclosed brackets are plain text with bounded scanning',()=>{
  const text='[a '.repeat(100000),start=performance.now();
  assert.deepEqual(markdownInlineTokens(text),[]);
  assert.ok(performance.now()-start<1500);
});
test('balanced URL parentheses and literal word/math delimiters survive preview parsing',()=>{
  const text='snake_case_name 2*3*4 [article](https://example.com/a(b(c))) **bold** _italic_';
  const tokens=markdownInlineTokens(text);
  assert.equal(tokens.length,3);
  assert.equal(tokens[0].groups[5],'https://example.com/a(b(c))');
  assert.equal(tokens[1].groups[7],'bold');
  assert.equal(tokens[2].groups[11],'italic');
});
test('XML cleanup preserves valid Unicode and replaces invalid controls/surrogates',()=>{
  assert.equal(xmlText('中文🙂\u000b\ud800\t'),'中文🙂��\t');
});
