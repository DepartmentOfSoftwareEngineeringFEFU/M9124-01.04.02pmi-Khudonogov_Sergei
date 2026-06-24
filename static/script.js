// ----------------------------- ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ -----------------------------
let map;
let rasterLayer = null;
let pointsLayer = null;
let layerGroup = null;
let currentActiveMenu = 'map';
let currentRouteSegments = null;
let currentRouteParams = null;
let currentRouteIceData = null;
let currentRouteSaved = false;
let mapRoutes = {};
let nextRouteId = 1;

// ----------------------------- ИНИЦИАЛИЗАЦИЯ КАРТЫ -----------------------------
function initMap() {
    map = L.map('map', {
        worldCopyJump: true,
        minZoom: 2,
        maxZoom: 10,
        maxBounds: [[-90, -540], [90, 540]],
        maxBoundsViscosity: 1.0,
        attributionControl: false
    }).setView([70, 0], 3);

    L.control.attribution({
        prefix: '<a href="https://leafletjs.com/">Leaflet</a>'
    }).addTo(map);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        subdomains: 'abcd',
        minZoom: 2,
        maxZoom: 10
    }).addTo(map);

    map.on('mousemove', throttle(onMouseMove, 100));
}

// ----------------------------- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ -----------------------------
function throttle(func, limit) {
    let lastFunc, lastRan;
    return function(...args) {
        if (!lastRan) {
            func.apply(this, args);
            lastRan = Date.now();
        } else {
            clearTimeout(lastFunc);
            lastFunc = setTimeout(() => {
                if (Date.now() - lastRan >= limit) {
                    func.apply(this, args);
                    lastRan = Date.now();
                }
            }, limit - (Date.now() - lastRan));
        }
    };
}

function getThicknessRange(value) {
    if (value === null || value === undefined || isNaN(value)) return '—';
    if (value <= 0) return '0 м (вода)';
    if (value <= 1) return '0–1 м';
    if (value <= 2) return '1–2 м';
    if (value <= 3) return '2–3 м';
    if (value <= 4) return '3–4 м';
    return '>4 м';
}

function findNearestIcePoint(lat, lng, maxDistance = 50000) {
    if (!pointsLayer) return null;
    let nearest = null;
    let minDist = Infinity;
    pointsLayer.eachLayer(layer => {
        const layerLatLng = layer.getLatLng();
        const dist = map.distance({ lat, lng }, layerLatLng);
        if (dist < minDist) {
            minDist = dist;
            nearest = layer;
        }
    });
    if (minDist <= maxDistance && nearest && nearest.feature) {
        const props = nearest.feature.properties;
        return {
            concentration: props.concentration,
            thickness: props.thickness !== undefined ? props.thickness : null,
            distance: minDist,
            lat: nearest.getLatLng().lat,
            lng: nearest.getLatLng().lng
        };
    }
    return null;
}

function onMouseMove(e) {
    const nearest = findNearestIcePoint(e.latlng.lat, e.latlng.lng);
    const iceValueSpan = document.getElementById('ice-value');
    const thickValueSpan = document.getElementById('thickness-value');
    const iceCoordsSpan = document.getElementById('ice-coords');
    if (nearest) {
        iceValueSpan.innerHTML = `${nearest.concentration}%`;
        thickValueSpan.innerHTML = getThicknessRange(nearest.thickness);
        iceCoordsSpan.innerHTML = `${e.latlng.lat.toFixed(4)}, ${e.latlng.lng.toFixed(4)}`;
    } else {
        iceValueSpan.innerHTML = '—';
        thickValueSpan.innerHTML = '—';
        iceCoordsSpan.innerHTML = 'нет данных в радиусе 50 км';
    }
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>]/g, m => m === '&' ? '&amp;' : m === '<' ? '&lt;' : '&gt;');
}

function createSegmentWithCopies(segment, options) {
    const group = L.layerGroup();
    const offsets = [0, 360, -360];
    offsets.forEach(offset => {
        const shiftedSegment = segment.map(([lat, lon]) => [lat, lon + offset]);
        L.polyline(shiftedSegment, options).addTo(group);
    });
    return group;
}

