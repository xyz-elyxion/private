import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { FOV_DEG } from './constants';

type ShaderUniforms = {
  uTime: { value: number };
};

/** Install the lightweight arena shader pass on a lit material. */
export function installArenaShader(material: THREE.MeshStandardMaterial, accent = 0x68d9ff) {
  const uniforms: ShaderUniforms & { uAccent: { value: THREE.Color } } = {
    uTime: { value: 0 },
    uAccent: { value: new THREE.Color(accent) },
  };
  material.userData.elyxionShaderUniforms = uniforms;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uAccent = uniforms.uAccent;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>\n        varying vec3 vElyWorldPosition;`,
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>\n        vElyWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>\n        uniform float uTime;\n        uniform vec3 uAccent;\n        varying vec3 vElyWorldPosition;`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <output_fragment>',
      `
        // Animated arena grid seams, scanlines, and a low-frequency energy pulse.
        float cellX = fract(vElyWorldPosition.x * 0.5);
        float cellZ = fract(vElyWorldPosition.z * 0.5);
        float gridX = 1.0 - smoothstep(0.0, 0.045, min(cellX, 1.0 - cellX));
        float gridZ = 1.0 - smoothstep(0.0, 0.045, min(cellZ, 1.0 - cellZ));
        float grid = max(gridX, gridZ);
        float scan = 0.5 + 0.5 * sin(vElyWorldPosition.y * 3.0 + uTime * 1.6);
        float pulse = 0.5 + 0.5 * sin((vElyWorldPosition.x + vElyWorldPosition.z) * 0.08 - uTime * 0.8);
        outgoingLight += uAccent * (grid * (0.22 + 0.16 * pulse) + scan * 0.035);
        #include <output_fragment>
      `,
    );
  };
  material.customProgramCacheKey = () => 'elyxion-arena-surface-v1';
  return material;
}

export function updateSceneShaders(scene: THREE.Scene, time: number) {
  scene.traverse((object) => {
    const material = (object as THREE.Mesh).material;
    const materials = Array.isArray(material) ? material : material ? [material] : [];
    for (const current of materials) {
      const uniforms = current.userData.elyxionShaderUniforms as ShaderUniforms | undefined;
      if (uniforms) uniforms.uTime.value = time;
      const skyUniforms = current.userData.elyxionSkyUniforms as ShaderUniforms | undefined;
      if (skyUniforms) skyUniforms.uTime.value = time;
    }
  });
}

export function createRenderer(canvas: HTMLCanvasElement): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  const w = canvas.clientWidth || window.innerWidth;
  const h = canvas.clientHeight || window.innerHeight;
  renderer.setSize(w, h, false);
  return renderer;
}

export function createCamera(canvas: HTMLCanvasElement): THREE.PerspectiveCamera {
  const w = canvas.clientWidth || window.innerWidth;
  const h = canvas.clientHeight || window.innerHeight;
  return new THREE.PerspectiveCamera(FOV_DEG, w / h, 0.1, 1000);
}

// Procedural sky dome: gradient, moving cloud bands, and subtle stars.
function createSky(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(500, 32, 15);
  const uniforms: ShaderUniforms & {
    topColor: { value: THREE.Color };
    bottomColor: { value: THREE.Color };
  } = {
    uTime: { value: 0 },
    topColor: { value: new THREE.Color(0x386fae) },
    bottomColor: { value: new THREE.Color(0xe7f1f7) },
  };
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTime: uniforms.uTime,
      topColor: uniforms.topColor,
      bottomColor: uniforms.bottomColor,
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorldPosition;
      void main() {
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPos.xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 topColor;
      uniform vec3 bottomColor;
      varying vec3 vWorldPosition;

      float hash21(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }

      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
          mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x),
          f.y
        );
      }

      void main() {
        vec3 direction = normalize(vWorldPosition - cameraPosition);
        float height = clamp(direction.y * 0.5 + 0.5, 0.0, 1.0);
        vec3 color = mix(bottomColor, topColor, pow(height, 0.72));

        vec2 cloudUv = direction.xz / max(0.25, direction.y + 1.0);
        float cloud = noise(cloudUv * 3.2 + vec2(uTime * 0.012, 0.0));
        float cloudBand = smoothstep(0.38, 0.7, cloud) * smoothstep(0.02, 0.72, height);
        color = mix(color, color + vec3(0.15, 0.18, 0.2), cloudBand * 0.42);

        float stars = step(0.995, hash21(floor(direction.xz * 900.0))) * smoothstep(0.38, 0.88, height);
        color += vec3(0.65, 0.82, 1.0) * stars * 0.45;
        gl_FragColor = vec4(color, 1.0);
      }
    `,
  });
  const sky = new THREE.Mesh(geo, mat);
  sky.name = 'sky';
  mat.userData.elyxionSkyUniforms = uniforms;
  return sky;
}

export function createScene(renderer: THREE.WebGLRenderer): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9fc0dd);
  scene.fog = new THREE.Fog(0xb6cadb, 90, 280);
  scene.add(createSky());

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();

  const hemi = new THREE.HemisphereLight(0xcfe2f2, 0x55504e, 0.7);
  scene.add(hemi);
  const fill = new THREE.DirectionalLight(0x88a6ff, 0.35);
  fill.position.set(-15, 18, -12);
  scene.add(fill);
  return scene;
}
