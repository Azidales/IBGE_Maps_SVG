// Map state and configurations
const state = {
    currentLevel: 'BR', // 'BR' or 'UF'
    activeUFs: [], // list of loaded state IDs
    brDivisionMode: 'none', // 'none', 'painted', 'all'
    toolMode: 'navigate', // 'navigate' or 'paint'
    data: {
        estadosMeta: {}, // id -> name mapping
        municipiosMeta: {}, // id -> name mapping
        brGeoJson: null,
        brMunGeoJson: null,
        ufGeoJsonCache: {}
    },
    colors: {
        bg: '#ffffff',
        base: '#e2e8f0',
        strokeMun: '#94a3b8',
        strokeWidthMun: localStorage.getItem('mapStrokeWidthMun') !== null ? parseFloat(localStorage.getItem('mapStrokeWidthMun')) : 0.5,
        strokeUf: '#000000',
        strokeWidthUf: localStorage.getItem('mapStrokeWidthUf') !== null ? parseFloat(localStorage.getItem('mapStrokeWidthUf')) : 2.5,
        paint: '#3b82f6'
    },
    paintedPaths: {} // store painted colors by feature ID
};

// D3 Setup
let svg, g, projection, path, d3Zoom;
const container = document.getElementById('map-container');
let width, height;

// List state
let listSortAsc = true;

// UI Elements
const loader = document.getElementById('loader');
const tooltip = document.getElementById('tooltip');
const btnBackBR = document.getElementById('btn-back-br');
const viewLabel = document.getElementById('current-view-label');

// Initialize
async function init() {
    setupUI();
    setupSVG();
    
    showLoader('Carregando metadados...');
    await loadMetadadosEstados();
    
    showLoader('Carregando mapa do Brasil...');
    await loadMapBR();
    
    hideLoader();
}

