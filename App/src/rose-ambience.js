// Rose-dusk light study. Original implementation, with no runtime dependencies.
// The photographic petals supply the bloom mask; the car remains outside it.
// Design references: masked sources, soft bloom and slowly changing light:
// https://docs.wallpaperengine.io/en/scene/effects/effect/shine.html
// https://docs.wallpaperengine.io/en/scene/effects/effect/godrays.html
// Particle lifetime fades and gentle turbulence, rather than random flashing:
// https://docs.wallpaperengine.io/en/scene/particles/component/operator.html
// Independent depth/size/opacity groups (reference only; no library code used):
// https://github.com/tsparticles/tsparticles/blob/main/markdown/Options/Particles.md

const TAU = Math.PI * 2;
const fraction = value => value - Math.floor(value);
const smooth = (lo, hi, value) => {
 const t = Math.max(0, Math.min(1, (value - lo) / (hi - lo)));
 return t * t * (3 - 2 * t);
};
const seed = value => fraction(Math.sin(value * 127.1 + 311.7) * 43758.5453);
const cache = new WeakMap();
const palette = ['255,219,188', '255,180,177', '255,238,210'];
const petalPoints = [
 [.270,.414,1.0], [.385,.480,.72], [.480,.478,.62], [.280,.524,.76],
 [.331,.627,1.0], [.477,.566,.80], [.613,.582,1.0], [.678,.702,.72],
 [.537,.390,.62], [.659,.470,.62], [.457,.553,.52], [.568,.649,.60],
];

// These populations are fixed and evaluated from absolute scene time. Pausing,
// resuming or drawing an arbitrary frame never spawns a second animation loop.
const motes = Array.from({ length: 66 }, (_, index) => {
 const layer = index < 34 ? 0 : index < 58 ? 1 : 2;
 return {
  layer, x: .16 + seed(index + 1) * .535,
  y: .392 + seed(index + 83) * .329,
  life: 12 + seed(index + 24) * 14,
  phase: seed(index + 191), turn: seed(index + 76) * TAU,
  radius: layer === 0 ? 3.5 + seed(index + 52) * 2.5
   : layer === 1 ? 16 + seed(index + 52) * 10 : 24 + seed(index + 52) * 18,
  tint: index % palette.length,
 };
});

function sprite(color, bokeh = false) {
 const canvas = document.createElement('canvas');
 canvas.width = canvas.height = 128;
 const ctx = canvas.getContext('2d'), gradient = ctx.createRadialGradient(64,64,0,64,64,64);
 const stops = bokeh ? [[0,.66],[.28,.63],[.5,.42],[.74,.13],[1,0]]
  : [[0,1],[.13,.78],[.32,.40],[.59,.10],[.82,.018],[1,0]];
 for (const [offset, alpha] of stops) gradient.addColorStop(offset, `rgba(${color},${alpha})`);
 ctx.fillStyle = gradient; ctx.fillRect(0,0,128,128);
 return canvas;
}

function windowPath(scene) {
 const path = new Path2D(), point = (x,y) => scene.photoPoint(x,y);
 const move = (x,y) => { const p=point(x,y);path.moveTo(p.x,p.y); };
 const line = (x,y) => { const p=point(x,y);path.lineTo(p.x,p.y); };
 const curve = (x1,y1,x2,y2,x3,y3) => {
  const a=point(x1,y1),b=point(x2,y2),c=point(x3,y3);
  path.bezierCurveTo(a.x,a.y,b.x,b.y,c.x,c.y);
 };
 // A conservative inset follows the windshield opening, then the mirror's
 // upper/right edge. The sill, mirror, pillar, roof and seat never receive light.
 move(.042,.533);
 curve(.17,.366,.29,.270,.450,.228);
 curve(.54,.203,.646,.189,.735,.188);
 line(.702,.721); line(.235,.727);
 curve(.238,.663,.220,.608,.192,.600);
 curve(.137,.577,.087,.587,.042,.607);
 path.closePath();
 return path;
}

function petalBloom(scene) {
 // Extract warm petals once at modest resolution. The derived transparent
 // canvas is a light layer only; the supplied photograph is never modified.
 const scale = Math.min(1, 480 / scene.width, 360 / scene.height);
 const source = document.createElement('canvas');
 source.width = Math.max(1, Math.round(scene.width * scale));
 source.height = Math.max(1, Math.round(scene.height * scale));
 const ctx = source.getContext('2d', { willReadFrequently: true });
 ctx.drawImage(scene.backing,0,0,source.width,source.height);
 const pixels = ctx.getImageData(0,0,source.width,source.height), data = pixels.data;
 for (let y=0;y<source.height;y++) for (let x=0;x<source.width;x++) {
  const i=(y*source.width+x)*4;
  const px=(x/scale-scene.cover.x)/scene.cover.width;
  const py=(y/scale-scene.cover.y)/scene.cover.height;
  const region=smooth(.20,.25,px)*(1-smooth(.68,.71,px))*smooth(.35,.39,py)*(1-smooth(.70,.73,py));
  const warm=smooth(12,56,data[i]-data[i+1])*smooth(22,120,data[i]);
  data[i]=255;data[i+1]=155;data[i+2]=137;data[i+3]=Math.round(255*warm*region);
 }
 ctx.putImageData(pixels,0,0);
 const bloom=document.createElement('canvas');bloom.width=source.width;bloom.height=source.height;
 const light=bloom.getContext('2d');
 light.filter='blur(6px)';light.globalAlpha=.68;light.drawImage(source,0,0);
 light.filter='blur(2px)';light.globalAlpha=.34;light.drawImage(source,0,0);
 return bloom;
}

