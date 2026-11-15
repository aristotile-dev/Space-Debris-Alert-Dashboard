import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Scan } from "./api";

/** Scene units are 1000 km. The globe is drawn at 62% of true size so the orbits and the debris shell stay readable (positions are true). */
const R_EARTH = 6.378 * 0.62;
const AQUA = 0x5ef2ff;
const TANGERINE = 0xff6a1a;

interface Props {
  cloud: Float32Array | null;
  scan: Scan | null;
  scanning: boolean;
  band: [number, number] | null; // target altitude band in km from Earth's centre, widened by the alert distance
  selectedId: number | null;
  onPick: (id: number | null) => void;
}

const cloudVert = /* glsl */ `
  uniform vec3 uTarget; uniform float uSweep; uniform vec2 uBand; uniform float uBandOn; uniform float uPx;
  varying float vBand; varying float vSwept; varying float vDepth;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float r = length(position) * 1000.0;
    vBand = (r > uBand.x && r < uBand.y) ? uBandOn : 0.0;
    float d = distance(position, uTarget) * 1000.0;
    vSwept = uSweep > 0.0 ? smoothstep(uSweep, uSweep - 2500.0, d) : 0.0;
    vDepth = clamp(1.0 - (-mv.z - 12.0) / 26.0, 0.25, 1.0);
    gl_PointSize = uPx * (1.0 + vBand * 0.9 + vSwept * 1.2) * (0.7 + vDepth * 0.6);
    gl_Position = projectionMatrix * mv;
  }
`;
const cloudFrag = /* glsl */ `
  varying float vBand; varying float vSwept; varying float vDepth;
  void main() {
    vec2 c = gl_PointCoord - 0.5; float d = length(c); if (d > 0.5) discard;
    vec3 dim = vec3(0.62, 0.74, 1.0);
    vec3 aqua = vec3(0.37, 0.95, 1.0);
    vec3 col = mix(dim, aqua, vBand);
    col = mix(col, vec3(1.0), vSwept * 0.85);
    float a = (0.5 + vBand * 0.35 + vSwept * 0.15) * vDepth * smoothstep(0.5, 0.15, d);
    gl_FragColor = vec4(col, a);
  }
`;
const earthVert = /* glsl */ `
  varying vec3 vN; varying vec3 vV;
  void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }
`;
const earthFrag = /* glsl */ `
  varying vec3 vN; varying vec3 vV;
  void main() {
    float nv = clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0);
    vec3 deep = vec3(0.02, 0.06, 0.42);
    vec3 mid = vec3(0.08, 0.30, 0.95);
    vec3 col = mix(mid, deep, pow(nv, 0.7));
    float rim = pow(1.0 - nv, 2.6);
    col += vec3(0.37, 0.95, 1.0) * rim * 1.15;
    vec3 L = normalize(vec3(-0.5, 0.65, 0.6));
    vec3 H = normalize(L + normalize(vV));
    float spec = pow(max(dot(normalize(vN), H), 0.0), 38.0);
    col += vec3(0.85, 0.97, 1.0) * spec * 0.8;
    gl_FragColor = vec4(col, 0.93);
  }
`;
const atmoFrag = /* glsl */ `
  varying vec3 vN; varying vec3 vV;
  void main() { float i = pow(0.74 - dot(normalize(vN), normalize(vV)), 3.2); gl_FragColor = vec4(0.37, 0.95, 1.0, 1.0) * clamp(i, 0.0, 1.0) * 0.42; }
`;

function tubeFrom(flat: number[], scale: number, radius: number, color: number, emissive: number, closed = true) {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i + 2 < flat.length; i += 3) pts.push(new THREE.Vector3(flat[i] * scale, flat[i + 1] * scale, flat[i + 2] * scale));
  if (pts.length < 3) return null;
  const curve = new THREE.CatmullRomCurve3(pts, closed, "centripetal");
  const geo = new THREE.TubeGeometry(curve, Math.min(260, pts.length * 3), radius, 10, closed);
  const mat = new THREE.MeshPhysicalMaterial({ color, emissive, emissiveIntensity: 0.55, metalness: 0.55, roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.08, transparent: true });
  return { mesh: new THREE.Mesh(geo, mat), curve };
}

interface Ev { id: number; name: string; km: number; tube: THREE.Mesh; hit: THREE.Mesh; marker: THREE.Mesh; pos: THREE.Vector3 }

