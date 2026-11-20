import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// Lens pass: shockwave refraction, radial warp blur, chromatic split, glitch
// slices, scanlines, grain and vignette — everything that sells "projected light".
const LensShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uAberr: { value: 0.0016 },
    uGlitch: { value: 0 },
    uWarp: { value: 0 },
    uWaveR: { value: 2 },
    uWaveAmp: { value: 0 },
    uCenter: { value: new THREE.Vector2(0.5, 0.5) },
    uAspect: { value: 1 },
    uShake: { value: new THREE.Vector2() },
  },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }',
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uTime, uAberr, uGlitch, uWarp, uWaveR, uWaveAmp, uAspect;
    uniform vec2 uCenter; uniform vec2 uShake;
    varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    void main(){
      vec2 uv = vUv + uShake;
      // glitch: displaced horizontal slices
      float sl = floor(uv.y * 28. + uTime * 31.);
      float r = hash(vec2(sl, floor(uTime * 24.)));
      uv.x += (r - .5) * .12 * uGlitch * step(.62, r);
      uv.y += (hash(vec2(floor(uTime * 18.), 4.)) - .5) * .02 * uGlitch * step(.8, r);

      // shockwave ring refraction
      vec2 dir = uv - uCenter; dir.x *= uAspect;
      float dist = length(dir);
      float w = exp(-pow((dist - uWaveR) * 13., 2.)) * uWaveAmp;
      uv -= normalize(dir + 1e-5) * w * .05 * vec2(1. / uAspect, 1.);

      vec2 c = uv - .5;
      float r2 = dot(c, c);
      float ab = uAberr * (.35 + r2 * 5.) + w * .012 + uGlitch * .006 + uWarp * .006;

      // radial warp blur (time dilation) with chromatic split
      vec3 col = vec3(0.);
      float tot = 0.;
      for (int i = 0; i < 8; i++) {
        float k = float(i) / 7.;
        vec2 o = c * uWarp * .11 * k;
        float wgt = 1. - k * .6;
        col.r += texture2D(tDiffuse, uv - o + c * ab).r * wgt;
        col.g += texture2D(tDiffuse, uv - o).g * wgt;
        col.b += texture2D(tDiffuse, uv - o - c * ab).b * wgt;
        tot += wgt;
      }
      col /= tot;
      col += w * .12;

      col *= .93 + .07 * sin(gl_FragCoord.y * 1.6 + uTime * 4.);
      col += (hash(uv * vec2(1733., 911.) + fract(uTime) * 61.) - .5) * .03;
      col *= smoothstep(1.05, .28, sqrt(r2) * 1.25);
      gl_FragColor = vec4(max(col, 0.), 1.);
    }`,
};

export function createPost(renderer, scene, camera, pixelRatio) {
  const size = renderer.getSize(new THREE.Vector2());
  const target = new THREE.WebGLRenderTarget(size.x * pixelRatio, size.y * pixelRatio, {
    type: THREE.HalfFloatType, samples: 2,
  });
  const composer = new EffectComposer(renderer, target);
  composer.setPixelRatio(pixelRatio);
  composer.setSize(size.x, size.y);

  const after = new AfterimagePass(0.5);
  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.42, 0.45, 0.42);
  const lens = new ShaderPass(LensShader);

  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(after);
  composer.addPass(bloom);
  composer.addPass(lens);
  composer.addPass(new OutputPass());

  return { composer, after, bloom, lens: lens.uniforms };
}
