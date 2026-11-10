/**
 * The backdrop: a starfield bent around the composer, as if it were heavy.
 *
 * WebGL, one full-screen fragment shader, and one idea: gravitational
 * lensing. For each pixel we compute the distance d to the composer's
 * rounded rectangle and its outward normal n, then look the star field up
 * at a point pulled toward the composer by k / (d + c). Stars far away barely
 * move; near the rim they are pushed outward and squeezed into a dense band
 * of thin points. The pointer is a second, smaller lens, so the sky bends
 * around it the same way, and it also drives parallax across four depths.
 *
 * The page drives it every frame: where the composer is (so the lens follows
 * it from the centre to its dock), focus (the rim brightens), and whether the
 * agent is working (the sky drifts faster). Decorative only, aria-hidden. A 2D
 * fallback runs without WebGL; reduced motion gets one still frame.
 */

const VERT = `
attribute vec2 a;
void main() { gl_Position = vec4(a, 0.0, 1.0); }
`;

const FRAG = `
precision highp float;
uniform vec2 uRes;        // canvas size, px
uniform float uDpr;
uniform float uTime;
uniform vec4 uBox;        // composer centre x, y, half width, half height (px, top-left origin)
uniform float uRadius;    // composer corner radius
uniform float uLens;      // lens strength, px²
uniform float uCore;      // softening, px: smaller is a sharper lens
uniform float uDrift;     // accumulated drift time: advances faster while the agent works
uniform float uGlow;      // lens and rim strength: full on welcome, softer in a chat
uniform float uFocus;     // rim boost when the composer has focus
uniform vec3 uMouse;      // pointer x, y (px) and presence 0..1
uniform vec3 uInk;        // star colour
uniform vec3 uCool;       // the cooler star colour
uniform vec3 uGround;     // page colour

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
vec2 hash2(vec2 p) { float n = hash(p); return vec2(n, hash(p + n + 17.0)); }

// One star per cell: brightness at point u (in px units of the cell grid).
// \`tdir\` and \`stretch\` draw it longer along one direction: a lensed star is a short arc.
vec4 star(vec2 u, vec2 cell, float density, float size, vec2 tdir, float stretch) {
  vec2 id = floor(u / cell);
  vec2 f = fract(u / cell) * cell;
  vec2 h = hash2(id);
  float on = step(1.0 - density, hash(id + 3.1));
  vec2 pos = (0.2 + 0.6 * h) * cell;
  float r = size * (0.45 + 0.9 * h.x * h.x);
  vec2 off = f - pos;
  float along = dot(off, tdir) / stretch;
  float across = dot(off, vec2(-tdir.y, tdir.x));
  float dd = length(off);
  float core = exp(-(along * along + across * across) / (r * r));
  float halo = exp(-dd / (r * 3.5)) * 0.22 * step(0.85, h.y); // only the brightest stars bloom
  float b = on * (0.35 + 0.65 * h.y) * (core + halo);
  float cool = step(0.72, hash(id + 9.7));
  return vec4(b, cool, h);
}

float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

void main() {
  vec2 px = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uDpr;   // CSS px, top-left origin
  vec2 rel = px - uBox.xy;
  float d = sdRoundBox(rel, uBox.zw, uRadius);
  vec3 col = uGround;

  // Outward normal of the composer's outline (gradient of the distance field).
  vec2 e = vec2(1.0, 0.0);
  vec2 n = normalize(vec2(sdRoundBox(rel + e.xy, uBox.zw, uRadius) - sdRoundBox(rel - e.xy, uBox.zw, uRadius),
                          sdRoundBox(rel + e.yx, uBox.zw, uRadius) - sdRoundBox(rel - e.yx, uBox.zw, uRadius)) + 1e-5);

  // Two lenses bend the same sky. Each pixel looks up the star field at a point
  // pulled toward the mass: stars near it are pushed outward and squeezed into a
  // dense, thin band, the way light bends around something heavy. No lines are
  // drawn; every star is still a point, only displaced.
  float dd = max(d, 0.0);
  // Capped, so the corners (where the normal turns) cannot focus one star into a long ring.
  vec2 boxLens = n * min((uLens * uGlow) / (dd + uCore), 55.0);
  vec2 toMouse = px - uMouse.xy;
  float md = length(toMouse);
  vec2 mouseLens = normalize(toMouse + 1e-5) * (5200.0 / (md + 70.0)) * uMouse.z;
  vec2 parallax = (uMouse.xy - uRes / (2.0 * uDpr)) * uMouse.z;
  vec2 src = px - boxLens - mouseLens;

  // Each lens also stretches stars along its edge (its tangent). The stronger lens here wins.
  float boxPull = (uLens * uGlow) / ((dd + uCore) * (dd + uCore));
  float mousePull = 5200.0 * uMouse.z / ((md + 70.0) * (md + 70.0));
  vec2 tBox = vec2(-n.y, n.x);
  vec2 tMouse = normalize(vec2(-toMouse.y, toMouse.x) + 1e-5);
  vec2 tdir = boxPull >= mousePull ? tBox : tMouse;
  float stretch = 1.0 + min(boxPull + mousePull, 1.0) * 4.5; // a short arc, never a line

  float bright = 0.0;
  vec3 tint = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    float depth = float(i) + 1.0;
    vec2 u = src - parallax * 0.03 * depth + vec2(2.5 * depth, 0.8 * depth) * uDrift;
    vec4 s = star(u, vec2(30.0 + 26.0 * depth), 0.55, 0.65 + 0.4 * depth, tdir, stretch);
    float tw = 0.7 + 0.3 * sin(uTime * (0.6 + s.z * 2.0) + s.w * 6.2831);
    float b = s.x * tw * (0.7 + 0.3 * depth);
    bright += b;
    tint += b * mix(uInk, uCool, s.y);
  }
  // Lensing concentrates light: squeezed, stretched stars near an edge shine brighter.
  tint *= 1.0 + min(boxPull + mousePull, 1.2) * 1.4;

  // A hairline of light on the rim, and a soft falloff just outside it.
  float rim = d > 0.0 ? exp(-d / 1.4) * (0.35 + 0.4 * uFocus) * uGlow : 0.0;
  col += tint + uInk * rim;
  gl_FragColor = vec4(col, 1.0);
}

`;

