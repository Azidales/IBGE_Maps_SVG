import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------
const IBGE = 'https://servicodados.ibge.gov.br/api';
const STORAGE_KEY = 'mapforge3d.scene.v1';

// Projeção equiretangular centrada no Brasil (1 unidade = 1 grau de latitude)
const LON0 = -54;
const LAT0 = -15;
const COSL = Math.cos(LAT0 * Math.PI / 180);

const DEFAULT_SETTINGS = {
    baseColor: '#8e9196',
    sideShade: 0.62,
    baseHeight: 0.35,
    highlightHeight: 0.85,
    borderColor: '#2a2d33',
    borderWidth: 1.8,
    labelMode: 'sigla',
    labelColor: '#d9dbde',
    labelSize: 1,
    bgColor: '#f4f5f7',
    shadows: true,
    lightAngle: 215,
    markerSize: 0.8,
    munHeight: 0.12,
    routeStyle: 'flat',
    routeLift: 0.15,
    routeArc: 0.28,
    routeWidth: 0.11,
    fov: 30,
    clickMode: 'highlight',
    photoSize: '1200x900',
    photoFrame: true,
    photoTransparent: false
};

const CAMERA_PRESETS = {
    perspectiva: { dir: [0, 0.7, 0.72] },
    topo: { dir: [0, 1, 0.0001] },
    rasante: { dir: [0, 0.4, 0.92] }
};

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------
let scene3d = loadScene();
const S = scene3d.settings;

const statesMeta = {};      // cod -> { sigla, nome }
const stateObjs = {};       // cod -> { group, mesh, topMat, sideMat, labelPoint, bbox, area }
let municipiosPromise = null; // lista para busca (carregada uma vez)
let pendingMarker = null;   // marcador sendo criado (local já escolhido)
const munShapes = {};       // munId -> { shapes, segs } (malha do município, já projetada)
const munLoading = new Set();
let editingMarkerId = null;