function resources(scene) {
 const key = [scene.width,scene.height,scene.cover.x,scene.cover.y,scene.cover.width,scene.cover.height].join(':');
 let entry=cache.get(scene);
 if (!entry || entry.key!==key || entry.backing!==scene.backing) {
  entry={key,backing:scene.backing,clip:windowPath(scene),bloom:petalBloom(scene),
   lights:palette.map(color=>sprite(color)),bokeh:palette.map(color=>sprite(color,true))};
  cache.set(scene,entry);
 }
 return entry;
}

function light(ctx,texture,x,y,rx,ry,alpha) {
 if (alpha < .001 || rx <= 0 || ry <= 0) return;
 ctx.globalAlpha=alpha;
 ctx.drawImage(texture,x-rx,y-ry,rx*2,ry*2);
}

/** Draw after the scene's photograph pass; t is the parent's elapsed seconds. */
export function drawRoseAmbience(scene,ctx,t) {
 if (!scene.backing || !scene.cover || scene.width<=0 || scene.height<=0) return;
 const art=resources(scene), size=Math.max(.65,Math.min(1.5,scene.cover.width/1440));
 ctx.save();ctx.clip(art.clip);ctx.globalCompositeOperation='screen';

 // Broad, barely breathing color carries through the reader's frosted glass.
 // Sources stay among the roses, so the moon does not become a second sun.
 const left=scene.photoPoint(.352+Math.sin(t*.055)*.012,.526);
 const right=scene.photoPoint(.587+Math.sin(t*.046+2)*.010,.584);
 light(ctx,art.lights[1],left.x,left.y,scene.cover.width*.235,scene.cover.height*.22,.145+Math.sin(t*.15)*.018);
 light(ctx,art.lights[0],right.x,right.y,scene.cover.width*.225,scene.cover.height*.20,.12+Math.sin(t*.13+1)*.015);
 ctx.globalAlpha=.46+Math.sin(t*.17)*.055;
 ctx.drawImage(art.bloom,0,0,scene.width,scene.height);

 const moon=scene.photoPoint(.492,.424);
 light(ctx,art.lights[2],moon.x,moon.y,77*size,77*size,.095+Math.sin(t*.105)*.01);

 // Petal-attached highlights have a soft core, no long diffraction crosses.
 // Unequal cycles and a nonzero floor keep the light unhurried and continuous.
 for (let i=0;i<petalPoints.length;i++) {
  const [px,py,weight]=petalPoints[i],p=scene.photoPoint(px,py);
  const phase=.5+.5*Math.sin(t*(.30+(i%4)*.017)+i*2.399);
  const breath=.32+.68*phase*phase;
  light(ctx,art.lights[i%2],p.x,p.y,49*weight*size,42*weight*size,.25*breath);
  if (i%3===0) {
   light(ctx,art.lights[2],p.x-3*size,p.y-4*size,18*size,14*size,.56*breath);
  }
 }

 // Far pinpoints, middle-distance luminous dust and a handful of foreground
 // bokeh share a breeze, but move at different speeds and focal sizes.
 for (let i=0;i<motes.length;i++) {
  const mote=motes[i],phase=fraction(t/mote.life+mote.phase);
  const fade=smooth(0,.23,phase)*(1-smooth(.71,1,phase));
  if (fade<.004) continue;
  const depth=mote.layer+1;
  const x=mote.x+Math.sin(t*(.070+depth*.012)+mote.turn)*(.003+depth*.0018);
  const y=mote.y-(phase-.5)*(.021+depth*.007)+Math.cos(t*.061+mote.turn)*.004;
  const p=scene.photoPoint(x,y),r=mote.radius*size;
  const opacity=(mote.layer===0?.55:mote.layer===1?.65:.29)*fade;
  light(ctx,mote.layer===2?art.bokeh[mote.tint]:art.lights[mote.tint],p.x,p.y,r,r,opacity);
  if (mote.layer<2) {
   light(ctx,art.lights[2],p.x,p.y,(mote.layer===0?1.3:2.0)*size,(mote.layer===0?1.3:2.0)*size,.77*fade);
  }
 }
 ctx.restore();
}