/** Read a CSS colour token as linear-ish rgb 0..1 (canvas does the parsing, oklch included). */
function tokenRgb(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  const x = c.getContext('2d');
  x.fillStyle = value;
  x.fillRect(0, 0, 1, 1);
  const [r, g, b] = x.getImageData(0, 0, 1, 1).data;
  return [r / 255, g / 255, b / 255];
}

export function startCosmos(canvas, getTarget) {
  const gl = canvas.getContext('webgl', { antialias: false, alpha: false, premultipliedAlpha: false, powerPreference: 'high-performance' });
  if (!gl) return startFlat(canvas, getTarget);

  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
    return s;
  };
  let program;
  try {
    program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'link');
  } catch (err) {
    console.warn('[cosmos] WebGL unavailable, using the flat version:', err);
    return startFlat(canvas, getTarget);
  }
  gl.useProgram(program);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(program, 'a');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const U = (n) => gl.getUniformLocation(program, n);
  const u = {
    res: U('uRes'), dpr: U('uDpr'), time: U('uTime'), box: U('uBox'), radius: U('uRadius'),
    lens: U('uLens'), core: U('uCore'), drift: U('uDrift'), glow: U('uGlow'), focus: U('uFocus'), mouse: U('uMouse'), ink: U('uInk'), cool: U('uCool'), ground: U('uGround'),
  };
  gl.uniform3fv(u.ink, tokenRgb('--color-star', 'white'));
  gl.uniform3fv(u.cool, tokenRgb('--color-star-cool', 'lightblue'));
  gl.uniform3fv(u.ground, tokenRgb('--color-paper', 'black'));

  const still = matchMedia('(prefers-reduced-motion: reduce)');
  let dpr = 1;
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 1.5); // the field is soft; full retina costs more than it shows
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  // The pointer, eased so the sky follows it like something with mass.
  const mouse = { x: innerWidth / 2, y: innerHeight / 2, tx: innerWidth / 2, ty: innerHeight / 2, on: 0, ton: 0 };
  addEventListener('pointermove', (e) => {
    mouse.tx = e.clientX;
    mouse.ty = e.clientY;
    mouse.ton = e.pointerType === 'mouse' ? 1 : 0.6;
  }, { passive: true });
  document.documentElement.addEventListener('pointerleave', () => (mouse.ton = 0));

  let raf = 0;
  let last = performance.now();
  let time = 0;
  let drift = 0;
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    const target = getTarget();
    time += dt;
    drift += dt * target.energy; // integrated, so a change of speed never makes the sky jump
    const ease = 1 - Math.exp(-dt * 6);
    mouse.x += (mouse.tx - mouse.x) * ease;
    mouse.y += (mouse.ty - mouse.y) * ease;
    mouse.on += (mouse.ton - mouse.on) * ease;

    const r = target.rect;
    gl.uniform2f(u.res, canvas.width, canvas.height);
    gl.uniform1f(u.dpr, dpr);
    gl.uniform1f(u.time, time);
    gl.uniform4f(u.box, r.left + r.width / 2, r.top + r.height / 2, r.width / 2, r.height / 2);
    gl.uniform1f(u.radius, target.radius);
    gl.uniform1f(u.lens, target.lens);
    gl.uniform1f(u.core, 26);
    gl.uniform1f(u.drift, drift);
    gl.uniform1f(u.glow, target.glow);
    gl.uniform1f(u.focus, target.focus);
    gl.uniform3f(u.mouse, mouse.x, mouse.y, still.matches ? 0 : mouse.on);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (!still.matches) raf = requestAnimationFrame(frame);
  }
  function start() {
    cancelAnimationFrame(raf);
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }
  resize();
  start();
  addEventListener('resize', () => {
    resize();
    start();
  });
  still.addEventListener('change', start);
  document.addEventListener('visibilitychange', () => (document.hidden ? cancelAnimationFrame(raf) : start()));
  return { redraw: start };
}