// ---------------------------------------------------------------------------
// Three.js
// ---------------------------------------------------------------------------
const stage = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
stage.prepend(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(S.fov, 1, 0.1, 2000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.screenSpacePanning = false;
controls.maxPolarAngle = Math.PI / 2 - 0.03;
controls.minDistance = 2;
controls.maxDistance = 300;

const hemi = new THREE.HemisphereLight(0xffffff, 0x8a8f99, 1.6);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.camera.left = -40;
sun.shadow.camera.right = 40;
sun.shadow.camera.top = 40;
sun.shadow.camera.bottom = -40;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 200;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
scene.add(sun);
scene.add(sun.target);

const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(600, 600),
    new THREE.ShadowMaterial({ opacity: 0.22 })
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.001;
ground.receiveShadow = true;
scene.add(ground);

// Grupo do mapa no plano XY (x = leste, y = norte), girado para deitar no chão.
const mapGroup = new THREE.Group();
mapGroup.rotation.x = -Math.PI / 2;
scene.add(mapGroup);
const munGroup = new THREE.Group();
mapGroup.add(munGroup);
const labelGroup = new THREE.Group();
mapGroup.add(labelGroup);
const markerGroup = new THREE.Group();
scene.add(markerGroup);
const routeGroup = new THREE.Group();
scene.add(routeGroup);

const borderMaterial = new LineMaterial({ color: S.borderColor, linewidth: S.borderWidth });

// ---------------------------------------------------------------------------
// Utilidades geográficas
// ---------------------------------------------------------------------------
function project(lon, lat) {
    return [(lon - LON0) * COSL, lat - LAT0];
}
function unproject(x, y) {
    return [x / COSL + LON0, y + LAT0];
}
// Converte lon/lat para posição no mundo (y = altura)
function worldPos(lon, lat, h) {
    const [x, y] = project(lon, lat);
    return new THREE.Vector3(x, h, -y);
}
function haversineKm(a, b) {
    const R = 6371;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
}
function ringArea(ring) {
    let a = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        a += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
    }
    return a / 2;
}

// Ponto interno mais distante das bordas (algoritmo "polylabel", simplificado)
function polylabel(rings, precision = 0.03) {
    const outer = rings[0];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of outer) {
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
    const cellSize = Math.min(maxX - minX, maxY - minY);
    if (cellSize === 0) return [minX, minY];

    const signedDist = (px, py) => {
        let inside = false, minSq = Infinity;
        for (const ring of rings) {
            for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                const a = ring[i], b = ring[j];
                if ((a[1] > py) !== (b[1] > py) && px < (b[0] - a[0]) * (py - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
                let x = b[0], y = b[1], dx = a[0] - x, dy = a[1] - y;
                if (dx !== 0 || dy !== 0) {
                    const t = ((px - x) * dx + (py - y) * dy) / (dx * dx + dy * dy);
                    if (t > 1) { x = a[0]; y = a[1]; } else if (t > 0) { x += dx * t; y += dy * t; }
                }
                dx = px - x; dy = py - y;
                minSq = Math.min(minSq, dx * dx + dy * dy);
            }
        }
        return (inside ? 1 : -1) * Math.sqrt(minSq);
    };
    const makeCell = (x, y, h) => {
        const d = signedDist(x, y);
        return { x, y, h, d, max: d + h * Math.SQRT2 };
    };
    // fila ordenada por "max" (crescente; o melhor fica no fim)
    const queue = [];
    const push = c => {
        let lo = 0, hi = queue.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (queue[mid].max < c.max) lo = mid + 1; else hi = mid; }
        queue.splice(lo, 0, c);
    };
    const h0 = cellSize / 2;
    for (let x = minX; x < maxX; x += cellSize) {
        for (let y = minY; y < maxY; y += cellSize) push(makeCell(x + h0, y + h0, h0));
    }
    let best = makeCell((minX + maxX) / 2, (minY + maxY) / 2, 0);
    let guard = 0;
    while (queue.length && guard++ < 20000) {
        const c = queue.pop();
        if (c.d > best.d) best = c;
        if (c.max - best.d <= precision) continue;
        const h = c.h / 2;
        push(makeCell(c.x - h, c.y - h, h));
        push(makeCell(c.x + h, c.y - h, h));
        push(makeCell(c.x - h, c.y + h, h));
        push(makeCell(c.x + h, c.y + h, h));
    }
    return [best.x, best.y];
}

// ---------------------------------------------------------------------------
// Texturas de texto (canvas)
// ---------------------------------------------------------------------------
const FONT = "'Inter', 'Segoe UI', Arial, sans-serif";

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

function makeTexture(canvas) {
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return tex;
}

function textCanvas(text, color) {
    const fontPx = 128;
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    ctx.font = `700 ${fontPx}px ${FONT}`;
    const w = Math.ceil(ctx.measureText(text).width) + 16;
    c.width = w;
    c.height = Math.ceil(fontPx * 1.25);
    ctx.font = `700 ${fontPx}px ${FONT}`;
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(text, w / 2, c.height / 2);
    return c;
}

function pillCanvas(lines, bg, fg, { radius = 26, padX = 34, padY = 20, border = null } = {}) {
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    const specs = lines.filter(l => l.text).map(l => ({ ...l, font: `${l.weight || 700} ${l.size}px ${FONT}` }));
    let w = 0, h = 0;
    for (const s of specs) {
        ctx.font = s.font;
        w = Math.max(w, ctx.measureText(s.text).width);
        h += s.size * 1.22;
    }
    const shadow = 10;
    c.width = Math.ceil(w + padX * 2 + shadow * 2);
    c.height = Math.ceil(h + padY * 2 + shadow * 2);
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = shadow;
    ctx.shadowOffsetY = 3;
    roundRect(ctx, shadow, shadow, c.width - shadow * 2, c.height - shadow * 2, radius);
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    if (border) {
        ctx.lineWidth = 3;
        ctx.strokeStyle = border;
        ctx.stroke();
    }
    ctx.fillStyle = fg;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let y = shadow + padY;
    for (const s of specs) {
        ctx.font = s.font;
        ctx.globalAlpha = s.alpha ?? 1;
        ctx.fillText(s.text, c.width / 2, y + s.size * 0.61);
        y += s.size * 1.22;
    }
    return c;
}

function pinCanvas(color, icon) {
    const pinW = 120, pinH = 160, iconH = icon ? 120 : 0;
    const c = document.createElement('canvas');
    c.width = 160;
    c.height = pinH + iconH + 12;
    const ctx = c.getContext('2d');
    const cx = c.width / 2, r = pinW / 2 - 6, cy = r + 6;
    // gota
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 3;
    ctx.beginPath();
    const tipY = pinH;
    const ang = Math.asin(r / (tipY - cy));
    ctx.moveTo(cx, tipY);
    ctx.arc(cx, cy, r, Math.PI / 2 + ang, Math.PI / 2 - ang + Math.PI * 2, false);
    ctx.closePath();
    const grad = ctx.createLinearGradient(cx - r, 0, cx + r, 0);
    const base = new THREE.Color(color);
    const light = base.clone().lerp(new THREE.Color('#ffffff'), 0.3);
    const dark = base.clone().multiplyScalar(0.65);
    grad.addColorStop(0, '#' + light.getHexString());
    grad.addColorStop(0.55, color);
    grad.addColorStop(1, '#' + dark.getHexString());
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#' + dark.getHexString();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.38, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    if (icon) {
        ctx.font = `${iconH * 0.82}px 'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(icon, cx, c.height - 4);
    }
    return c;
}

function makeSprite(canvas, worldHeight, center) {
    const mat = new THREE.SpriteMaterial({ map: makeTexture(canvas), depthTest: false, depthWrite: false, transparent: true });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(worldHeight * canvas.width / canvas.height, worldHeight, 1);
    sprite.center.set(center[0], center[1]);
    sprite.renderOrder = 10;
    return sprite;
}

function disposeTree(obj) {
    obj.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
            (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => {
                if (m.map) m.map.dispose();
                m.dispose();
            });
        }
    });
}
function clearGroup(group) {
    while (group.children.length) {
        const ch = group.children[0];
        group.remove(ch);
        disposeTree(ch);
    }
}

// ---------------------------------------------------------------------------
// Estados (malha do IBGE)
// ---------------------------------------------------------------------------
// Converte um Polygon/MultiPolygon GeoJSON em shapes do Three.js (já projetados)
// e nos segmentos do contorno (z = 1, o topo da extrusão).
function geometryToShapes(geometry) {
    const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    const shapes = [];
    const segs = [];
    let largest = null, largestArea = 0;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    for (const poly of polys) {
        const rings = poly.map(ring => {
            const pts = ring.map(([lon, lat]) => project(lon, lat));
            const a = pts[0], b = pts[pts.length - 1];
            if (pts.length > 1 && a[0] === b[0] && a[1] === b[1]) pts.pop();
            return pts;
        });
        if (rings[0].length < 3) continue;
        const shape = new THREE.Shape(rings[0].map(([x, y]) => new THREE.Vector2(x, y)));
        for (let i = 1; i < rings.length; i++) {
            if (rings[i].length >= 3) shape.holes.push(new THREE.Path(rings[i].map(([x, y]) => new THREE.Vector2(x, y))));
        }
        shapes.push(shape);
        for (const ring of rings) {
            for (let i = 0; i < ring.length; i++) {
                const p = ring[i], q = ring[(i + 1) % ring.length];
                segs.push(p[0], p[1], 1.002, q[0], q[1], 1.002);
            }
        }
        for (const [x, y] of rings[0]) {
            minX = Math.min(minX, x); minY = Math.min(minY, y);
            maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
        }
        const area = Math.abs(ringArea(rings[0]));
        if (area > largestArea) { largestArea = area; largest = rings; }
    }
    return { shapes, segs, largest, bbox: { minX, minY, maxX, maxY } };
}

async function loadStates() {
    const [geo, meta] = await Promise.all([
        fetch(`${IBGE}/v3/malhas/paises/BR?intrarregiao=UF&resolucao=2&formato=application/vnd.geo+json`).then(r => {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
        }),
        fetch(`${IBGE}/v1/localidades/estados`).then(r => r.json())
    ]);
    meta.forEach(e => { statesMeta[String(e.id)] = { sigla: e.sigla, nome: e.nome }; });

    for (const f of geo.features) {
        const cod = String(f.properties.codarea);
        const { shapes, segs, largest, bbox } = geometryToShapes(f.geometry);

        const geom = new THREE.ExtrudeGeometry(shapes, { depth: 1, bevelEnabled: false, curveSegments: 1 });
        geom.computeVertexNormals();
        const topMat = new THREE.MeshStandardMaterial({ color: S.baseColor, roughness: 0.85, metalness: 0 });
        const sideMat = new THREE.MeshStandardMaterial({ color: S.baseColor, roughness: 0.9, metalness: 0 });
        const mesh = new THREE.Mesh(geom, [topMat, sideMat]);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData.cod = cod;

        const lineGeom = new LineSegmentsGeometry();
        lineGeom.setPositions(segs);
        const lines = new LineSegments2(lineGeom, borderMaterial);

        const group = new THREE.Group();
        group.add(mesh, lines);
        mapGroup.add(group);

        stateObjs[cod] = {
            group, mesh, topMat, sideMat, lines,
            labelPoint: polylabel(largest),
            bbox
        };
    }
}

function stateHeight(cod) {
    return scene3d.highlights[cod] ? S.highlightHeight : S.baseHeight;
}

function applyStateStyles() {
    for (const [cod, o] of Object.entries(stateObjs)) {
        const color = new THREE.Color(scene3d.highlights[cod] || S.baseColor);
        o.topMat.color.copy(color);
        o.sideMat.color.copy(color).multiplyScalar(S.sideShade);
        o.group.scale.z = stateHeight(cod);
        o.lines.visible = S.borderWidth > 0;
    }
    borderMaterial.color.set(S.borderColor);
    borderMaterial.linewidth = S.borderWidth;
    rebuildLabels();
    rebuildMarkers();
}

function rebuildLabels() {
    clearGroup(labelGroup);
    if (S.labelMode === 'none') return;
    for (const [cod, o] of Object.entries(stateObjs)) {
        const meta = statesMeta[cod];
        if (!meta) continue;
        const text = S.labelMode === 'nome' ? meta.nome : meta.sigla;
        const hl = scene3d.highlights[cod];
        // em estados destacados o rótulo fica um pouco mais claro que a cor do estado
        const color = hl ? '#' + new THREE.Color(hl).lerp(new THREE.Color('#ffffff'), 0.55).getHexString() : S.labelColor;
        const canvas = textCanvas(text, color);
        const h = 1.1 * S.labelSize;
        const w = h * canvas.width / canvas.height;
        const mat = new THREE.MeshBasicMaterial({
            map: makeTexture(canvas), transparent: true, depthWrite: false,
            polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4
        });
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
        plane.position.set(o.labelPoint[0], o.labelPoint[1], stateHeight(cod) + 0.01);
        plane.renderOrder = 2;
        labelGroup.add(plane);
    }
}

// ---------------------------------------------------------------------------
// Marcadores
// ---------------------------------------------------------------------------
// Marcadores antigos (sem o campo "pin") mostram o pino só quando não têm ícone
const showsPin = m => m.pin ?? !m.icon;
const paintsMun = m => !!(m.paint && m.munId);

function markerAnchor(m) {
    const munLift = paintsMun(m) && munShapes[m.munId] ? S.munHeight : 0;
    return worldPos(m.lon, m.lat, stateHeight(m.uf) + munLift + 0.02);
}

function loadMunShapes(munId) {
    if (munShapes[munId] || munLoading.has(munId)) return;
    munLoading.add(munId);
    fetch(`${IBGE}/v3/malhas/municipios/${munId}?formato=application/vnd.geo+json`)
        .then(r => {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
        })
        .then(geo => {
            const { shapes, segs, bbox } = geometryToShapes(geo.features[0].geometry);
            munShapes[munId] = { shapes, segs, bbox };
            rebuildMarkers();
        })
        .catch(e => console.error('Erro ao carregar a malha do município', munId, e))
        .finally(() => munLoading.delete(munId));
}

// Municípios pintados: uma placa fina por cima do estado, com laterais e contorno
function rebuildMunicipios() {
    clearGroup(munGroup);
    for (const m of scene3d.markers) {
        if (!paintsMun(m)) continue;
        const data = munShapes[m.munId];
        if (!data) { loadMunShapes(m.munId); continue; }
        const color = new THREE.Color(m.paintColor);
        const topMat = new THREE.MeshStandardMaterial({ color, roughness: 0.85 });
        const sideMat = new THREE.MeshStandardMaterial({ color: color.clone().multiplyScalar(S.sideShade), roughness: 0.9 });
        const mesh = new THREE.Mesh(new THREE.ExtrudeGeometry(data.shapes, { depth: 1, bevelEnabled: false, curveSegments: 1 }), [topMat, sideMat]);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        const lineGeom = new LineSegmentsGeometry();
        lineGeom.setPositions(data.segs);
        const lines = new LineSegments2(lineGeom, borderMaterial);
        lines.visible = S.borderWidth > 0;
        const group = new THREE.Group();
        group.add(mesh, lines);
        group.position.z = stateHeight(m.uf);
        group.scale.z = Math.max(S.munHeight, 0.004);
        munGroup.add(group);
    }
}

function markerIconCanvas(icon) {
    const c = document.createElement('canvas');
    c.width = 160;
    c.height = 150;
    const ctx = c.getContext('2d');
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 4;
    ctx.font = `120px 'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(icon, c.width / 2, c.height - 6);
    return c;
}

function rebuildMarkers() {
    rebuildMunicipios();
    clearGroup(markerGroup);
    const size = S.markerSize;
    for (const m of scene3d.markers) {
        const anchor = markerAnchor(m);
        // com o município pintado, o pino/ícone fica na borda norte dele e o rótulo na borda sul,
        // assim a área pintada continua à vista entre os dois
        const standAt = anchor.clone();
        const labelAt = anchor.clone();
        const mun = paintsMun(m) && munShapes[m.munId];
        if (mun) {
            standAt.z = -mun.bbox.maxY;
            labelAt.z = -mun.bbox.minY;
        }
        if (showsPin(m)) {
            const pin = pinCanvas(m.color, m.icon);
            const pinSprite = makeSprite(pin, size * 1.15 * pin.height / 172, [0.5, 0]);
            pinSprite.position.copy(standAt);
            markerGroup.add(pinSprite);
        } else if (m.icon) {
            const iconSprite = makeSprite(markerIconCanvas(m.icon), size * 1.05, [0.5, 0]);
            iconSprite.position.copy(standAt);
            markerGroup.add(iconSprite);
        }

        if (m.title || m.subtitle) {
            const label = pillCanvas([
                { text: m.title, size: 58, weight: 700 },
                { text: m.subtitle, size: 42, weight: 500, alpha: 0.85 }
            ], m.bg, '#ffffff', { radius: 30 });
            const lblSprite = makeSprite(label, size * 0.62 * label.height / 132, [0.5, 1.12]);
            lblSprite.position.copy(labelAt);
            markerGroup.add(lblSprite);
        }
    }
    rebuildRoutes();
}

// ---------------------------------------------------------------------------
// Setas
// ---------------------------------------------------------------------------
function rebuildRoutes() {
    clearGroup(routeGroup);
    for (const r of scene3d.routes) {
        const a = scene3d.markers.find(m => m.id === r.from);
        const b = scene3d.markers.find(m => m.id === r.to);
        if (!a || !b) continue;
        if (S.routeStyle === 'flat') buildFlatRoute(r, a, b);
        else buildTubeRoute(r, a, b);
    }
}

function routeLabelCanvas(r, a, b) {
    const text = r.label || routeAutoLabel(a, b);
    if (!text) return null;
    const fg = new THREE.Color(r.color).getHSL({}).l > 0.55 ? '#1f2937' : '#ffffff';
    return pillCanvas([{ text, size: 60, weight: 800 }], r.color, fg, { radius: 40, border: 'rgba(0,0,0,0.18)' });
}

// Altura do topo do mapa (estado ou município pintado) num ponto do chão
const downRay = new THREE.Raycaster();
function surfaceHeightAt(x, z) {
    downRay.set(new THREE.Vector3(x, 100, z), new THREE.Vector3(0, -1, 0));
    const targets = Object.values(stateObjs).map(o => o.mesh)
        .concat(munGroup.children.map(g => g.children[0]));
    const hit = downRay.intersectObjects(targets, false)[0];
    return hit ? hit.point.y : 0;
}

// Contorno da seta (corpo + ponta) no plano do chão, em coordenadas 2D (x, -z)
function arrowOutline(curve, len, u0, uHead, halfW, headHalfW, headLen, grow) {
    const left = [], right = [];
    const N = 64;
    for (let i = 0; i <= N; i++) {
        const u = u0 + (uHead - u0) * i / N;
        const p = curve.getPointAt(u);
        const t = curve.getTangentAt(u);
        const n = new THREE.Vector2(-t.y, t.x);
        left.push(p.clone().addScaledVector(n, halfW + grow));
        right.push(p.clone().addScaledVector(n, -(halfW + grow)));
    }
    // recua o começo um pouco para o contorno também cobrir a ponta de trás
    const t0 = curve.getTangentAt(u0);
    left[0].addScaledVector(t0, -grow);
    right[0].addScaledVector(t0, -grow);
    const base = curve.getPointAt(uHead);
    const tH = curve.getTangentAt(uHead);
    const nH = new THREE.Vector2(-tH.y, tH.x);
    const tip = base.clone().addScaledVector(tH, headLen + grow * 2.2);
    const back = base.clone().addScaledVector(tH, -grow);
    const pts = [
        ...left,
        back.clone().addScaledVector(nH, headHalfW + grow * 1.8),
        tip,
        back.clone().addScaledVector(nH, -(headHalfW + grow * 1.8)),
        ...right.reverse()
    ];
    return new THREE.Shape(pts);
}

// Seta "de papel": figura plana deitada sobre o mapa, que acompanha a perspectiva
function buildFlatRoute(r, a, b) {
    const A3 = markerAnchor(a), B3 = markerAnchor(b);
    const A = new THREE.Vector2(A3.x, -A3.z), B = new THREE.Vector2(B3.x, -B3.z);
    const dist = A.distanceTo(B);
    if (dist < 0.01) return;
    const mid = A.clone().add(B).multiplyScalar(0.5);
    const side = new THREE.Vector2(-(B.y - A.y), B.x - A.x).normalize();
    const curve = new THREE.QuadraticBezierCurve(A, mid.clone().addScaledVector(side, S.routeArc * dist), B);
    const len = curve.getLength();
    const halfW = S.routeWidth * 1.5;
    const headLen = Math.min(halfW * 4.5, len * 0.35);
    const headHalfW = halfW * 2.6;
    const gapStart = Math.min(S.markerSize * 0.35, len * 0.15);
    // o ícone/pino de destino fica em pé sobre o ponto: para antes dele
    const gapEnd = Math.min(S.markerSize * (showsPin(b) || b.icon ? 0.7 : 0.35), len * 0.25);
    const u0 = gapStart / len;
    const uHead = 1 - (gapEnd + headLen) / len;
    if (uHead <= u0) return;

    // flutua um pouco acima do ponto mais alto do mapa sob a seta
    scene.updateMatrixWorld();
    let top = Math.max(A3.y, B3.y);
    for (let i = 0; i <= 20; i++) {
        const p = curve.getPoint(i / 20);
        top = Math.max(top, surfaceHeightAt(p.x, -p.y));
    }
    const y = top + S.routeLift;

    const color = new THREE.Color(r.color);
    const layers = [
        { grow: halfW * 0.28, color: color.clone().multiplyScalar(0.55), y: y - 0.004, shadow: true },
        { grow: 0, color, y, shadow: false }
    ];
    for (const L of layers) {
        const shape = arrowOutline(curve, len, u0, uHead, halfW, headHalfW, headLen, L.grow);
        const mesh = new THREE.Mesh(
            new THREE.ShapeGeometry(shape),
            new THREE.MeshBasicMaterial({ color: L.color, side: THREE.DoubleSide })
        );
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.y = L.y;
        mesh.castShadow = L.shadow;
        routeGroup.add(mesh);
    }

    const canvas = routeLabelCanvas(r, a, b);
    if (canvas) {
        // deitado no chão o texto fica achatado pela perspectiva: um pouco maior que o das setas 3D
        const h = S.markerSize * 0.95 * canvas.height / 140;
        const w = h * canvas.width / canvas.height;
        const label = new THREE.Mesh(
            new THREE.PlaneGeometry(w, h),
            new THREE.MeshBasicMaterial({ map: makeTexture(canvas), transparent: true, depthWrite: false, side: THREE.DoubleSide })
        );
        // posição e giro dependem da câmera: ver updateFlatLabels()
        label.userData.flat = { mid: curve.getPoint(0.5), n: side.clone(), gap: halfW * 1.3, w, h, y: y + 0.01 };
        label.renderOrder = 3;
        routeGroup.add(label);
        updateFlatLabels();
    }
}

// Rótulos das setas planas ficam deitados no mapa, mas com o texto alinhado
// à horizontal da câmera, ao lado da curva (no lado de fora do arco).
function updateFlatLabels() {
    const az = controls.getAzimuthalAngle();
    const right = new THREE.Vector2(Math.cos(az), Math.sin(az));
    const up = new THREE.Vector2(-Math.sin(az), Math.cos(az));
    for (const o of routeGroup.children) {
        const f = o.userData.flat;
        if (!f) continue;
        const extent = Math.abs(f.w / 2 * right.dot(f.n)) + Math.abs(f.h / 2 * up.dot(f.n));
        const p = f.mid.clone().addScaledVector(f.n, f.gap + extent);
        o.rotation.set(-Math.PI / 2, 0, az);
        o.position.set(p.x, f.y, -p.y);
    }
}

function buildTubeRoute(r, a, b) {
    const A = markerAnchor(a), B = markerAnchor(b);
    const dist = A.distanceTo(B);
    if (dist < 0.01) return;
    // ponto de controle: sobe e desvia para o lado, para a curva aparecer em qualquer ângulo
    const mid = A.clone().add(B).multiplyScalar(0.5);
    const side = new THREE.Vector3(B.z - A.z, 0, A.x - B.x).normalize();
    mid.addScaledVector(side, S.routeArc * dist * 0.7);
    mid.y = Math.max(A.y, B.y) + S.routeArc * dist * 0.6;
    const curve = new THREE.QuadraticBezierCurve3(A, mid, B);
    const len = curve.getLength();
    const width = S.routeWidth;
    const headLen = Math.min(width * 5, len * 0.3);
    const gapStart = Math.min(S.markerSize * 0.25, len * 0.15);
    const gapEnd = Math.min(S.markerSize * 0.35, len * 0.2);
    const u0 = gapStart / len;
    const uHead = 1 - (gapEnd + headLen) / len;
    const uEnd = 1 - gapEnd / len;
    if (uHead <= u0) return;

    const pts = [];
    const N = 64;
    for (let i = 0; i <= N; i++) pts.push(curve.getPointAt(u0 + (uHead - u0) * i / N));
    const path = new THREE.CatmullRomCurve3(pts);
    const mat = new THREE.MeshStandardMaterial({
        color: r.color, roughness: 0.45, metalness: 0.05,
        emissive: new THREE.Color(r.color).multiplyScalar(0.25)
    });
    const tube = new THREE.Mesh(new THREE.TubeGeometry(path, 96, width, 16, false), mat);
    tube.castShadow = true;
    routeGroup.add(tube);

    const head = new THREE.Mesh(new THREE.ConeGeometry(width * 2.4, headLen, 24), mat);
    const pHead = curve.getPointAt(uHead), pEnd = curve.getPointAt(uEnd);
    const dir = pEnd.clone().sub(pHead).normalize();
    head.position.copy(pHead).addScaledVector(dir, headLen / 2);
    head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    head.castShadow = true;
    routeGroup.add(head);

    const canvas = routeLabelCanvas(r, a, b);
    if (canvas) {
        const sprite = makeSprite(canvas, S.markerSize * 0.6 * canvas.height / 140, [0.5, 0.5]);
        sprite.position.copy(curve.getPoint(0.5));
        sprite.renderOrder = 11;
        routeGroup.add(sprite);
    }
}

function routeAutoLabel(a, b) {
    const km = haversineKm(a, b);
    const rounded = km >= 100 ? Math.round(km / 10) * 10 : Math.round(km);
    return `~${rounded.toLocaleString('pt-BR')} km`;
}

// ---------------------------------------------------------------------------
// Luz e fundo
// ---------------------------------------------------------------------------
function applyEnvironment() {
    scene.background = new THREE.Color(S.bgColor);
    renderer.shadowMap.enabled = S.shadows;
    sun.castShadow = S.shadows;
    ground.visible = S.shadows;
    const ang = S.lightAngle * Math.PI / 180;
    sun.position.set(Math.sin(ang) * 30, 45, Math.cos(ang) * 30);
    sun.target.position.set(0, 0, 0);
    scene.traverse(o => { if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { m.needsUpdate = true; }); });
}

