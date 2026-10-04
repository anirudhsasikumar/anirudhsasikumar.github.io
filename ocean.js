(function () {
  'use strict';
  var canvas = document.getElementById('sea');
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- Presets and UI ----------
  var PRESETS = {
    dawn: { az: -15, el: 2.2, isun: 22, exp: 1.25, night: 0, clouds: 0.50, grade: [1.0, 0.97, 1.02], accent: [242, 184, 162] },
    noon: { az: -38, el: 48, isun: 22, exp: 0.68, night: 0, clouds: 0.56, grade: [1, 1, 1], accent: [196, 226, 240] },
    gold: { az: -10, el: 4.2, isun: 22, exp: 0.95, night: 0, clouds: 0.53, grade: [1.04, 1.0, 0.95], accent: [244, 194, 122] },
    moon: { az: 16, el: 22, isun: 0.55, exp: 3.2, night: 1, clouds: 0.56, grade: [0.55, 0.72, 1.15], accent: [185, 199, 230] }
  };
  var BEAUFORT = [[0.5, 'Calm'], [1.6, 'Light air'], [3.4, 'Light breeze'], [5.5, 'Gentle breeze'], [8, 'Moderate breeze'], [10.8, 'Fresh breeze'], [13.9, 'Strong breeze'], [17.2, 'Near gale'], [20.8, 'Gale'], [24.5, 'Strong gale'], [28.5, 'Storm'], [32.7, 'Violent storm'], [1e9, 'Hurricane force']];

  function clone(p) { var o = {}; for (var k in p) o[k] = Array.isArray(p[k]) ? p[k].slice() : p[k]; return o; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function ease(t) { return t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }

  var state = clone(PRESETS.gold), from = null, to = null, tweenStart = 0, TWEEN = 2600;
  var sea = 0.68;
  var skyDirty = true;

  function seaParams(s) {
    return {
      wind: 6 + 18 * s,              // m/s at 10 m
      swellHs: 1.2 + 3.2 * s,        // m
      swellTp: 10.5 + 5 * s          // s
    };
  }

  function updateSkyReadout() {
    document.getElementById('r-body').textContent = state.night > 0.5 ? 'Moon' : 'Sun';
    document.getElementById('r-el').textContent = Math.round(state.el) + '°';
    document.documentElement.style.setProperty('--sun', 'rgb(' + state.accent.map(Math.round).join(',') + ')');
  }

  function setTod(key, instant) {
    var target = PRESETS[key]; if (!target) return;
    document.querySelectorAll('.chip').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.tod === key)); });
    try { localStorage.setItem('as-tod', key); } catch (e) {}
    skyDirty = true;
    if (instant || reduce) { state = clone(target); from = to = null; updateSkyReadout(); return; }
    from = clone(state); to = clone(target); tweenStart = performance.now();
  }
  document.querySelectorAll('.chip').forEach(function (b) { b.addEventListener('click', function () { setTod(b.dataset.tod); }); });

  var paused = false;
  var pauseBtn = document.getElementById('pause');
  pauseBtn.addEventListener('click', function () {
    paused = !paused; pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    if (!paused && start) { last = performance.now(); requestAnimationFrame(frame); }
  });

  var lookTarget = [0, 0], look = [0, 0];
  window.addEventListener('pointermove', function (e) {
    lookTarget[0] = (e.clientX / window.innerWidth - 0.5) * 0.5;
    lookTarget[1] = -(e.clientY / window.innerHeight - 0.5) * 0.14;
  }, { passive: true });

  var saved = null;
  try { saved = localStorage.getItem('as-tod'); } catch (e) {}
  setTod(PRESETS[saved] ? saved : 'gold', true);

  // ---------- WebGL2 setup ----------
  var gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'high-performance' });
  var ok = !!gl && !!gl.getExtension('EXT_color_buffer_float');
  var start = null, last = performance.now();
  var slider = document.getElementById('sea-state');

  if (!ok) {
    var fb = document.createElement('div'); fb.className = 'fallback';
    document.body.insertBefore(fb, document.body.firstChild);
    canvas.remove();
    slider.addEventListener('input', function () { sea = parseFloat(slider.value); readoutOnly(); });
    readoutOnly();
    return;
  }
  gl.getExtension('OES_texture_float_linear');
  var aniso = gl.getExtension('EXT_texture_filter_anisotropic');
  var maxAniso = aniso ? Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)) : 0;

  var N = 256, G = 9.81, TAU = Math.PI * 2;
  var CASCADES = [{ L: 1009 }, { L: 173 }, { L: 29.3 }];
  CASCADES[0].kmin = 0; CASCADES[0].kmax = TAU / CASCADES[1].L * 6;
  CASCADES[1].kmin = CASCADES[0].kmax; CASCADES[1].kmax = TAU / CASCADES[2].L * 6;
  CASCADES[2].kmin = CASCADES[1].kmax; CASCADES[2].kmax = 1e9;
  var WIND_ANGLE = Math.atan2(-1, 0.22);   // waves travel toward the camera, slightly across
  var SWELL_ANGLE = Math.atan2(-1, -0.12);
  var CHOP = 0.9;

  // ---------- Shaders ----------
  var FS_VERT = '#version 300 es\nlayout(location=0) in vec2 a; out vec2 vUv; void main(){ vUv = a*0.5+0.5; gl_Position = vec4(a,0.,1.); }';
  var HEAD = '#version 300 es\nprecision highp float;\nprecision highp int;\n#define N 256\n#define PI 3.14159265359\n';
  var CMUL = 'vec2 cmul(vec2 a, vec2 b){ return vec2(a.x*b.x - a.y*b.y, a.x*b.y + a.y*b.x); }\n';

  var SPECTRUM_FS = HEAD + CMUL + [
    'uniform sampler2D uH0; uniform float uT; uniform float uL;',
    'layout(location=0) out vec4 o0; layout(location=1) out vec4 o1;',
    'void main(){',
    '  ivec2 p = ivec2(gl_FragCoord.xy);',
    '  vec4 h = texelFetch(uH0, p, 0);',
    '  vec2 n = vec2(p.x < N/2 ? p.x : p.x - N, p.y < N/2 ? p.y : p.y - N);',
    '  vec2 kv = n * (2.0*PI/uL);',
    '  float k = length(kv);',
    '  float w = sqrt(9.81*k);',
    '  float ph = mod(w*uT, 2.0*PI);',
    '  vec2 e = vec2(cos(ph), sin(ph));',
    '  vec2 ht = cmul(h.xy, e) + cmul(h.zw, vec2(e.x, -e.y));',
    '  vec2 ik = k > 1e-6 ? kv/k : vec2(0.0);',
    '  vec2 iht = vec2(-ht.y, ht.x);',
    '  vec2 dx = iht*ik.x, dz = iht*ik.y, sx = iht*kv.x, sz = iht*kv.y;',
    '  vec2 dxx = -ht*kv.x*ik.x, dzz = -ht*kv.y*ik.y, dxz = -ht*kv.x*ik.y;',
    '  o0 = vec4(ht.x - dx.y, ht.y + dx.x, dz.x - sx.y, dz.y + sx.x);',
    '  o1 = vec4(sz.x - dxx.y, sz.y + dxx.x, dzz.x - dxz.y, dzz.y + dxz.x);',
    '}'].join('\n');

  var FFT_FS = HEAD + CMUL + [
    'uniform sampler2D uA; uniform sampler2D uB; uniform int uSub; uniform int uHoriz;',
    'layout(location=0) out vec4 o0; layout(location=1) out vec4 o1;',
    'void main(){',
    '  ivec2 p = ivec2(gl_FragCoord.xy);',
    '  int idx = uHoriz == 1 ? p.x : p.y;',
    '  int hs = uSub / 2;',
    '  int e = (idx / uSub) * hs + (idx % hs);',
    '  ivec2 pe = uHoriz == 1 ? ivec2(e, p.y) : ivec2(p.x, e);',
    '  ivec2 po = uHoriz == 1 ? ivec2(e + N/2, p.y) : ivec2(p.x, e + N/2);',
    '  float a = 2.0*PI*float(idx)/float(uSub);',
    '  vec2 tw = vec2(cos(a), sin(a));',
    '  vec4 ae = texelFetch(uA, pe, 0), ao = texelFetch(uA, po, 0);',
    '  vec4 be = texelFetch(uB, pe, 0), bo = texelFetch(uB, po, 0);',
    '  o0 = vec4(ae.xy + cmul(tw, ao.xy), ae.zw + cmul(tw, ao.zw));',
    '  o1 = vec4(be.xy + cmul(tw, bo.xy), be.zw + cmul(tw, bo.zw));',
    '}'].join('\n');

  var ASSEMBLE_FS = HEAD + [
    'uniform sampler2D uA; uniform sampler2D uB; uniform sampler2D uPrev; uniform float uLambda; uniform float uDt; uniform float uFoamBias;',
    'layout(location=0) out vec4 o0; layout(location=1) out vec4 o1;',
    'void main(){',
    '  ivec2 p = ivec2(gl_FragCoord.xy);',
    '  vec4 a = texelFetch(uA, p, 0), b = texelFetch(uB, p, 0);',
    '  float h = a.x, dx = a.y, dz = a.z, sx = a.w, sz = b.x, dxx = b.y, dzz = b.z, dxz = b.w;',
    '  float jxx = 1.0 + uLambda*dxx, jzz = 1.0 + uLambda*dzz, jxz = uLambda*dxz;',
    '  float J = jxx*jzz - jxz*jxz;',
    '  float prev = texelFetch(uPrev, p, 0).w;',
    '  float src = 1.0 - smoothstep(uFoamBias - 0.45, uFoamBias, J);',
    '  float f = max(prev * exp(-uDt*0.55), src);',
    '  o0 = vec4(uLambda*dx, h, uLambda*dz, 1.0);',
    '  o1 = vec4(sx/max(jxx, 0.25), sz/max(jzz, 0.25), J, clamp(f, 0.0, 1.0));',
    '}'].join('\n');

  var PROBE_FS = HEAD + [
    'uniform sampler2D uD0; uniform sampler2D uD1; uniform vec2 uC0; uniform vec2 uC1; uniform vec2 uInvL;',
    'out vec4 o;',
    'float hAt(vec2 off){ return textureLod(uD0, uC0 + off*uInvL.x, 1.5).y + textureLod(uD1, uC1 + off*uInvL.y, 3.0).y; }',
    'void main(){',
    '  float d = 5.0;',
    '  float c = hAt(vec2(0.0)), r = hAt(vec2(d,0.0)), l = hAt(vec2(-d,0.0)), f = hAt(vec2(0.0,d)), b = hAt(vec2(0.0,-d));',
    '  o = vec4((2.0*c + r + l + f + b)/6.0, (r-l)/(2.0*d), (f-b)/(2.0*d), 1.0);',
    '}'].join('\n');

  var ATMOS = [
    'vec2 rsi(vec3 r0, vec3 rd, float sr){',
    '  float b = 2.0*dot(rd, r0); float c = dot(r0, r0) - sr*sr; float d = b*b - 4.0*c;',
    '  if (d < 0.0) return vec2(1e5, -1e5);',
    '  float s = sqrt(d); return vec2((-b - s)*0.5, (-b + s)*0.5);',
    '}',
    'vec3 atmosphere(vec3 r, vec3 r0, vec3 pSun, float iSun){',
    '  const float rP = 6371e3, rA = 6471e3, shR = 8e3, shM = 1.2e3, g = 0.758, kM = 21e-6;',
    '  const vec3 kR = vec3(5.5e-6, 13.0e-6, 22.4e-6);',
    '  vec2 p = rsi(r0, r, rA);',
    '  if (p.x > p.y) return vec3(0.0);',
    '  vec2 pp = rsi(r0, r, rP);',
    '  if (pp.x > 0.0) p.y = min(p.y, pp.x);',
    '  p.x = max(p.x, 0.0);',
    '  p.y = min(p.y, p.x + 140e3);',
    '  float st = (p.y - p.x)/16.0, t = p.x;',
    '  vec3 tR = vec3(0.0), tM = vec3(0.0); float oR = 0.0, oM = 0.0;',
    '  float mu = dot(r, pSun), mumu = mu*mu, gg = g*g;',
    '  float phR = 3.0/(16.0*PI)*(1.0 + mumu);',
    '  float phM = 3.0/(8.0*PI)*((1.0 - gg)*(mumu + 1.0))/(pow(1.0 + gg - 2.0*mu*g, 1.5)*(2.0 + gg));',
    '  for (int i = 0; i < 16; i++){',
    '    vec3 ip = r0 + r*(t + st*0.5);',
    '    float ih = length(ip) - rP;',
    '    float dR = exp(-ih/shR)*st, dM = exp(-ih/shM)*st;',
    '    oR += dR; oM += dM;',
    '    float js = rsi(ip, pSun, rA).y/8.0, jt = 0.0, jR = 0.0, jM = 0.0;',
    '    for (int j = 0; j < 8; j++){',
    '      vec3 jp = ip + pSun*(jt + js*0.5);',
    '      float jh = length(jp) - rP;',
    '      jR += exp(-jh/shR)*js; jM += exp(-jh/shM)*js; jt += js;',
    '    }',
    '    vec3 at = exp(-(kM*1.1*(oM + jM) + kR*(oR + jR)));',
    '    tR += dR*at; tM += dM*at; t += st;',
    '  }',
    '  return iSun*(phR*kR*tR + phM*kM*tM);',
    '}'].join('\n');

  var SKYLUT_FS = HEAD + ATMOS + [
    'in vec2 vUv; out vec4 o; uniform vec3 uSun; uniform float uISun;',
    'void main(){',
    '  float az = (vUv.x - 0.5)*2.0*PI;',
    '  float el = vUv.y*vUv.y*PI*0.5;',
    '  vec3 d = vec3(cos(el)*cos(az), sin(el), cos(el)*sin(az));',
    '  o = vec4(atmosphere(d, vec3(0.0, 6371e3 + 30.0, 0.0), uSun, uISun), 1.0);',
    '}'].join('\n');

  // Shared sky lookups, clouds and stars for the sky pass and ocean reflections.
  var SKY_COMMON = [
    'uniform sampler2D uSky; uniform sampler2D uNoise;',
    'uniform vec3 uSunDir; uniform vec3 uSunIrr; uniform float uClock; uniform float uCover; uniform float uNight; uniform vec2 uCamXZ;',
    'vec3 skyLut(vec3 d){',
    '  float el = asin(clamp(d.y, 0.0, 1.0));',
    '  vec2 uv = vec2(atan(d.z, d.x)/(2.0*PI) + 0.5, sqrt(el/(0.5*PI)));',
    '  return textureLod(uSky, uv, 0.0).rgb;',
    '}',
    'vec3 skyAmbient(){ return textureLod(uSky, vec2(0.5, 0.6), 7.0).rgb; }',
    'float vnoise(vec2 x){ vec2 p = floor(x), f = fract(x); f = f*f*(3.0 - 2.0*f); return textureLod(uNoise, (p + f + 0.5)/256.0, 0.0).x; }',
    'float fbm(vec2 p, int oct){',
    '  float a = 0.5, s = 0.0; mat2 m = mat2(1.6, 1.2, -1.2, 1.6);',
    '  for (int i = 0; i < 6; i++){ if (i >= oct) break; s += a*vnoise(p); p = m*p; a *= 0.5; }',
    '  return s;',
    '}',
    'vec4 clouds(vec3 rd, int oct){',
    '  if (rd.y < 0.01) return vec4(0.0);',
    '  float t = 1600.0/rd.y;',
    '  vec2 q = (uCamXZ + rd.xz*t)*0.00042 + vec2(uClock*0.004, uClock*0.0015);',
    '  vec2 w = vec2(fbm(q*0.7 + 3.1, 3), fbm(q*0.7 + 8.7, 3));',
    '  q += (w - 0.5)*0.9;',
    '  float n = fbm(q, oct);',
    '  float dens = smoothstep(uCover, uCover + 0.32, n);',
    '  if (dens <= 0.0) return vec4(0.0);',
    '  float ns = fbm(q + uSunDir.xz*0.09, oct);',
    '  float shade = exp(-max(smoothstep(uCover, uCover + 0.32, ns) - dens*0.35, 0.0)*3.2);',
    '  float mu = dot(rd, uSunDir);',
    '  float hg = 0.75*(1.0 - 0.36)/pow(1.0 + 0.36 - 1.2*mu, 1.5) + 0.25*(1.0 - 0.09)/pow(1.0 + 0.09 + 0.6*mu, 1.5);',
    '  vec3 lit = uSunIrr*(0.05 + 0.55*shade)*hg*0.08 + skyAmbient()*(1.6 - 0.6*dens);',
    '  float fade = smoothstep(0.01, 0.12, rd.y)*exp(-t*0.000012);',
    '  vec3 hz = skyLut(normalize(vec3(rd.x, 0.02, rd.z)));',
    '  lit = mix(hz, lit, exp(-t*0.00004));',
    '  return vec4(lit, dens*fade*0.96);',
    '}',
    'float hash3(vec3 p){ p = fract(p*0.3183099 + 0.1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x + p.y + p.z)); }',
    'vec3 stars(vec3 rd){',
    '  if (uNight < 0.01 || rd.y < 0.0) return vec3(0.0);',
    '  vec3 c = rd*420.0; vec3 id = floor(c); float h = hash3(id);',
    '  float s = step(0.9965, h)*smoothstep(0.5, 0.0, length(fract(c) - 0.5));',
    '  s *= 0.55 + 0.45*sin(uClock*(0.7 + 2.0*h) + h*50.0);',
    '  return vec3(0.75, 0.82, 1.0)*s*uNight*smoothstep(0.02, 0.2, rd.y)*0.9;',
    '}'].join('\n');

  var SKY_FS = HEAD + SKY_COMMON + [
    'in vec2 vUv; out vec4 o;',
    'uniform vec3 uFw; uniform vec3 uRt; uniform vec3 uUp; uniform vec2 uTan; uniform float uSunDisc;',
    'void main(){',
    '  vec2 ndc = vUv*2.0 - 1.0;',
    '  vec3 rd = normalize(uFw + uRt*ndc.x*uTan.x + uUp*ndc.y*uTan.y);',
    '  vec3 d = vec3(rd.x, max(rd.y, 0.0), rd.z);',
    '  vec3 c = skyLut(normalize(d + vec3(0.0, 1e-4, 0.0)));',
    '  float mu = dot(rd, uSunDir);',
    '  float disc = smoothstep(0.99996, 0.999975, mu);',
    '  c += uSunIrr*uSunDisc*disc;',
    '  c += stars(rd);',
    '  vec4 cl = clouds(rd, 6);',
    '  c = mix(c, cl.rgb, cl.a);',
    '  o = vec4(c, 1.0);',
    '}'].join('\n');

  var OCEAN_VS = HEAD + [
    'layout(location=0) in vec2 aP;',
    'uniform mat4 uVP; uniform float uCamY; uniform float uSpacing;',
    'uniform sampler2D uD0; uniform sampler2D uD1; uniform sampler2D uD2;',
    'uniform vec2 uC0; uniform vec2 uC1; uniform vec2 uC2; uniform vec3 uL;',
    'out vec2 vUv0; out vec2 vUv1; out vec2 vUv2; out vec3 vRel; out float vH;',
    'void main(){',
    '  float r = length(aP);',
    '  float sp = r*uSpacing + 0.02;',
    '  vec2 u0 = uC0 + aP/uL.x, u1 = uC1 + aP/uL.y, u2 = uC2 + aP/uL.z;',
    '  float l0 = log2(max(sp/(uL.x/256.0), 1.0)), l1 = log2(max(sp/(uL.y/256.0), 1.0)), l2 = log2(max(sp/(uL.z/256.0), 1.0));',
    '  float f0 = 1.0 - smoothstep(12000.0, 30000.0, r), f1 = 1.0 - smoothstep(2500.0, 7000.0, r), f2 = 1.0 - smoothstep(250.0, 900.0, r);',
    '  vec3 d = textureLod(uD0, u0, l0).xyz*f0 + textureLod(uD1, u1, l1).xyz*f1 + textureLod(uD2, u2, l2).xyz*f2;',
    '  vec3 rel = vec3(aP.x + d.x, d.y - uCamY, aP.y + d.z);',
    '  vUv0 = u0; vUv1 = u1; vUv2 = u2; vRel = rel; vH = d.y;',
    '  gl_Position = uVP*vec4(rel, 1.0);',
    '}'].join('\n');

  var OCEAN_FS = HEAD + SKY_COMMON + [
    'in vec2 vUv0; in vec2 vUv1; in vec2 vUv2; in vec3 vRel; in float vH;',
    'uniform sampler2D uS0; uniform sampler2D uS1; uniform sampler2D uS2; uniform float uHs;',
    'out vec4 o;',
    'void main(){',
    '  float dist = length(vRel);',
    '  vec3 V = -vRel/dist;',
    '  vec4 s0 = texture(uS0, vUv0), s1 = texture(uS1, vUv1), s2 = texture(uS2, vUv2);',
    '  float f1 = 1.0 - smoothstep(3000.0, 9000.0, dist), f2 = 1.0 - smoothstep(300.0, 1400.0, dist);',
    '  vec2 sl = s0.xy + s1.xy*f1 + s2.xy*f2;',
    '  vec3 Nn = normalize(vec3(-sl.x, 1.0, -sl.y));',
    '  float nv = dot(Nn, V);',
    '  if (nv < 0.02) Nn = normalize(Nn + V*(0.02 - nv));',
    '  vec3 L = uSunDir;',
    '  float NdV = max(dot(Nn, V), 1e-3), NdL = max(dot(Nn, L), 0.0);',
    '  float rough = 0.075 + 0.22*smoothstep(0.0, 9000.0, dist);',
    '  float a = rough*rough, a2 = a*a;',
    '  vec3 Hv = normalize(L + V);',
    '  float NdH = max(dot(Nn, Hv), 0.0), VdH = max(dot(V, Hv), 0.0);',
    '  float D = a2/(PI*pow(NdH*NdH*(a2 - 1.0) + 1.0, 2.0));',
    '  float kk = a*0.5;',
    '  float Gs = (NdV/(NdV*(1.0 - kk) + kk))*(NdL/(NdL*(1.0 - kk) + kk));',
    '  float Fs = 0.02 + 0.98*pow(1.0 - VdH, 5.0);',
    '  vec3 spec = min(uSunIrr*D*Gs*Fs/(4.0*NdV), vec3(30000.0)) * step(0.0, L.y);',
    '  vec3 R = reflect(-V, Nn); R.y = abs(R.y);',
    '  vec3 refl = skyLut(R);',
    '  vec4 cr = clouds(R, 4);',
    '  refl = mix(refl, cr.rgb, cr.a);',
    '  float F = 0.02 + 0.98*pow(1.0 - NdV, 5.0);',
    '  F = min(F, mix(1.0, 0.62, smoothstep(200.0, 6000.0, dist)));',
    '  vec3 amb = skyAmbient();',
    '  float sunUp = smoothstep(-0.02, 0.06, L.y);',
    '  vec3 scatterCol = vec3(0.02, 0.21, 0.20);',
    '  vec3 deep = vec3(0.0016, 0.010, 0.017);',
    '  float Hc = max(vH + 0.15*uHs, 0.0)/max(uHs, 0.5);',
    '  float k1 = 1.6*Hc*pow(max(dot(L, -V), 0.0), 3.0)*pow(0.5 - 0.5*dot(L, Nn), 2.0);',
    '  float k2 = 0.22*pow(NdV, 2.0);',
    '  vec3 scatter = (k1 + k2)*scatterCol*uSunIrr*0.045*sunUp + deep*(amb*3.0 + 0.002) + scatterCol*amb*0.18;',
    '  vec3 col = (1.0 - F)*scatter + F*refl + spec;',
    '  float foam = s0.w*0.55 + s1.w*f1 + s2.w*f2*0.6;',
    '  vec2 fq = (vUv1*173.0)*0.9;',
    '  float fn = fbm(fq + uClock*0.05, 4);',
    '  float fm = smoothstep(0.35, 0.95, foam*(0.45 + 1.1*fn)) * (1.0 - smoothstep(600.0, 3000.0, dist));',
    '  vec3 foamCol = 0.85*(uSunIrr*(0.25 + 0.75*NdL)/PI*sunUp + amb*1.3);',
    '  col = mix(col, foamCol, fm*0.85);',
    '  vec3 hz = skyLut(normalize(vec3(-V.x, 0.015, -V.z)));',
    '  float fog = 1.0 - exp(-dist*0.000085);',
    '  col = mix(col, hz, fog*0.92);',
    '  o = vec4(col, 1.0);',
    '}'].join('\n');

  var DOWN_FS = HEAD + [
    'in vec2 vUv; out vec4 o; uniform sampler2D uSrc; uniform vec2 uHp; uniform float uFirst;',
    'vec3 s(vec2 uv){ vec3 c = texture(uSrc, uv).rgb; return uFirst > 0.5 ? min(c, vec3(400.0)) : c; }',
    'void main(){',
    '  vec3 c = s(vUv)*4.0 + s(vUv - uHp) + s(vUv + uHp) + s(vUv + vec2(uHp.x, -uHp.y)) + s(vUv - vec2(uHp.x, -uHp.y));',
    '  o = vec4(c/8.0, 1.0);',
    '}'].join('\n');

  var UP_FS = HEAD + [
    'in vec2 vUv; out vec4 o; uniform sampler2D uSrc; uniform vec2 uHp;',
    'void main(){',
    '  vec2 h = uHp;',
    '  vec3 c = texture(uSrc, vUv + vec2(-2.0*h.x, 0.0)).rgb + texture(uSrc, vUv + vec2(-h.x, h.y)).rgb*2.0',
    '    + texture(uSrc, vUv + vec2(0.0, 2.0*h.y)).rgb + texture(uSrc, vUv + vec2(h.x, h.y)).rgb*2.0',
    '    + texture(uSrc, vUv + vec2(2.0*h.x, 0.0)).rgb + texture(uSrc, vUv + vec2(h.x, -h.y)).rgb*2.0',
    '    + texture(uSrc, vUv + vec2(0.0, -2.0*h.y)).rgb + texture(uSrc, vUv + vec2(-h.x, -h.y)).rgb*2.0;',
    '  o = vec4(c/12.0, 1.0);',
    '}'].join('\n');

  var COMP_FS = HEAD + [
    'in vec2 vUv; out vec4 o; uniform sampler2D uScene; uniform sampler2D uBloom; uniform float uExp; uniform vec3 uGrade; uniform float uFade; uniform float uClock; uniform float uLevels;',
    'const mat3 AIN = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);',
    'const mat3 AOUT = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);',
    'vec3 rrt(vec3 v){ vec3 a = v*(v + 0.0245786) - 0.000090537; vec3 b = v*(0.983729*v + 0.4329510) + 0.238081; return a/b; }',
    'float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233)))*43758.5453); }',
    'void main(){',
    '  vec3 c = texture(uScene, vUv).rgb;',
    '  vec3 b = texture(uBloom, vUv).rgb/uLevels;',
    '  c = mix(c, b, 0.055);',
    '  c *= uExp*uGrade;',
    '  c = clamp(AOUT*rrt(AIN*c), 0.0, 1.0);',
    '  c = mix(c*12.92, 1.055*pow(c, vec3(1.0/2.4)) - 0.055, step(0.0031308, c));',
    '  vec2 q = vUv;',
    '  c *= 0.62 + 0.38*pow(16.0*q.x*q.y*(1.0 - q.x)*(1.0 - q.y), 0.16);',
    '  c += (hash(gl_FragCoord.xy + fract(uClock*7.0)*91.0) - 0.5)/160.0;',
    '  o = vec4(c*uFade, 1.0);',
    '}'].join('\n');

  function compile(type, src) {
    var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(s);
      console.error(log + '\n' + src.split('\n').map(function (l, i) { return (i + 1) + ': ' + l; }).join('\n'));
      throw new Error('shader');
    }
    return s;
  }
  function program(vs, fs) {
    var p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { console.error(gl.getProgramInfoLog(p)); throw new Error('link'); }
    var cache = {};
    return {
      p: p,
      u: function (n) { if (!(n in cache)) cache[n] = gl.getUniformLocation(p, n); return cache[n]; }
    };
  }

  var P;
  try {
    P = {
      spectrum: program(FS_VERT, SPECTRUM_FS),
      fft: program(FS_VERT, FFT_FS),
      assemble: program(FS_VERT, ASSEMBLE_FS),
      probe: program(FS_VERT, PROBE_FS),
      skylut: program(FS_VERT, SKYLUT_FS),
      sky: program(FS_VERT, SKY_FS),
      ocean: program(OCEAN_VS, OCEAN_FS),
      down: program(FS_VERT, DOWN_FS),
      up: program(FS_VERT, UP_FS),
      comp: program(FS_VERT, COMP_FS)
    };
  } catch (e) {
    var fb2 = document.createElement('div'); fb2.className = 'fallback';
    document.body.insertBefore(fb2, document.body.firstChild);
    canvas.remove();
    return;
  }

  // ---------- Geometry ----------
  var fsVao = gl.createVertexArray();
  gl.bindVertexArray(fsVao);
  var fsBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, fsBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  var small = Math.min(window.innerWidth, window.innerHeight) < 700;
  var RINGS = small ? 260 : 420, SEGS = small ? 420 : 760, R0 = 0.6, RMAX = 40000;
  var meshVao = gl.createVertexArray();
  gl.bindVertexArray(meshVao);
  var pos = new Float32Array(RINGS * SEGS * 2);
  var lnr = Math.log(RMAX / R0);
  for (var ri = 0; ri < RINGS; ri++) {
    var rr = R0 * Math.exp(lnr * ri / (RINGS - 1));
    for (var si = 0; si < SEGS; si++) {
      var th = si / SEGS * TAU;
      pos[(ri * SEGS + si) * 2] = Math.cos(th) * rr;
      pos[(ri * SEGS + si) * 2 + 1] = Math.sin(th) * rr;
    }
  }
  var idx = new Uint32Array((RINGS - 1) * SEGS * 6), q = 0;
  for (ri = 0; ri < RINGS - 1; ri++) {
    for (si = 0; si < SEGS; si++) {
      var a0 = ri * SEGS + si, a1 = ri * SEGS + (si + 1) % SEGS, b0 = a0 + SEGS, b1 = a1 + SEGS;
      idx[q++] = a0; idx[q++] = b0; idx[q++] = a1;
      idx[q++] = a1; idx[q++] = b0; idx[q++] = b1;
    }
  }
  var vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  var ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
  var INDEX_COUNT = idx.length;
  var SPACING = Math.max(TAU / SEGS, lnr / (RINGS - 1));
  gl.bindVertexArray(null);

  // ---------- Textures and framebuffers ----------
  function makeTex(w, h, internal, type, filter, wrap, mip, data) {
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, internal === gl.RGBA8 ? gl.RGBA : gl.RGBA, type, data || null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    return t;
  }
  function makeFbo(texs, depth) {
    var f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    var bufs = [];
    texs.forEach(function (t, i) { gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0); bufs.push(gl.COLOR_ATTACHMENT0 + i); });
    if (depth) gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    gl.drawBuffers(bufs);
    return f;
  }

  // Seeded Gaussian noise so the sea keeps its shape when the wind changes.
  function rng(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; var t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

  CASCADES.forEach(function (c, i) {
    var r = rng(1337 + i * 7919), g = new Float32Array(N * N * 2);
    for (var j = 0; j < N * N; j++) {
      var u1 = Math.max(r(), 1e-9), u2 = r(), m = Math.sqrt(-2 * Math.log(u1));
      g[j * 2] = m * Math.cos(TAU * u2); g[j * 2 + 1] = m * Math.sin(TAU * u2);
    }
    c.gauss = g;
    c.h0data = new Float32Array(N * N * 4);
    c.h0 = makeTex(N, N, gl.RGBA32F, gl.FLOAT, gl.NEAREST, gl.REPEAT, false, null);
    c.ping = [0, 1].map(function () {
      var A = makeTex(N, N, gl.RGBA32F, gl.FLOAT, gl.NEAREST, gl.REPEAT, false);
      var B = makeTex(N, N, gl.RGBA32F, gl.FLOAT, gl.NEAREST, gl.REPEAT, false);
      return { A: A, B: B, fbo: makeFbo([A, B]) };
    });
    c.disp = makeTex(N, N, gl.RGBA16F, gl.HALF_FLOAT, gl.LINEAR, gl.REPEAT, true);
    c.slope = [0, 1].map(function () {
      var t = makeTex(N, N, gl.RGBA16F, gl.HALF_FLOAT, gl.LINEAR, gl.REPEAT, true);
      if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, maxAniso);
      return t;
    });
    c.out = [makeFbo([c.disp, c.slope[0]]), makeFbo([c.disp, c.slope[1]])];
    c.cur = 0;
  });

  // Normalisers for the directional spreading functions, cos^(2s)(theta/2).
  function spreadNorm(s) { var sum = 0, n = 2000; for (var i = 0; i < n; i++) { var th = -Math.PI + (i + 0.5) / n * TAU; sum += Math.pow(Math.cos(th / 2), 2 * s); } return 1 / (sum * TAU / n); }
  var SW_S = 5, SS_S = 28, SW_Q = spreadNorm(SW_S), SS_Q = spreadNorm(SS_S);
  function jonswap(w, wp, alpha, gamma) {
    if (w <= 0) return 0;
    var sigma = w <= wp ? 0.07 : 0.09;
    var r = Math.exp(-((w - wp) * (w - wp)) / (2 * sigma * sigma * wp * wp));
    return alpha * G * G / Math.pow(w, 5) * Math.exp(-1.25 * Math.pow(wp / w, 4)) * Math.pow(gamma, r);
  }
  function swellAlpha(Hs, wp) {
    var sum = 0, n = 4000, wmax = wp * 6;
    for (var i = 0; i < n; i++) { var w = (i + 0.5) / n * wmax; sum += jonswap(w, wp, 1, 7) * wmax / n; }
    return (Hs / 4) * (Hs / 4) / sum;
  }
  var m0Total = 0;
  function buildSpectra() {
    var sp = seaParams(sea);
    var U = sp.wind, F = 280e3;
    var wpW = 22 * Math.pow(G * G / (U * F), 1 / 3);
    var aW = 0.076 * Math.pow(U * U / (F * G), 0.22);
    var wpS = TAU / sp.swellTp, aS = swellAlpha(sp.swellHs, wpS);
    m0Total = 0;
    CASCADES.forEach(function (c) {
      var L = c.L, dk = TAU / L, S = new Float32Array(N * N), d = c.h0data, g = c.gauss;
      for (var iz = 0; iz < N; iz++) {
        var nz = iz < N / 2 ? iz : iz - N;
        for (var ix = 0; ix < N; ix++) {
          var nx = ix < N / 2 ? ix : ix - N;
          var kx = nx * dk, kz = nz * dk, k = Math.sqrt(kx * kx + kz * kz), v = 0;
          if (k > 1e-6 && k >= c.kmin && k < c.kmax) {
            var w = Math.sqrt(G * k), dwdk = G / (2 * w), th = Math.atan2(kz, kx);
            var dW = SW_Q * Math.pow(Math.cos((th - WIND_ANGLE) / 2), 2 * SW_S);
            var dS = SS_Q * Math.pow(Math.cos((th - SWELL_ANGLE) / 2), 2 * SS_S);
            v = (jonswap(w, wpW, aW, 3.3) * dW + jonswap(w, wpS, aS, 7) * dS) * dwdk / k * Math.exp(-k * k * 0.0004);
            m0Total += v * dk * dk;
          }
          S[iz * N + ix] = Math.sqrt(Math.max(v, 0) * dk * dk / 4);
        }
      }
      for (iz = 0; iz < N; iz++) {
        for (ix = 0; ix < N; ix++) {
          var i = iz * N + ix, mi = ((N - iz) % N) * N + ((N - ix) % N);
          d[i * 4] = g[i * 2] * S[i]; d[i * 4 + 1] = g[i * 2 + 1] * S[i];
          d[i * 4 + 2] = g[mi * 2] * S[mi]; d[i * 4 + 3] = -g[mi * 2 + 1] * S[mi];
        }
      }
      gl.bindTexture(gl.TEXTURE_2D, c.h0);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, N, N, 0, gl.RGBA, gl.FLOAT, d);
    });
    readout();
  }

  function beaufort(u) { for (var i = 0; i < BEAUFORT.length; i++) if (u < BEAUFORT[i][0]) return BEAUFORT[i][1]; return 'Hurricane force'; }
  function readout() {
    var sp = seaParams(sea);
    document.getElementById('r-wind').textContent = Math.round(sp.wind * 1.944) + ' kn';
    document.getElementById('r-hs').textContent = (4 * Math.sqrt(m0Total)).toFixed(1) + ' m';
    document.getElementById('r-t').textContent = Math.round(sp.swellTp) + ' s';
    document.getElementById('sea-name').textContent = beaufort(sp.wind);
  }
  function readoutOnly() {
    var sp = seaParams(sea);
    document.getElementById('r-wind').textContent = Math.round(sp.wind * 1.944) + ' kn';
    document.getElementById('r-t').textContent = Math.round(sp.swellTp) + ' s';
    document.getElementById('sea-name').textContent = beaufort(sp.wind);
  }

  var spectrumTimer = null;
  slider.addEventListener('input', function () {
    sea = parseFloat(slider.value);
    if (!spectrumTimer) spectrumTimer = setTimeout(function () { spectrumTimer = null; buildSpectra(); }, 90);
  });
  buildSpectra();

  // Noise texture for clouds and foam breakup.
  var nr = rng(42), nd = new Uint8Array(256 * 256 * 4);
  for (var ni = 0; ni < nd.length; ni++) nd[ni] = Math.floor(nr() * 256);
  var noiseTex = makeTex(256, 256, gl.RGBA8, gl.UNSIGNED_BYTE, gl.LINEAR, gl.REPEAT, false, nd);

  var skyTex = makeTex(256, 128, gl.RGBA16F, gl.HALF_FLOAT, gl.LINEAR, gl.CLAMP_TO_EDGE, true);
  gl.bindTexture(gl.TEXTURE_2D, skyTex); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  var skyFbo = makeFbo([skyTex]);

  var probeTex = makeTex(1, 1, gl.RGBA32F, gl.FLOAT, gl.NEAREST, gl.CLAMP_TO_EDGE, false);
  var probeFbo = makeFbo([probeTex]);
  var pbo = gl.createBuffer();
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo); gl.bufferData(gl.PIXEL_PACK_BUFFER, 16, gl.STREAM_READ);
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  var probeSync = null, probeData = new Float32Array(4), probe = { h: 0, dx: 0, dz: 0, have: false };

  var W = 0, H = 0, sceneTex, depthRb, sceneFbo, bloom = [];
  var BLOOM_LEVELS = 6;
  var scale = window.__forceScale || (small ? 0.75 : 0.85), frameAvg = 16, sampleFrames = 0;
  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    var w = Math.max(16, Math.round(window.innerWidth * dpr * scale));
    var h = Math.max(16, Math.round(window.innerHeight * dpr * scale));
    if (w === W && h === H) return;
    W = w; H = h; canvas.width = w; canvas.height = h;
    if (sceneTex) { gl.deleteTexture(sceneTex); gl.deleteRenderbuffer(depthRb); gl.deleteFramebuffer(sceneFbo); bloom.forEach(function (b) { gl.deleteTexture(b.t); gl.deleteFramebuffer(b.f); }); }
    sceneTex = makeTex(w, h, gl.RGBA16F, gl.HALF_FLOAT, gl.LINEAR, gl.CLAMP_TO_EDGE, false);
    depthRb = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, depthRb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    sceneFbo = makeFbo([sceneTex], depthRb);
    bloom = [];
    var bw = w, bh = h;
    for (var i = 0; i < BLOOM_LEVELS; i++) {
      bw = Math.max(1, bw >> 1); bh = Math.max(1, bh >> 1);
      var t = makeTex(bw, bh, gl.RGBA16F, gl.HALF_FLOAT, gl.LINEAR, gl.CLAMP_TO_EDGE, false);
      bloom.push({ t: t, f: makeFbo([t]), w: bw, h: bh });
    }
  }
  window.addEventListener('resize', resize);
  resize();

  function bindTex(prog, name, unit, tex) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(prog.u(name), unit); }
  function fullscreen() { gl.bindVertexArray(fsVao); gl.drawArrays(gl.TRIANGLES, 0, 3); }

  // Sun transmittance through the same atmosphere, for light colour on water and clouds.
  function rsi(o, d, r) { var b = 2 * (o[0] * d[0] + o[1] * d[1] + o[2] * d[2]), c = o[0] * o[0] + o[1] * o[1] + o[2] * o[2] - r * r, D = b * b - 4 * c; if (D < 0) return [1e5, -1e5]; var s = Math.sqrt(D); return [(-b - s) / 2, (-b + s) / 2]; }
  function sunIrradiance(dir, iSun) {
    var o = [0, 6371e3 + 30, 0], t = rsi(o, dir, 6471e3)[1], hit = rsi(o, dir, 6371e3);
    if (hit[0] > 0) return [0, 0, 0];
    var steps = 48, st = t / steps, oR = 0, oM = 0;
    for (var i = 0; i < steps; i++) {
      var s = st * (i + 0.5), p = [o[0] + dir[0] * s, o[1] + dir[1] * s, o[2] + dir[2] * s];
      var h = Math.sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]) - 6371e3;
      oR += Math.exp(-h / 8e3) * st; oM += Math.exp(-h / 1.2e3) * st;
    }
    var kR = [5.5e-6, 13.0e-6, 22.4e-6];
    return kR.map(function (k) { return iSun * Math.exp(-(k * oR + 21e-6 * 1.1 * oM)); });
  }

  // ---------- Matrices ----------
  function persp(fovy, asp, n, f) { var t = 1 / Math.tan(fovy / 2); return [t / asp, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) / (n - f), -1, 0, 0, 2 * f * n / (n - f), 0]; }
  function mul(a, b) { var o = new Array(16); for (var c = 0; c < 4; c++) for (var r = 0; r < 4; r++) { var s = 0; for (var k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; }
  function norm3(v) { var l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }

  // ---------- Frame ----------
  var simT = 0, clock = 0, camX = 0, camZ = 0, camY = 6, roll = 0, pitchSway = 0, born = performance.now();
  var FOV = 42 * Math.PI / 180;
  start = true;

  function frame(now) {
    if (paused || document.hidden) return;
    var dt = Math.min((now - last) / 1000, 0.1); last = now;
    frameAvg = frameAvg * 0.94 + dt * 1000 * 0.06;
    if (!window.__forceScale && ++sampleFrames > 50) {
      sampleFrames = 0;
      if (frameAvg > 21 && scale > 0.4) { scale = Math.max(0.4, scale * 0.86); resize(); }
      else if (frameAvg < 12.5 && scale < 1) { scale = Math.min(1, scale * 1.08); resize(); }
    }
    var speed = reduce ? 0.15 : 1;
    simT += dt * speed; clock += dt * speed;

    if (to) {
      var tt = Math.min(1, (now - tweenStart) / TWEEN), e = ease(tt);
      ['az', 'el', 'isun', 'exp', 'night', 'clouds'].forEach(function (k) { state[k] = lerp(from[k], to[k], e); });
      for (var i = 0; i < 3; i++) { state.grade[i] = lerp(from.grade[i], to.grade[i], e); state.accent[i] = lerp(from.accent[i], to.accent[i], e); }
      updateSkyReadout(); skyDirty = true;
      if (tt >= 1) { from = to = null; }
    }
    var az = state.az * Math.PI / 180, el = state.el * Math.PI / 180;
    var sunDir = [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];
    var sunIrr = sunIrradiance(sunDir, state.isun);

    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);

    // Sky look-up table
    if (skyDirty) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, skyFbo); gl.viewport(0, 0, 256, 128);
      gl.useProgram(P.skylut.p);
      gl.uniform3fv(P.skylut.u('uSun'), sunDir); gl.uniform1f(P.skylut.u('uISun'), state.isun);
      fullscreen();
      gl.bindTexture(gl.TEXTURE_2D, skyTex); gl.generateMipmap(gl.TEXTURE_2D);
      skyDirty = false;
    }

    // Ocean spectrum -> inverse FFT -> displacement, slopes and foam, per cascade
    gl.viewport(0, 0, N, N);
    CASCADES.forEach(function (c) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, c.ping[0].fbo);
      gl.useProgram(P.spectrum.p);
      bindTex(P.spectrum, 'uH0', 0, c.h0);
      gl.uniform1f(P.spectrum.u('uT'), simT); gl.uniform1f(P.spectrum.u('uL'), c.L);
      fullscreen();
      gl.useProgram(P.fft.p);
      var src = 0;
      for (var dir = 1; dir >= 0; dir--) {
        gl.uniform1i(P.fft.u('uHoriz'), dir);
        for (var sub = 2; sub <= N; sub *= 2) {
          var dst = 1 - src;
          gl.bindFramebuffer(gl.FRAMEBUFFER, c.ping[dst].fbo);
          bindTex(P.fft, 'uA', 0, c.ping[src].A); bindTex(P.fft, 'uB', 1, c.ping[src].B);
          gl.uniform1i(P.fft.u('uSub'), sub);
          fullscreen();
          src = dst;
        }
      }
      var nxt = 1 - c.cur;
      gl.bindFramebuffer(gl.FRAMEBUFFER, c.out[nxt]);
      gl.useProgram(P.assemble.p);
      bindTex(P.assemble, 'uA', 0, c.ping[src].A); bindTex(P.assemble, 'uB', 1, c.ping[src].B); bindTex(P.assemble, 'uPrev', 2, c.slope[c.cur]);
      gl.uniform1f(P.assemble.u('uLambda'), CHOP); gl.uniform1f(P.assemble.u('uDt'), dt * speed); gl.uniform1f(P.assemble.u('uFoamBias'), 0.42);
      fullscreen();
      c.cur = nxt;
      gl.bindTexture(gl.TEXTURE_2D, c.disp); gl.generateMipmap(gl.TEXTURE_2D);
      gl.bindTexture(gl.TEXTURE_2D, c.slope[c.cur]); gl.generateMipmap(gl.TEXTURE_2D);
    });

    // Camera drifts slowly and rides the swell.
    camZ += dt * speed * 0.9; camX += dt * speed * 0.15;
    function camUv(c) { return [((camX % c.L) + c.L) % c.L / c.L, ((camZ % c.L) + c.L) % c.L / c.L]; }
    var cuv = CASCADES.map(camUv);

    if (probeSync) {
      var st = gl.clientWaitSync(probeSync, 0, 0);
      if (st === gl.ALREADY_SIGNALED || st === gl.CONDITION_SATISFIED) {
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo); gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, probeData); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        gl.deleteSync(probeSync); probeSync = null;
        probe.h = probeData[0]; probe.dx = probeData[1]; probe.dz = probeData[2]; probe.have = true;
      }
    }
    if (!probeSync) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, probeFbo); gl.viewport(0, 0, 1, 1);
      gl.useProgram(P.probe.p);
      bindTex(P.probe, 'uD0', 0, CASCADES[0].disp); bindTex(P.probe, 'uD1', 1, CASCADES[1].disp);
      gl.uniform2fv(P.probe.u('uC0'), cuv[0]); gl.uniform2fv(P.probe.u('uC1'), cuv[1]);
      gl.uniform2f(P.probe.u('uInvL'), 1 / CASCADES[0].L, 1 / CASCADES[1].L);
      fullscreen();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      probeSync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
    }

    var hs = 4 * Math.sqrt(m0Total);
    var sway = reduce ? 0 : 1;
    var targetY = (probe.have ? probe.h * sway : 0) + 2.4 + 0.32 * hs;
    camY = lerp(camY, targetY, 1 - Math.exp(-dt * 2.5));
    roll = lerp(roll, sway * Math.atan(probe.dx) * 0.35, 1 - Math.exp(-dt * 2));
    pitchSway = lerp(pitchSway, sway * Math.atan(probe.dz) * 0.3, 1 - Math.exp(-dt * 2));

    var lk = 1 - Math.exp(-dt * 2.0);
    look[0] = lerp(look[0], lookTarget[0], lk); look[1] = lerp(look[1], lookTarget[1], lk);
    var yaw = look[0] + Math.sin(clock * 0.05) * 0.06 * sway;
    var pitch = 0.035 + look[1] + pitchSway;
    var fw = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
    var rt = norm3(cross(fw, [0, 1, 0]));
    var up = cross(rt, fw);
    var cr = Math.cos(roll), sr = Math.sin(roll);
    var rt2 = [rt[0] * cr + up[0] * sr, rt[1] * cr + up[1] * sr, rt[2] * cr + up[2] * sr];
    up = cross(rt2, fw); rt = rt2;
    var view = [rt[0], up[0], -fw[0], 0, rt[1], up[1], -fw[1], 0, rt[2], up[2], -fw[2], 0, 0, 0, 0, 1];
    var asp = W / H, proj = persp(FOV, asp, 1.0, 60000), vp = mul(proj, view);
    var tanY = Math.tan(FOV / 2), tanX = tanY * asp;

    // Scene: sky, then ocean
    gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFbo); gl.viewport(0, 0, W, H);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    function skyUniforms(pr, unit) {
      bindTex(pr, 'uSky', unit, skyTex); bindTex(pr, 'uNoise', unit + 1, noiseTex);
      gl.uniform3fv(pr.u('uSunDir'), sunDir); gl.uniform3fv(pr.u('uSunIrr'), sunIrr);
      gl.uniform1f(pr.u('uClock'), clock); gl.uniform1f(pr.u('uCover'), state.clouds); gl.uniform1f(pr.u('uNight'), state.night);
      gl.uniform2f(pr.u('uCamXZ'), camX, camZ);
    }
    gl.useProgram(P.sky.p);
    skyUniforms(P.sky, 0);
    gl.uniform3fv(P.sky.u('uFw'), fw); gl.uniform3fv(P.sky.u('uRt'), rt); gl.uniform3fv(P.sky.u('uUp'), up);
    gl.uniform2f(P.sky.u('uTan'), tanX, tanY); gl.uniform1f(P.sky.u('uSunDisc'), state.night > 0.5 ? 320 : 260);
    fullscreen();

    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS);
    gl.useProgram(P.ocean.p);
    skyUniforms(P.ocean, 0);
    gl.uniformMatrix4fv(P.ocean.u('uVP'), false, vp);
    gl.uniform1f(P.ocean.u('uCamY'), camY); gl.uniform1f(P.ocean.u('uSpacing'), SPACING); gl.uniform1f(P.ocean.u('uHs'), hs);
    gl.uniform3f(P.ocean.u('uL'), CASCADES[0].L, CASCADES[1].L, CASCADES[2].L);
    ['uC0', 'uC1', 'uC2'].forEach(function (n, i) { gl.uniform2fv(P.ocean.u(n), cuv[i]); });
    bindTex(P.ocean, 'uD0', 2, CASCADES[0].disp); bindTex(P.ocean, 'uD1', 3, CASCADES[1].disp); bindTex(P.ocean, 'uD2', 4, CASCADES[2].disp);
    bindTex(P.ocean, 'uS0', 5, CASCADES[0].slope[CASCADES[0].cur]); bindTex(P.ocean, 'uS1', 6, CASCADES[1].slope[CASCADES[1].cur]); bindTex(P.ocean, 'uS2', 7, CASCADES[2].slope[CASCADES[2].cur]);
    gl.bindVertexArray(meshVao);
    gl.drawElements(gl.TRIANGLES, INDEX_COUNT, gl.UNSIGNED_INT, 0);
    gl.disable(gl.DEPTH_TEST);

    // Bloom: dual-filter down and up chain
    gl.useProgram(P.down.p);
    for (var b = 0; b < BLOOM_LEVELS; b++) {
      var srcT = b === 0 ? sceneTex : bloom[b - 1].t, sw = b === 0 ? W : bloom[b - 1].w, sh = b === 0 ? H : bloom[b - 1].h;
      gl.bindFramebuffer(gl.FRAMEBUFFER, bloom[b].f); gl.viewport(0, 0, bloom[b].w, bloom[b].h);
      bindTex(P.down, 'uSrc', 0, srcT);
      gl.uniform2f(P.down.u('uHp'), 0.5 / sw, 0.5 / sh); gl.uniform1f(P.down.u('uFirst'), b === 0 ? 1 : 0);
      fullscreen();
    }
    gl.useProgram(P.up.p);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    for (b = BLOOM_LEVELS - 1; b > 0; b--) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, bloom[b - 1].f); gl.viewport(0, 0, bloom[b - 1].w, bloom[b - 1].h);
      bindTex(P.up, 'uSrc', 0, bloom[b].t);
      gl.uniform2f(P.up.u('uHp'), 0.5 / bloom[b].w, 0.5 / bloom[b].h);
      fullscreen();
    }
    gl.disable(gl.BLEND);

    // Composite
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W, H);
    gl.useProgram(P.comp.p);
    bindTex(P.comp, 'uScene', 0, sceneTex); bindTex(P.comp, 'uBloom', 1, bloom[0].t);
    var fade = reduce ? 1 : Math.min(1, (now - born) / 2800);
    gl.uniform1f(P.comp.u('uExp'), state.exp); gl.uniform3fv(P.comp.u('uGrade'), state.grade);
    gl.uniform1f(P.comp.u('uFade'), fade * fade * (3 - 2 * fade)); gl.uniform1f(P.comp.u('uClock'), clock);
    gl.uniform1f(P.comp.u('uLevels'), BLOOM_LEVELS);
    fullscreen();

    requestAnimationFrame(frame);
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden && !paused) { last = performance.now(); requestAnimationFrame(frame); } });
  canvas.classList.add('on');
  requestAnimationFrame(frame);
})();
