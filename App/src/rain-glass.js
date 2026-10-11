// Local adapter for SardineFish/Raindrop-FX 1.0.8 (MIT), pinned at
// bae4081bc15815bb094ea040a976dca083bbc3a5. Licenses are beside the vendor file.
// Its mass-based simulation merges drops and sheds smaller trail droplets;
// its normal-map pass refracts the current photograph through the water.
// The scene owns the clock. Never call the library's start() / internal RAF.
let library;
const loadLibrary = () => library ||= import('/vendor/raindrop-fx/raindrop-fx.js');

export class RainGlass {
 constructor() {
  this.canvas = document.createElement('canvas');
  this.ready = false; this.failed = false; this.version = 0;
  this.total = 0; this.previous = null; this.queue = Promise.resolve();
 }

 setBackground(backing) {
  const version = ++this.version;
  this.ready = false;
  this.queue = this.queue.then(async () => {
   if (version !== this.version || this.failed || !backing.width || !backing.height) return false;
   const { default: RaindropFX } = await loadLibrary();
   if (version !== this.version) return false;
   // Cap framebuffer area on large displays, retaining CSS-sized droplets.
   const scale = Math.min(1, 1600 / backing.width, 1000 / backing.height);
   const width = Math.max(1, Math.round(backing.width * scale));
   const height = Math.max(1, Math.round(backing.height * scale));
   const area = width * height / 1000000;
   const options = {
    spawnSize: [38 * scale, 92 * scale],
    spawnInterval: [.13 / Math.max(.45, area), .3 / Math.max(.45, area)],
    spawnLimit: Math.round(250 * Math.max(.5, area)),
    gravity: 1050 * scale, slipRate: .4, motionInterval: [.45, 1.3],
    colliderSize: 1.05, xShifting: [0, .075],
    trailDistance: [14 * scale, 24 * scale], trailDropSize: [.22, .40],
    trailDropDensity: .22, trailSpread: .50,
    initialSpread: .42, shrinkRate: .018, velocitySpread: .32,
    evaporate: 12 * scale * scale,
    dropletsPerSeconds: 36 * area, dropletSize: [4 * scale, 12 * scale],
    backgroundBlurSteps: 0, mist: false, mistBlurStep: 0,
    smoothRaindrop: [.94, .99], refractBase: .065, refractScale: .23,
    raindropCompose: 'smoother',
    raindropDiffuseLight: [.13, .15, .17], raindropShadowOffset: .72,
    raindropSpecularLight: [0, 0, 0], raindropLightBump: .7,
   };
   if (!this.fx) {
    this.canvas.width = width; this.canvas.height = height;
    this.fx = new RaindropFX({ canvas: this.canvas, background: backing, ...options });
    // Upstream's zero-step blur never copies the source to its output. Supply
    // that missing identity case so the Paris photo remains completely sharp.
    const blur = this.fx.renderer.blurRenderer;
    const upstreamBlur = blur.blur.bind(blur);
    blur.blur = (texture, steps, output) => {
     if (steps > 0) return upstreamBlur(texture, steps, output);
     this.fx.renderer.renderer.blit(texture, output);
     return output;
    };
    await this.fx.renderer.loadAssets();
   } else {
    Object.assign(this.fx.options, options);
    this.fx.resize(width, height);
    await this.fx.setBackground(backing);
   }
   if (version !== this.version) return false;
   const simulator = this.fx.simulator;
   simulator.raindrops.length = 0;
   simulator.grid.length = 0;
   simulator.resize();
   simulator.spawner.currentTime = 0; simulator.spawner.nextSpawn = 0;
   this.total = 0;
   // Begin with an established light shower; simulation only, no timer.
   for (let frame = 0; frame < 200; frame++) {
    this.total += .04;
    this.step({ dt: .04, total: this.total });
   }
   this.previous = null;
   this.ready = true;
   return true;
  }).catch(error => {
   this.error = error; this.failed = true; this.ready = false;
   return false;
  });
  return this.queue;
 }

 step(tick) {
  const simulator = this.fx.simulator;
  // Upstream 1.0.8 does not retire evaporated particles. Remove them before
  // mass becomes negative (sqrt(mass) would otherwise poison the GPU buffer).
  for (let i = simulator.raindrops.length - 1; i >= 0; i--) {
   const drop = simulator.raindrops[i];
   if (!drop.destroied && drop.mass > this.fx.options.evaporate * tick.dt + 1 && Number.isFinite(drop.mass)) continue;
   drop.grid?.delete(drop); simulator.raindrops.splice(i, 1);
  }
  simulator.update(tick);
 }

 draw(context, time, width, height) {
  if (!this.ready || !this.fx || this.fx.renderer.renderer.gl.isContextLost()) return false;
  // Scene time is seconds and excludes pauses. Also bound dt defensively if
  // a caller resumes with wall-clock time, so drops never jump down the glass.
  const delta = this.previous === null ? .04 : time - this.previous;
  const dt = delta > 0 && delta <= .12 ? delta : .04;
  this.previous = time; this.total += dt;
  const tick = { dt, total: this.total };
  const simulator = this.fx.simulator;
  this.step(tick);
  this.fx.renderer.render(simulator.raindrops, tick);
  context.drawImage(this.canvas, 0, 0, width, height);
  return true;
 }
}