// ---------------------------------------------------------------------------
// Câmera
// ---------------------------------------------------------------------------
let camAnim = null;

function animateCamera(pos, target, ms = 700) {
    camAnim = {
        p0: camera.position.clone(), t0: controls.target.clone(),
        p1: pos, t1: target, start: performance.now(), ms
    };
}

// Distância para enquadrar um retângulo (no chão) com a lente atual
function fitDistance(w, h) {
    const vFov = camera.fov * Math.PI / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
    return Math.max((h / 2) / Math.tan(vFov / 2), (w / 2) / Math.tan(hFov / 2)) * 1.08;
}

function bboxAll() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const o of Object.values(stateObjs)) {
        minX = Math.min(minX, o.bbox.minX); minY = Math.min(minY, o.bbox.minY);
        maxX = Math.max(maxX, o.bbox.maxX); maxY = Math.max(maxY, o.bbox.maxY);
    }
    return { minX, minY, maxX, maxY };
}

function cameraPreset(name, ms) {
    let bb, dirArr = [0, 0.75, 0.66], zoom = 1;
    if (name === 'foco') {
        const cods = Object.keys(scene3d.highlights).filter(c => stateObjs[c]);
        if (!cods.length && !scene3d.markers.length) {
            alert('Destaque um estado ou adicione marcadores para focar.');
            return;
        }
        bb = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
        const grow = (x, y) => {
            bb.minX = Math.min(bb.minX, x); bb.minY = Math.min(bb.minY, y);
            bb.maxX = Math.max(bb.maxX, x); bb.maxY = Math.max(bb.maxY, y);
        };
        cods.forEach(c => { const b = stateObjs[c].bbox; grow(b.minX, b.minY); grow(b.maxX, b.maxY); });
        scene3d.markers.forEach(m => grow(...project(m.lon, m.lat)));
        zoom = 2;
        dirArr = [0, 0.7, 0.72];
    } else {
        bb = bboxAll();
        const p = CAMERA_PRESETS[name];
        dirArr = p.dir;
        zoom = name === 'topo' ? 1 : 0.9;
    }
    const cx = (bb.minX + bb.maxX) / 2, cy = (bb.minY + bb.maxY) / 2;
    const w = Math.max(bb.maxX - bb.minX, 5), h = Math.max(bb.maxY - bb.minY, 5);
    const dir = new THREE.Vector3(...dirArr).normalize();
    // em perspectiva a parte de perto parece maior: desloca o alvo um pouco para perto da câmera
    const target = new THREE.Vector3(cx, 0, -cy + h * 0.06 * dir.z);
    // altura projetada do retângulo vista em ângulo
    const elev = Math.asin(dir.y);
    const dist = fitDistance(w * zoom, h * zoom * Math.max(Math.sin(elev), 0.35));
    animateCamera(target.clone().addScaledVector(dir, dist), target, ms);
}

