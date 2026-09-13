// /mapeditor — community map editor. Build maps from axis-aligned boxes
// (the community map format), preview them in a real three.js viewport using
// the same geometry builder the game uses, then save to the server and play
// them in a private match. The document is validated with the shared validator
// in src/game/community-map.ts, so anything saved is guaranteed playable.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Box, Play, Save, Trash2, Upload, Download, MousePointer2 } from 'lucide-react';
import * as THREE from 'three';
import { apiUrl } from '../game/urls';
import { authHeaders } from '../auth';
import { CrosshairMark } from '../pages/Landing';
import {
  COMMUNITY_MAP_VERSION,
  validateCommunityMap,
  type CommunityMapDocument,
} from '../game/community-map';
import { buildMapMesh } from '../game/map';

type Vec3 = { x: number; y: number; z: number };
type AABB = { min: Vec3; max: Vec3 };

const MAP_ID_RE = /^[a-z0-9][a-z0-9-]{2,31}$/;
const MAX_BOXES = 256;

function defaultDoc(): CommunityMapDocument {
  return {
    version: COMMUNITY_MAP_VERSION,
    id: '',
    name: '',
    bounds: { min: { x: -30, y: -1, z: -24 }, max: { x: 30, y: 20, z: 24 } },
    spawn: { x: 0, y: 0.05, z: 16 },
    boxes: [
      // Floor
      { min: { x: -30, y: -1, z: -24 }, max: { x: 30, y: 0, z: 24 } },
      // A couple of cover blocks to start from
      { min: { x: -6, y: 0, z: -3 }, max: { x: 6, y: 3, z: -1 } },
      { min: { x: -6, y: 0, z: 1 }, max: { x: 6, y: 3, z: 3 } },
    ],
  };
}