// ----------------------------- ЗАГРУЗКА КАРТОГРАФИЧЕСКИХ СЛОЁВ -----------------------------
async function loadMapLayers() {
    try {
        const resp = await fetch('/api/raster_info');
        const data = await resp.json();
        if (data.error) throw new Error('Нет растра');
        if (rasterLayer) map.removeLayer(rasterLayer);
        rasterLayer = L.tileLayer(data.tile_url, {
            opacity: 0.8,
            attribution: 'Sea ice concentration AMSR2'
        });
        const pointsResp = await fetch('/api/points');
        const geojson = await pointsResp.json();
        if (pointsLayer) map.removeLayer(pointsLayer);
        pointsLayer = L.geoJSON(geojson, {
            pointToLayer: function(feature, latlng) {
                return L.circleMarker(latlng, {
                    radius: 0,
                    opacity: 0,
                    fillOpacity: 0,
                    interactive: false
                });
            }
        });
        if (layerGroup) map.removeLayer(layerGroup);
        layerGroup = L.layerGroup([rasterLayer, pointsLayer]).addTo(map);
        map.invalidateSize();
    } catch(e) {
        console.error(e);
        showNotification('Ошибка загрузки слоёв карты', true);
    }
}

function toggleLayer() {
    if (layerGroup) {
        if (map.hasLayer(layerGroup)) map.removeLayer(layerGroup);
        else layerGroup.addTo(map);
    }
}

// ----------------------------- РАБОТА С БД -----------------------------
async function loadShipsSelect() {
    const resp = await fetch('/api/ships');
    const ships = await resp.json();
    const select = document.getElementById('shipSelect');
    select.innerHTML = '<option value="">-- выберите судно --</option>';
    ships.forEach(ship => {
        const option = document.createElement('option');
        option.value = ship.id;
        option.textContent = `${ship.name} (${ship.ice_class})`;
        select.appendChild(option);
    });
}

async function loadPointsSelect() {
    const resp = await fetch('/api/points/list');
    const points = await resp.json();
    const startSelect = document.getElementById('startPointSelect');
    const endSelect = document.getElementById('endPointSelect');
    startSelect.innerHTML = '<option value="">-- выберите из списка --</option>';
    endSelect.innerHTML = '<option value="">-- выберите из списка --</option>';
    points.forEach(p => {
        const opt1 = document.createElement('option');
        opt1.value = p.id;
        opt1.textContent = `${p.name} (${p.lon}, ${p.lat})`;
        startSelect.appendChild(opt1.cloneNode(true));
        endSelect.appendChild(opt1.cloneNode(true));
    });
}

// ----------------------------- ПЕРЕКЛЮЧЕНИЕ ВВОДА -----------------------------
function toggleStartInputs() {
    const type = document.querySelector('input[name="startType"]:checked').value;
    document.getElementById('startListDiv').style.display = type === 'list' ? 'block' : 'none';
    document.getElementById('startCoordsDiv').style.display = type === 'list' ? 'none' : 'block';
    checkFormValid();
}

function toggleGoalInputs() {
    const type = document.querySelector('input[name="goalType"]:checked').value;
    document.getElementById('goalListDiv').style.display = type === 'list' ? 'block' : 'none';
    document.getElementById('goalCoordsDiv').style.display = type === 'list' ? 'none' : 'block';
    checkFormValid();
}

