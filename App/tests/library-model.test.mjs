import test from 'node:test';
import assert from 'node:assert/strict';
import {dateGroups, filterDocuments, humanSize} from '../src/library-model.js';

const documents = [
  {id:'1',name:'Bonjour Paris',categoryId:'fr',importedAt:'2026-10-09T10:00:00.000Z'},
  {id:'2',name:'English Essays',categoryId:'en',importedAt:'2026-10-10T09:00:00.000Z'},
  {id:'3',name:'Le Monde',categoryId:'fr',importedAt:'2026-10-10T12:00:00.000Z'}
];
test('date groups count imported documents and sort newest first',()=>{
  assert.deepEqual(dateGroups(documents),[{date:'2026-10-10',count:2},{date:'2026-10-09',count:1}]);
});
test('category, date and case-insensitive search combine without changing the library',()=>{
  assert.deepEqual(filterDocuments(documents,{categoryId:'fr',date:'2026-10-10',query:'MONDE'}).map(x=>x.id),['3']);
  assert.deepEqual(filterDocuments(documents,{}).map(x=>x.id),['3','2','1']);
  assert.deepEqual(documents.map(x=>x.id),['1','2','3']);
});
test('file sizes are readable including an empty file',()=>{
  assert.equal(humanSize(0),'0 B'); assert.equal(humanSize(1024),'1 KB'); assert.equal(humanSize(1572864),'1.5 MB');
});