function setupUI() {
    // Tool selection
    document.querySelectorAll('input[name="toolMode"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            state.toolMode = e.target.value;
        });
    });

    // Color pickers
    const colorBg = document.getElementById('color-bg');
    const colorBase = document.getElementById('color-base');
    const colorPaint = document.getElementById('color-paint');
    const toggleTransparentBg = document.getElementById('toggle-bg-transparent');
    
    function updateBgColor() {
        if (toggleTransparentBg.checked) {
            state.colors.bg = 'transparent';
        } else {
            state.colors.bg = colorBg.value;
        }
        if(svg) svg.style('background-color', state.colors.bg);
    }

    colorBg.addEventListener('input', updateBgColor);
    toggleTransparentBg.addEventListener('change', updateBgColor);

    colorBase.addEventListener('input', (e) => {
        state.colors.base = e.target.value;
        document.documentElement.style.setProperty('--map-fill', state.colors.base);
        updateMapColors();
    });

    const colorStrokeMun = document.getElementById('color-stroke-mun');
    const strokeWidthMun = document.getElementById('stroke-width-mun');
    const strokeWidthMunVal = document.getElementById('stroke-width-mun-val');
    const colorStrokeUf = document.getElementById('color-stroke-uf');
    const strokeWidthUf = document.getElementById('stroke-width-uf');
    const strokeWidthUfVal = document.getElementById('stroke-width-uf-val');

    strokeWidthMun.value = state.colors.strokeWidthMun;
    strokeWidthMunVal.value = state.colors.strokeWidthMun;
    strokeWidthUf.value = state.colors.strokeWidthUf;
    strokeWidthUfVal.value = state.colors.strokeWidthUf;

    colorStrokeMun.addEventListener('input', (e) => {
        state.colors.strokeMun = e.target.value;
        if (state.currentLevel !== 'BR' && g) {
            g.selectAll('.map-path').style('stroke', state.colors.strokeMun);
        }
    });
    
    const setStrokeWidthMun = (val) => {
        const parsed = Math.max(0, Math.min(5, parseFloat(val) || 0));
        state.colors.strokeWidthMun = parsed;
        strokeWidthMun.value = parsed;
        strokeWidthMunVal.value = parsed;
        localStorage.setItem('mapStrokeWidthMun', parsed);
        if (state.currentLevel !== 'BR' && g) {
            g.selectAll('.map-path').style('stroke-width', `${parsed}px`);
        }
    };
    strokeWidthMun.addEventListener('input', (e) => setStrokeWidthMun(e.target.value));
    strokeWidthMunVal.addEventListener('change', (e) => setStrokeWidthMun(e.target.value));

    colorStrokeUf.addEventListener('input', (e) => {
        state.colors.strokeUf = e.target.value;
        if (state.currentLevel === 'BR' && g) {
            g.selectAll('.map-path').style('stroke', state.colors.strokeUf);
        } else if (g) {
            g.selectAll('.state-border').style('stroke', state.colors.strokeUf);
        }
    });
    
    const setStrokeWidthUf = (val) => {
        const parsed = Math.max(0, Math.min(10, parseFloat(val) || 0));
        state.colors.strokeWidthUf = parsed;
        strokeWidthUf.value = parsed;
        strokeWidthUfVal.value = parsed;
        localStorage.setItem('mapStrokeWidthUf', parsed);
        if (state.currentLevel === 'BR' && g) {
            g.selectAll('.map-path').style('stroke-width', `${parsed}px`);
        } else if (g) {
            g.selectAll('.state-border').style('stroke-width', `${parsed}px`);
        }
    };
    strokeWidthUf.addEventListener('input', (e) => setStrokeWidthUf(e.target.value));
    strokeWidthUfVal.addEventListener('change', (e) => setStrokeWidthUf(e.target.value));
    colorPaint.addEventListener('input', (e) => {
        state.colors.paint = e.target.value;
    });
    
    document.getElementById('br-division-mode').addEventListener('change', (e) => {
        state.brDivisionMode = e.target.value;
        if (state.currentLevel === 'BR') {
            loadMapBR();
        }
    });

    // Back to BR Button
    btnBackBR.addEventListener('click', async () => {
        if (state.currentLevel === 'BR') return;
        state.currentLevel = 'BR';
        state.activeUFs = [];
        updateViewLabel();
        btnBackBR.disabled = true;
        btnBackBR.classList.add('disabled');
        document.getElementById('add-uf-container').classList.add('hidden');
        loadMapBR();
    });

    // Add UF Button
    document.getElementById('btn-add-uf').addEventListener('click', () => {
        const select = document.getElementById('add-uf-select');
        const ufId = select.value;
        if (ufId) {
            addMapUF(ufId);
        }
    });

    // Border Toggle
    document.getElementById('toggle-borders').addEventListener('change', (e) => {
        if (e.target.checked) {
            if(g) g.classList?.remove('no-borders');
            if(g) g.attr('class', '');
        } else {
            if(g) g.attr('class', 'no-borders');
        }
    });

    // Zoom Controls
    const zoomSlider = document.getElementById('zoom-slider');
    const zoomInput = document.getElementById('zoom-input');
    const btnZoomIn = document.getElementById('btn-zoom-in');
    const btnZoomOut = document.getElementById('btn-zoom-out');

    function updateZoom(value) {
        if (!svg || !d3Zoom) return;
        value = Math.max(10, Math.min(800, value)); // clamp 10-800
        svg.transition().duration(250).call(d3Zoom.scaleTo, value / 100);
    }

    zoomSlider.addEventListener('input', (e) => updateZoom(e.target.value));
    zoomInput.addEventListener('change', (e) => updateZoom(e.target.value));
    
    btnZoomIn.addEventListener('click', () => {
        if (!svg || !d3Zoom) return;
        svg.transition().duration(250).call(d3Zoom.scaleBy, 1.2);
    });
    btnZoomOut.addEventListener('click', () => {
        if (!svg || !d3Zoom) return;
        svg.transition().duration(250).call(d3Zoom.scaleBy, 0.8);
    });

    // Localidades List UI
    const searchInput = document.getElementById('search-local');
    const btnSort = document.getElementById('btn-sort-list');

    searchInput.addEventListener('input', () => {
        renderLocalidadesList();
    });

    btnSort.addEventListener('click', () => {
        listSortAsc = !listSortAsc;
        renderLocalidadesList();
    });

    // Export SVG
    document.getElementById('btn-export-svg').addEventListener('click', exportSVG);
    
    // Resize event
    window.addEventListener('resize', () => {
        if(state.currentLevel === 'BR') {
            setupSVG();
            renderMap(state.showBrMunicipios && state.data.brMunGeoJson ? state.data.brMunGeoJson : state.data.brGeoJson);
        } else if (state.currentLevel === 'UF' && state.activeUFs.length > 0) {
            setupSVG();
            renderActiveUFs();
        }
    });
}

