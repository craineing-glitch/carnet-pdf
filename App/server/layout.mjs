import path from 'node:path';
import {fileURLToPath} from 'node:url';
export const programRoot=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
export const productRoot=path.dirname(programRoot);
export function dataDirectory(env=process.env){
  return path.resolve(productRoot,env.CARNET_PDF_DATA_DIR||'Files');
}