// ----------------------------- МАРШРУТЫ -----------------------------
async function buildRoute() {
    setUIEnabled(false);
    const progressText = document.querySelector('#progressOverlay p');
    if (progressText) progressText.textContent = 'Построение маршрута...';

    try {
        const shipId = parseInt(document.getElementById('shipSelect').value, 10);
        if (!shipId) { showNotification('Выберите судно', true); return; }
        const shipsResp = await fetch('/api/ships');
        const ships = await shipsResp.json();
        const ship = ships.find(s => s.id == shipId);
        if (!ship) return;
        const iceClass = ship.ice_class;

        let startLon, startLat, goalLon, goalLat;
        let startPointId = null, endPointId = null;
        const startType = document.querySelector('input[name="startType"]:checked').value;
        const goalType = document.querySelector('input[name="goalType"]:checked').value;

        if (startType === 'list') {
            const startPointIdVal = parseInt(document.getElementById('startPointSelect').value, 10);
            if (!startPointIdVal) { showNotification('Выберите начальный пункт', true); return; }
            const pointsResp = await fetch('/api/points/list');
            const points = await pointsResp.json();
            const startP = points.find(p => p.id == startPointIdVal);
            if (startP) { startLon = startP.lon; startLat = startP.lat; startPointId = startP.id; }
            else { showNotification('Ошибка координат', true); return; }
        } else {
            startLon = parseFloat(document.getElementById('startLon').value);
            startLat = parseFloat(document.getElementById('startLat').value);
            if (isNaN(startLon) || isNaN(startLat)) { showNotification('Неверные координаты', true); return; }
        }

        if (goalType === 'list') {
            const endPointIdVal = parseInt(document.getElementById('endPointSelect').value, 10);
            if (!endPointIdVal) { showNotification('Выберите конечный пункт', true); return; }
            const pointsResp = await fetch('/api/points/list');
            const points = await pointsResp.json();
            const endP = points.find(p => p.id == endPointIdVal);
            if (endP) { goalLon = endP.lon; goalLat = endP.lat; endPointId = endP.id; }
            else { showNotification('Ошибка координат', true); return; }
        } else {
            goalLon = parseFloat(document.getElementById('goalLon').value);
            goalLat = parseFloat(document.getElementById('goalLat').value);
            if (isNaN(goalLon) || isNaN(goalLat)) { showNotification('Неверные координаты', true); return; }
        }

        const payload = {
            ice_class: iceClass,
            start_lon: startLon,
            start_lat: startLat,
            goal_lon: goalLon,
            goal_lat: goalLat
        };
        const resp = await fetch('/plan_route', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await resp.json();
        if (data.error) {
            showNotification(`Ошибка: ${data.error}`, true);
            return;
        }

        currentRouteIceData = {
            points_ice: data.points_ice || [],
            points_thickness: data.points_thickness || null
        };

        const layerGroup = L.layerGroup();
        data.route_segments.forEach(seg => {
            createSegmentWithCopies(seg, { color: 'red', weight: 4, opacity: 0.8 }).addTo(layerGroup);
        });
        layerGroup.addTo(map);

        const routeId = nextRouteId++;
        const startCoord = `${startLat.toFixed(2)}, ${startLon.toFixed(2)}`;
        const endCoord = `${goalLat.toFixed(2)}, ${goalLon.toFixed(2)}`;
        const name = `Маршрут ${routeId}: ${startCoord} → ${endCoord}`;

        mapRoutes[routeId] = {
            id: routeId,
            name: name,
            startLat, startLon,
            endLat: goalLat, endLon: goalLon,
            geometry: data.route_segments,
            iceConcentrations: data.points_ice || [],
            iceThicknesses: data.points_thickness || null,
            layerGroup: layerGroup,
            visible: true,
            color: '#ff0000',
            shipId: shipId,
            startPointId: startPointId,
            endPointId: endPointId
        };

        currentRouteSegments = data.route_segments;
        currentRouteParams = { start_lon: startLon, start_lat: startLat, goal_lon: goalLon, goal_lat: goalLat, ship_id: shipId, ice_class: iceClass };
        currentRouteSaved = false;
        document.getElementById('saveRouteBtn').disabled = false;
        showNotification('Маршрут построен');

        const allPoints = data.route_segments.flat();
        if (allPoints.length) map.fitBounds(L.latLngBounds(allPoints));
        if (document.getElementById('panel-routes-on-map')?.classList.contains('open')) renderRoutesOnMapPanel();
    } catch (e) {
        console.error(e);
        showNotification('Ошибка при построении маршрута', true);
    } finally {
        setUIEnabled(true);
        if (progressText) progressText.textContent = 'Обновление карты...';
        checkFormValid();
        document.getElementById('saveRouteBtn').disabled = currentRouteSaved || !currentRouteSegments;
    }
}

async function saveRoute() {
    if (!currentRouteSegments) return;
    const name = prompt('Введите название маршрута', 'Маршрут ' + new Date().toLocaleString());
    if (!name) return;
    const geometry = currentRouteSegments;
    const payload = {
        name: name,
        start_lon: currentRouteParams.start_lon,
        start_lat: currentRouteParams.start_lat,
        end_lon: currentRouteParams.goal_lon,
        end_lat: currentRouteParams.goal_lat,
        ship_id: currentRouteParams.ship_id,
        geometry: geometry,
        points_ice: currentRouteIceData?.points_ice || null,
        points_thickness: currentRouteIceData?.points_thickness || null
    };
    const resp = await fetch('/api/routes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const data = await resp.json();
    if (data.success) {
        showNotification('Маршрут сохранён');
        currentRouteSaved = true;
        document.getElementById('saveRouteBtn').disabled = true;
        loadSavedRoutes();
    } else {
        showNotification('Ошибка сохранения', true);
    }
}

// ----------------------------- МАРШРУТЫ НА КАРТЕ -----------------------------
function renderRoutesOnMapPanel() {
    const container = document.getElementById('routesOnMapList');
    if (!container) return;
    const routes = Object.values(mapRoutes);
    if (routes.length === 0) {
        container.innerHTML = '<div class="empty-message">Нет маршрутов на карте</div>';
        return;
    }
    let html = '<div class="cards-list">';
    for (const route of routes) {
        const visibilityIcon = route.visible ? 'fa-eye' : 'fa-eye-slash';
        const visibilityTitle = route.visible ? 'Скрыть' : 'Показать';
        html += `
            <div class="route-card">
                <div class="route-header">
                    <span class="route-name">${escapeHtml(route.name)}</span>
                </div>
                <div class="route-details">
                    <div><i class="fas fa-map-marker-alt"></i> ${escapeHtml(route.startLat.toFixed(2) + ', ' + route.startLon.toFixed(2))} → ${escapeHtml(route.endLat.toFixed(2) + ', ' + route.endLon.toFixed(2))}</div>
                    <div class="route-actions">
                        <button class="action-btn" onclick="toggleRouteVisibility(${route.id})" title="${visibilityTitle}"><i class="fas ${visibilityIcon}"></i></button>
                        <button class="action-btn" onclick="showRouteCoords(${route.id})" title="Координаты маршрута"><i class="fas fa-list"></i></button>
                        <button class="action-btn" onclick="changeRouteColor(${route.id})" title="Изменить цвет"><i class="fas fa-palette"></i></button>
                        <button class="action-btn" onclick="removeRouteFromMap(${route.id})" title="Убрать с карты"><i class="fas fa-trash"></i></button>
                    </div>
                </div>
            </div>
        `;
    }
    html += '</div>';
    container.innerHTML = html;
}

function toggleRouteVisibility(routeId) {
    const route = mapRoutes[routeId];
    if (!route) return;
    if (route.visible) {
        map.removeLayer(route.layerGroup);
        route.visible = false;
        showNotification('Маршрут скрыт');
    } else {
        map.addLayer(route.layerGroup);
        route.visible = true;
        showNotification('Маршрут показан');
    }
    renderRoutesOnMapPanel();
}

function removeRouteFromMap(routeId) {
    const route = mapRoutes[routeId];
    if (!route) return;
    map.removeLayer(route.layerGroup);
    delete mapRoutes[routeId];
    showNotification('Маршрут убран с карты');
    renderRoutesOnMapPanel();
}

function showRouteCoords(routeId) {
    const route = mapRoutes[routeId];
    if (!route) return;
    const panel = document.getElementById('routeCoordsPanel');
    const content = document.getElementById('routeCoordsContent');
    const allPoints = [];
    route.geometry.forEach(seg => { allPoints.push(...seg); });
    const ices = route.iceConcentrations || [];
    const thicks = route.iceThicknesses || [];

    let tableHtml = '<table><thead><tr><th>Широта</th><th>Долгота</th><th>Лёд (%)</th><th>Толщина (м)</th></tr></thead><tbody>';
    for (let i = 0; i < allPoints.length; i++) {
        const [lat, lon] = allPoints[i];
        const ice = i < ices.length ? (ices[i] !== null ? ices[i].toFixed(1) : '—') : '—';
        const thick = i < thicks.length ? getThicknessRange(thicks[i]) : '—';
        tableHtml += `<tr><td>${lat.toFixed(4)}</td><td>${lon.toFixed(4)}</td><td>${ice}</td><td>${thick}</td></tr>`;
    }
    tableHtml += '</tbody></table>';
    content.innerHTML = tableHtml;
    panel.style.display = 'block';
}

function closeCoordsPanel() {
    document.getElementById('routeCoordsPanel').style.display = 'none';
}

function changeRouteColor(routeId) {
    const route = mapRoutes[routeId];
    if (!route) return;

    const input = document.createElement('input');
    input.type = 'color';
    input.value = route.color || '#ff0000';
    input.style.position = 'absolute';
    input.style.left = '-9999px';
    document.body.appendChild(input);

    input.click();

    input.addEventListener('change', () => {
        const newColor = input.value;
        map.removeLayer(route.layerGroup);

        const newLayerGroup = L.layerGroup();
        route.geometry.forEach(seg => {
            createSegmentWithCopies(seg, { color: newColor, weight: 4, opacity: 0.8 }).addTo(newLayerGroup);
        });
        if (route.visible) {
            newLayerGroup.addTo(map);
        }

        route.layerGroup = newLayerGroup;
        route.color = newColor;
        document.body.removeChild(input);
    });

    input.addEventListener('cancel', () => {
        document.body.removeChild(input);
    });
}

// ----------------------------- СОХРАНЁННЫЕ МАРШРУТЫ -----------------------------
async function loadSavedRoutes() {
    const resp = await fetch('/api/routes');
    const routes = await resp.json();
    const container = document.getElementById('savedRoutesList');
    if (!container) return;
    if (routes.length === 0) {
        container.innerHTML = '<div class="empty-message">Нет сохранённых маршрутов</div>';
        return;
    }
    let html = '<div class="cards-list">';
    for (let r of routes) {
        const startName = r.start_point_name || `${r.start_lon},${r.start_lat}`;
        const endName = r.end_point_name || `${r.end_lon},${r.end_lat}`;
        const statusClass = r.is_valid ? 'status-valid' : 'status-invalid';
        const statusText = r.is_valid ? 'Актуален' : 'Неактуален';
        html += `
            <div class="route-card">
                <div class="route-header">
                    <span class="route-name">${escapeHtml(r.name)}</span>
                    <span class="route-status ${statusClass}">${statusText}</span>
                </div>
                <div class="route-details">
                    <div><i class="fas fa-ship"></i> ${escapeHtml(r.ship_name)} (${r.ice_class})</div>
                    <div><i class="fas fa-map-marker-alt"></i> ${escapeHtml(startName)} → ${escapeHtml(endName)}</div>
                    <div class="route-actions">
                        <button class="action-btn" onclick="showRouteOnMap(${r.id})" title="Показать на карте"><i class="fas fa-map"></i></button>
                        <button class="action-btn" onclick="updateRoute(${r.id})" title="Обновить маршрут"><i class="fas fa-sync-alt"></i></button>
                        <button class="action-btn" onclick="deleteRoute(${r.id})" title="Удалить маршрут"><i class="fas fa-trash"></i></button>
                    </div>
                </div>
            </div>
        `;
    }
    html += '</div>';
    container.innerHTML = html;
}

function normalizeGeometry(raw) {
    if (!raw || raw.length === 0) return [];
    if (typeof raw[0] === 'number') {
        const points = [];
        for (let i = 0; i < raw.length; i += 2) {
            points.push([raw[i], raw[i + 1]]);
        }
        return [points];
    }
    if (Array.isArray(raw[0])) {
        if (Array.isArray(raw[0][0])) {
            return raw;
        } else {
            return [raw];
        }
    }
    return [];
}

function showRouteOnMap(routeId) {
    fetch('/api/routes').then(r => r.json()).then(routes => {
        const route = routes.find(r => r.id == routeId);
        if (route && route.geometry) {
            const raw = JSON.parse(route.geometry);
            const segments = normalizeGeometry(raw);

            if (!segments || segments.length === 0) {
                showNotification('Ошибка: неверный формат маршрута', true);
                return;
            }

            if (mapRoutes[routeId]) {
                map.removeLayer(mapRoutes[routeId].layerGroup);
            }

            const layerGroup = L.layerGroup();
            segments.forEach(seg => {
                createSegmentWithCopies(seg, { color: 'red', weight: 4, opacity: 0.8 }).addTo(layerGroup);
            });
            layerGroup.addTo(map);

            const startLat = route.start_lat != null ? route.start_lat : segments[0][0][0];
            const startLon = route.start_lon != null ? route.start_lon : segments[0][0][1];
            const lastSeg = segments[segments.length - 1];
            const endLat = route.end_lat != null ? route.end_lat : lastSeg[lastSeg.length - 1][0];
            const endLon = route.end_lon != null ? route.end_lon : lastSeg[lastSeg.length - 1][1];
            const name = route.name || `Сохранённый маршрут ${route.id}`;

            mapRoutes[routeId] = {
                id: routeId,
                name: name,
                startLat, startLon,
                endLat, endLon,
                geometry: segments,
                iceConcentrations: route.ice_concentrations || null,
                iceThicknesses: route.ice_thicknesses || null,
                layerGroup: layerGroup,
                visible: true,
                color: '#ff0000',
                shipId: route.ship_id,
                startPointId: route.start_point_id,
                endPointId: route.end_point_id
            };

            try {
                map.fitBounds(layerGroup.getBounds());
            } catch (e) {
                console.warn('Не удалось подогнать границы карты под маршрут');
            }
            showNotification('Маршрут отображён');
            renderRoutesOnMapPanel();
        }
    }).catch(e => {
        console.error(e);
        showNotification('Ошибка при отображении маршрута', true);
    });
}

async function updateRoute(routeId) {
    showNotification('Перестроение маршрута...');
    const resp = await fetch('/api/routes');
    const routes = await resp.json();
    const route = routes.find(r => r.id == routeId);
    if (!route) return;
    const ship = await fetch('/api/ships').then(r => r.json()).then(s => s.find(s => s.id == route.ship_id));
    if (!ship) return;
    const payload = {
        ice_class: ship.ice_class,
        start_lon: route.start_lon,
        start_lat: route.start_lat,
        goal_lon: route.end_lon,
        goal_lat: route.end_lat
    };
    const planResp = await fetch('/plan_route', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const data = await planResp.json();
    if (data.error) {
        showNotification(`Маршрут не может быть перестроен: ${data.error}`, true);
        await fetch(`/api/routes/${routeId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ is_valid: false, geometry: route.geometry }) });
        loadSavedRoutes();
        return;
    }
    const newGeometry = data.route_segments;
    if (mapRoutes[routeId]) {
        map.removeLayer(mapRoutes[routeId].layerGroup);
    }
    const layerGroup = L.layerGroup();
    newGeometry.forEach(seg => {
        createSegmentWithCopies(seg, { color: 'red', weight: 4, opacity: 0.8 }).addTo(layerGroup);
    });
    layerGroup.addTo(map);

    mapRoutes[routeId] = {
        id: routeId,
        name: route.name || `Сохранённый маршрут ${routeId}`,
        startLat: route.start_lat,
        startLon: route.start_lon,
        endLat: route.end_lat,
        endLon: route.end_lon,
        geometry: newGeometry,
        iceConcentrations: data.points_ice || null,
        iceThicknesses: data.points_thickness || null,
        layerGroup: layerGroup,
        visible: true,
        color: '#ff0000',
        shipId: route.ship_id,
        startPointId: route.start_point_id,
        endPointId: route.end_point_id
    };

    await fetch(`/api/routes/${routeId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ is_valid: true, geometry: newGeometry }) });
    showNotification('Маршрут обновлён');
    map.fitBounds(layerGroup.getBounds());
    renderRoutesOnMapPanel();
    loadSavedRoutes();
}

async function deleteRoute(routeId) {
    if (confirm('Удалить маршрут?')) {
        await fetch(`/api/routes/${routeId}`, { method: 'DELETE' });
        if (mapRoutes[routeId]) {
            map.removeLayer(mapRoutes[routeId].layerGroup);
            delete mapRoutes[routeId];
            renderRoutesOnMapPanel();
        }
        loadSavedRoutes();
        showNotification('Маршрут удалён');
    }
}

// ----------------------------- СУДА -----------------------------
async function loadShipsTable() {
    const resp = await fetch('/api/ships');
    const ships = await resp.json();
    const container = document.getElementById('shipsTable');
    if (!container) return;
    if (ships.length === 0) {
        container.innerHTML = '<div class="empty-message">Нет судов</div>';
        return;
    }
    let html = '<div class="cards-list">';
    ships.forEach(s => {
        html += `
            <div class="ship-card">
                <div class="ship-name">${escapeHtml(s.name)}</div>
                <div class="ship-details">
                    <div>IMO: ${escapeHtml(s.imo)}</div>
                    <div>Ледовый класс: ${escapeHtml(s.ice_class)}</div>
                </div>
                <div class="ship-actions">
                    <button class="action-btn" onclick="deleteShip(${s.id})" title="Удалить судно"><i class="fas fa-trash"></i></button>
                </div>
            </div>
        `;
    });
    html += '</div>';
    container.innerHTML = html;
}

async function deleteShip(id) {
    if (!confirm('Удалить судно?')) return;
    const resp = await fetch(`/api/ships/${id}`, { method: 'DELETE' });
    const data = await resp.json();
    if (data.success) {
        if (data.deleted_routes > 0) {
            showNotification(`Судно удалено. Также удалено маршрутов: ${data.deleted_routes}`, false);
        } else {
            showNotification('Судно удалено');
        }
        for (const [routeId, route] of Object.entries(mapRoutes)) {
            if (route.shipId === id) {
                map.removeLayer(route.layerGroup);
                delete mapRoutes[routeId];
            }
        }
        renderRoutesOnMapPanel();
        loadShipsTable();
        loadShipsSelect();
        loadSavedRoutes();
    } else {
        showNotification(data.error || 'Ошибка удаления', true);
    }
}

async function addShip() {
    const name = document.getElementById('shipName').value;
    const imo = document.getElementById('shipIMO').value;
    const ice_class = document.getElementById('shipIceClass').value;
    if (!name || !imo || !ice_class) {
        showNotification('Заполните все поля', true);
        return;
    }
    if (!/^\d{7}$/.test(imo)) {
        showNotification('IMO должен состоять из 7 цифр', true);
        return;
    }
    const resp = await fetch('/api/ships', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, imo, ice_class }) });
    const data = await resp.json();
    if (data.success) {
        showNotification('Судно добавлено');
        document.getElementById('shipName').value = '';
        document.getElementById('shipIMO').value = '';
        loadShipsTable();
        loadShipsSelect();
    } else {
        showNotification(data.error || 'Ошибка', true);
    }
}