function setupSVG() {
    container.innerHTML = '';
    width = container.clientWidth;
    height = container.clientHeight;

    d3Zoom = d3.zoom()
        .scaleExtent([0.1, 8])
        .on('zoom', (event) => {
            g.attr('transform', event.transform);
            
            // Sync UI inputs
            const pct = Math.round(event.transform.k * 100);
            document.getElementById('zoom-slider').value = pct;
            document.getElementById('zoom-input').value = pct;
        });

    svg = d3.select('#map-container')
        .append('svg')
        .attr('width', '100%')
        .attr('height', '100%')
        .attr('viewBox', `0 0 ${width} ${height}`)
        .style('background-color', state.colors.bg)
        .call(d3Zoom)
        .on('dblclick.zoom', null);

    g = svg.append('g');
}

// Fetch Metadata to map IDs to Names
async function loadMetadadosEstados() {
    try {
        const res = await fetch('https://servicodados.ibge.gov.br/api/v1/localidades/estados');
        const estados = await res.json();
        estados.forEach(uf => {
            state.data.estadosMeta[uf.id] = { nome: uf.nome, sigla: uf.sigla };
        });
    } catch (e) {
        console.error('Erro ao carregar metadados dos estados', e);
    }
}

async function loadMetadadosMunicipios(ufId) {
    if (state.data.municipiosMeta[ufId]) return;
    try {
        const res = await fetch(`https://servicodados.ibge.gov.br/api/v1/localidades/estados/${ufId}/municipios`);
        const municipios = await res.json();
        const ufMetaMap = {};
        municipios.forEach(mun => {
            ufMetaMap[mun.id] = mun.nome;
        });
        state.data.municipiosMeta[ufId] = ufMetaMap;
    } catch (e) {
        console.error('Erro ao carregar metadados dos municipios', e);
    }
}

// Fetch Malhas GeoJSON
async function loadMapBR() {
    try {
        if (state.brDivisionMode === 'all') {
            if (!state.data.brMunGeoJson) {
                showLoader('Carregando 5570 municípios do Brasil (pode demorar)...');
                const res = await fetch('https://servicodados.ibge.gov.br/api/v3/malhas/paises/BR?intrarregiao=municipio&resolucao=5&formato=application/vnd.geo+json');
                let data = await res.json();
                state.data.brMunGeoJson = rewindGeoJson(data);
                hideLoader();
            }
            renderMap(state.data.brMunGeoJson);
        } else {
            if (!state.data.brGeoJson) {
                showLoader('Carregando mapa do Brasil...');
                const res = await fetch('https://servicodados.ibge.gov.br/api/v3/malhas/paises/BR?intrarregiao=UF&resolucao=2&formato=application/vnd.geo+json');
                let data = await res.json();
                state.data.brGeoJson = rewindGeoJson(data);
                hideLoader();
            }
            
            if (state.brDivisionMode === 'painted') {
                const paintedUfs = Object.keys(state.paintedPaths).filter(k => k.length === 2);
                if (paintedUfs.length > 0) {
                    showLoader('Carregando municípios dos estados pintados...');
                    await Promise.all(paintedUfs.map(async (ufId) => {
                        if (!state.data.ufGeoJsonCache[ufId]) {
                            const res = await fetch(`https://servicodados.ibge.gov.br/api/v3/malhas/estados/${ufId}?intrarregiao=municipio&resolucao=5&formato=application/vnd.geo+json`);
                            let data = await res.json();
                            state.data.ufGeoJsonCache[ufId] = rewindGeoJson(data);
                        }
                    }));
                    hideLoader();
                }
            }
            
            renderMap(state.data.brGeoJson);
        }
    } catch (e) {
        console.error('Erro ao carregar malha do Brasil', e);
        alert('Erro ao carregar o mapa base do IBGE.');
        hideLoader();
    }
}

