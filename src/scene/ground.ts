import * as THREE from 'three';

/** How far the ground plane reaches; the grid has faded out long before this. */
const EXTENT = 200000; // mm

const vertexShader = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

// Anti-aliased grid lines drawn per pixel: minor and major lines (10 / 50 mm, or 0.25 / 1 inch),
// red/green lines along the X and Y axes, all fading out with distance from
// the point the camera looks at. Minor lines also fade where they would get
// denser than a few pixels, which avoids moiré near the horizon.
const fragmentShader = /* glsl */ `
  uniform vec3 uMinor;
  uniform vec3 uMajor;
  uniform vec3 uFill;
  uniform float uFillOpacity;
  uniform float uLineOpacity;
  uniform vec2 uCenter;
  uniform float uFade;
  uniform float uMinorStep;
  uniform float uMajorStep;
  varying vec3 vWorld;

  float line(vec2 p, float step, out float density) {
    vec2 q = p / step;
    vec2 w = fwidth(q);
    density = max(w.x, w.y);
    vec2 g = abs(fract(q - 0.5) - 0.5) / max(w, vec2(1e-5));
    return 1.0 - min(min(g.x, g.y), 1.0);
  }

  void main() {
    vec2 p = vWorld.xy;
    float dMinor, dMajor;
    float minor = line(p, uMinorStep, dMinor) * (1.0 - smoothstep(0.15, 0.4, dMinor));
    float major = line(p, uMajorStep, dMajor) * (1.0 - smoothstep(0.3, 0.6, dMajor));
    float fade = 1.0 - smoothstep(uFade * 0.35, uFade, length(p - uCenter));

    vec3 color = uFill;
    float alpha = uFillOpacity;
    color = mix(color, uMinor, minor);
    alpha = max(alpha, minor * 0.8 * uLineOpacity);
    color = mix(color, uMajor, major);
    alpha = max(alpha, major * uLineOpacity);

    // Axis lines: X axis (y = 0) red, Y axis (x = 0) green.
    vec2 aw = fwidth(p);
    float onX = 1.0 - min(abs(p.y) / max(aw.y, 1e-5) * 0.7, 1.0);
    float onY = 1.0 - min(abs(p.x) / max(aw.x, 1e-5) * 0.7, 1.0);
    color = mix(color, vec3(0.75, 0.25, 0.25), onX);
    color = mix(color, vec3(0.25, 0.6, 0.35), onY);
    alpha = max(alpha, max(onX, onY));

    gl_FragColor = vec4(color, alpha * fade);
  }
`;

export interface GroundColors {
  minor: number;
  major: number;
  fill: number;
  fillOpacity: number;
}

/**
 * Infinite build surface: one large plane whose grid is drawn in the shader
 * and fades toward the horizon, plus a matching shadow catcher. There is no
 * edge for objects to cross, so nothing has to grow or jump while dragging.
 */
export class Ground {
  readonly group = new THREE.Group();
  private readonly material: THREE.ShaderMaterial;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uMinor: { value: new THREE.Color() },
        uMajor: { value: new THREE.Color() },
        uFill: { value: new THREE.Color() },
        uFillOpacity: { value: 0.3 },
        uLineOpacity: { value: 1 },
        uCenter: { value: new THREE.Vector2() },
        uFade: { value: 1000 },
        uMinorStep: { value: 10 },
        uMajorStep: { value: 50 },
      },
    });
    const grid = new THREE.Mesh(new THREE.PlaneGeometry(EXTENT, EXTENT), this.material);
    grid.renderOrder = -1;
    grid.name = 'ground';
    this.group.add(grid);

    // Only draws where shadows fall; invisible elsewhere.
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(EXTENT, EXTENT),
      new THREE.ShadowMaterial({ opacity: 0.3, depthWrite: false }),
    );
    shadow.receiveShadow = true;
    shadow.position.z = 0.01;
    this.group.add(shadow);
  }

  setColors(c: GroundColors): void {
    const u = this.material.uniforms;
    (u.uMinor.value as THREE.Color).setHex(c.minor);
    (u.uMajor.value as THREE.Color).setHex(c.major);
    (u.uFill.value as THREE.Color).setHex(c.fill);
    u.uFillOpacity.value = c.fillOpacity;
  }

  /** How strongly the minor and major grid lines show (1: as designed; the axis lines and the fill are not affected). */
  setLineOpacity(opacity: number): void {
    this.material.uniforms.uLineOpacity.value = opacity;
  }

  /** Distance (mm) between the minor and the major grid lines. */
  setSteps(minor: number, major: number): void {
    this.material.uniforms.uMinorStep.value = minor;
    this.material.uniforms.uMajorStep.value = major;
  }

  /** Centre the fade on what the camera looks at; reach grows as the camera backs away. */
  follow(target: THREE.Vector3, cameraDistance: number): void {
    (this.material.uniforms.uCenter.value as THREE.Vector2).set(target.x, target.y);
    this.material.uniforms.uFade.value = Math.max(400, cameraDistance * 3);
  }
}