// ----------------------------- ПУНКТЫ -----------------------------
async function loadPointsTable() {
    const resp = await fetch('/api/points/list');
    const points = await resp.json();
    const container = document.getElementById('pointsTable');
    if (!container) return;
    if (points.length === 0) {
        container.innerHTML = '<div class="empty-message">Нет пунктов</div>';
        return;
    }
    let html = '<div class="cards-list">';
    points.forEach(p => {
        html += `
            <div class="point-card">
                <div class="point-name">${escapeHtml(p.name)}</div>
                <div class="point-coords">
                    <div>Долгота: ${p.lon.toFixed(4)}°</div>
                    <div>Широта: ${p.lat.toFixed(4)}°</div>
                </div>
                <div class="point-actions">
                    <button class="action-btn" onclick="deletePoint(${p.id})" title="Удалить пункт"><i class="fas fa-trash"></i></button>
                </div>
            </div>
        `;
    });
    html += '</div>';
    container.innerHTML = html;
}

async function deletePoint(id) {
    if (!confirm('Удалить пункт?')) return;
    const resp = await fetch(`/api/points/${id}`, { method: 'DELETE' });
    const data = await resp.json();
    if (data.success) {
        if (data.deleted_routes > 0) {
            showNotification(`Пункт удалён. Также удалено маршрутов: ${data.deleted_routes}`, false);
        } else {
            showNotification('Пункт удалён');
        }
        for (const [routeId, route] of Object.entries(mapRoutes)) {
            if (route.startPointId === id || route.endPointId === id) {
                map.removeLayer(route.layerGroup);
                delete mapRoutes[routeId];
            }
        }
        renderRoutesOnMapPanel();
        loadPointsTable();
        loadPointsSelect();
        loadSavedRoutes();
    } else {
        showNotification(data.error || 'Ошибка удаления', true);
    }
}

