import { RainGlass } from './rain-glass.js';
import { drawRoseAmbience } from './rose-ambience.js';

const TAU = Math.PI * 2;
const FRAME_INTERVAL = 40;
const fraction = value => value - Math.floor(value);
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const animatedEffects = new Set(['rain', 'sea', 'dusk', 'sunshine']);

// Image-space effects follow the same masked, perspective-aware approach as
// Wallpaper Engine's scene editor. No photograph or icon file is modified.
// https://docs.wallpaperengine.io/en/scene/first/effects.html
// https://docs.wallpaperengine.io/en/scene/effects/effect/waterripple.html
const WATER_OUTLINES = {
 mediterranean: [[0,.379],[.70,.379],[.68,.399],[.62,.411],[.57,.427],[.55,.443],
  [.46,.458],[.42,.481],[.39,.503],[.44,.511],[.50,.519],[.54,.523],
  [.51,.548],[.46,.570],[.40,.584],[.37,.605],[.33,.628],[.26,.655],
  [.23,.688],[.16,.711],[.09,.730],[0,.721]],
 shinchan: [[0,.719],[.29,.709],[.56,.695],[.70,.687],[.78,.701],[.80,.711],
  [.74,.748],[.62,.791],[.47,.836],[.34,.870],[.22,.911],[.09,.949],[0,.967]],
};

// Separate leaf/grass weights, following Wallpaper Engine's masked UV sway.
// https://docs.wallpaperengine.io/en/scene/effects/effect/sway.html
const FOLIAGE_OUTLINES = [
 [[.948,0],[1,0],[1,.40],[.974,.365],[.953,.338],[.918,.318],[.899,.291],
  [.928,.216],[.904,.162],[.919,.093],[.938,.06]],
 [[0,.974],[.08,.952],[.11,.917],[.134,.903],[.158,.952],[.20,.922],
  [.235,.883],[.275,.872],[.307,.920],[.348,.913],[.387,.862],[.421,.89],
  [.462,.883],[.49,.832],[.526,.888],[.56,.833],[.60,.825],[.64,.812],
  [.70,.776],[.75,.75],[.81,.718],[.85,.721],[.93,.695],[1,.658],[1,1],[0,1]],
 [[.97,.546],[1,.515],[1,.72],[.962,.732],[.953,.647]],
];
const CHARACTER_OUTLINE = [[.818,.573],[.874,.554],[.931,.572],[.954,.62],[.955,.692],
 [.939,.746],[.938,.817],[.908,.861],[.85,.868],[.801,.864],[.799,.825],
 [.82,.798],[.808,.762],[.81,.731],[.792,.696],[.806,.625]];

const VERTEX = `
attribute vec2 a_position;
varying vec2 v_uv;
void main() { v_uv = vec2(a_position.x * .5 + .5, .5 - a_position.y * .5); gl_Position = vec4(a_position, 0., 1.); }
`;
const FRAGMENT = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_photo;
uniform sampler2D u_mask;
uniform sampler2D u_foliage;
uniform vec2 u_resolution;
uniform vec4 u_cover;
uniform float u_time;
uniform float u_effect;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
vec3 photograph(vec2 p) { return texture2D(u_photo, clamp(p / u_resolution, vec2(.001), vec2(.999))).rgb; }
float softUnion(float a, float b, float k) {
 float h = max(k - abs(a - b), 0.) / k;
 return min(a, b) - h * h * k * .25;
}
float dropDistance(vec2 q, float seed) {
 // Surface tension holds a rounded, off-centre bulb at the bottom. The neck
 // climbs into its wet trail; it is deliberately not a stretched ellipse.
 float bend = .10 * sin(q.y * 1.9 + seed * 19.);
 vec2 bulb = vec2((q.x - bend) * mix(1.05, 1.33, seed), q.y - .10);
 float angle = atan(bulb.y, bulb.x);
 float body = length(bulb) - .89 + .045 * sin(angle * 3. + seed * 17.);
 float neckLength = mix(1.35, 3.4, seed);
 float width = mix(.075, .47, smoothstep(-neckLength, -.1, q.y));
 float axis = .12 * sin(q.y * 1.1 + seed * 20.);
 float neck = length(vec2(q.x - axis, q.y - clamp(q.y, -neckLength, -.2))) - width;
 return softUnion(body, neck, .24);
}