// ---------------------------------------------------------------------------
// Render / redimensionamento
// ---------------------------------------------------------------------------
function resize() {
    const w = stage.clientWidth, h = stage.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    borderMaterial.resolution.set(w, h);
    updateFrame();
}

function photoDims() {
    if (S.photoSize === 'screen') {
        return [stage.clientWidth * 2, stage.clientHeight * 2];
    }
    return S.photoSize.split('x').map(Number);
}

// Retângulo (em px da tela) que aparecerá na foto
function frameRect() {
    const vw = stage.clientWidth, vh = stage.clientHeight;
    const [pw, ph] = photoDims();
    const a = pw / ph;
    if (a > vw / vh) {
        const h = vw / a;
        return { x: 0, y: (vh - h) / 2, w: vw, h };
    }
    const w = vh * a;
    return { x: (vw - w) / 2, y: 0, w, h: vh };
}

function updateFrame() {
    const frame = document.getElementById('frame');
    if (!S.photoFrame || S.photoSize === 'screen') {
        frame.classList.add('hidden');
        return;
    }
    const r = frameRect();
    frame.classList.remove('hidden');
    Object.assign(frame.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
}

function tick(now) {
    if (camAnim) {
        const t = Math.min((now - camAnim.start) / camAnim.ms, 1);
        const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        camera.position.lerpVectors(camAnim.p0, camAnim.p1, e);
        controls.target.lerpVectors(camAnim.t0, camAnim.t1, e);
        if (t >= 1) { camAnim = null; saveSoon(); }
    }
    controls.update();
    updateFlatLabels();
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------
// Foto
// ---------------------------------------------------------------------------
async function takePhoto() {
    const [pw, ph] = photoDims();
    const vw = stage.clientWidth, vh = stage.clientHeight;
    const rect = frameRect();
    const prev = {
        pr: renderer.getPixelRatio(), fov: camera.fov, aspect: camera.aspect,
        bg: scene.background, lw: borderMaterial.linewidth
    };

    // mesma área do enquadramento: ajusta o FOV vertical à altura do retângulo
    const fov = 2 * Math.atan(Math.tan(camera.fov * Math.PI / 360) * rect.h / vh) * 180 / Math.PI;
    renderer.setPixelRatio(1);
    renderer.setSize(pw, ph, false);
    camera.fov = S.photoSize === 'screen' ? camera.fov : fov;
    camera.aspect = pw / ph;
    camera.updateProjectionMatrix();
    borderMaterial.resolution.set(pw, ph);
    borderMaterial.linewidth = S.borderWidth * ph / rect.h;
    if (S.photoTransparent) scene.background = null;

    renderer.render(scene, camera);
    const blob = await new Promise(res => renderer.domElement.toBlob(res, 'image/png'));

    scene.background = prev.bg;
    borderMaterial.linewidth = prev.lw;
    camera.fov = prev.fov;
    renderer.setPixelRatio(prev.pr);
    resize();

    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    a.download = `mapa-brasil-3d-${stamp}.png`;
    a.href = URL.createObjectURL(blob);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------------------------------------------------------------------------
// Interação com o mapa
// ---------------------------------------------------------------------------
const raycaster = new THREE.Raycaster();
const tooltip = document.getElementById('tooltip');
let downAt = null;

function pick(ev) {
    const r = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const meshes = Object.values(stateObjs).map(o => o.mesh);
    const hit = raycaster.intersectObjects(meshes, false)[0];
    if (!hit) return null;
    return { cod: hit.object.userData.cod, point: hit.point, x: ev.clientX - r.left, y: ev.clientY - r.top };
}

renderer.domElement.addEventListener('pointerdown', ev => { downAt = [ev.clientX, ev.clientY]; });
renderer.domElement.addEventListener('pointerup', ev => {
    if (!downAt || Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]) > 5 || ev.button !== 0) return;
    downAt = null;
    const hit = pick(ev);
    if (!hit) return;
    if (S.clickMode === 'highlight') {
        toggleHighlight(hit.cod);
    } else if (S.clickMode === 'marker') {
        const [lon, lat] = unproject(hit.point.x, -hit.point.z);
        const sigla = statesMeta[hit.cod]?.sigla || '';
        choosePlace({ lon, lat, uf: hit.cod, nome: `Ponto/${sigla}` });
        document.getElementById('mk-title').focus();
    }
});

let hoverRaf = 0;
renderer.domElement.addEventListener('pointermove', ev => {
    if (ev.buttons || hoverRaf) return;
    hoverRaf = requestAnimationFrame(() => {
        hoverRaf = 0;
        const hit = pick(ev);
        if (!hit || S.clickMode === 'none') {
            tooltip.classList.add('hidden');
            renderer.domElement.style.cursor = '';
            return;
        }
        const meta = statesMeta[hit.cod];
        tooltip.textContent = meta ? `${meta.nome} (${meta.sigla})` : hit.cod;
        tooltip.style.left = hit.x + 'px';
        tooltip.style.top = hit.y + 'px';
        tooltip.classList.remove('hidden');
        renderer.domElement.style.cursor = 'pointer';
    });
});
renderer.domElement.addEventListener('pointerleave', () => tooltip.classList.add('hidden'));

function toggleHighlight(cod) {
    if (scene3d.highlights[cod]) delete scene3d.highlights[cod];
    else scene3d.highlights[cod] = document.getElementById('hl-color').value;
    document.getElementById('hl-state').value = cod;
    applyStateStyles();
    renderHighlightList();
    saveSoon();
}

// ---------------------------------------------------------------------------
// Busca de municípios
// ---------------------------------------------------------------------------
const norm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function ensureMunicipios() {
    if (!municipiosPromise) {
        municipiosPromise = fetch(`${IBGE}/v1/localidades/municipios?view=nivelado`)
            .then(r => r.json())
            .then(data => data.map(m => ({
                id: String(m['municipio-id']),
                nome: m['municipio-nome'],
                sigla: m['UF-sigla'],
                uf: String(m['UF-id']),
                key: norm(m['municipio-nome'])
            })))
            .catch(e => { municipiosPromise = null; throw e; });
    }
    return municipiosPromise;
}

async function municipioCentroid(id) {
    const res = await fetch(`${IBGE}/v3/malhas/municipios/${id}/metadados`);
    const data = await res.json();
    const c = data[0].centroide;
    return { lon: c.longitude, lat: c.latitude };
}

function choosePlace(place) {
    pendingMarker = place;
    updatePaintOption();
    const title = document.getElementById('mk-title');
    if (!editingMarkerId) title.value = place.nome;
    document.getElementById('btn-mk-add').disabled = false;
    document.getElementById('mk-hint').textContent = `Local: ${place.nome} (${place.lat.toFixed(3)}, ${place.lon.toFixed(3)})`;
}

function setupSearch() {
    const input = document.getElementById('mk-search');
    const list = document.getElementById('mk-results');
    let results = [], active = 0;

    const render = () => {
        list.innerHTML = '';
        results.forEach((m, i) => {
            const li = document.createElement('li');
            li.innerHTML = `${m.nome} <small>${m.sigla}</small>`;
            if (i === active) li.classList.add('active');
            li.addEventListener('mousedown', e => { e.preventDefault(); select(m); });
            list.appendChild(li);
        });
        list.classList.toggle('hidden', results.length === 0);
    };
    const select = async m => {
        list.classList.add('hidden');
        input.value = `${m.nome}/${m.sigla}`;
        try {
            const c = await municipioCentroid(m.id);
            choosePlace({ ...c, uf: m.uf, munId: m.id, nome: `${m.nome}/${m.sigla}` });
        } catch (e) {
            console.error(e);
            alert('Não foi possível obter a localização do município no IBGE.');
        }
    };

    input.addEventListener('input', async () => {
        if (norm(input.value.trim()).length < 2) { results = []; render(); return; }
        const all = await ensureMunicipios();
        // lê o texto de novo: o usuário pode ter continuado digitando enquanto a lista carregava
        const q = norm(input.value.trim()).split('/')[0];
        if (q.length < 2) return;
        const starts = all.filter(m => m.key.startsWith(q));
        const contains = all.filter(m => !m.key.startsWith(q) && m.key.includes(q));
        results = starts.concat(contains).slice(0, 30);
        active = 0;
        render();
    });
    input.addEventListener('keydown', e => {
        if (list.classList.contains('hidden')) return;
        if (e.key === 'ArrowDown') { active = Math.min(active + 1, results.length - 1); render(); e.preventDefault(); }
        if (e.key === 'ArrowUp') { active = Math.max(active - 1, 0); render(); e.preventDefault(); }
        if (e.key === 'Enter' && results[active]) { select(results[active]); e.preventDefault(); }
        if (e.key === 'Escape') list.classList.add('hidden');
    });
    input.addEventListener('blur', () => setTimeout(() => list.classList.add('hidden'), 150));
    input.addEventListener('focus', () => { ensureMunicipios().catch(() => {}); });
}

// ---------------------------------------------------------------------------
// Painel: listas
// ---------------------------------------------------------------------------
const uid = () => Math.random().toString(36).slice(2, 9);

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderHighlightList() {
    const ul = document.getElementById('hl-list');
    ul.innerHTML = '';
    for (const [cod, color] of Object.entries(scene3d.highlights)) {
        const meta = statesMeta[cod];
        const li = document.createElement('li');
        li.innerHTML = `<input type="color" value="${color}" title="Cor"><span class="name">${escapeHtml(meta ? meta.nome : cod)}</span><button class="icon-btn" title="Remover"><i class="fa-solid fa-xmark"></i></button>`;
        li.querySelector('input').addEventListener('input', e => {
            scene3d.highlights[cod] = e.target.value;
            applyStateStyles();
            saveSoon();
        });
        li.querySelector('button').addEventListener('click', () => toggleHighlight(cod));
        ul.appendChild(li);
    }
}

function renderMarkerList() {
    const ul = document.getElementById('mk-list');
    ul.innerHTML = '';
    for (const m of scene3d.markers) {
        const li = document.createElement('li');
        li.innerHTML = `<span class="swatch" style="background:${paintsMun(m) ? m.paintColor : m.color}"></span><span class="name">${escapeHtml((m.icon ? m.icon + ' ' : '') + (m.title || m.nome))}</span>
            <button class="icon-btn" data-act="edit" title="Editar"><i class="fa-solid fa-pen"></i></button>
            <button class="icon-btn" data-act="del" title="Remover"><i class="fa-solid fa-xmark"></i></button>`;
        li.querySelector('[data-act="edit"]').addEventListener('click', () => startEditMarker(m));
        li.querySelector('[data-act="del"]').addEventListener('click', () => {
            scene3d.markers = scene3d.markers.filter(x => x.id !== m.id);
            scene3d.routes = scene3d.routes.filter(r => r.from !== m.id && r.to !== m.id);
            if (editingMarkerId === m.id) resetMarkerForm();
            refreshMarkers();
        });
        ul.appendChild(li);
    }
    // selects das setas
    for (const id of ['rt-from', 'rt-to']) {
        const sel = document.getElementById(id);
        const prev = sel.value;
        sel.innerHTML = scene3d.markers.length ? '' : '<option value="">(adicione marcadores)</option>';
        scene3d.markers.forEach(m => {
            const o = document.createElement('option');
            o.value = m.id;
            o.textContent = m.title || m.nome;
            sel.appendChild(o);
        });
        if (scene3d.markers.some(m => m.id === prev)) sel.value = prev;
    }
    if (scene3d.markers.length > 1 && document.getElementById('rt-from').value === document.getElementById('rt-to').value) {
        document.getElementById('rt-to').selectedIndex = 1;
    }
}

function renderRouteList() {
    const ul = document.getElementById('rt-list');
    ul.innerHTML = '';
    for (const r of scene3d.routes) {
        const a = scene3d.markers.find(m => m.id === r.from);
        const b = scene3d.markers.find(m => m.id === r.to);
        if (!a || !b) continue;
        const li = document.createElement('li');
        li.innerHTML = `<input type="color" value="${r.color}" title="Cor"><span class="name">${escapeHtml(`${a.title || a.nome} → ${b.title || b.nome}`)}</span>
            <button class="icon-btn" data-act="label" title="Editar texto"><i class="fa-solid fa-pen"></i></button>
            <button class="icon-btn" data-act="del" title="Remover"><i class="fa-solid fa-xmark"></i></button>`;
        li.querySelector('input').addEventListener('input', e => { r.color = e.target.value; rebuildRoutes(); saveSoon(); });
        li.querySelector('[data-act="label"]').addEventListener('click', () => {
            const t = prompt('Texto da seta (deixe vazio para automático):', r.label || '');
            if (t === null) return;
            r.label = t.trim();
            rebuildRoutes();
            saveSoon();
        });
        li.querySelector('[data-act="del"]').addEventListener('click', () => {
            scene3d.routes = scene3d.routes.filter(x => x !== r);
            rebuildRoutes();
            renderRouteList();
            saveSoon();
        });
        ul.appendChild(li);
    }
}

function refreshMarkers() {
    rebuildMarkers();
    renderMarkerList();
    renderRouteList();
    saveSoon();
}

function startEditMarker(m) {
    editingMarkerId = m.id;
    pendingMarker = { lon: m.lon, lat: m.lat, uf: m.uf, munId: m.munId, nome: m.nome };
    document.getElementById('mk-title').value = m.title;
    document.getElementById('mk-pin').checked = showsPin(m);
    document.getElementById('mk-paint').checked = paintsMun(m);
    if (m.paintColor) document.getElementById('mk-paint-color').value = m.paintColor;
    updatePaintOption();
    document.getElementById('mk-subtitle').value = m.subtitle;
    document.getElementById('mk-icon').value = m.icon;
    document.getElementById('mk-color').value = m.color;
    document.getElementById('mk-bg').value = m.bg;
    document.getElementById('mk-search').value = '';
    const btn = document.getElementById('btn-mk-add');
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-check"></i> Salvar';
    document.getElementById('btn-mk-cancel').classList.remove('hidden');
    document.getElementById('mk-hint').textContent = `Editando: ${m.nome}. Busque outro município ou clique no mapa para mudar o local.`;
}

function resetMarkerForm() {
    editingMarkerId = null;
    pendingMarker = null;
    document.getElementById('mk-search').value = '';
    document.getElementById('mk-title').value = '';
    document.getElementById('mk-subtitle').value = '';
    const btn = document.getElementById('btn-mk-add');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-plus"></i> Adicionar';
    document.getElementById('btn-mk-cancel').classList.add('hidden');
    document.getElementById('mk-hint').textContent = 'Escolha um município na busca, ou selecione "Adiciona marcador" em "Clique no mapa".';
    updatePaintOption();
}

// "Pintar município" só existe para locais escolhidos na busca (precisa do código do IBGE)
function updatePaintOption() {
    const ok = !pendingMarker || !!pendingMarker.munId;
    document.getElementById('mk-paint').disabled = !ok;
    document.getElementById('mk-paint-row').classList.toggle('disabled', !ok);
    document.getElementById('mk-paint-row').title = ok ? '' : 'Disponível só para municípios escolhidos na busca';
}

// ---------------------------------------------------------------------------
// Painel: controles
// ---------------------------------------------------------------------------
function bindRange(id, key, onChange, fmt = v => v) {
    const el = document.getElementById(id);
    const out = document.querySelector(`output[data-for="${id}"]`);
    el.value = S[key];
    if (out) out.textContent = fmt(S[key]);
    el.addEventListener('input', () => {
        S[key] = parseFloat(el.value);
        if (out) out.textContent = fmt(S[key]);
        onChange();
        saveSoon();
    });
}
function bindValue(id, key, onChange, evt = 'input') {
    const el = document.getElementById(id);
    if (el.type === 'checkbox') el.checked = S[key];
    else el.value = S[key];
    el.addEventListener(evt, () => {
        S[key] = el.type === 'checkbox' ? el.checked : el.value;
        onChange();
        saveSoon();
    });
}

function setupPanel() {
    const fix2 = v => Number(v).toFixed(2);

    // Foto
    bindValue('photo-size', 'photoSize', updateFrame, 'change');
    bindValue('photo-frame', 'photoFrame', updateFrame, 'change');
    bindValue('photo-transparent', 'photoTransparent', () => {}, 'change');
    const shoot = async () => {
        const btns = [document.getElementById('btn-photo'), document.getElementById('btn-photo-fab')];
        btns.forEach(b => { b.disabled = true; });
        try { await takePhoto(); } finally { btns.forEach(b => { b.disabled = false; }); }
    };
    document.getElementById('btn-photo').addEventListener('click', shoot);
    document.getElementById('btn-photo-fab').addEventListener('click', shoot);

    // Câmera
    document.querySelectorAll('[data-cam]').forEach(b => b.addEventListener('click', () => cameraPreset(b.dataset.cam)));
    bindRange('cam-fov', 'fov', () => {
        // mantém o enquadramento ao trocar a lente (efeito "dolly zoom")
        const old = camera.fov;
        const k = Math.tan(old * Math.PI / 360) / Math.tan(S.fov * Math.PI / 360);
        const off = camera.position.clone().sub(controls.target).multiplyScalar(k);
        camera.position.copy(controls.target).add(off);
        camera.fov = S.fov;
        camera.updateProjectionMatrix();
    }, v => v + '°');

    // Destaques
    bindValue('click-mode', 'clickMode', () => tooltip.classList.add('hidden'), 'change');
    const hlSel = document.getElementById('hl-state');
    Object.entries(statesMeta)
        .sort((a, b) => a[1].nome.localeCompare(b[1].nome, 'pt-BR'))
        .forEach(([cod, m]) => {
            const o = document.createElement('option');
            o.value = cod;
            o.textContent = `${m.nome} (${m.sigla})`;
            hlSel.appendChild(o);
        });
    hlSel.value = '52';
    document.getElementById('btn-hl-add').addEventListener('click', () => {
        scene3d.highlights[hlSel.value] = document.getElementById('hl-color').value;
        applyStateStyles();
        renderHighlightList();
        saveSoon();
    });
    bindRange('hl-height', 'highlightHeight', applyStateStyles, fix2);

    // Marcadores
    setupSearch();
    document.getElementById('btn-mk-add').addEventListener('click', () => {
        if (!pendingMarker) return;
        const data = {
            ...pendingMarker,
            title: document.getElementById('mk-title').value.trim(),
            subtitle: document.getElementById('mk-subtitle').value.trim(),
            icon: document.getElementById('mk-icon').value,
            color: document.getElementById('mk-color').value,
            bg: document.getElementById('mk-bg').value,
            pin: document.getElementById('mk-pin').checked,
            paint: !!pendingMarker.munId && document.getElementById('mk-paint').checked,
            paintColor: document.getElementById('mk-paint-color').value
        };
        if (editingMarkerId) {
            const m = scene3d.markers.find(x => x.id === editingMarkerId);
            if (m) Object.assign(m, data);
        } else {
            scene3d.markers.push({ id: uid(), ...data });
        }
        resetMarkerForm();
        refreshMarkers();
    });
    document.getElementById('btn-mk-cancel').addEventListener('click', resetMarkerForm);
    bindRange('mk-size', 'markerSize', rebuildMarkers, fix2);
    bindRange('mun-height', 'munHeight', rebuildMarkers, fix2);

    // Setas
    document.getElementById('btn-rt-add').addEventListener('click', () => {
        const from = document.getElementById('rt-from').value;
        const to = document.getElementById('rt-to').value;
        if (!from || !to || from === to) {
            alert('Escolha dois marcadores diferentes.');
            return;
        }
        scene3d.routes.push({
            id: uid(), from, to,
            label: document.getElementById('rt-label').value.trim(),
            color: document.getElementById('rt-color').value
        });
        document.getElementById('rt-label').value = '';
        rebuildRoutes();
        renderRouteList();
        saveSoon();
    });
    bindRange('rt-arc', 'routeArc', rebuildRoutes, fix2);
    bindRange('rt-width', 'routeWidth', rebuildRoutes, fix2);
    bindValue('rt-style', 'routeStyle', rebuildRoutes, 'change');
    bindRange('rt-lift', 'routeLift', rebuildRoutes, fix2);

    // Aparência
    bindValue('st-base', 'baseColor', applyStateStyles);
    bindRange('st-shade', 'sideShade', applyStateStyles, fix2);
    bindRange('st-height', 'baseHeight', applyStateStyles, fix2);
    bindValue('st-border', 'borderColor', applyStateStyles);
    bindRange('st-border-w', 'borderWidth', applyStateStyles, v => Number(v).toFixed(1));
    bindValue('st-labels', 'labelMode', rebuildLabels, 'change');
    bindValue('st-label-color', 'labelColor', rebuildLabels, 'change');
    bindRange('st-label-size', 'labelSize', rebuildLabels, fix2);
    bindValue('st-bg', 'bgColor', applyEnvironment);
    bindValue('st-shadows', 'shadows', applyEnvironment, 'change');
    bindRange('st-light', 'lightAngle', applyEnvironment, v => v + '°');

    document.getElementById('btn-reset').addEventListener('click', () => {
        if (!confirm('Apagar destaques, marcadores, setas e configurações?')) return;
        try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* sem armazenamento */ }
        location.reload();
    });

    // Gaveta no celular
    const panel = document.getElementById('panel');
    document.getElementById('btn-panel').addEventListener('click', () => panel.classList.toggle('open'));
}