export default function Globe({ cloud, scan, scanning, band, selectedId, onPick }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const api = useRef<{ setCloud: (c: Float32Array | null) => void; setScan: (s: Scan | null) => void; setScanning: (b: boolean) => void; setBand: (b: [number, number] | null) => void; setSelected: (id: number | null) => void } | null>(null);
  const [lab, setLab] = useState<{ name: string; km: number } | null>(null);
  const labelCb = useRef(setLab);
  const pickCb = useRef(onPick);
  pickCb.current = onPick;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setClearColor(0x000000, 0);
    el.appendChild(renderer.domElement);
    renderer.domElement.style.cssText = "display:block;width:100%;height:100%;touch-action:pan-y;";

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 200);
    const home = new THREE.Vector3(8.7, 9.9, 24.4);
    camera.position.copy(reduce ? home : home.clone().multiplyScalar(1.9));
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableZoom = false;
    controls.enablePan = false;
    controls.enableDamping = true;
    controls.autoRotate = !reduce;
    controls.autoRotateSpeed = 0.45;
    controls.minPolarAngle = 0.5;
    controls.maxPolarAngle = Math.PI - 0.5;

    scene.add(new THREE.AmbientLight(0x9bb4ff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(-8, 12, 14);
    scene.add(key);
    const rim = new THREE.PointLight(AQUA, 60, 80);
    rim.position.set(14, -6, -10);
    scene.add(rim);

    // glass Earth, its grid and its glow
    const earth = new THREE.Mesh(
      new THREE.SphereGeometry(R_EARTH, 96, 64),
      new THREE.ShaderMaterial({ vertexShader: earthVert, fragmentShader: earthFrag, transparent: true })
    );
    scene.add(earth);
    const gridPts: number[] = [];
    const rr = R_EARTH * 1.003;
    for (let lat = -75; lat <= 75; lat += 15) {
      const phi = (lat * Math.PI) / 180;
      for (let k = 0; k < 120; k++) {
        const a = (k / 120) * Math.PI * 2, b = ((k + 1) / 120) * Math.PI * 2;
        gridPts.push(rr * Math.cos(phi) * Math.cos(a), rr * Math.sin(phi), rr * Math.cos(phi) * Math.sin(a), rr * Math.cos(phi) * Math.cos(b), rr * Math.sin(phi), rr * Math.cos(phi) * Math.sin(b));
      }
    }
    for (let lon = 0; lon < 360; lon += 15) {
      const a = (lon * Math.PI) / 180;
      for (let k = 0; k < 90; k++) {
        const p = -Math.PI / 2 + (k / 90) * Math.PI, q = -Math.PI / 2 + ((k + 1) / 90) * Math.PI;
        gridPts.push(rr * Math.cos(p) * Math.cos(a), rr * Math.sin(p), rr * Math.cos(p) * Math.sin(a), rr * Math.cos(q) * Math.cos(a), rr * Math.sin(q), rr * Math.cos(q) * Math.sin(a));
      }
    }
    const gridGeo = new THREE.BufferGeometry();
    gridGeo.setAttribute("position", new THREE.Float32BufferAttribute(gridPts, 3));
    scene.add(new THREE.LineSegments(gridGeo, new THREE.LineBasicMaterial({ color: AQUA, transparent: true, opacity: 0.2 })));
    const atmo = new THREE.Mesh(
      new THREE.SphereGeometry(R_EARTH * 1.09, 64, 48),
      new THREE.ShaderMaterial({ vertexShader: earthVert, fragmentShader: atmoFrag, side: THREE.BackSide, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false })
    );
    scene.add(atmo);

    // the catalogue
    const cloudMat = new THREE.ShaderMaterial({
      vertexShader: cloudVert,
      fragmentShader: cloudFrag,
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTarget: { value: new THREE.Vector3() },
        uSweep: { value: 0 },
        uBand: { value: new THREE.Vector2(0, 0) },
        uBandOn: { value: 0 },
        uPx: { value: 2.3 * renderer.getPixelRatio() },
      },
    });
    let points: THREE.Points | null = null;

    const dynamic = new THREE.Group();
    scene.add(dynamic);
    const halo = new THREE.Mesh(new THREE.SphereGeometry(0.3, 24, 16), new THREE.MeshBasicMaterial({ color: TANGERINE, transparent: true, opacity: 0.35, depthWrite: false }));
    halo.visible = false;
    scene.add(halo);
    let evs: Ev[] = [];
    let hoverId: number | null = null;
    let selId: number | null = null;
    let focusPos: THREE.Vector3 | null = null;
    let sweep = 0;
    let scanningNow = false;
    let sweepDone = true;
    let bandOnTarget = 0;

    const clearDynamic = () => {
      for (const c of [...dynamic.children]) {
        dynamic.remove(c);
        (c as THREE.Mesh).geometry?.dispose?.();
        const m = (c as THREE.Mesh).material as THREE.Material | undefined;
        m?.dispose?.();
      }
      evs = [];
      focusPos = null;
      halo.visible = false;
    };

    /** The focused pass is the hovered one, else the selected one, else the closest. Everything else steps back. */
    const applyFocus = () => {
      const fid = hoverId ?? selId;
      const active = evs.find((e) => e.id === fid) ?? (fid === null ? evs[0] : undefined);
      const dim = fid !== null && !!active;
      evs.forEach((e) => {
        const on = e === active;
        const m = e.tube.material as THREE.MeshPhysicalMaterial;
        m.opacity = dim && !on ? 0.22 : 1;
        m.emissiveIntensity = on && fid !== null ? 1.7 : 0.55;
        (e.marker.material as THREE.MeshBasicMaterial).opacity = dim && !on ? 0.25 : 1;
        e.marker.scale.setScalar(on ? 1.5 : 1);
      });
      if (active) {
        focusPos = active.pos;
        halo.position.copy(active.pos);
        halo.visible = true;
        labelCb.current({ name: active.name, km: active.km });
      } else {
        focusPos = null;
        halo.visible = false;
        labelCb.current(null);
      }
    };

    api.current = {
      setCloud(c) {
        if (points) {
          scene.remove(points);
          points.geometry.dispose();
          points = null;
        }
        if (!c) return;
        const g = new THREE.BufferGeometry();
        const scaled = new Float32Array(c.length);
        for (let i = 0; i < c.length; i++) scaled[i] = c[i] / 1000;
        g.setAttribute("position", new THREE.BufferAttribute(scaled, 3));
        points = new THREE.Points(g, cloudMat);
        points.frustumCulled = false;
        scene.add(points);
      },
      setScan(s) {
        clearDynamic();
        if (!s) return;
        const ring = tubeFrom(s.target_ring, 0.01, 0.07, 0x8ff7ff, 0x1fb8d4);
        if (ring) dynamic.add(ring.mesh);
        (s.scene?.events ?? []).forEach((ev, i) => {
          const tube = tubeFrom(ev.path, 0.01, i === 0 ? 0.05 : 0.032, 0xff8a3d, 0xff4a00);
          if (!tube) return;
          dynamic.add(tube.mesh);
          const hit = new THREE.Mesh(new THREE.TubeGeometry(tube.curve, 120, 0.22, 6, true), new THREE.MeshBasicMaterial());
          hit.visible = false;
          dynamic.add(hit);
          const pos = new THREE.Vector3(ev.target_marker[0], ev.target_marker[1], ev.target_marker[2]).multiplyScalar(0.001);
          const marker = new THREE.Mesh(new THREE.SphereGeometry(0.09, 16, 12), new THREE.MeshBasicMaterial({ color: TANGERINE, transparent: true }));
          marker.position.copy(pos);
          dynamic.add(marker);
          const th = s.threats.find((x) => x.id === ev.id);
          evs.push({ id: ev.id, name: th?.name ?? ev.name, km: th?.distance_km ?? 0, tube: tube.mesh, hit, marker, pos });
        });
        const tgt = s.target_ring.length >= 3 ? new THREE.Vector3(s.target_ring[0], s.target_ring[1], s.target_ring[2]).multiplyScalar(0.01) : new THREE.Vector3();
        cloudMat.uniforms.uTarget.value.copy(tgt);
        applyFocus();
      },
      setScanning(b) {
        scanningNow = b;
        if (b) {
          sweep = 0;
          sweepDone = false;
        }
      },
      setBand(b) {
        if (!b) {
          bandOnTarget = 0;
          return;
        }
        cloudMat.uniforms.uBand.value.set(b[0], b[1]);
        bandOnTarget = 1;
      },
      setSelected(id) {
        selId = id;
        applyFocus();
      },
    };

    // hover and click on an orbit
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const dom = renderer.domElement;
    const hitTest = (e: PointerEvent): number | null => {
      if (!evs.length) return null;
      const r = dom.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      const hits = ray.intersectObjects(evs.map((x) => x.hit), false);
      if (!hits.length) return null;
      return evs.find((x) => x.hit === hits[0].object)?.id ?? null;
    };
    let down: { x: number; y: number } | null = null;
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === "touch" || down) return;
      const id = hitTest(e);
      if (id !== hoverId) {
        hoverId = id;
        dom.style.cursor = id === null ? "grab" : "pointer";
        applyFocus();
      }
    };
    const onLeave = () => {
      if (hoverId !== null) {
        hoverId = null;
        applyFocus();
      }
    };
    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY };
    };
    const onUp = (e: PointerEvent) => {
      const d = down;
      down = null;
      if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;
      const id = hitTest(e);
      pickCb.current(id === null || id === selId ? null : id);
    };
    dom.addEventListener("pointermove", onMove);
    dom.addEventListener("pointerleave", onLeave);
    dom.addEventListener("pointerdown", onDown);
    dom.addEventListener("pointerup", onUp);

    const resize = () => {
      const w = el.clientWidth || 1, h = el.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.fov = w / h < 0.9 ? 40 : 36;
      camera.zoom = w / h < 0.9 ? 1.45 : w < 1000 ? 1.3 : 1;
      if (w > 1000) camera.setViewOffset(w, h, -w * 0.07, h * 0.015, w, h);
      else camera.clearViewOffset();
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    let visible = true;
    const io = new IntersectionObserver((e) => { visible = e[0].isIntersecting; }, { threshold: 0 });
    io.observe(el);

    const tmp = new THREE.Vector3();
    let raf = 0;
    const clock = new THREE.Clock();
    let introK = reduce ? 1 : 1.9;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      if (!visible || document.hidden) return;
      const dt = Math.min(0.05, clock.getDelta());
      const t = clock.elapsedTime;
      if (introK > 1.001) {
        introK = 1 + (introK - 1) * Math.pow(0.012, dt);
        controls.minDistance = controls.maxDistance = home.length() * introK;
      } else if (introK !== 1) {
        introK = 1;
        controls.minDistance = controls.maxDistance = home.length();
      }
      controls.autoRotate = !reduce && hoverId === null;
      controls.update();
      // sweep: expands while scanning, then finishes and fades
      if (scanningNow) sweep = Math.min(18000, sweep + dt * 9500);
      else if (!sweepDone) {
        sweep += dt * 24000;
        if (sweep > 26000) {
          sweep = 0;
          sweepDone = true;
        }
      }
      cloudMat.uniforms.uSweep.value = sweepDone && !scanningNow ? 0 : sweep;
      cloudMat.uniforms.uBandOn.value += (bandOnTarget - cloudMat.uniforms.uBandOn.value) * Math.min(1, dt * 3);
      halo.scale.setScalar(reduce ? 1 : 1 + 0.35 * Math.sin(t * 3.2));
      renderer.render(scene, camera);
      if (focusPos) {
        tmp.copy(focusPos).project(camera);
        const w = el.clientWidth, h = el.clientHeight;
        const behind = focusPos.clone().normalize().dot(camera.position.clone().normalize()) < -0.2;
        const x = (tmp.x * 0.5 + 0.5) * w, y = (-tmp.y * 0.5 + 0.5) * h;
        const labEl = el.querySelector<HTMLElement>(".glabel");
        if (labEl) {
          labEl.style.transform = `translate(${x}px, ${y}px)`;
          labEl.style.opacity = behind || tmp.z > 1 ? "0" : "1";
          labEl.classList.toggle("left", x > w * 0.5);
        }
      }
    };
    frame();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      dom.removeEventListener("pointermove", onMove);
      dom.removeEventListener("pointerleave", onLeave);
      dom.removeEventListener("pointerdown", onDown);
      dom.removeEventListener("pointerup", onUp);
      controls.dispose();
      clearDynamic();
      points?.geometry.dispose();
      cloudMat.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      api.current = null;
    };
  }, []);

  useEffect(() => { api.current?.setCloud(cloud); }, [cloud]);
  useEffect(() => { api.current?.setScan(scan); api.current?.setSelected(selectedId); }, [scan]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { api.current?.setScanning(scanning); }, [scanning]);
  useEffect(() => { api.current?.setBand(band); }, [band]);
  useEffect(() => { api.current?.setSelected(selectedId); }, [selectedId]);

  return (
    <div ref={host} className="globe" aria-hidden="true">
      <div className="glabel" style={{ opacity: 0 }}>
        {lab && (
          <span className="lbl">
            <b>{lab.name}</b>
            <i>{lab.km.toFixed(1)} km</i>
          </span>
        )}
      </div>
    </div>
  );
}