void main() {
 vec2 p = v_uv * u_resolution;
 vec2 photo = (p - u_cover.xy) / u_cover.zw;
 float t = u_time;
 vec3 original = photograph(p);
 vec3 color = original;
 float alpha = 0.;

 if (u_effect < 1.5) {
  // Sparse running drops catch on glass and release, leaving hairline trails.
  // Refraction provides the outline: no full white ring or oval is painted.
  vec2 cells = vec2(137., 211.);
  vec2 grid = floor(p / cells);
  vec2 normal = vec2(0.);
  float surface = 0.;
  float edge = 0.;
  float highlight = 0.;
  for (int yy = -1; yy <= 1; yy++) {
   for (int xx = -1; xx <= 1; xx++) {
    float column = grid.x + float(xx);
    float columnSeed = hash(vec2(column, 19.));
    float speed = mix(22., 49., columnSeed);
    float travel = t * speed + sin(t * .83 + columnSeed * 23.) * speed * 1.12;
    float row = floor((p.y - travel) / cells.y) + float(yy);
    vec2 id = vec2(column, row);
    float seed = hash(id);
    float present = step(.26, seed);
    vec2 center = (id + vec2(.16 + .68 * seed, .16 + .68 * hash(id + 7.))) * cells + vec2(0.,travel);
    center.x += sin(center.y * .018 + seed * 29.) * 2.1;
    float radius = mix(3.2, 8.2, pow(hash(id + 3.), 1.6));
    vec2 q = (p - center) / radius;
    if (present > .5 && abs(q.x) < 1.5 && q.y > -4. && q.y < 1.4) {
     float d = dropDistance(q, seed);
     float lens = 1. - smoothstep(-.10, .045, d);
     vec2 slope = vec2(dropDistance(q + vec2(.055,0.), seed) - dropDistance(q - vec2(.055,0.), seed),
      dropDistance(q + vec2(0.,.055), seed) - dropDistance(q - vec2(0.,.055), seed));
     slope /= max(.001, length(slope));
     float curve = sqrt(clamp(-d * 1.6, 0., 1.));
     normal += slope * curve * lens * radius * .92;
     surface = max(surface, lens * .89);
     float rim = exp(-abs(d + .08) * 25.) * lens;
     edge += rim * .11 * max(0., dot(slope, vec2(.4,.9)));
     highlight += rim * pow(max(0., dot(slope, vec2(-.6,-.8))), 9.) * .22;
    }
    float behind = center.y - p.y;
    float trailLength = mix(47., 143., hash(id + 12.));
    float trailX = center.x + sin(behind * .025 + seed * 29.) * 1.4;
    float trailWidth = mix(.32, .95, 1. - clamp(behind / trailLength, 0., 1.));
    float trail = (1. - smoothstep(trailWidth, trailWidth + .65, abs(p.x - trailX))) *
     smoothstep(radius, radius * 2.7, behind) * (1. - smoothstep(trailLength * .55, trailLength, behind)) * present;
    surface = max(surface, trail * .27);
    normal.x += trail * (p.x - trailX) * 3.6;
   }
  }
  // Tiny beads sit still on the glass while the larger drops run through them.
  vec2 fineGrid = floor(p / 43.);
  vec2 beadCenter = (fineGrid + vec2(.2 + .6 * hash(fineGrid + 7.), .2 + .6 * hash(fineGrid + 31.))) * 43.;
  vec2 bead = (p - beadCenter) / (.85 + hash(fineGrid) * 1.7);
  bead.x += .16 * sin(bead.y * 2. + hash(fineGrid) * 11.);
  float beadShape = (1. - smoothstep(.65, 1., length(bead))) * step(.38, hash(fineGrid + 9.));
  normal += bead * beadShape * 2.6;
  surface = max(surface, beadShape * .67);
  color = photograph(p + normal) * (1. - edge) + vec3(.87,.94,1.) * highlight;
  alpha = clamp(surface, 0., .92);
 } else if (u_effect < 3.5) {
  float mask = texture2D(u_mask, v_uv).r;
  bool sea = u_effect < 2.5;
  float horizon = sea ? .379 : .697;
  float depth = clamp((photo.y - horizon) / (sea ? .36 : .27), 0., 1.);
  // Long horizontal wave fronts, with a second oblique wave field. Their size
  // and travel speed decrease into the distance rather than stretching buildings.
  float perspective = .2 + .8 * depth;
  float flow = photo.y * (sea ? 300. : 245.) + sin(photo.x * 17. + t * .32) * 2.;
  float broad = sin(flow - t * 1.9);
  float fine = sin(flow * 2.7 + photo.x * 90. + t * 2.2);
  vec2 offset = vec2(sin(flow * .78 + photo.x * 24. - t * .8), broad + fine * .3);
  offset *= vec2(2.4, 2.9) * perspective * mask;
  color = photograph(p + offset);
  float reflection = pow(max(0., .5 + .5 * sin(flow * 1.6 + photo.x * 19. - t * 2.3)), 9.);
  float sunPath = exp(-pow((photo.x - (sea ? .045 : .116)) / (.11 + depth * .24), 2.));
  float glint = reflection * sunPath * perspective * (.25 + .75 * hash(floor(photo * vec2(500.,750.))));
  // Mediterranean retains the gentle water reflections from version 1.9.1.
  if (sea) color += vec3(1., .91, .67) * glint * .25;
  else color += vec3(1., .94, .76) * glint * .19;
  color *= 1. + broad * .022 * perspective;
  alpha = mask;
  if (!sea) {
   float foliage = texture2D(u_foliage, v_uv).r;
   // Spatial phase makes gusts travel along the bank. Fine leaf flutter rides
   // on a much slower sway; trunks, face, clothing and buildings are excluded.
   float gust = .65 + .35 * sin(t * .29 - photo.x * 5.);
   float sway = sin(t * .79 - photo.x * 8. + photo.y * 3.1);
   float flutter = sin(t * 1.9 + photo.x * 57. + photo.y * 32.);
   float foreground = smoothstep(.70, .95, photo.y);
   float canopy = 1. - smoothstep(.32,.42,photo.y);
   float amplitude = (2.1 + foreground * 3.7 + canopy * 1.9) * gust;
   vec2 wind = vec2(sway + flutter * .16, cos(t * .67 + photo.x * 18.) * .14);
   vec3 leaves = photograph(p + wind * amplitude * foliage);
   color = mix(color, leaves, foliage);
   alpha = max(alpha, foliage);
  }
 } else {
  // A soft light pass is confined to the flowers, leaving the car/window still.
  float mask = texture2D(u_mask, v_uv).r;
  float breeze = sin(photo.y * 15. - t * .57) * sin(photo.x * 22. + t * .31);
  vec2 offset = vec2(breeze * 1.45, sin(t * .6 + photo.x * 31.) * .35) * mask;
  color = photograph(p + offset);
  float petal = smoothstep(.035, .15, color.r - color.g);
  float sheen = .5 + .5 * sin(photo.x * 12. + photo.y * 9. - t * .63);
  color += vec3(.12,.039,.018) * petal * sheen * mask;
  alpha = mask;
 }
 gl_FragColor = vec4(clamp(color, 0., 1.), alpha);
}
`;

class PhotoEffects {
 constructor() {
  this.canvas = document.createElement('canvas');
  const gl = this.gl = this.canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false, antialias: false, depth: false, powerPreference: 'low-power' });
  if (!gl) throw new Error('No WebGL context');
  const shader = (type, source) => {
   const result = gl.createShader(type); gl.shaderSource(result, source); gl.compileShader(result);
   if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(result));
   return result;
  };
  const program = gl.createProgram(), vertex = shader(gl.VERTEX_SHADER, VERTEX), fragment = shader(gl.FRAGMENT_SHADER, FRAGMENT);
  gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
  gl.deleteShader(vertex); gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);
  const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, 'a_position');
  gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  this.uniforms = Object.fromEntries(['photo','mask','foliage','resolution','cover','time','effect'].map(name => [name, gl.getUniformLocation(program, `u_${name}`)]));
  this.textures = [0, 1, 2].map(index => {
   const texture = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + index); gl.bindTexture(gl.TEXTURE_2D, texture);
   gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
   gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
   return texture;
  });
  gl.uniform1i(this.uniforms.photo, 0); gl.uniform1i(this.uniforms.mask, 1); gl.uniform1i(this.uniforms.foliage, 2);
 }
 upload(photo, mask, cover, effect, foliage) {
  const gl = this.gl;
  // A 1080p ceiling also bounds GPU cost on 4K/HiDPI displays.
  const scale = Math.min(1, 1920 / photo.width, 1080 / photo.height);
  this.canvas.width = Math.round(photo.width * scale); this.canvas.height = Math.round(photo.height * scale);
  gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  [photo, mask, foliage].forEach((source, index) => {
   gl.activeTexture(gl.TEXTURE0 + index); gl.bindTexture(gl.TEXTURE_2D, this.textures[index]);
   gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  });
  gl.uniform2f(this.uniforms.resolution, photo.width, photo.height);
  gl.uniform4f(this.uniforms.cover, cover.x, cover.y, cover.width, cover.height);
  gl.uniform1f(this.uniforms.effect, effect);
 }
 draw(context, time, width, height) {
  if (this.gl.isContextLost()) return false;
  this.gl.uniform1f(this.uniforms.time, time); this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
  context.drawImage(this.canvas, 0, 0, width, height); return true;
 }
}

export class EnvironmentScene {
 constructor(host) {
  this.host = host; this.canvas = document.createElement('canvas');
  this.canvas.className = 'environment-canvas'; this.canvas.setAttribute('aria-hidden', 'true');
  this.context = this.canvas.getContext('2d');
  this.backing = document.createElement('canvas'); this.mask = document.createElement('canvas');
  this.maskScratch = document.createElement('canvas');
  this.foliageMask = document.createElement('canvas'); this.foliageScratch = document.createElement('canvas');
  this.foliageFrame = document.createElement('canvas');
  this.rain = new RainGlass();
  this.key = ''; this.token = 0; this.frame = 0; this.elapsed = 0; this.hidden = document.hidden;
  try { this.gpu = new PhotoEffects(); } catch { this.gpu = null; }
  this.canvas.dataset.renderer = this.gpu ? 'webgl' : 'canvas';
 }
 set(theme, mode) {
  const key = `${theme.id}-${mode}`;
  if (key === this.key) { if (!this.canvas.isConnected) this.host.append(this.canvas); this.resize(); this.start(); return; }
  this.stop(); this.key = key; this.theme = theme; this.mode = mode;
  const token = ++this.token;
  this.host.replaceChildren(this.canvas); this.image = null; this.elapsed = 0; this.previous = 0;
  this.canvas.dataset.effect = theme.effect; this.canvas.dataset.frame = '0'; this.resize(true);
  const image = new Image();
  image.onload = () => { if (token !== this.token) return; this.image = image; this.paintBacking(); };
  image.src = theme.image; this.start();
 }
 resize(reset = false) {
  const width = innerWidth, height = innerHeight, dpr = Math.min(devicePixelRatio || 1, 1.5);
  if (!reset && width === this.width && height === this.height && dpr === this.dpr) return;
  this.width = width; this.height = height; this.dpr = dpr;
  this.canvas.width = Math.round(width * dpr); this.canvas.height = Math.round(height * dpr);
  this.context.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (const canvas of [this.backing, this.mask, this.maskScratch, this.foliageMask, this.foliageScratch, this.foliageFrame]) { canvas.width = width; canvas.height = height; }
  this.cover = { x: 0, y: 0, width, height }; this.paintBacking();
 }
 paintBacking() {
  if (!this.image) return;
  const { width, height, image } = this, scale = Math.max(width / image.width, height / image.height);
  const imageWidth = image.width * scale, imageHeight = image.height * scale;
  const position = this.theme.position ?? (this.theme.id === 'rose-dusk' ? .47 : this.theme.id === 'mediterranean' ? .58 : .5);
  const x = (width - imageWidth) * (this.theme.id === 'shinchan' ? 1 : .5), y = (height - imageHeight) * position;
  this.cover = { x, y, width: imageWidth, height: imageHeight };
  const ctx = this.backing.getContext('2d'); ctx.clearRect(0, 0, width, height); ctx.drawImage(image, x, y, imageWidth, imageHeight);
  this.paintMask();
  this.paintFoliageMask();
  if (this.theme.effect === 'rain') this.rain.setBackground(this.backing);
  if (this.gpu) {
   const effect = this.theme.effect === 'rain' ? 1 : this.theme.effect === 'sea' ? 2 : this.theme.effect === 'sunshine' ? 3 : 4;
   this.gpu.upload(this.backing, this.mask, this.cover, effect, this.foliageMask);
  }
 }
 photoPoint(x, y) { return { x: this.cover.x + x * this.cover.width, y: this.cover.y + y * this.cover.height }; }
 photoPolygon(ctx, points) {
  ctx.beginPath(); points.forEach(([x,y], index) => { const point = this.photoPoint(x,y); if (!index) ctx.moveTo(point.x,point.y); else ctx.lineTo(point.x,point.y); }); ctx.closePath();
 }
 paintMask() {
  const ctx = this.maskScratch.getContext('2d'), { width, height } = this;
  ctx.clearRect(0, 0, width, height); ctx.fillStyle = '#fff';
  if (WATER_OUTLINES[this.theme.id]) {
   this.photoPolygon(ctx, WATER_OUTLINES[this.theme.id]); ctx.fill();
   if (this.theme.id === 'mediterranean') {
    // Boat hulls and their masts remain fixed as the water moves around them.
    ctx.globalCompositeOperation = 'destination-out';
    for (const [x,y,rx,ry] of [[.351,.548,.023,.027],[.330,.599,.023,.022]]) {
     const point = this.photoPoint(x,y); ctx.beginPath(); ctx.ellipse(point.x,point.y,this.cover.width*rx,this.cover.height*ry,0,0,TAU); ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
   }
  } else if (this.theme.effect === 'dusk') {
   this.photoPolygon(ctx, [[.10,.59],[.16,.46],[.25,.38],[.29,.41],[.37,.43],[.40,.28],[.43,.35],[.47,.46],
    [.52,.37],[.57,.46],[.62,.47],[.68,.56],[.69,.73],[.17,.73]]); ctx.fill();
  }
  const mask = this.mask.getContext('2d'); mask.fillStyle = '#000'; mask.fillRect(0,0,width,height);
  // Feather inwards: the coast/car frame cannot bleed into the animated surface.
  mask.filter = 'blur(9px)'; mask.drawImage(this.maskScratch,0,0); mask.filter = 'none';
  mask.globalCompositeOperation = 'destination-in'; mask.drawImage(this.maskScratch,0,0);
  mask.globalCompositeOperation = 'destination-over'; mask.fillStyle = '#000'; mask.fillRect(0,0,width,height); mask.globalCompositeOperation = 'source-over';
 }
 paintFoliageMask() {
  const ctx = this.foliageScratch.getContext('2d'), { width, height } = this;
  ctx.clearRect(0,0,width,height);
  if (this.theme.id === 'shinchan') {
   ctx.fillStyle = '#fff';
   for (const outline of FOLIAGE_OUTLINES) { this.photoPolygon(ctx,outline); ctx.fill(); }
   ctx.globalCompositeOperation = 'destination-out';
   this.photoPolygon(ctx,CHARACTER_OUTLINE); ctx.fill();
   this.photoPolygon(ctx,[[.453,1],[.53,.96],[.69,.88],[.808,.839],[.81,.853],[.69,.901],[.55,.984],[.52,1]]); ctx.fill();
   ctx.globalCompositeOperation = 'source-over';
  }
  const mask = this.foliageMask.getContext('2d');
  mask.clearRect(0,0,width,height); mask.filter = 'blur(6px)';
  mask.drawImage(this.foliageScratch,0,0); mask.filter = 'none';
  mask.globalCompositeOperation = 'destination-in'; mask.drawImage(this.foliageScratch,0,0);
  mask.globalCompositeOperation = 'destination-over'; mask.fillStyle = '#000'; mask.fillRect(0,0,width,height);
  mask.globalCompositeOperation = 'source-over';
 }
 start() {
  if (!this.theme) return;
  if (this.mode === 'still' || !animatedEffects.has(this.theme.effect)) { this.canvas.dataset.motion = 'still'; return; }
  if (this.hidden) { this.canvas.dataset.motion = 'paused'; return; }
  this.canvas.dataset.motion = 'running'; if (!this.frame) this.frame = requestAnimationFrame(time => this.draw(time));
 }
 stop() { cancelAnimationFrame(this.frame); this.frame = 0; this.previous = 0; this.canvas.dataset.motion = this.mode === 'still' ? 'still' : 'paused'; }
 setHidden(hidden) { this.hidden = hidden; if (hidden) this.stop(); else this.start(); }
 draw(time) {
  this.frame = 0; if (this.hidden || this.mode === 'still') return;
  if (this.previous && time - this.previous < FRAME_INTERVAL) { this.start(); return; }
  const dt = this.previous ? Math.min(.08, (time-this.previous)/1000) : .04;
  this.previous = time; this.elapsed += dt;
  const ctx = this.context, t = this.elapsed; ctx.clearRect(0,0,this.width,this.height);
  if (this.image) {
   const raining = this.theme.effect === 'rain' && this.rain.draw(ctx,t,this.width,this.height);
   if (raining) { this.canvas.dataset.renderer = 'webgl2'; }
   else if (!this.gpu?.draw(ctx,t,this.width,this.height)) this.fallback(ctx,t);
   else this.canvas.dataset.renderer = 'webgl';
   if (this.theme.effect === 'sea') this.sunlight(ctx,t,this.photoPoint(.025,.374),false);
   else if (this.theme.effect === 'dusk') this.dusk(ctx,t);
   else if (this.theme.effect === 'sunshine') {
    this.sunlight(ctx,t,this.photoPoint(.116,.541),true); this.sunMotes(ctx,t);
   }
  }
  this.canvas.dataset.frame = String(Math.round(t*25)); this.start();
 }
 glow(ctx,x,y,radius,color,strength) {
  const gradient = ctx.createRadialGradient(x,y,0,x,y,radius);
  gradient.addColorStop(0,`rgba(${color},${strength})`); gradient.addColorStop(.2,`rgba(${color},${strength*.38})`); gradient.addColorStop(1,`rgba(${color},0)`);
  ctx.fillStyle = gradient; ctx.fillRect(x-radius,y-radius,radius*2,radius*2);
 }
 sparkle(ctx,x,y,size,pulse,warm) {
  if(pulse<.012)return;
  // A luminous centre and a short diffraction glint survive the panel's blur.
  // The slow envelope avoids hard flashing; the wide bloom has no visible rim.
  const color=warm?'255,225,151':'255,209,168';
  this.glow(ctx,x,y,size*2.1,color,pulse*.76);
  this.glow(ctx,x,y,size*.64,'255,251,224',pulse*.98);
  ctx.save();ctx.translate(x,y);ctx.rotate(warm?-.13:.23);
  const ray=ctx.createLinearGradient(-size,0,size,0);
  ray.addColorStop(0,`rgba(${color},0)`);ray.addColorStop(.43,`rgba(255,248,218,${pulse*.76})`);
  ray.addColorStop(.5,`rgba(255,255,241,${pulse})`);ray.addColorStop(.57,`rgba(255,248,218,${pulse*.76})`);ray.addColorStop(1,`rgba(${color},0)`);
  ctx.strokeStyle=ray;ctx.lineWidth=2.4;ctx.beginPath();ctx.moveTo(-size,0);ctx.lineTo(size,0);ctx.stroke();
  ctx.rotate(Math.PI/2);ctx.scale(.78,1);ctx.beginPath();ctx.moveTo(-size,0);ctx.lineTo(size,0);ctx.stroke();ctx.restore();
  ctx.fillStyle=`rgba(255,254,232,${pulse*.98})`;ctx.beginPath();ctx.arc(x,y,2+size*.15,0,TAU);ctx.fill();
 }
 sunlight(ctx,t,point,warm) {
  const radius = Math.max(this.width,this.height)*.68, breath = .83+Math.sin(t*.29)*.12;
  ctx.save(); ctx.globalCompositeOperation = 'screen';
  this.glow(ctx,point.x,point.y,radius,warm?'255,206,126':'255,244,194',.2*breath);
  // Soft shafts radiate from the sun already present in each photograph.
  // Slow variation in angular density resembles clouds crossing the light.
  for (let i=0;i<6;i++) {
   const angle = -.63+i*.29+Math.sin(t*.085+i)*.07;
   ctx.save(); ctx.translate(point.x,point.y); ctx.rotate(angle);
   const length = radius*(1.5+(i%2)*.25), gradient = ctx.createLinearGradient(0,0,length,0);
   gradient.addColorStop(0,'rgba(255,227,160,0)'); gradient.addColorStop(.17,`rgba(255,227,160,${(.014+.015*(.5+.5*Math.sin(t*.27+i)))*breath})`);
   gradient.addColorStop(1,'rgba(255,227,160,0)'); ctx.fillStyle=gradient;
   ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(length,-length*.07); ctx.quadraticCurveTo(length*1.1,0,length,length*.07); ctx.closePath(); ctx.fill();ctx.restore();
  }
  ctx.restore();
 }
 dusk(ctx,t) {
  return drawRoseAmbience(this,ctx,t);
 }
 sunMotes(ctx,t) {
  ctx.save();ctx.globalCompositeOperation='screen';
  for(let i=0;i<19;i++) {
   const phase=fraction(i*.317+t/(7.5+(i%7))),pulse=Math.pow(Math.sin(phase*Math.PI),3);
   const point=this.photoPoint(.035+fraction(i*.618+.17)*.68,.47+fraction(i*.329)*.45);
   const x=point.x+Math.sin(t*.12+i)*12,y=point.y-18*phase;
   this.sparkle(ctx,x,y,17.5+(i%4)*1.5,pulse,true);
  }
  ctx.restore();
 }
 rainDrop(ctx,x,y,r,seed,neck) {
  const top=y-r*neck,bend=Math.sin(seed*19)*r*.16;
  ctx.beginPath();ctx.moveTo(x+bend,top);
  ctx.bezierCurveTo(x+r*.17,top+r*.25,x+r*.12,y-r*.87,x+r*.61,y-r*.44);
  ctx.bezierCurveTo(x+r*1.08,y-r*.10,x+r*.86,y+r*.88,x+r*.11,y+r);
  ctx.bezierCurveTo(x-r*.89,y+r*1.06,x-r*.98,y+r*.01,x-r*.50,y-r*.53);
  ctx.bezierCurveTo(x-r*.14,y-r*.90,x-r*.10,top+r*.37,x+bend,top);ctx.closePath();
 }
 fallback(ctx,t) {
  // GPU-disabled machines retain a modest scene-aware animation, rather than
  // losing motion completely. The high-quality path uses the shader above.
  this.canvas.dataset.renderer='canvas';
  if(WATER_OUTLINES[this.theme.id]) {
   ctx.save();this.photoPolygon(ctx,WATER_OUTLINES[this.theme.id]);ctx.clip();
   const top=clamp(this.photoPoint(0,this.theme.id==='shinchan'?.71:.38).y,0,this.height);
   for(let y=top;y<this.height;y+=3) {
    const shift=Math.sin(y*.08-t*1.7)*2;ctx.drawImage(this.backing,0,y,this.width,3,shift,y,this.width,3);
   }
   ctx.restore();
   if(this.theme.id==='shinchan') {
    const frame=this.foliageFrame.getContext('2d'); frame.clearRect(0,0,this.width,this.height);
    for(let y=0;y<this.height;y+=6) {
     const shift=Math.sin(t*.79+y*.014)*2.4+Math.sin(t*1.9+y*.047)*.4;
     frame.drawImage(this.backing,0,y,this.width,6,shift,y,this.width,6);
    }
    frame.globalCompositeOperation='destination-in';frame.drawImage(this.foliageScratch,0,0);frame.globalCompositeOperation='source-over';
    ctx.drawImage(this.foliageFrame,0,0);
   }
  } else if(this.theme.effect==='rain') {
   const runners=Math.ceil(this.width*this.height/42000),beads=Math.ceil(this.width*this.height/6200);
   for(let i=0;i<runners+beads;i++) {
    const running=i<runners,seed=fraction(i*.754877+.13),r=running?3.2+fraction(i*.317)*4.7:.85+fraction(i*.417)*1.7;
    const speed=22+seed*27,travel=running?t*speed+Math.sin(t*.83+seed*23)*speed*1.12:0;
    const y=fraction(i*.319+travel/(this.height+160))*(this.height+160)-70;
    const x=fraction(i*.618+.07)*this.width+(running?Math.sin(y*.018+seed*29)*2.1:0),neck=running?1.4+seed*2:.7;
    if(running) {
     const length=47+seed*96,trail=ctx.createLinearGradient(x,y-length,x,y-r);
     trail.addColorStop(0,'rgba(232,244,251,0)');trail.addColorStop(.7,'rgba(232,244,251,.07)');trail.addColorStop(1,'rgba(232,244,251,.16)');
     ctx.strokeStyle=trail;ctx.lineWidth=.55+seed*.65;ctx.lineCap='round';ctx.beginPath();ctx.moveTo(x-1,y-length);ctx.bezierCurveTo(x+2,y-length*.72,x-2,y-length*.27,x,y-r);ctx.stroke();
    }
    ctx.save();this.rainDrop(ctx,x,y,r,seed,neck);ctx.clip();
    const top=y-r*neck,boxHeight=r*(neck+1.05);
    ctx.drawImage(this.backing,clamp(x-r*.73,0,this.width-r*1.46),clamp(top+r*.2,0,this.height-boxHeight*.75),r*1.46,boxHeight*.75,x-r,top,r*2,boxHeight);
    // Directional gleam only on the shoulder; no radial white outline.
    const lens=ctx.createLinearGradient(x-r,y-r,x+r,y+r);lens.addColorStop(0,'rgba(241,249,255,.30)');lens.addColorStop(.28,'rgba(241,249,255,.08)');lens.addColorStop(.58,'rgba(0,20,40,0)');lens.addColorStop(1,'rgba(0,20,40,.11)');
    ctx.fillStyle=lens;ctx.fillRect(x-r,top,r*2,boxHeight);ctx.restore();
   }
  }
 }
}