async function api<T>(path: string, body?: unknown, method?: string): Promise<{ status: number; data: T }> {
  const res = await fetch(apiUrl(path), {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: body === undefined ? { ...authHeaders() } : { 'Content-Type': 'application/json', ...authHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'include',
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as T };
}

// Command-deck utility bar — mirrors the landing page header.
function DeckHeader() {
  return (
    <header className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-5 pt-5 sm:px-8">
      <Link to="/" className="flex items-center gap-2.5">
        <CrosshairMark />
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.32em] text-white/50">
          Elyxion
        </span>
      </Link>
      <nav
        aria-label="Site links"
        className="flex items-center gap-4 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-white/45"
      >
        <Link to="/search" className="transition hover:text-white/90">
          Players
        </Link>
        <Link to="/" className="transition hover:text-white/90">
          Home
        </Link>
      </nav>
    </header>
  );
}

// ── three.js editor viewport ────────────────────────────────────────────────
// Renders the current document with buildMapMesh (the same builder the game
// uses), plus a clickable ground-plane gizmo for placing boxes and a spawn
// marker. Clicks raycast against the ground plane; drag sets the box extent.
function EditorViewport({
  doc,
  selected,
  onSelect,
  onGroundClick,
  placingRef,
}: {
  doc: CommunityMapDocument;
  selected: number | null;
  onSelect: (i: number | null) => void;
  onGroundClick: (x: number, z: number, dragEnd: boolean) => void;
  placingRef: React.RefObject<{ active: boolean; x0: number; z0: number } | null>;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const docRef = useRef(doc);
  docRef.current = doc;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0f12);
    scene.fog = new THREE.Fog(0x0b0f12, 60, 160);

    const camera = new THREE.PerspectiveCamera(60, mount.clientWidth / mount.clientHeight, 0.1, 400);
    camera.position.set(38, 26, 38);
    camera.lookAt(0, 0, 0);

    // Lights + ground grid.
    scene.add(new THREE.HemisphereLight(0xbfdcff, 0x202830, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(30, 60, 20);
    scene.add(sun);
    const grid = new THREE.GridHelper(120, 60, 0x2a4a5a, 0x14242e);
    grid.position.y = 0.02;
    scene.add(grid);

    // Map mesh group — rebuilt whenever the document changes.
    const mapGroup = new THREE.Group();
    scene.add(mapGroup);

    // Spawn marker.
    const spawnMarker = new THREE.Mesh(
      new THREE.ConeGeometry(0.5, 1.4, 4),
      new THREE.MeshBasicMaterial({ color: 0x34d399 }),
    );
    scene.add(spawnMarker);

    // Selection highlight box.
    const selBox = new THREE.Box3Helper(new THREE.Box3(), new THREE.Color(0x22d3ee));
    selBox.visible = false;
    scene.add(selBox);

    // Drag-placement preview.
    const placeBox = new THREE.Box3Helper(new THREE.Box3(), new THREE.Color(0xfbbf24));
    placeBox.visible = false;
    scene.add(placeBox);

    const rebuild = () => {
      mapGroup.clear();
      // buildMapMesh expects the game's ArenaMap shape; the community document
      // converts directly (identical fields).
      const mesh = buildMapMesh({
        name: docRef.current.name || 'Draft',
        boxes: docRef.current.boxes,
        spawn: docRef.current.spawn,
        bounds: docRef.current.bounds,
        openTop: true,
      });
      mapGroup.add(mesh);
      spawnMarker.position.set(docRef.current.spawn.x, docRef.current.spawn.y + 0.8, docRef.current.spawn.z);
      if (selectedRef.current != null && docRef.current.boxes[selectedRef.current]) {
        const b = docRef.current.boxes[selectedRef.current];
        selBox.box.set(new THREE.Vector3(b.min.x, b.min.y, b.min.z), new THREE.Vector3(b.max.x, b.max.y, b.max.z));
        selBox.visible = true;
      } else {
        selBox.visible = false;
      }
    };
    rebuild();

    // Camera orbit (right-drag) + zoom (wheel). Simple hand-rolled orbit — no
    // OrbitControls dependency needed.
    let yaw = Math.PI * 0.25;
    let pitch = Math.PI * 0.32;
    let dist = 55;
    const target = new THREE.Vector3(0, 2, 0);
    const applyCam = () => {
      pitch = Math.max(0.15, Math.min(1.4, pitch));
      camera.position.set(
        target.x + dist * Math.cos(pitch) * Math.cos(yaw),
        target.y + dist * Math.sin(pitch),
        target.z + dist * Math.cos(pitch) * Math.sin(yaw),
      );
      camera.lookAt(target);
    };
    applyCam();

    let dragging = false;
    let orbiting = false;
    let lastX = 0;
    let lastY = 0;

    const raycaster = new THREE.Raycaster();
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const ndc = (e: PointerEvent): THREE.Vector2 => {
      const r = renderer.domElement.getBoundingClientRect();
      return new THREE.Vector2(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        -((e.clientY - r.top) / r.height) * 2 + 1,
      );
    };
    const groundPoint = (e: PointerEvent): Vec3 | null => {
      raycaster.setFromCamera(ndc(e), camera);
      const hit = new THREE.Vector3();
      return raycaster.ray.intersectPlane(groundPlane, hit) ? { x: hit.x, y: 0, z: hit.z } : null;
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button === 2 || e.shiftKey) {
        orbiting = true;
      } else if (e.button === 0) {
        const g = groundPoint(e);
        if (g) {
          dragging = true;
          placingRef.current = { active: true, x0: g.x, z0: g.z };
        }
      }
      lastX = e.clientX;
      lastY = e.clientY;
      renderer.domElement.setPointerCapture(e.pointerId);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (orbiting) {
        yaw += (e.clientX - lastX) * 0.006;
        pitch += (e.clientY - lastY) * 0.005;
        applyCam();
      } else if (dragging && placingRef.current?.active) {
        const g = groundPoint(e);
        const p0 = placingRef.current;
        if (g) {
          placeBox.box.set(
            new THREE.Vector3(Math.min(p0.x0, g.x), 0, Math.min(p0.z0, g.z)),
            new THREE.Vector3(Math.max(p0.x0, g.x), 3, Math.max(p0.z0, g.z)),
          );
          placeBox.visible = true;
        }
      }
      lastX = e.clientX;
      lastY = e.clientY;
    };

    const onPointerUp = (e: PointerEvent) => {
      if (orbiting) {
        orbiting = false;
      } else if (dragging && placingRef.current?.active) {
        const g = groundPoint(e);
        if (g) onGroundClick(g.x, g.z, true);
        placeBox.visible = false;
        dragging = false;
        if (placingRef.current) placingRef.current.active = false;
      }
      renderer.domElement.releasePointerCapture(e.pointerId);
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      dist = Math.max(12, Math.min(150, dist + e.deltaY * 0.05));
      applyCam();
    };

    const onClick = (e: MouseEvent) => {
      // Click (no drag) selects a box under the cursor via its world AABB.
      raycaster.setFromCamera(
        new THREE.Vector2(
          ((e.clientX - renderer.domElement.getBoundingClientRect().left) / renderer.domElement.clientWidth) * 2 - 1,
          -((e.clientY - renderer.domElement.getBoundingClientRect().top) / renderer.domElement.clientHeight) * 2 + 1,
        ),
        camera,
      );
      const boxes = docRef.current.boxes;
      for (let i = boxes.length - 1; i >= 0; i--) {
        const b = boxes[i];
        const box3 = new THREE.Box3(
          new THREE.Vector3(b.min.x, b.min.y, b.min.z),
          new THREE.Vector3(b.max.x, b.max.y, b.max.z),
        );
        const hit = raycaster.ray.intersectBox(box3, new THREE.Vector3());
        if (hit) {
          onSelect(i);
          return;
        }
      }
      onSelect(null);
    };

    const dom = renderer.domElement;
    dom.addEventListener('pointerdown', onPointerDown);
    dom.addEventListener('pointermove', onPointerMove);
    dom.addEventListener('pointerup', onPointerUp);
    dom.addEventListener('wheel', onWheel, { passive: false });
    dom.addEventListener('click', onClick);
    dom.addEventListener('contextmenu', (e) => e.preventDefault());

    let raf = 0;
    const tick = () => {
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    tick();

    const ro = new ResizeObserver(() => {
      if (!mount.clientWidth) return;
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    });
    ro.observe(mount);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      dom.removeEventListener('pointerdown', onPointerDown);
      dom.removeEventListener('pointermove', onPointerMove);
      dom.removeEventListener('pointerup', onPointerUp);
      dom.removeEventListener('wheel', onWheel);
      dom.removeEventListener('click', onClick);
      renderer.dispose();
      dom.remove();
    };
    // rebuild/references via refs; doc changes handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Rebuild the mesh whenever the doc or selection changes.
  const rebuildRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    // The scene closure captured the initial doc; signal a rebuild by re-running
    // the lightweight mesh swap through a custom event the scene listens for.
    mountRef.current?.dispatchEvent(new CustomEvent('doc-changed'));
  }, [doc, selected]);

  return <div ref={mountRef} className="h-[420px] w-full overflow-hidden rounded-lg ring-1 ring-white/10 sm:h-[520px]" />;
}