// ---------------------------------------------------------------------------
// Persistência (localStorage, opcional)
// ---------------------------------------------------------------------------
function loadScene() {
    const empty = { settings: { ...DEFAULT_SETTINGS }, highlights: {}, markers: [], routes: [], camera: null };
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return empty;
        const data = JSON.parse(raw);
        return {
            settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) },
            highlights: data.highlights || {},
            markers: data.markers || [],
            routes: data.routes || [],
            camera: data.camera || null
        };
    } catch (e) {
        return empty;
    }
}

let saveTimer = 0;
function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        scene3d.camera = { pos: camera.position.toArray(), target: controls.target.toArray() };
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(scene3d)); } catch (e) { /* sem armazenamento */ }
    }, 300);
}
controls.addEventListener('end', saveSoon);

// ---------------------------------------------------------------------------
// Início
// ---------------------------------------------------------------------------
async function init() {
    const loader = document.getElementById('loader');
    resize();
    window.addEventListener('resize', resize);
    new ResizeObserver(resize).observe(stage);
    try {
        await Promise.all([
            loadStates(),
            document.fonts ? document.fonts.load(`700 64px Inter`).catch(() => {}) : null
        ]);
    } catch (e) {
        console.error(e);
        document.getElementById('loader-text').textContent = 'Erro ao carregar a malha do IBGE. Verifique a conexão e recarregue.';
        return;
    }
    // primeira visita: GO em destaque, como exemplo
    if (!scene3d.camera && !Object.keys(scene3d.highlights).length) {
        scene3d.highlights['52'] = '#4c9a3f';
    }
    setupPanel();
    applyEnvironment();
    applyStateStyles();
    renderHighlightList();
    renderMarkerList();
    renderRouteList();

    if (scene3d.camera) {
        camera.position.fromArray(scene3d.camera.pos);
        controls.target.fromArray(scene3d.camera.target);
    } else {
        camera.position.set(0, 60, 50);
        cameraPreset('perspectiva', 1);
    }
    loader.classList.add('hidden');
    requestAnimationFrame(tick);

    // ganchos para testes automatizados
    window.__mapa3d = { scene3d, cameraPreset, takePhoto, rebuildMarkers, refreshMarkers, applyStateStyles, municipioCentroid };
}

init();
