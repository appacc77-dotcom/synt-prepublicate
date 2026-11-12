import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { chromium } from 'playwright';
const dist = '/Users/gleb/Documents/deepseek-harness/default-workspace/syntonia-v2/dist';
const mime={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.woff2':'font/woff2','.woff':'font/woff','.mp4':'video/mp4'};
const srv=createServer((q,r)=>{let p=decodeURIComponent(new URL(q.url,'http://x').pathname); if(p==='/')p='/index.html'; const f=normalize(join(dist,p)); if(!existsSync(f)||!statSync(f).isFile()){r.writeHead(404);r.end();return;} r.writeHead(200,{'content-type':mime[extname(f)]||'application/octet-stream'}); r.end(readFileSync(f));});
srv.listen(4370,'127.0.0.1',async()=>{
  const b=await chromium.launch(); const pg=await b.newPage({viewport:{width:1440,height:900}});
  await pg.goto('http://127.0.0.1:4370/',{waitUntil:'load', timeout: 60000});
  await pg.evaluate(() => document.fonts.ready);
  await pg.evaluate(async () => { for (const img of document.images) { try { await Promise.race([img.decode(), new Promise(r => setTimeout(r, 3000))]); } catch {} } });
  const h = await pg.evaluate(() => document.documentElement.scrollHeight);
  console.log('высота v2:', h);
  await pg.screenshot({ path: '/tmp/v2-home.png', fullPage: true, timeout: 120000 });
  console.log('снято');
  await b.close(); srv.close();
});