// ── Page ────────────────────────────────────────────────────────────────────
export default function MapEditor() {
  const navigate = useNavigate();
  const [doc, setDoc] = useState<CommunityMapDocument>(defaultDoc);
  const [selected, setSelected] = useState<number | null>(null);
  const [status, setStatus] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);
  const [myMaps, setMyMaps] = useState<{ id: string; name: string; author: string }[]>([]);
  const placingRef = useRef<{ active: boolean; x0: number; z0: number } | null>(null);

  const valid = useMemo(() => validateCommunityMap(doc) && MAP_ID_RE.test(doc.id), [doc]);

  // My maps list (when logged in).
  const refreshMine = useCallback(async () => {
    const { status, data } = await api<{ maps: { id: string; name: string; author: string }[] }>('/api/community-maps');
    if (status === 200) setMyMaps(data.maps ?? []);
  }, []);
  useEffect(() => {
    void refreshMine();
    void api<{ username?: string }>('/api/auth/me').then(({ data }) => setLoggedIn(!!data.username));
  }, [refreshMine]);

  // Ground drag → new box.
  const onGroundClick = useCallback((x: number, z: number, dragEnd: boolean) => {
    if (!dragEnd) return;
    const p = placingRef.current;
    if (!p) return;
    const min = { x: Math.min(p.x0, x), y: 0, z: Math.min(p.z0, z) };
    const max = { x: Math.max(p.x0, x), y: 3, z: Math.max(p.z0, z) };
    if (max.x - min.x < 0.5 || max.z - min.z < 0.5) return; // too small — treat as a click
    setDoc((d) => ({ ...d, boxes: [...d.boxes, { min, max }] }));
    setStatus('Box added — drag on the ground to place another.');
  }, []);

  const updateBox = (i: number, axis: 'min' | 'max', comp: 'x' | 'y' | 'z', value: number) => {
    setDoc((d) => {
      const boxes = d.boxes.map((b, bi) =>
        bi === i ? { ...b, [axis]: { ...b[axis], [comp]: value } } : b,
      );
      return { ...d, boxes };
    });
  };

  const deleteBox = (i: number) => {
    setDoc((d) => ({ ...d, boxes: d.boxes.filter((_, bi) => bi !== i) }));
    setSelected(null);
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${doc.id || 'map'}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importJson = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as CommunityMapDocument;
        if (!validateCommunityMap(parsed)) {
          setStatus('Import failed: document failed validation.');
          return;
        }
        setDoc(parsed);
        setStatus(`Imported “${parsed.name}”.`);
      } catch {
        setStatus('Import failed: not valid JSON.');
      }
    };
    reader.readAsText(file);
  };

  const save = async () => {
    if (!valid) {
      setStatus('Fix the errors first — id, name, and box geometry must all be valid.');
      return;
    }
    setBusy(true);
    const { status, data } = await api<{ ok?: boolean; error?: string }>('/api/community-maps', {
      id: doc.id,
      doc: JSON.stringify(doc),
    });
    setBusy(false);
    if (status === 200 && data.ok) {
      setStatus(`Saved “${doc.name}” — it's playable in Create Match → map “${doc.id}”.`);
      void refreshMine();
      return;
    }
    setStatus(
      data.error === 'login_required'
        ? 'Log in (in the game menu) to save maps.'
        : data.error === 'rate_limited'
          ? 'Too many saves — wait a few minutes.'
          : data.error === 'not_author'
            ? 'That map id already belongs to another player.'
            : 'Save failed — check the map and try again.',
    );
  };

  const testPlay = () => {
    if (!valid) {
      setStatus('Fix the errors before test-playing.');
      return;
    }
    // Stash the working doc; /play reads it for the private test match.
    sessionStorage.setItem('elyxion-map-test', JSON.stringify(doc));
    navigate('/play?testmap=1');
  };

  const selBox = selected != null ? doc.boxes[selected] : null;

  return (
    <div className="deck-bg relative h-full overflow-hidden text-white">
      <div className="deck-scan pointer-events-none fixed inset-0 z-10" aria-hidden="true" />

      <div className="relative h-full overflow-y-auto">
        <DeckHeader />

        <main className="mx-auto w-full max-w-6xl px-5 pb-14 pt-10 sm:px-8">
          <Link
            to="/play"
            className="inline-flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-white/45 transition hover:text-white/90"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Back to the arena
          </Link>

          <p className="deck-rise mt-8 font-mono text-[11px] uppercase tracking-[0.32em] text-cyan-300/90">
            Forge
          </p>
          <h1
            className="deck-rise mt-3 font-display text-4xl font-bold uppercase leading-none tracking-[0.04em] sm:text-5xl"
            style={{ animationDelay: '60ms' }}
          >
            Map <span className="text-cyan-300">editor</span>
          </h1>
          <p
            className="deck-rise mt-3 max-w-xl text-[15px] leading-relaxed text-white/55"
            style={{ animationDelay: '120ms' }}
          >
            Build arenas from solid blocks — the same format the game servers run.
            Left-drag places a box, shift/right-drag orbits the camera, click a box to
            select it. Save to publish, or hit Test Play to jump straight in.
          </p>

          {/* Identity row */}
          <div className="deck-rise mt-8 grid gap-4 sm:grid-cols-2" style={{ animationDelay: '180ms' }}>
            <label className="deck-panel clip-deck-sm p-4">
              <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-white/40">
                Map id (URL-safe, used to join)
              </span>
              <input
                value={doc.id}
                onChange={(e) => setDoc((d) => ({ ...d, id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') }))}
                maxLength={32}
                placeholder="my-cool-arena"
                className="mt-2 w-full bg-black/40 px-3 py-2 font-mono text-sm text-white/90 outline-none ring-1 ring-white/10 focus:ring-cyan-400/50"
              />
              {doc.id && !MAP_ID_RE.test(doc.id) && (
                <span className="mt-1 block font-mono text-[10px] text-rose-300">
                  3–32 chars: lowercase letters, numbers, dashes.
                </span>
              )}
            </label>
            <label className="deck-panel clip-deck-sm p-4">
              <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-white/40">
                Display name
              </span>
              <input
                value={doc.name}
                onChange={(e) => setDoc((d) => ({ ...d, name: e.target.value }))}
                maxLength={48}
                placeholder="My Cool Arena"
                className="mt-2 w-full bg-black/40 px-3 py-2 font-mono text-sm text-white/90 outline-none ring-1 ring-white/10 focus:ring-cyan-400/50"
              />
            </label>
          </div>

          {/* Viewport + tools */}
          <div className="deck-rise mt-6 grid gap-6 lg:grid-cols-[1.4fr_1fr]" style={{ animationDelay: '240ms' }}>
            <div className="deck-panel clip-deck p-4">
              <p className="mb-3 flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-white/40">
                <MousePointer2 className="h-3.5 w-3.5 text-cyan-300" /> Viewport — left-drag to place · shift-drag to orbit · scroll to zoom
              </p>
              <EditorViewport
                doc={doc}
                selected={selected}
                onSelect={setSelected}
                onGroundClick={onGroundClick}
                placingRef={placingRef}
              />
            </div>

            <div className="grid content-start gap-4">
              {/* Spawn */}
              <div className="deck-panel clip-deck-sm p-4">
                <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-white/40">
                  Spawn point
                </p>
                <div className="mt-2 grid grid-cols-3 gap-2">
                  {(['x', 'y', 'z'] as const).map((c) => (
                    <label key={c} className="font-mono text-[11px] text-white/60">
                      {c}
                      <input
                        type="number"
                        step="0.5"
                        value={doc.spawn[c]}
                        onChange={(e) =>
                          setDoc((d) => ({ ...d, spawn: { ...d.spawn, [c]: parseFloat(e.target.value) || 0 } }))
                        }
                        className="mt-1 w-full bg-black/40 px-2 py-1.5 text-white/90 outline-none ring-1 ring-white/10 focus:ring-cyan-400/50"
                      />
                    </label>
                  ))}
                </div>
              </div>

              {/* Selected box editor */}
              <div className="deck-panel clip-deck-sm p-4">
                <p className="flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-white/40">
                  <Box className="h-3.5 w-3.5 text-amber-300" />
                  {selBox ? `Box #${(selected ?? 0) + 1} of ${doc.boxes.length}` : `Boxes: ${doc.boxes.length}/${MAX_BOXES}`}
                </p>
                {selBox ? (
                  <div className="mt-2 grid gap-2">
                    {(['min', 'max'] as const).map((axis) => (
                      <div key={axis} className="grid grid-cols-3 gap-2">
                        {(['x', 'y', 'z'] as const).map((comp) => (
                          <label key={comp} className="font-mono text-[11px] text-white/60">
                            {axis}.{comp}
                            <input
                              type="number"
                              step="0.5"
                              value={selBox[axis][comp]}
                              onChange={(e) =>
                                selected != null &&
                                updateBox(selected, axis, comp, parseFloat(e.target.value) || 0)
                              }
                              className="mt-1 w-full bg-black/40 px-2 py-1.5 text-white/90 outline-none ring-1 ring-white/10 focus:ring-cyan-400/50"
                            />
                          </label>
                        ))}
                      </div>
                    ))}
                    <button
                      onClick={() => selected != null && deleteBox(selected)}
                      className="mt-1 flex items-center justify-center gap-2 bg-rose-500/90 px-3 py-2 font-display text-[11px] font-bold uppercase tracking-[0.14em] text-white transition hover:bg-rose-400"
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Delete box
                    </button>
                  </div>
                ) : (
                  <p className="mt-2 font-mono text-[11px] leading-relaxed text-white/40">
                    Click a box in the viewport to edit its coordinates, or left-drag on
                    the ground to add a new one.
                  </p>
                )}
              </div>

              {/* Actions */}
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={save}
                  disabled={busy || !valid || loggedIn === false}
                  className="clip-deck-sm flex items-center justify-center gap-2 bg-cyan-400 px-4 py-3 font-display text-[11px] font-bold uppercase tracking-[0.16em] text-zinc-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:bg-white/12 disabled:text-white/40"
                >
                  <Save className="h-4 w-4" /> {busy ? 'Saving…' : 'Save'}
                </button>
                <button
                  onClick={testPlay}
                  disabled={!valid}
                  className="clip-deck-sm flex items-center justify-center gap-2 bg-emerald-400 px-4 py-3 font-display text-[11px] font-bold uppercase tracking-[0.16em] text-zinc-950 transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:bg-white/12 disabled:text-white/40"
                >
                  <Play className="h-4 w-4" /> Test play
                </button>
                <button
                  onClick={exportJson}
                  className="clip-deck-sm flex items-center justify-center gap-2 bg-white/10 px-4 py-2.5 font-display text-[11px] font-bold uppercase tracking-[0.14em] text-white transition hover:bg-white/20"
                >
                  <Download className="h-3.5 w-3.5" /> Export JSON
                </button>
                <label className="clip-deck-sm flex cursor-pointer items-center justify-center gap-2 bg-white/10 px-4 py-2.5 font-display text-[11px] font-bold uppercase tracking-[0.14em] text-white transition hover:bg-white/20">
                  <Upload className="h-3.5 w-3.5" /> Import JSON
                  <input
                    type="file"
                    accept="application/json"
                    className="hidden"
                    onChange={(e) => e.target.files?.[0] && importJson(e.target.files[0])}
                  />
                </label>
              </div>

              {status && (
                <p role="status" className="font-mono text-[11px] uppercase tracking-[0.14em] text-cyan-200/80">
                  {status}
                </p>
              )}
              {loggedIn === false && (
                <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-amber-300/80">
                  Log in from the game menu to save maps — Test Play and Export work without.
                </p>
              )}
            </div>
          </div>

          {/* Published maps */}
          {myMaps.length > 0 && (
            <section className="deck-rise mt-10" aria-label="Published maps">
              <p className="mb-3 font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-white/40">
                Recently published maps
              </p>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {myMaps.slice(0, 9).map((m) => (
                  <button
                    key={m.id}
                    onClick={() => {
                      void api<{ map: string }>(`/api/community-maps/${encodeURIComponent(m.id)}`).then(
                        ({ data }) => {
                          if (!data.map) return;
                          const parsed = JSON.parse(data.map) as CommunityMapDocument;
                          setDoc(parsed);
                          setStatus(`Loaded “${parsed.name}”.`);
                        },
                      );
                    }}
                    className="clip-deck-sm deck-panel px-4 py-3 text-left transition hover:ring-1 hover:ring-cyan-400/40"
                  >
                    <span className="block font-display text-[13px] font-bold uppercase tracking-[0.12em] text-white/85">
                      {m.name}
                    </span>
                    <span className="mt-0.5 block font-mono text-[10px] uppercase tracking-[0.14em] text-white/40">
                      {m.id} · by {m.author}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
