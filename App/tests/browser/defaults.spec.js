import {test,expect} from '@playwright/test';
test('new library and first page use the Mediterranean default, then remember a chosen theme',async({page})=>{
  await page.goto('/');await expect(page.locator('#save-status')).toHaveText('已保存');
  await expect(page.locator('html')).toHaveAttribute('data-theme','mediterranean');
  await page.getByRole('button',{name:'切换环境',exact:true}).click();
  await page.locator('[data-theme-id="paris"]').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme','paris');
  await page.reload();await expect(page.locator('html')).toHaveAttribute('data-theme','paris');
});