async function addPoint() {
    const name = document.getElementById('pointName').value;
    const lon = parseFloat(document.getElementById('pointLon').value);
    const lat = parseFloat(document.getElementById('pointLat').value);
    if (!name || isNaN(lon) || isNaN(lat)) {
        showNotification('Заполните все поля', true);
        return;
    }
    const resp = await fetch('/api/points', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, lon, lat }) });
    const data = await resp.json();
    if (data.success) {
        showNotification('Пункт добавлен');
        document.getElementById('pointName').value = '';
        document.getElementById('pointLon').value = '';
        document.getElementById('pointLat').value = '';
        loadPointsTable();
        loadPointsSelect();
    } else {
        showNotification(data.error || 'Ошибка', true);
    }
}

// ----------------------------- ОБНОВЛЕНИЕ КАРТЫ -----------------------------
async function updateMap() {
    setUIEnabled(false);
    try {
        const check = await fetch('/api/check_updates');
        const { outdated } = await check.json();
        if (!outdated) {
            showNotification('Карта актуальна');
            setUIEnabled(true);
            checkFormValid();
            document.getElementById('saveRouteBtn').disabled = currentRouteSaved || !currentRouteSegments;
            return;
        }
        const updateResp = await fetch('/api/update_dataset');
        const { success } = await updateResp.json();
        if (success) {
            await loadMapLayers();
            showNotification('Карта обновлена');
        } else {
            showNotification('Ошибка обновления', true);
        }
    } catch(e) {
        showNotification('Ошибка соединения', true);
    }
    setUIEnabled(true);
    checkFormValid();
    document.getElementById('saveRouteBtn').disabled = currentRouteSaved || !currentRouteSegments;
}

