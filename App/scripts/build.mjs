import {cp,mkdir,readFile,writeFile,access,readdir,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
if(process.platform==='win32') await import('./build-native.mjs');
const extractorVendor=path.join(root,'server/vendor');
await mkdir(extractorVendor,{recursive:true});
await cp(path.join(root,'node_modules/pdf-lib/dist/pdf-lib.esm.js'),path.join(extractorVendor,'pdf-lib.mjs'));
for(const [dependency,license] of [['pdf-lib','LICENSE.md'],['@pdf-lib/standard-fonts','LICENSE.md'],['@pdf-lib/upng','LICENSE'],['pako','LICENSE'],['tslib','LICENSE.txt']]) {
  await cp(path.join(root,'node_modules',dependency,license),path.join(extractorVendor,'LICENSE-'+dependency.replaceAll('/','-').replace('@','')+'.txt'));
}
const vendor=path.join(root,'public/vendor/pdfjs');
await mkdir(vendor,{recursive:true});
for(const item of ['build/pdf.mjs','build/pdf.worker.mjs','web/pdf_viewer.css','web/pdf_viewer.mjs','cmaps','standard_fonts','wasm','LICENSE']){
  await mkdir(path.dirname(path.join(vendor,item)),{recursive:true});
  await cp(path.join(root,'node_modules/pdfjs-dist',item),path.join(vendor,item),{recursive:true});
}
for(const dir of ['src','server','scripts'])for(const file of await readdir(path.join(root,dir))){if(!/\.m?js$/.test(file))continue;const check=spawnSync(process.execPath,['--check',path.join(root,dir,file)],{encoding:'utf8'});if(check.status!==0)throw new Error(check.stderr);}
const {themes}=await import('../src/themes.js');for(const theme of themes)await access(path.join(root,'public',theme.image));
await access(path.join(root,'index.html'));
await access(path.join(root,'public/vendor/raindrop-fx/raindrop-fx.js'));
await access(path.join(root,'public/vendor/raindrop-fx/LICENSE'));
const manifest=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
await writeFile(path.join(root,'BUILD.json'),JSON.stringify({product:'Carnet PDF',version:manifest.version,pdfjs:'6.4.299',themes:themes.length},null,2)+'\n');
console.log(`Build ready: PDF.js bundled locally, ${themes.length} Carnet themes, JavaScript syntax verified.`);