async function loadMapUF(ufId) {
    state.activeUFs = [];
    await addMapUF(ufId);
}

async function addMapUF(ufId) {
    if (state.activeUFs.includes(ufId)) return;
    
    const ufNome = state.data.estadosMeta[ufId]?.nome || ufId;
    showLoader(`Carregando municípios de ${ufNome}...`);
    
    try {
        await Promise.all([
            loadMetadadosMunicipios(ufId),
            (async () => {
                if (!state.data.ufGeoJsonCache[ufId]) {
                    const res = await fetch(`https://servicodados.ibge.gov.br/api/v3/malhas/estados/${ufId}?intrarregiao=municipio&resolucao=5&formato=application/vnd.geo+json`);
                    let data = await res.json();
                    state.data.ufGeoJsonCache[ufId] = rewindGeoJson(data);
                }
            })()
        ]);

        state.currentLevel = 'UF';
        if (!state.activeUFs.includes(ufId)) {
            state.activeUFs.push(ufId);
        }
        
        updateViewLabel();
        btnBackBR.disabled = false;
        btnBackBR.classList.remove('disabled');
        
        document.getElementById('add-uf-container').classList.remove('hidden');
        updateAddUFSelect();
        
        renderActiveUFs();
    } catch (e) {
        console.error('Erro ao carregar malha do Estado', e);
        alert('Erro ao carregar o mapa do estado.');
    } finally {
        hideLoader();
    }
}

function renderActiveUFs() {
    const combinedFeatures = [];
    state.activeUFs.forEach(uf => {
        if (state.data.ufGeoJsonCache[uf]) {
            combinedFeatures.push(...state.data.ufGeoJsonCache[uf].features);
        }
    });
    
    const combinedGeoJson = {
        type: 'FeatureCollection',
        features: combinedFeatures
    };
    
    renderMap(combinedGeoJson);
}

function updateViewLabel() {
    if (state.currentLevel === 'BR') {
        viewLabel.innerText = 'Visão: Brasil (Estados)';
    } else {
        const nomes = state.activeUFs.map(id => state.data.estadosMeta[id]?.sigla || id).join(', ');
        viewLabel.innerText = `Visão: ${nomes} (Municípios)`;
    }
}

function updateAddUFSelect() {
    const select = document.getElementById('add-uf-select');
    select.innerHTML = '<option value="" disabled selected>+ Adicionar vizinho...</option>';
    
    const sortedStates = Object.entries(state.data.estadosMeta)
        .sort((a, b) => a[1].nome.localeCompare(b[1].nome));
        
    sortedStates.forEach(([id, meta]) => {
        if (!state.activeUFs.includes(id)) {
            const option = document.createElement('option');
            option.value = id;
            option.innerText = `${meta.nome} (${meta.sigla})`;
            select.appendChild(option);
        }
    });
}