// ----------------------------- УПРАВЛЕНИЕ ИНТЕРФЕЙСОМ -----------------------------
function showNotification(text, isError = false) {
    const notif = document.getElementById('notification');
    notif.style.backgroundColor = isError ? '#e74c3c' : '#000000';
    notif.style.color = 'white';
    notif.textContent = text;
    notif.style.display = 'block';
    setTimeout(() => { notif.style.display = 'none'; }, 5000);
}

function setUIEnabled(enabled) {
    const btns = document.querySelectorAll('.menu-item, .submenu-item, button, select, input');
    btns.forEach(el => el.disabled = !enabled);
    const progress = document.getElementById('progressOverlay');
    if (progress) progress.style.display = enabled ? 'none' : 'flex';
}

function closeAllPanels() {
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('open'));
}

function openPanel(panelId) {
    closeAllPanels();
    const panel = document.getElementById(panelId);
    if (panel) panel.classList.add('open');
}

function checkFormValid() {
    const ship = document.getElementById('shipSelect').value;
    let startValid = false;
    const startType = document.querySelector('input[name="startType"]:checked')?.value;
    if (startType === 'list') {
        startValid = document.getElementById('startPointSelect').value !== '';
    } else if (startType === 'coords') {
        const lon = parseFloat(document.getElementById('startLon').value);
        const lat = parseFloat(document.getElementById('startLat').value);
        startValid = !isNaN(lon) && !isNaN(lat);
    }
    let goalValid = false;
    const goalType = document.querySelector('input[name="goalType"]:checked')?.value;
    if (goalType === 'list') {
        goalValid = document.getElementById('endPointSelect').value !== '';
    } else if (goalType === 'coords') {
        const lon = parseFloat(document.getElementById('goalLon').value);
        const lat = parseFloat(document.getElementById('goalLat').value);
        goalValid = !isNaN(lon) && !isNaN(lat);
    }
    const btn = document.getElementById('calculateRouteBtn');
    if (btn) btn.disabled = !(ship && startValid && goalValid);
}

