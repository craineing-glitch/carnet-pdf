import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {dataDirectory,productRoot} from '../server/layout.mjs';
import {browserLaunch} from '../scripts/launch.mjs';

test('portable library uses Files beside the launcher, independent of working directory',()=>{
  assert.equal(dataDirectory({}),path.join(productRoot,'Files'));
});
test('custom library paths and browser profiles use the same product directory',async()=>{
  const env={CARNET_PDF_DATA_DIR:'CustomFiles',ProgramFiles:path.join(productRoot,'fake-programs')};
  const chrome=path.join(env.ProgramFiles,'Google/Chrome/Application/chrome.exe');
  const launch=await browserLaunch(productRoot,'http://127.0.0.1:4328',env,async candidate=>candidate===chrome);
  assert.equal(launch.profileDirectory,path.join(dataDirectory(env),'browser-profile'));
  assert.equal(dataDirectory(env),path.join(productRoot,'CustomFiles'));
});