// Fix IBGE GeoJSON Winding Order (Right-hand rule for D3)
function rewindGeoJson(geoJson) {
    if (!geoJson || !geoJson.features) return geoJson;
    geoJson.features.forEach(feature => {
        if (!feature.geometry || !feature.geometry.coordinates) return;
        if (feature.geometry.type === 'Polygon') {
            feature.geometry.coordinates.forEach(ring => ring.reverse());
        } else if (feature.geometry.type === 'MultiPolygon') {
            feature.geometry.coordinates.forEach(polygon => {
                polygon.forEach(ring => ring.reverse());
            });
        }
    });
    return geoJson;
}

// Render the Map
function renderMap(geoJsonData) {
    g.selectAll('*').remove(); // clear previous map

    // Create a new projection fit to the new geometry
    projection = d3.geoMercator()
        .fitSize([width, height], geoJsonData);
    
    path = d3.geoPath().projection(projection);

    // Reset zoom transform smoothly
    svg.transition().duration(750).call(
        d3Zoom.transform, 
        d3.zoomIdentity
    );

    // Draw paths
    g.selectAll('path')
        .data(geoJsonData.features)
        .enter()
        .append('path')
        .attr('d', path)
        .attr('class', 'map-path')
        .attr('id', d => `feature-${d.properties.codarea || d.properties.id || Math.random().toString()}`)
        .style('stroke', state.currentLevel === 'BR' && state.brDivisionMode !== 'all' ? state.colors.strokeUf : state.colors.strokeMun)
        .style('stroke-width', (state.currentLevel === 'BR' && state.brDivisionMode !== 'all' ? state.colors.strokeWidthUf : state.colors.strokeWidthMun) + 'px')
        .style('cursor', state.currentLevel === 'BR' && state.brDivisionMode === 'all' ? 'default' : 'pointer')
        .style('fill', d => getFillColor(d.properties.codarea || d.properties.id))
        .on('mousemove', handleMouseMove)
        .on('mouseout', handleMouseOut)
        .on('click', handleClick);

    // After drawing map, update the side list
    renderLocalidadesList();
    
    // 1. Overlays in BR mode (when base map is just states)
    if (state.currentLevel === 'BR' && state.brDivisionMode !== 'all') {
        const paintedMunFeatures = [];
        const paintedStatesMunFeatures = [];
        
        // Find individual painted municipalities
        for (const munId in state.paintedPaths) {
            if (munId.length > 2) {
                const ufId = munId.substring(0, 2);
                if (state.data.ufGeoJsonCache[ufId] && (!state.paintedPaths[ufId] || state.brDivisionMode !== 'painted')) {
                    const feature = state.data.ufGeoJsonCache[ufId].features.find(f => (f.properties.codarea || f.properties.id) === munId);
                    if (feature) paintedMunFeatures.push(feature);
                }
            }
        }
        
        // Find all municipalities for painted states if mode is 'painted'
        if (state.brDivisionMode === 'painted') {
            const paintedUfs = Object.keys(state.paintedPaths).filter(k => k.length === 2);
            for (const ufId of paintedUfs) {
                if (state.data.ufGeoJsonCache[ufId]) {
                    paintedStatesMunFeatures.push(...state.data.ufGeoJsonCache[ufId].features);
                }
            }
        }
        
        if (paintedMunFeatures.length > 0) {
            g.selectAll('.painted-mun')
                .data(paintedMunFeatures)
                .enter()
                .append('path')
                .attr('d', path)
                .attr('class', 'painted-mun')
                .style('stroke', 'none')
                .style('fill', d => getFillColor(d.properties.codarea || d.properties.id))
                .style('pointer-events', 'none');
        }
        
        if (paintedStatesMunFeatures.length > 0) {
            g.selectAll('.painted-state-mun')
                .data(paintedStatesMunFeatures)
                .enter()
                .append('path')
                .attr('d', path)
                .attr('class', 'painted-state-mun')
                .style('stroke', state.colors.strokeMun)
                .style('stroke-width', `${state.colors.strokeWidthMun}px`)
                .style('fill', d => getFillColor(d.properties.codarea || d.properties.id))
                .style('pointer-events', 'none');
        }
    }
    
    // 2. Overlay thick state borders in UF mode or BR mode with 'all' municipalities
    if ((state.currentLevel === 'UF' || (state.currentLevel === 'BR' && state.brDivisionMode === 'all')) && state.data.brGeoJson) {
        let stateBorderFeatures = state.data.brGeoJson.features;
        if (state.currentLevel === 'UF') {
            stateBorderFeatures = stateBorderFeatures.filter(f => state.activeUFs.includes(f.properties.codarea || f.properties.id));
        }
        
        if (stateBorderFeatures.length > 0) {
            g.selectAll('.state-border')
                .data(stateBorderFeatures)
                .enter()
                .append('path')
                .attr('d', path)
                .attr('class', 'state-border')
                .style('fill', 'none')
                .style('stroke', state.colors.strokeUf)
                .style('stroke-width', `${state.colors.strokeWidthUf}px`)
                .style('pointer-events', 'none');
        }
    }
    
    // Apply borders toggle if it was unchecked
    if (!document.getElementById('toggle-borders').checked) {
        g.attr('class', 'no-borders');
    }
}