// ----------------------------- ИНИЦИАЛИЗАЦИЯ -----------------------------
document.addEventListener('DOMContentLoaded', () => {
    initMap();
    loadMapLayers();
    loadShipsSelect();
    loadPointsSelect();
    loadShipsTable();
    loadPointsTable();
    loadSavedRoutes();

    const menuItems = document.querySelectorAll('.menu-item');
    menuItems.forEach(item => {
        item.addEventListener('click', (e) => {
            const menu = item.dataset.menu;
            menuItems.forEach(mi => mi.classList.remove('active'));
            item.classList.add('active');
            document.querySelectorAll('.submenu').forEach(s => s.style.display = 'none');
            if (menu === 'map') {
                document.getElementById('submenu-map').style.display = 'block';
                openPanel(null);
            } else if (menu === 'routes') {
                openPanel('panel-routes-list');
                loadSavedRoutes();
            } else if (menu === 'ships') {
                openPanel('panel-ships');
                loadShipsTable();
            } else if (menu === 'points') {
                openPanel('panel-points');
                loadPointsTable();
            }
        });
    });
    menuItems[0].click();
    const buildRouteAction = document.querySelector('[data-action="build-route"]');
    if (buildRouteAction) {
        buildRouteAction.addEventListener('click', () => {
            openPanel('panel-build-route');
            loadShipsSelect();
            loadPointsSelect();
            setTimeout(() => {
                document.querySelectorAll('input[name="startType"]').forEach(radio => radio.addEventListener('change', () => { toggleStartInputs(); checkFormValid(); }));
                document.querySelectorAll('input[name="goalType"]').forEach(radio => radio.addEventListener('change', () => { toggleGoalInputs(); checkFormValid(); }));
                toggleStartInputs();
                toggleGoalInputs();
                ['startPointSelect', 'endPointSelect', 'startLon', 'startLat', 'goalLon', 'goalLat', 'shipSelect'].forEach(id => {
                    const el = document.getElementById(id);
                    if (el) el.addEventListener('input', checkFormValid);
                });
                checkFormValid();
            }, 100);
        });
    }

    const routesOnMapAction = document.querySelector('[data-action="routes-on-map"]');
    if (routesOnMapAction) {
        routesOnMapAction.addEventListener('click', () => {
            openPanel('panel-routes-on-map');
            renderRoutesOnMapPanel();
        });
    }

    const updateMapAction = document.querySelector('[data-action="update-map"]');
    if (updateMapAction) updateMapAction.addEventListener('click', () => updateMap());

    const toggleLayerAction = document.querySelector('[data-action="toggle-layer"]');
    if (toggleLayerAction) toggleLayerAction.addEventListener('click', () => toggleLayer());

    document.getElementById('calculateRouteBtn')?.addEventListener('click', buildRoute);
    document.getElementById('saveRouteBtn')?.addEventListener('click', saveRoute);
    document.getElementById('addShipBtn')?.addEventListener('click', addShip);
    document.getElementById('addPointBtn')?.addEventListener('click', addPoint);
    document.getElementById('closeCoordsBtn')?.addEventListener('click', closeCoordsPanel);
});