import { test, expect } from '@playwright/test';

// Exercise the real WebGL photo pass separately from sunbeams and floating motes:
// a moving light over a still tree must not qualify as wind in its leaves.
async function photographFrames(page, theme, regions, times, flatSource = false) {
  await page.goto('/api/session');
  return page.evaluate(async ({ theme, regions, times, flatSource }) => {
    const { EnvironmentScene } = await import('/src/environment.js');
    const { getTheme } = await import('/src/themes.js');
    const host = document.createElement('div');
    document.body.append(host);
    const scene = new EnvironmentScene(host);
    scene.set(getTheme(theme), 'still');
    await new Promise((resolve, reject) => {
      const deadline = performance.now() + 10000;
      function loaded() {
        if (scene.image) resolve();
        else if (performance.now() > deadline) reject(new Error('Background photograph did not load'));
        else requestAnimationFrame(loaded);
      }
      loaded();
    });
    if (!scene.gpu) throw new Error('These pixel checks require the actual WebGL renderer');
    if (flatSource) {
      // A flat photograph cannot brighten merely by being displaced. Retain the
      // actual scene masks, then measure light emitted by the real water pass.
      const source = document.createElement('canvas');
      source.width = scene.image.width;
      source.height = scene.image.height;
      const sourceContext = source.getContext('2d');
      sourceContext.fillStyle = '#606060';
      sourceContext.fillRect(0, 0, source.width, source.height);
      scene.image = source;
      scene.paintBacking();
    }
    const composite = document.createElement('canvas');
    composite.width = scene.width;
    composite.height = scene.height;
    const context = composite.getContext('2d', { willReadFrequently: true });
    const frames = times.map(time => {
      scene.context.clearRect(0, 0, scene.width, scene.height);
      if (!scene.gpu.draw(scene.context, time, scene.width, scene.height)) {
        throw new Error('WebGL context was lost');
      }
      context.drawImage(scene.backing, 0, 0);
      context.drawImage(scene.canvas, 0, 0, scene.width, scene.height);
      return Object.fromEntries(Object.entries(regions).map(([name, [x, y, w, h]]) => {
        const cover = scene.cover;
        const pixels = context.getImageData(Math.round(cover.x + x * cover.width),
          Math.round(cover.y + y * cover.height), Math.round(w * cover.width), Math.round(h * cover.height)).data;
        return [name, Array.from(pixels)];
      }));
    });
    scene.stop();
    scene.gpu.gl.getExtension('WEBGL_lose_context')?.loseContext();
    host.remove();
    return frames;
  }, { theme, regions, times, flatSource });
}

function meanRgbChange(before, after) {
  let total = 0;
  for (let i = 0; i < before.length; i++) {
    if (i % 4 !== 3) total += Math.abs(after[i] - before[i]);
  }
  return total / (before.length * .75);
}

test('Shinchan wind moves foreground grass and tree leaves while face and houses remain fixed', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 810 });
  // Image-space regions hand-picked from the unmodified Shinchan photograph.
  const regions = {
    grass: [.49, .88, .07, .065],
    tree: [.944, .232, .04, .065],
    face: [.839, .63, .053, .07],
    houses: [.156, .588, .053, .036],
  };
  const frames = await photographFrames(page, 'shinchan', regions, [0, 2.3, 5.7]);
  const change = name => Math.max(...frames.slice(1).map(frame => meanRgbChange(frames[0][name], frame[name])));
  expect(change('grass'), 'foreground grass must visibly deform').toBeGreaterThan(.1);
  expect(change('tree'), 'upper-right foliage must visibly deform').toBeGreaterThan(.1);
  expect(change('face'), 'wind must not warp Shinchan’s face').toBeLessThan(.01);
  expect(change('houses'), 'wind must not warp the buildings').toBeLessThan(.01);
});

test('Mediterranean gentle waves animate the sea while the coast remains fixed', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 1200 });
  const regions = {
    sea: [.025, .515, .16, .11],
    coast: [.68, .507, .095, .065],
  };
  const times = [0, 1.7, 4.9];
  const photos = await photographFrames(page, 'mediterranean', regions, times);
  expect(Math.max(...photos.slice(1).map(frame => meanRgbChange(photos[0].sea, frame.sea))),
    'the original sea photograph must animate').toBeGreaterThan(.2);
  for (const frame of photos.slice(1)) {
    expect(meanRgbChange(photos[0].coast, frame.coast), 'the coastal buildings must remain fixed').toBeLessThan(.01);
  }

});

test('Paris renders moving bundled WebGL2 raindrops with external network blocked', async ({ page, baseURL }) => {
  const errors = [];
  let rainModuleStatus;
  const localOrigin = new URL(baseURL).origin;
  // Blocking, rather than counting, also isolates antivirus/browser injection.
  // Any remote rain dependency would now fail and leave the fallback active.
  await page.route(/^https?:/, route => new URL(route.request().url()).origin === localOrigin ? route.continue() : route.abort());
  page.on('response', response => {
    if (new URL(response.url()).pathname === '/vendor/raindrop-fx/raindrop-fx.js') rainModuleStatus = response.status();
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');
  await expect(page.locator('#save-status')).toHaveText('已保存');
  await page.getByRole('button', { name: '切换环境', exact: true }).click();
  await page.locator('[data-theme-id="paris"]').click();
  const canvas = page.locator('#effects canvas');
  await expect(canvas).toHaveAttribute('data-renderer', 'webgl2', { timeout: 15000 });
  const pixels = () => canvas.evaluate(element => {
    const data = element.getContext('2d').getImageData(0, 0, element.width, element.height).data;
    let hash = 2166136261;
    for (let index = 0; index < data.length; index += 16) {
      hash = Math.imul(hash ^ data[index], 16777619);
      hash = Math.imul(hash ^ data[index + 1], 16777619);
      hash = Math.imul(hash ^ data[index + 2], 16777619);
    }
    return hash >>> 0;
  });
  const first = await pixels();
  await expect.poll(pixels).not.toBe(first);
  expect(rainModuleStatus).toBe(200);
  expect(errors).toEqual([]);
});
