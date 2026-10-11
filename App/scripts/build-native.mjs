import {access,cp} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=fileURLToPath(new URL('..',import.meta.url));
let compiler;
for (const framework of ['Framework64','Framework']) {
  const candidate=path.join(process.env.WINDIR||'C:\\Windows','Microsoft.NET',framework,'v4.0.30319','csc.exe');
  try {await access(candidate);compiler=candidate;break;} catch {}
}
if (!compiler) throw new Error('Windows .NET Framework 4 compiler is unavailable.');
const productRoot=path.dirname(root);
const executable=path.join(productRoot,'Carnet.exe');
const result=spawnSync(compiler,['/nologo','/optimize+','/target:winexe','/platform:anycpu','/codepage:65001',
  `/win32icon:${path.join(root,'desktop/app.ico')}`,`/out:${executable}`,'/reference:System.Windows.Forms.dll',path.join(root,'desktop/Launcher.cs')],{encoding:'utf8',windowsHide:true});
if (result.error) throw result.error;
if (result.status!==0) throw new Error(result.stdout+result.stderr);
await cp(executable,path.join(root,'Stop Reader.exe'));
console.log('Windows GUI executables built.');
