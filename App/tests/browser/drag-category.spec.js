import {test,expect} from '@playwright/test';
import {textPdf} from '../fixtures.mjs';

async function dragRowToCategory(page,row,target){
  await row.scrollIntoViewIfNeeded();
  const source=await row.boundingBox();
  const x=source.x+source.width/2,y=source.y+source.height/2;
  await page.mouse.move(x,y);
  await page.mouse.down();
  try{
    // Begin the native drag before scrolling the destination. dragTo scrolls
    // first, which can put a different row under the held mouse in long lists.
    await page.mouse.move(x+12,y,{steps:3});
    await expect(row).toHaveClass(/\bdragging\b/);
    await target.scrollIntoViewIfNeeded();
    const destination=await target.boundingBox();
    const targetX=destination.x+destination.width/2,targetY=destination.y+destination.height/2;
    await page.mouse.move(targetX,targetY,{steps:8});
    await page.mouse.move(targetX+1,targetY);
    await expect(target).toHaveClass(/\bcategory-drop-target\b/);
  }finally{await page.mouse.up();}
}

test('all-files row drags to built-in and custom categories, and survives reload',async({page},testInfo)=>{
  const suffix=`${Date.now()}-${testInfo.repeatEachIndex}`;
  const fileName=`Drag category ${suffix}.pdf`,categoryName=`拖动分类 ${suffix}`;
  const {token}=await (await page.request.get('/api/session')).json();
  // Keep the destination below the fold even when this spec runs on its own.
  for(let index=0;index<7;index++){
    const response=await page.request.post('/api/documents',{
      headers:{'x-carnet-token':token,'Content-Type':'application/pdf','x-file-name':encodeURIComponent(`Drag neighbour ${suffix}-${index}.pdf`)},
      data:textPdf()
    });
    expect(response.ok()).toBeTruthy();
  }
  await page.goto('/');await expect(page.locator('#save-status')).toHaveText('已保存');
  await page.locator('[data-filter=""]').click();
  await page.locator('#file-input').setInputFiles({name:fileName,mimeType:'application/pdf',buffer:textPdf()});
  await expect(page.locator('#reader-host')).toHaveAttribute('aria-busy','false');
  const lib=await (await page.request.get('/api/library')).json();const id=lib.documents.find(d=>d.name===fileName).id;
  const row=page.locator(`[data-drag-document="${id}"]`);
  await dragRowToCategory(page,row,page.locator('[data-filter="fr"]'));
  await expect.poll(async()=> (await (await page.request.get('/api/library')).json()).documents.find(d=>d.id===id).categoryId).toBe('fr');
  await page.getByRole('button',{name:'新增分类',exact:true}).click();await page.getByLabel('分类名称').fill(categoryName);
  await page.getByRole('button',{name:'创建分类',exact:true}).click();await expect(page.getByRole('dialog')).toBeHidden();
  const category=(await (await page.request.get('/api/library')).json()).categories.find(c=>c.name===categoryName);
  await dragRowToCategory(page,row,page.locator(`[data-filter="${category.id}"]`));
  await expect.poll(async()=> (await (await page.request.get('/api/library')).json()).documents.find(d=>d.id===id).categoryId).toBe(category.id);
  await page.reload();await expect(page.locator('#save-status')).toHaveText('已保存');
  await page.locator(`[data-filter="${category.id}"]`).click();await expect(page.getByRole('button',{name:`打开 ${fileName}`,exact:true})).toBeVisible();
  const final=await (await page.request.get('/api/library')).json();expect(final.documents.filter(d=>d.id===id)).toHaveLength(1);
});
