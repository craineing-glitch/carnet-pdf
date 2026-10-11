import {defineConfig} from '@playwright/test';
import path from 'node:path';
const port=process.env.TEST_PORT||'4340';
export default defineConfig({
  testDir: './tests/browser', timeout: 60000, workers: 1,
  outputDir: '../.work/browser-results',
  use: {baseURL:`http://127.0.0.1:${port}`, headless:true, channel:process.env.TEST_BROWSER||'msedge', launchOptions:{ignoreDefaultArgs:['--hide-scrollbars']}, viewport:{width:1440,height:1000}, screenshot:'only-on-failure',trace:'retain-on-failure'},
  webServer:{command:'node server/server.mjs',url:`http://127.0.0.1:${port}/api/session`,reuseExistingServer:false,env:{PORT:port,CARNET_PDF_DATA_DIR:path.resolve('../.work/browser-data-'+Date.now())}}
});