/* The flat fallback: points drifting in orbit around the composer, on a 2D canvas. */
function startFlat(canvas, getTarget) {
  const ctx = canvas.getContext('2d');
  const ink = `rgb(${tokenRgb('--color-star', 'white').map((v) => Math.round(v * 255)).join(' ')})`;
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  const orbit = Array.from({ length: 600 }, () => ({ t: Math.random() * Math.PI * 2, d: Math.random() ** 2.2, a: 0.2 + Math.random() * 0.8 }));
  let raf = 0;
  let last = performance.now();
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(canvas.clientWidth * dpr)) {
      canvas.width = Math.round(canvas.clientWidth * dpr);
      canvas.height = Math.round(canvas.clientHeight * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const { rect: r, reach, energy, glow } = getTarget();
    ctx.fillStyle = ink;
    for (const p of orbit) {
      p.t += dt * (0.05 + 0.5 * (1 - p.d) ** 3) * energy;
      const c = Math.cos(p.t);
      const s = Math.sin(p.t);
      const out = 6 + p.d * reach;
      const x = r.left + r.width / 2 + Math.sign(c) * Math.abs(c) ** 0.4 * (r.width / 2 + out);
      const y = r.top + r.height / 2 + Math.sign(s) * Math.abs(s) ** 0.4 * (r.height / 2 + out * 0.42);
      ctx.globalAlpha = p.a * (1 - p.d) ** 1.8 * glow;
      ctx.fillRect(x, y, 1.4, 1.4);
    }
    ctx.globalAlpha = 1;
    if (!still.matches) raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);
  return { redraw: () => (raf = requestAnimationFrame(frame)) };
}
