(function () {
    const BASE_URL = new URL('.', document.currentScript.src).href;

    function loadScript(src) {
        return new Promise((resolve, reject) => {
            if (document.querySelector(`script[src="${src}"]`)) return resolve();
            const s = document.createElement('script');
            s.src = src;
            s.onload = resolve;
            s.onerror = reject;
            document.head.appendChild(s);
        });
    }

    function loadCSS(href) {
        if (document.querySelector(`link[href="${href}"]`)) return;
        const l = document.createElement('link');
        l.rel = 'stylesheet';
        l.href = href;
        document.head.appendChild(l);
    }

    function injectStyles() {
        if (document.getElementById('karta-np-embed-styles')) return;
        const style = document.createElement('style');
        style.id = 'karta-np-embed-styles';
        style.textContent = `
            @font-face { font-family: 'CustomArial'; src: url('${BASE_URL}arialmt.ttf') format('truetype'); font-weight: normal; }
            @font-face { font-family: 'CustomArial'; src: url('${BASE_URL}arialmt.ttf') format('truetype'); font-weight: bold; }
            .knp-marker-dot, .knp-marker-center { position: relative; width: 0; height: 0; pointer-events: none; user-select: none; transition: opacity 0.3s; }
            .knp-hidden { display: none !important; }
            .knp-label { position: absolute; white-space: nowrap; line-height: 1; font-family: 'CustomArial', Arial, sans-serif; }
            .knp-label::after { content: attr(data-shadow); position: absolute; left: 1.5px; top: 1.5px; color: rgba(255,255,255,0.75); z-index: -1; }
            .knp-obl { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #111; }
            .knp-ray { font-size: 11.5px; font-weight: 700; color: #1a1a1a; }
            .knp-selo { font-size: 10px; font-weight: 400; color: #2b2b2b; }
            .knp-dot { position: absolute; top: 0; left: 0; width: 4px; height: 4px; background: #333; border: 1px solid #fff; border-radius: 50%; transform: translate(-50%, -50%); }
            .knp-marker-dot .knp-label { left: 6px; top: 4px; }
            .knp-marker-center .knp-label { left: 0; top: 0; transform: translate(-50%, -50%); }
        `;
        document.head.appendChild(style);
    }

    function decodeApiKey(apiKey) {
        const defaults = {
            saturation: 0, darkness: 30, shadowFloor: 22, bordersOpacity: 100,
            showLabels: true, showLandcover: true, showTownsBorders: true, townsBorderWidth: 0.5
        };
        try {
            if (!apiKey || !apiKey.startsWith('knp_live_')) return defaults;
            const json = decodeURIComponent(escape(atob(apiKey.replace('knp_live_', ''))));
            return { ...defaults, ...JSON.parse(json) };
        } catch (e) {
            return defaults;
        }
    }

    function darkenHex(hex, percent) {
        const h = hex.replace('#', '');
        const r = Math.max(0, Math.round(parseInt(h.substring(0, 2), 16) * (1 - percent / 100)));
        const g = Math.max(0, Math.round(parseInt(h.substring(2, 4), 16) * (1 - percent / 100)));
        const b = Math.max(0, Math.round(parseInt(h.substring(4, 6), 16) * (1 - percent / 100)));
        return '#' + r.toString(16).padStart(2, '0') + g.toString(16).padStart(2, '0') + b.toString(16).padStart(2, '0');
    }

    window.KartaNP = {
        init: async function ({ container, apiKey, center = [33.56587, 51.87999], zoom = 8.3 }) {
            loadCSS('https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css');
            injectStyles();
            await loadScript('https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js');
            await loadScript('https://unpkg.com/earcut@2.2.4/dist/earcut.min.js');

            const cfg = decodeApiKey(apiKey);
            const map = new maplibregl.Map({
                container,
                style: 'https://api.maptiler.com/maps/01a15d84-49c8-768b-8c27-37c84b553d7e/style.json?key=NxVg5ozWhACUzHBh2DZr',
                center,
                zoom
            });

            const markers = [];
            const OSM_LAYERS = [];

            // Загрузка подписей НП
            const files = ['loc1.json', 'loc2.json', 'loc3.json', 'loc4.json', 'loc5.json'];
            const placesPromise = Promise.all(files.map(f =>
                fetch(BASE_URL + f).then(r => r.json()).then(d => {
                    const arr = Array.isArray(d) ? d : [d];
                    if (f === 'loc5.json') arr.forEach(p => { if (p) p.minZoom = 10.0; });
                    return arr;
                }).catch(() => [])
            )).then(res => res.flat());

            function updateVisibility() {
                const z = map.getZoom();
                const bounds = map.getBounds();
                const showOsm = z >= 12;

                OSM_LAYERS.forEach(id => {
                    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', showOsm ? 'visible' : 'none');
                });

                markers.forEach(m => {
                    const visible = cfg.showLabels && !showOsm && z >= m.minZoom && bounds.contains(m.lngLat);
                    m.el.classList.toggle('knp-hidden', !visible);
                });
            }

            map.on('move', updateVisibility);
            map.on('zoom', updateVisibility);

            map.on('style.load', async () => {
                const layers = map.getStyle().layers;
                let firstSymbolId = null;

                for (const l of layers) {
                    if (l.type === 'symbol') {
                        if (!firstSymbolId) firstSymbolId = l.id;
                        OSM_LAYERS.push(l.id);
                        map.setLayoutProperty(l.id, 'visibility', 'none');
                    }
                    if (l.type === 'line' && (l['source-layer'] === 'transportation' || /road|highway|transportation|bridge|tunnel/i.test(l.id))) {
                        map.setLayoutProperty(l.id, 'visibility', 'none');
                    }
                }

                const addGeo = async (name, url, color, useZoom, minZ) => {
                    const data = typeof url === 'string' ? await fetch(BASE_URL + url).then(r => r.json()) : url;
                    map.addSource(name, { type: 'geojson', data });
                    const filter = useZoom ? ['>=', ['zoom'], ['coalesce', ['get', 'minZoom'], 0]] : null;
                    const vis = cfg.showLandcover ? 'visible' : 'none';
                    const isTown = name === 'towns' || name === 'villages';

                    const fill = { id: `${name}-fill`, type: 'fill', source: name, layout: { visibility: vis }, paint: { 'fill-color': color } };
                    const line = {
                        id: `${name}-line`, type: 'line', source: name, layout: { visibility: vis },
                        paint: {
                            'line-color': isTown ? darkenHex(color, 25) : color,
                            'line-width': isTown ? cfg.townsBorderWidth : 0.5,
                            'line-opacity': isTown ? (cfg.showTownsBorders ? 0.9 : 0) : 0.6
                        }
                    };
                    if (filter) { fill.filter = filter; line.filter = filter; }
                    if (minZ) { fill.minzoom = minZ; line.minzoom = minZ; }
                    map.addLayer(fill, firstSymbolId);
                    map.addLayer(line, firstSymbolId);
                };

                const addLine = async (name, url, color, width, baseOp, minZ) => {
                    const data = await fetch(BASE_URL + url).then(r => r.json());
                    map.addSource(name, { type: 'geojson', data });
                    const def = {
                        id: `${name}-line`, type: 'line', source: name,
                        paint: { 'line-color': color, 'line-width': width, 'line-opacity': baseOp * (cfg.bordersOpacity / 100) }
                    };
                    if (minZ) def.minzoom = minZ;
                    map.addLayer(def, firstSymbolId);
                };

                const allPlaces = await placesPromise;
                allPlaces.forEach(p => {
                    if (!p || !p.coords) return;
                    const wrap = document.createElement('div');
                    wrap.className = p.dot ? 'knp-marker-dot' : 'knp-marker-center';
                    if (p.dot) {
                        const d = document.createElement('div');
                        d.className = 'knp-dot';
                        wrap.appendChild(d);
                    }
                    const lbl = document.createElement('span');
                    lbl.className = `knp-label knp-${p.type}`;
                    lbl.textContent = p.name;
                    lbl.setAttribute('data-shadow', p.name);
                    wrap.appendChild(lbl);

                    const lngLat = { lng: p.coords[0], lat: p.coords[1] };
                    new maplibregl.Marker({ element: wrap, anchor: 'top-left' }).setLngLat(lngLat).addTo(map);
                    markers.push({ el: wrap, lngLat, minZoom: p.minZoom || 0 });
                });

                await addGeo('forest', 'forest.geojson', '#cae1c4', false);
                await addGeo('towns', 'towns.geojson', '#ede0d0', true);
                
                const vData = await fetch(BASE_URL + 'village.geojson').then(r => r.ok ? r.json() : fetch(BASE_URL + 'villages.geojson').then(r2 => r2.json()));
                if (vData?.features) vData.features.forEach(f => { f.properties = { ...f.properties, minZoom: 10.0 }; });
                await addGeo('villages', vData, '#ede0d0', true, 10.0);

                // Шейдер затемнения за пределами Украины
                const ukrData = await fetch(BASE_URL + 'ukraine.geojson').then(r => r.json());
                map.addLayer(createOutsideShader(ukrData, cfg), firstSymbolId);

                await addLine('doroga', 'doroga.geojson', '#CED0CF', 1.4, 1, 10.0);
                await addLine('traca', 'traca.geojson', '#CED0CF', 1.4, 1);
                await addLine('gromady', 'gromady.geojson', '#e01b1b', 0.3, 0.2);
                await addLine('rayony_ukrainy', 'rayony_ukrainy.geojson', '#e01b1b', 0.9, 0.2);
                await addLine('regions', 'regions.geojson', '#e01b1b', 1.4, 0.9);
                await addLine('ukraine', 'ukraine.geojson', '#e01b1b', 1.6, 1);

                updateVisibility();
            });

            return map; // Возвращаем инстанс MapLibre, чтобы на новом сайте вы могли рисовать поверх свои маркеры/линии
        }
    };

    // WebGL слой затемнения территории вне Украины
    function createOutsideShader(ukraineData, cfg) {
        const rings = [];
        const collect = g => {
            if (!g) return;
            if (g.type === 'Polygon') g.coordinates.forEach(r => rings.push(r));
            else if (g.type === 'MultiPolygon') g.coordinates.forEach(p => p.forEach(r => rings.push(r)));
        };
        (ukraineData.features || [ukraineData]).forEach(f => collect(f.geometry || f));

        const flat = [], holes = [];
        [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]].forEach(pt => {
            const mc = maplibregl.MercatorCoordinate.fromLngLat(pt);
            flat.push(mc.x, mc.y);
        });
        rings.forEach(r => {
            if (r.length < 4) return;
            holes.push(flat.length / 2);
            r.forEach(pt => { const mc = maplibregl.MercatorCoordinate.fromLngLat(pt); flat.push(mc.x, mc.y); });
        });

        const tris = earcut(flat, holes, 2);
        const verts = new Float32Array(tris.length * 2);
        for (let i = 0; i < tris.length; i++) {
            verts[i * 2] = flat[tris[i] * 2];
            verts[i * 2 + 1] = flat[tris[i] * 2 + 1];
        }

        const cache = new Map();
        let prog, vBuf, mRef;

        return {
            id: 'osm-outside-masked', type: 'custom',
            onAdd(m, gl) {
                mRef = m;
                const vs = `attribute vec2 a_pos; uniform mat4 u_matrix; varying vec2 v_merc; void main(){ v_merc=a_pos; gl_Position=u_matrix*vec4(a_pos,0.0,1.0); }`;
                const fs = `precision highp float; varying vec2 v_merc; uniform sampler2D u_tile; uniform vec2 u_min; uniform float u_sz, u_sat, u_minT, u_maxT;
                    void main(){ vec2 uv=(v_merc-u_min)/u_sz; if(uv.x<0.||uv.x>1.||uv.y<0.||uv.y>1.) discard;
                    vec4 c=texture2D(u_tile,uv); float g=dot(c.rgb,vec3(0.299,0.587,0.114));
                    gl_FragColor=vec4(mix(vec3(u_minT),vec3(u_maxT),mix(vec3(g),c.rgb,u_sat)),1.0); }`;
                const s1 = gl.createShader(gl.VERTEX_SHADER); gl.shaderSource(s1, vs); gl.compileShader(s1);
                const s2 = gl.createShader(gl.FRAGMENT_SHADER); gl.shaderSource(s2, fs); gl.compileShader(s2);
                prog = gl.createProgram(); gl.attachShader(prog, s1); gl.attachShader(prog, s2); gl.linkProgram(prog);
                vBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vBuf); gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
            },
            render(gl, matrix) {
                if (!prog) return;
                const z = Math.max(0, Math.min(19, Math.round(mRef.getZoom() + 1)));
                const n = Math.pow(2, z), sz = 1 / n, b = mRef.getBounds();
                const nw = maplibregl.MercatorCoordinate.fromLngLat(b.getNorthWest());
                const se = maplibregl.MercatorCoordinate.fromLngLat(b.getSouthEast());
                gl.useProgram(prog); gl.disable(gl.BLEND);
                gl.bindBuffer(gl.ARRAY_BUFFER, vBuf);
                const pLoc = gl.getAttribLocation(prog, 'a_pos');
                gl.enableVertexAttribArray(pLoc); gl.vertexAttribPointer(pLoc, 2, gl.FLOAT, false, 0, 0);
                gl.uniformMatrix4fv(gl.getUniformLocation(prog, 'u_matrix'), false, matrix);
                gl.uniform1f(gl.getUniformLocation(prog, 'u_sz'), sz);
                gl.uniform1f(gl.getUniformLocation(prog, 'u_sat'), cfg.saturation / 100);
                const maxT = Math.max(0.05, 1 - cfg.darkness / 100);
                gl.uniform1f(gl.getUniformLocation(prog, 'u_maxT'), maxT);
                gl.uniform1f(gl.getUniformLocation(prog, 'u_minT'), Math.min(maxT, cfg.shadowFloor / 100));

                for (let x = Math.max(0, Math.floor(nw.x * n)); x <= Math.min(n - 1, Math.floor(se.x * n)); x++) {
                    for (let y = Math.max(0, Math.floor(nw.y * n)); y <= Math.min(n - 1, Math.floor(se.y * n)); y++) {
                        const k = `${z}/${x}/${y}`;
                        let e = cache.get(k);
                        if (!e) {
                            e = { tex: null }; cache.set(k, e);
                            const img = new Image(); img.crossOrigin = 'anonymous';
                            img.onload = () => {
                                const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
                                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
                                e.tex = t; mRef.triggerRepaint();
                            };
                            img.src = `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
                        }
                        if (!e.tex) continue;
                        gl.bindTexture(gl.TEXTURE_2D, e.tex);
                        gl.uniform2f(gl.getUniformLocation(prog, 'u_min'), x * sz, y * sz);
                        gl.drawArrays(gl.TRIANGLES, 0, verts.length / 2);
                    }
                }
            }
        };
    }
})();