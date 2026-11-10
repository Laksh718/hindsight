/**
 * The backdrop: a starfield lensed around the composer, as if it were a heavy object.
 *
 * WebGL, one full-screen fragment shader. For each pixel:
 *   1. Signed distance d to the composer's rounded rectangle, and s, the
 *      position along its outline (arc length). Together (s, d) are "orbit
 *      coordinates" that follow the composer's shape exactly.
 *   2. Near the rim, stars live in orbit coordinates: they flow along s
 *      (faster when closer), are smeared along s into streaks, and crowd
 *      toward the edge (d is compressed). That is the lensing look.
 *   3. Further out, an ordinary starfield in three depth layers, displaced a
 *      little toward the composer, shifted by the pointer for parallax, and
 *      bent around the pointer as a second, small gravity well.
 *   4. A thin bright rim and a faint halo hug the edge.
 *
 * The page drives it: where the composer is (read every frame, so the lens
 * follows the composer when it glides to its dock), whether it is focused
 * (the rim brightens), whether the agent is working (the flow speeds up),
 * and the pointer. Purely decorative: the canvas is aria-hidden. Without
 * WebGL a simpler 2D version runs; under reduced motion, one still frame.
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
uniform float uFlow;      // accumulated flow along the outline, px
uniform vec4 uBox;        // composer centre x, y, half width, half height (px, top-left origin)
uniform float uRadius;    // composer corner radius
uniform float uReach;     // how far the lensed disc reaches
uniform float uGlow;      // overall disc and rim strength
uniform float uFocus;     // rim boost when the composer has focus
uniform vec3 uMouse;      // pointer x, y (px) and presence 0..1
uniform vec3 uInk;        // star colour
uniform vec3 uCool;       // the cooler star colour
uniform vec3 uGround;     // page colour

const float PI = 3.14159265;

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
vec2 hash2(vec2 p) { float n = hash(p); return vec2(n, hash(p + n + 17.0)); }

// One star per cell: brightness at point u (in px units of the cell grid).
vec4 star(vec2 u, vec2 cell, float density, float size) {
  vec2 id = floor(u / cell);
  vec2 f = fract(u / cell) * cell;
  vec2 h = hash2(id);
  float on = step(1.0 - density, hash(id + 3.1));
  vec2 pos = (0.2 + 0.6 * h) * cell;
  float r = size * (0.45 + 0.9 * h.x * h.x);
  float dd = length(f - pos);
  float core = exp(-dd * dd / (r * r));
  float halo = exp(-dd / (r * 3.5)) * 0.22 * step(0.85, h.y); // only the brightest stars bloom
  float b = on * (0.35 + 0.65 * h.y) * (core + halo);
  float cool = step(0.72, hash(id + 9.7));
  return vec4(b, cool, h);
}

// A streak: a star smeared into a segment along x (the outline direction), bright at its head.
// Drawn analytically, distance to a segment, so it is one smooth line rather than a row of dots.
// \`period\` is the outline's length: cells are sized to divide it exactly and their ids wrap,
// so the field closes seamlessly where the outline coordinate starts again.
vec4 streak(vec2 u, float cellW, float rowH, float density, float width, float len, float period) {
  float n = max(floor(period / cellW), 1.0);
  cellW = period / n;
  len = min(len, 2.6 * cellW);                       // a tail never outruns the cells we look at
  float row = floor(u.y / rowH);
  float total = 0.0;
  float cool = 0.0;
  float first = floor(u.x / cellW);
  for (int j = 0; j < 4; j++) {
    float cx = first + float(j);
    vec2 id = vec2(mod(cx, n), row);
    vec2 h = hash2(id);
    if (hash(id + 3.1) < 1.0 - density) continue;
    vec2 head = vec2((cx + h.x) * cellW, (row + 0.2 + 0.6 * h.y) * rowH);
    float L = len * (0.35 + 0.65 * hash(id + 5.3));
    float back = head.x - u.x;                      // how far behind the head this pixel is
    float dx = back < 0.0 ? -back : max(back - L, 0.0);
    float dy = u.y - head.y;
    float w = width * (0.6 + 0.8 * h.x);
    float core = exp(-(dx * dx + dy * dy) / (w * w));
    float along = clamp(back / L, 0.0, 1.0);
    float b = core * (1.0 - along) * (1.0 - along) * (0.4 + 0.6 * h.y);
    total += b;
    cool = max(cool, step(0.7, hash(id + 9.7)) * b);
  }
  return vec4(total, cool, 0.0, 0.0);
}

float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

// Arc-length position along the rounded rectangle's outline, clockwise from its top-left.
float outline(vec2 p, vec2 hb, float r) {
  float a = hb.x - r, b = hb.y - r;
  vec2 c = clamp(p, vec2(-a, -b), vec2(a, b));
  vec2 v = p - c;
  float th = atan(v.y, v.x);
  float q = PI * 0.5 * r;
  if (v.y > 0.0 && abs(v.x) < 0.001) return p.x + a;                                   // top
  if (v.x > 0.0 && abs(v.y) < 0.001) return 2.0 * a + q + (b - p.y);                     // right
  if (v.y < 0.0 && abs(v.x) < 0.001) return 2.0 * a + 2.0 * q + 2.0 * b + (a - p.x);     // bottom
  if (v.x < 0.0 && abs(v.y) < 0.001) return 4.0 * a + 3.0 * q + 2.0 * b + (p.y + b);     // left
  if (v.x >= 0.0 && v.y >= 0.0) return 2.0 * a + r * (PI * 0.5 - th);                    // top right
  if (v.x >= 0.0) return 2.0 * a + q + 2.0 * b + r * (-th);                              // bottom right
  if (v.y < 0.0) return 4.0 * a + 2.0 * q + 2.0 * b + r * (-PI * 0.5 - th);              // bottom left
  return 4.0 * a + 3.0 * q + 4.0 * b + r * (PI - th);                                    // top left
}

void main() {
  vec2 px = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uDpr;   // CSS px, top-left origin
  vec2 rel = px - uBox.xy;
  float d = sdRoundBox(rel, uBox.zw, uRadius);
  vec3 col = uGround;

  // Gradient of the distance field: the outward normal.
  vec2 e = vec2(1.0, 0.0);
  vec2 n = normalize(vec2(sdRoundBox(rel + e.xy, uBox.zw, uRadius) - sdRoundBox(rel - e.xy, uBox.zw, uRadius),
                          sdRoundBox(rel + e.yx, uBox.zw, uRadius) - sdRoundBox(rel - e.yx, uBox.zw, uRadius)) + 1e-5);

  // The pointer: parallax for the far field, and a small well that bends stars around it.
  vec2 toMouse = px - uMouse.xy;
  float mDist = length(toMouse);
  vec2 bend = normalize(toMouse + 1e-5) * (5200.0 / (mDist + 70.0)) * uMouse.z;
  vec2 parallax = (uMouse.xy - uRes / (2.0 * uDpr)) * uMouse.z;

  // Far field: three depths, pulled slightly toward the composer.
  float pull = 900.0 * uGlow / (max(d, 0.0) + 90.0);
  vec2 far = px - n * pull - bend;
  float field = 0.0;
  vec3 tint = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    float depth = float(i) + 1.0;
    vec2 u = far - parallax * 0.035 * depth + vec2(uTime * 2.0 * depth, uTime * 0.6);
    vec4 s = star(u, vec2(38.0 + 30.0 * depth), 0.5, 0.7 + 0.5 * depth);
    float tw = 0.7 + 0.3 * sin(uTime * (0.6 + s.z * 2.0) + s.w * 6.2831);
    float b = s.x * tw * (0.75 + 0.35 * depth);
    field += b;
    tint += b * mix(uInk, uCool, s.y);
  }

  // The lensed disc, in orbit coordinates.
  vec3 disc = vec3(0.0);
  if (d > 0.0 && uGlow > 0.01) {
    // Wider to the sides than above and below, so the disc never runs over the head.
    float reach = uReach * mix(0.42, 1.0, abs(n.x));
    float t = clamp(d / reach, 0.0, 1.0);
    float period = 4.0 * (uBox.z - uRadius) + 4.0 * (uBox.w - uRadius) + 2.0 * PI * uRadius;
    float w = pow(1.0 - t, 2.0);                            // presence falls off with distance
    float dw = reach * pow(t, 1.7);                          // crowd stars toward the rim
    float s = outline(rel, uBox.zw, uRadius);
    float speed = 0.25 + 2.6 * pow(1.0 - t, 3.0);            // faster near the edge
    float smear = 10.0 + 90.0 * pow(1.0 - t, 2.0);           // longer streaks near the edge
    vec2 u = vec2(s - uFlow * speed, dw);
    vec4 a = streak(u, 46.0, 6.0, 0.5, 0.9, smear, period);
    vec4 b = streak(u + vec2(0.0, 3.0), 64.0, 9.0, 0.4, 1.25, smear * 1.2, period);
    disc += mix(uInk, uCool, clamp(a.y / max(a.x, 1e-3), 0.0, 1.0)) * a.x;
    disc += mix(uInk, uCool, clamp(b.y / max(b.x, 1e-3), 0.0, 1.0)) * b.x;
    disc *= w * 0.8 * uGlow;
    // A few long arcs further out.
    float arcs = 0.0;
    arcs = streak(vec2(s - uFlow * 0.35, d * 0.9), 150.0, 26.0, 0.3, 1.1, 150.0, period).x;
    disc += uInk * arcs * 0.5 * uGlow * smoothstep(0.05, 0.3, t) * (1.0 - smoothstep(0.6, 1.2, t));
    // The rim and a faint halo.
    float rim = exp(-d / 1.6) * (0.55 + 0.45 * uFocus) + exp(-d / 22.0) * 0.07;
    disc += uInk * rim * uGlow;
    // The disc hides the far field behind it a little: lensing darkens the sky next to the rim.
    field *= mix(1.0, 0.35, w * uGlow);
    tint *= mix(1.0, 0.35, w * uGlow);
  }

  col += tint + disc;
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
    res: U('uRes'), dpr: U('uDpr'), time: U('uTime'), flow: U('uFlow'), box: U('uBox'), radius: U('uRadius'),
    reach: U('uReach'), glow: U('uGlow'), focus: U('uFocus'), mouse: U('uMouse'), ink: U('uInk'), cool: U('uCool'), ground: U('uGround'),
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
  let flow = 0;
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    const target = getTarget();
    time += dt;
    flow += dt * 24 * target.energy;
    const ease = 1 - Math.exp(-dt * 6);
    mouse.x += (mouse.tx - mouse.x) * ease;
    mouse.y += (mouse.ty - mouse.y) * ease;
    mouse.on += (mouse.ton - mouse.on) * ease;

    const r = target.rect;
    gl.uniform2f(u.res, canvas.width, canvas.height);
    gl.uniform1f(u.dpr, dpr);
    gl.uniform1f(u.time, time);
    gl.uniform1f(u.flow, flow);
    gl.uniform4f(u.box, r.left + r.width / 2, r.top + r.height / 2, r.width / 2, r.height / 2);
    gl.uniform1f(u.radius, target.radius);
    gl.uniform1f(u.reach, target.reach);
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