// Interactions
function handleMouseMove(event, d) {
    const id = d.properties.codarea || d.properties.id;
    if(!id) return;

    let name = "Desconhecido";
    
    if (state.currentLevel === 'BR') {
        if (state.brDivisionMode === 'all' && id.length > 2) {
            const ufId = id.substring(0, 2);
            if (state.data.municipiosMeta[ufId] && state.data.municipiosMeta[ufId][id]) {
                name = `${state.data.municipiosMeta[ufId][id]} (${state.data.estadosMeta[ufId].sigla})`;
            } else {
                name = `Município: ${id}`;
            }
        } else {
            if (state.data.estadosMeta[id]) {
                name = `${state.data.estadosMeta[id].nome} (${state.data.estadosMeta[id].sigla})`;
            }
        }
    } else {
        let found = false;
        for (const ufId of state.activeUFs) {
            if (state.data.municipiosMeta[ufId] && state.data.municipiosMeta[ufId][id]) {
                name = `${state.data.municipiosMeta[ufId][id]} (${state.data.estadosMeta[ufId].sigla})`;
                found = true;
                break;
            }
        }
        if (!found) {
            for (const ufId of state.activeUFs) {
                const prefixId = id.substring(0, 6);
                const possibleMatch = Object.keys(state.data.municipiosMeta[ufId] || {}).find(k => k.startsWith(prefixId));
                if (possibleMatch) {
                    name = `${state.data.municipiosMeta[ufId][possibleMatch]} (${state.data.estadosMeta[ufId].sigla})`;
                    found = true;
                    break;
                }
            }
            if(!found) name = `Cod: ${id}`;
        }
    }

    tooltip.innerText = name;
    tooltip.classList.remove('hidden');
    
    tooltip.style.left = (event.clientX + 15) + 'px';
    tooltip.style.top = (event.clientY + 15) + 'px';
}

function handleMouseOut() {
    tooltip.classList.add('hidden');
}

function handleClick(event, d) {
    const id = d.properties.codarea || d.properties.id;
    if(!id) return;
    
    if (state.currentLevel === 'BR' && state.brDivisionMode === 'all') return;
    
    if (state.toolMode === 'paint') {
        if (state.paintedPaths[id] === state.colors.paint) {
            delete state.paintedPaths[id];
            d3.select(event.currentTarget).style('fill', getFillColor(id));
        } else {
            state.paintedPaths[id] = state.colors.paint;
            d3.select(event.currentTarget).style('fill', getFillColor(id));
        }
        
        if (state.currentLevel === 'BR' && state.brDivisionMode === 'painted') {
            loadMapBR();
        }
    } else if (state.toolMode === 'navigate') {
        if (state.currentLevel === 'BR') {
            const ufId = id.length > 2 ? id.substring(0, 2) : id;
            loadMapUF(ufId);
        }
    }
}

function getFillColor(id) {
    if (!id) return state.colors.base;
    if (state.paintedPaths[id]) return state.paintedPaths[id];
    
    if (id.length > 2) {
        const ufId = id.substring(0, 2);
        if (state.paintedPaths[ufId]) return state.paintedPaths[ufId];
    }
    return state.colors.base;
}

// Utility to re-apply base color if painted paths exist
function updateMapColors() {
    g.selectAll('.map-path, .painted-mun, .painted-state-mun').style('fill', d => {
        return getFillColor(d.properties.codarea || d.properties.id);
    });
}

// Side List Render Logic
function renderLocalidadesList() {
    const listEl = document.getElementById('localidades-list');
    const query = document.getElementById('search-local').value.toLowerCase();
    listEl.innerHTML = '';
    
    let items = [];
    
    if (state.currentLevel === 'BR') {
        items = Object.keys(state.data.estadosMeta).map(id => ({
            id: id,
            name: `${state.data.estadosMeta[id].nome} (${state.data.estadosMeta[id].sigla})`
        }));
    } else {
        state.activeUFs.forEach(ufId => {
            if (state.data.municipiosMeta[ufId]) {
                const munKeys = Object.keys(state.data.municipiosMeta[ufId]);
                munKeys.forEach(munId => {
                    items.push({
                        id: munId,
                        name: `${state.data.municipiosMeta[ufId][munId]} (${state.data.estadosMeta[ufId].sigla})`
                    });
                });
            }
        });
    }
    
    // Filter
    if (query) {
        items = items.filter(item => item.name.toLowerCase().includes(query));
    }
    
    // Sort
    items.sort((a, b) => {
        return listSortAsc ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
    });
    
    // Render
    items.forEach(item => {
        const li = document.createElement('li');
        li.innerText = item.name;
        li.onclick = () => highlightFeatureFromList(item.id);
        listEl.appendChild(li);
    });
}

function highlightFeatureFromList(id) {
    if (state.toolMode === 'paint') {
        if (state.paintedPaths[id] === state.colors.paint) {
            // Toggle off
            delete state.paintedPaths[id];
            d3.select(`#feature-${id}`).style('fill', state.colors.base);
        } else {
            // Paint
            state.paintedPaths[id] = state.colors.paint;
            d3.select(`#feature-${id}`).style('fill', state.colors.paint);
        }
    } else if (state.toolMode === 'navigate') {
        if (state.currentLevel === 'BR') {
            loadMapUF(id);
        }
    }
}

// Loaders
function showLoader(msg = 'Carregando...') {
    loader.innerHTML = `<div class="spinner"></div> ${msg}`;
    loader.classList.remove('hidden');
}

function hideLoader() {
    loader.classList.add('hidden');
}

// Export SVG Functionality
function exportSVG() {
    // Clone the SVG node
    const svgClone = svg.node().cloneNode(true);
    
    // Convert to inline styles where necessary and maintain background
    const isTransparent = document.getElementById('toggle-bg-transparent').checked;
    svgClone.style.backgroundColor = isTransparent ? 'transparent' : document.getElementById('color-bg').value;
    
    // We need to inject the CSS into the SVG so it keeps styling when exported
    const styleElement = document.createElementNS("http://www.w3.org/2000/svg", "style");
    styleElement.textContent = `
        .map-path {
            stroke-linejoin: round;
        }
    `;
    svgClone.insertBefore(styleElement, svgClone.firstChild);

    // Serialize it
    const serializer = new XMLSerializer();
    let source = serializer.serializeToString(svgClone);
    
    source = '<?xml version="1.0" standalone="no"?>\r\n' + source;
    const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(source);

    const downloadLink = document.createElement("a");
    downloadLink.href = url;
    downloadLink.download = `mapa-brasil-${state.currentLevel}.svg`;
    document.body.appendChild(downloadLink);
    downloadLink.click();
    document.body.removeChild(downloadLink);
}

// Start app
init();
