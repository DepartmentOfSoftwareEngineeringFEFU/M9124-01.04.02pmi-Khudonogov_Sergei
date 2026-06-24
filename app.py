import os
import re
import math
import json
import sqlite3
import threading
from datetime import datetime
from pathlib import Path

from flask import Flask, render_template, request, jsonify, send_from_directory
import xarray as xr
import numpy as np
import folium
from folium import plugins
import matplotlib.pyplot as plt
import matplotlib.colors as colors
import geojsoncontour
import rioxarray
import rasterio
from pyproj import Transformer, CRS
import requests
from branca.colormap import LinearColormap
from localtileserver import TileClient, get_folium_tile_layer
from scipy.spatial import cKDTree
import atexit
import matplotlib

# ----------------------------- НАСТРОЙКИ -----------------------------
BASE_URL_NC = "https://data.seaice.uni-bremen.de/amsr2/asi_daygrid_swath/n3125/netcdf/2026/"
BASE_URL_TIF = "https://data.seaice.uni-bremen.de/amsr2/asi_daygrid_swath/n3125/2026/jun/Arctic3125/"
BASE_URL_ICEAGE = "https://daacdata.apps.nsidc.org/pub/DATASETS/nsidc0611_seaice_age_v4/data/iceage_nh_12.5km_20240101_20241231_v4.1.nc"

CACHE_DIR = Path("ice_data_cache")
STATIC_DIR = Path("static")
CACHE_DIR.mkdir(exist_ok=True)
STATIC_DIR.mkdir(exist_ok=True)
DATABASE = Path("instance/routes.db")
DATABASE.parent.mkdir(exist_ok=True)

# Глобальные данные
ice_data_percent = None
ice_data_thickness = None
x_coords_met = None
y_coords_met = None
transformer_inv = None
current_dataset_date = None
raster_client = None

STEP_POINTS = 25
PLANNING_RESAMPLE = 2

ALPHA_C = 3.0
ALPHA_T = 2.0
T_REF = 1.0

ICE_CLASSES = {
    "Ice1": {"max_conc": 30, "max_t": 0.4, "cost_factor": 1.0},
    "Ice2": {"max_conc": 40, "max_t": 0.5, "cost_factor": 1.0},
    "Ice3": {"max_conc": 50, "max_t": 0.7, "cost_factor": 1.0},
    "Arc4": {"max_conc": 60, "max_t": 0.8, "cost_factor": 1.0},
    "Arc5": {"max_conc": 70, "max_t": 1.0, "cost_factor": 1.0},
    "Arc6": {"max_conc": 80, "max_t": 1.3, "cost_factor": 1.0},
    "Arc7": {"max_conc": 90, "max_t": 1.4, "cost_factor": 1.0},
    "Arc8": {"max_conc": 95, "max_t": 2.1, "cost_factor": 1.0},
    "Arc9": {"max_conc": 100, "max_t": 3.5, "cost_factor": 1.0},
    "Icebreaker6": {"max_conc": 100, "max_t": 1.5, "cost_factor": 0.7},
    "Icebreaker7": {"max_conc": 100, "max_t": 2.0, "cost_factor": 0.5},
    "Icebreaker8": {"max_conc": 100, "max_t": 3.0, "cost_factor": 0.3},
    "Icebreaker9": {"max_conc": 100, "max_t": 4.0, "cost_factor": 0.2},
}

# ----------------------------- РАБОТА С БД -----------------------------
def get_db():
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with get_db() as conn:
        conn.execute('''
            CREATE TABLE IF NOT EXISTS points (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                lon REAL NOT NULL,
                lat REAL NOT NULL,
                UNIQUE(lon, lat)
            )
        ''')
        conn.execute('''
            CREATE TABLE IF NOT EXISTS ships (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                imo TEXT NOT NULL UNIQUE,
                ice_class TEXT NOT NULL
            )
        ''')
        conn.execute('''
            CREATE TABLE IF NOT EXISTS routes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                start_point_id INTEGER REFERENCES points(id) ON DELETE CASCADE,
                start_lon REAL,
                start_lat REAL,
                end_point_id INTEGER REFERENCES points(id) ON DELETE CASCADE,
                end_lon REAL,
                end_lat REAL,
                ship_id INTEGER REFERENCES ships(id) ON DELETE CASCADE,
                geometry TEXT NOT NULL,
                ice_concentrations TEXT,
                ice_thicknesses TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                is_valid BOOLEAN DEFAULT 1
            )
        ''')
        conn.execute("INSERT OR IGNORE INTO points (name, lon, lat) VALUES ('Мурманск', 33.0, 68.9)")
        conn.execute("INSERT OR IGNORE INTO points (name, lon, lat) VALUES ('Владивосток', 131.9, 43.1)")
        conn.execute("INSERT OR IGNORE INTO ships (name, imo, ice_class) VALUES ('Атомный ледокол 50 лет Победы', '9325195', 'Icebreaker9')")
        conn.execute("INSERT OR IGNORE INTO ships (name, imo, ice_class) VALUES ('Газовоз Arc7', '1234567', 'Arc7')")
        conn.commit()
init_db()

# ----------------------------- ЗАГРУЗКА ДАННЫХ -----------------------------
def download_file(url, local_path):
    if local_path.exists():
        return 0
    print(f"Загрузка {url}")
    with requests.get(url, stream=True) as r:
        r.raise_for_status()
        with open(local_path, 'wb') as f:
            for chunk in r.iter_content(8192):
                f.write(chunk)
    return 1

def get_latest_file(base_url, pattern):
    try:
        r = requests.get(base_url)
        r.raise_for_status()
    except:
        return None, None
    files = re.findall(r'href="(asi-AMSR2-n3125-\d{8}-v5\.4\.(?:nc|tif))"', r.text)
    if not files:
        return None, None
    files.sort(key=lambda f: f.split('-')[3], reverse=True)
    latest = files[0]
    url = base_url + latest
    local_path = CACHE_DIR / latest
    status = download_file(url, local_path)
    return local_path, status

def load_iceage_thickness():
    global ice_data_thickness
    if ice_data_percent is None or current_dataset_date is None:
        return False

    # Теперь файл лежит в static/
    local_path = STATIC_DIR / "iceage_nh_12.5km_20240101_20241231_v4.1.nc"
    if not local_path.exists():
        print(f"Файл возраста льда не найден: {local_path}")
        return False

    try:
        ds = xr.open_dataset(local_path, engine='netcdf4')
    except Exception as e:
        print(f"Ошибка открытия файла: {e}")
        return False

    age_var = ds['age_of_sea_ice'] if 'age_of_sea_ice' in ds else None
    if age_var is None:
        print("Не удалось найти переменную 'age_of_sea_ice'")
        return False

    time_var = ds['time']
    try:
        time_vals = time_var.values.astype('datetime64[D]')
    except:
        import pandas as pd
        time_vals = np.array([pd.Timestamp(t) for t in time_var.values], dtype='datetime64[D]')

    year = 2024
    month = int(current_dataset_date[4:6])
    day = int(current_dataset_date[6:8])
    target_date = np.datetime64(f"{year}-{month:02d}-{day:02d}")

    idx = np.argmin(np.abs(time_vals - target_date))
    print(f"Выбран индекс времени: {idx}, дата: {time_vals[idx]}")

    age_slice = age_var.isel(time=idx).values.astype(float)

    age_slice[(age_slice == 20) | (age_slice == 21)] = np.nan
    age_slice[age_slice == 0] = 0.0

    thick_raw = np.zeros_like(age_slice, dtype=float)
    thick_raw[age_slice == 1] = 0.5
    thick_raw[age_slice == 2] = 1.5
    thick_raw[age_slice == 3] = 2.5
    thick_raw[age_slice == 4] = 3.5
    thick_raw[age_slice >= 5] = 4.5

    if 'latitude' in ds and 'longitude' in ds:
        lat = ds['latitude'].values
        lon = ds['longitude'].values
    else:
        print("Не найдены latitude/longitude в файле")
        return False

    crs_geo = CRS.from_epsg(4326)
    crs_proj = CRS.from_epsg(3411)
    transformer = Transformer.from_crs(crs_geo, crs_proj, always_xy=True)
    x_age, y_age = transformer.transform(lon, lat)

    valid_ice = (thick_raw > 0) & ~np.isnan(thick_raw)
    x_valid = x_age[valid_ice].ravel()
    y_valid = y_age[valid_ice].ravel()
    thick_valid = thick_raw[valid_ice].ravel()

    tree = cKDTree(np.column_stack((x_valid, y_valid)))
    xm, ym = np.meshgrid(x_coords_met, y_coords_met)
    pts = np.column_stack((xm.ravel(), ym.ravel()))
    dist, idx_p = tree.query(pts, k=1)

    ice_data_thickness = thick_valid[idx_p].reshape(ice_data_percent.shape)
    ice_data_thickness[(ice_data_percent > 0) & (ice_data_thickness == 0)] = np.nan
    ice_data_thickness[np.isnan(ice_data_percent)] = np.nan
    print("Толщина на основе возраста льда успешно построена")
    return True

def load_ice_data():
    global ice_data_percent, x_coords_met, y_coords_met, transformer_inv, current_dataset_date
    nc_path, _ = get_latest_file(BASE_URL_NC, "*.nc")
    if not nc_path:
        return False
    match = re.search(r'(\d{8})', str(nc_path))
    if match:
        current_dataset_date = match.group(1)
    ds = xr.open_dataset(nc_path, engine='netcdf4')
    x_coords_met = ds['x'].values
    y_coords_met = ds['y'].values
    ice_conc_raw = ds['z'].values
    ice_data_percent = ice_conc_raw.astype(float)
    ice_data_percent = np.where((ice_data_percent < 0) | (ice_data_percent > 100), np.nan, ice_data_percent)
    crs_proj = CRS.from_epsg(3411)
    crs_geo = CRS.from_epsg(4326)
    transformer_inv = Transformer.from_crs(crs_geo, crs_proj, always_xy=True)
    if not load_iceage_thickness():
        print("Предупреждение: толщина льда не загружена, будет использоваться только концентрация")
    return True

def get_current_date():
    return current_dataset_date

def is_dataset_outdated():
    try:
        r = requests.get(BASE_URL_NC)
        r.raise_for_status()
        files = re.findall(r'href="(asi-AMSR2-n3125-(\d{8})-v5\.4\.nc)"', r.text)
        if not files:
            return False
        latest_server = max(files, key=lambda x: x[1])[1]
        return latest_server > current_dataset_date if current_dataset_date else True
    except:
        return False

def create_colored_tif(src_path, dst_path, cmap_name='Blues', vmin=0, vmax=100):
    with rasterio.open(src_path) as src:
        data = src.read(1).astype(float)
        profile = src.profile
        src_nodata = src.nodata

    nodata_mask = np.zeros_like(data, dtype=bool)
    if src_nodata is not None:
        nodata_mask |= (data == src_nodata)
    nodata_mask |= (data == 120)
    nodata_mask |= (data < 0) | (data > 100)

    data[nodata_mask] = 0
    data_clipped = np.clip(data, vmin, vmax)
    data_scaled = ((data_clipped - vmin) / (vmax - vmin) * 254).astype(np.uint8)

    cmap = matplotlib.colormaps[cmap_name]
    norm = plt.Normalize(vmin=vmin, vmax=vmax)
    colors = cmap(norm(np.linspace(vmin, vmax, 255)))
    colors = (colors * 255).astype(np.uint8)
    colors = np.vstack([colors, [[0, 0, 0, 0]]])

    data_scaled[nodata_mask] = 255
    profile.update(dtype='uint8', count=1, photometric='PALETTE', nodata=255)
    with rasterio.open(dst_path, 'w', **profile) as dst:
        dst.write(data_scaled, 1)
        dst.write_colormap(1, {i: tuple(colors[i, :3]) for i in range(256)})

def update_dataset():
    global ice_data_percent, ice_data_thickness, x_coords_met, y_coords_met, transformer_inv, current_dataset_date, raster_client
    nc_path, _ = get_latest_file(BASE_URL_NC, "*.nc")
    if not nc_path:
        return False
    ds = xr.open_dataset(nc_path, engine='netcdf4')
    x_coords_met = ds['x'].values
    y_coords_met = ds['y'].values
    ice_conc_raw = ds['z'].values
    ice_data_percent = ice_conc_raw.astype(float)
    ice_data_percent = np.where((ice_data_percent < 0) | (ice_data_percent > 100), np.nan, ice_data_percent)
    match = re.search(r'(\d{8})', str(nc_path))
    if match:
        current_dataset_date = match.group(1)
    if not load_iceage_thickness():
        print("Предупреждение: не удалось обновить толщину льда")
    tif_path, _ = get_latest_file(BASE_URL_TIF, "*.tif")
    if tif_path:
        tif_nolake_path = tif_path.parent / f"{tif_path.stem}_nolake{tif_path.suffix}"
        tif_colored_path = tif_path.parent / f"{tif_path.stem}_colored{tif_path.suffix}"
        if not tif_colored_path.exists():
            if not tif_nolake_path.exists():
                with rasterio.open(tif_path) as src:
                    profile = src.profile
                    data = src.read(1)
                data[data == 120] = 0
                with rasterio.open(tif_nolake_path, 'w', **profile) as dst:
                    dst.write(data, 1)
            create_colored_tif(tif_nolake_path, tif_colored_path, cmap_name='Blues')
        raster_client = TileClient(str(tif_colored_path), host='0.0.0.0', port=8082)
    return True

# ----------------------------- ГЕНЕРАЦИЯ ТОЧЕК GEOJSON -----------------------------
def generate_points_geojson():
    if ice_data_percent is None:
        return None
    crs_proj = CRS.from_epsg(3411)
    crs_geo = CRS.from_epsg(4326)
    transformer = Transformer.from_crs(crs_proj, crs_geo, always_xy=True)
    x_mesh, y_mesh = np.meshgrid(x_coords_met, y_coords_met)
    lon_flat, lat_flat = transformer.transform(x_mesh.ravel(), y_mesh.ravel())
    ice_flat = ice_data_percent.ravel()
    valid_mask = ~np.isnan(ice_flat)
    step = STEP_POINTS
    features = []
    for i in range(0, len(lon_flat), step):
        if valid_mask[i]:
            conc = ice_flat[i]
            if conc > 0:
                props = {"concentration": round(conc, 1)}
                if ice_data_thickness is not None:
                    thick_val = ice_data_thickness.ravel()[i]
                    props["thickness"] = round(float(thick_val), 2) if not np.isnan(thick_val) else None
                features.append({
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [lon_flat[i], lat_flat[i]]},
                    "properties": props
                })
    return {"type": "FeatureCollection", "features": features}

# ----------------------------- A* -----------------------------
def get_cost_grid(ice_conc_percent, ice_thickness, ice_class):
    max_conc = ICE_CLASSES[ice_class]["max_conc"]
    max_t = ICE_CLASSES[ice_class]["max_t"]
    factor = ICE_CLASSES[ice_class]["cost_factor"]
    cost = np.ones_like(ice_conc_percent)
    penalty_c = (ice_conc_percent / 100) ** 2
    cost += ALPHA_C * penalty_c
    if ice_thickness is not None:
        penalty_t = (ice_thickness / T_REF) ** 2
        cost += ALPHA_T * penalty_t
    cost[ice_conc_percent > max_conc] = np.inf
    if ice_thickness is not None:
        cost[ice_thickness > max_t] = np.inf
    cost[np.isnan(ice_conc_percent)] = np.inf
    if ice_thickness is not None:
        cost[np.isnan(ice_thickness)] = np.inf
    cost *= factor
    return cost

def a_star_route(cost_grid, start_idx, goal_idx, x_met, y_met):
    rows, cols = cost_grid.shape
    neighbors = [(-1,0),(1,0),(0,-1),(0,1),(-1,-1),(-1,1),(1,-1),(1,1)]
    def heuristic(a, b):
        dx = x_met[a[1]] - x_met[b[1]]
        dy = y_met[a[0]] - y_met[b[0]]
        return np.sqrt(dx*dx + dy*dy)
    import heapq
    open_set = [(0, start_idx)]
    g_score = {start_idx: 0}
    f_score = {start_idx: heuristic(start_idx, goal_idx)}
    came_from = {}
    closed_set = set()
    closed_count = 0
    total_vertices = rows * cols
    print(f"[A*] Старт: {start_idx}, Цель: {goal_idx}, Размер сетки: {rows}x{cols} ({total_vertices} вершин)")
    while open_set:
        current = heapq.heappop(open_set)[1]
        if current in closed_set:
            continue
        closed_set.add(current)
        closed_count += 1
        if closed_count % 10000 == 0:
            print(f"[A*] Обработано вершин: {closed_count}/{total_vertices} ({(closed_count/total_vertices)*100:.1f}%)")
        if current == goal_idx:
            print(f"[A*] Путь найден! Всего обработано вершин: {closed_count}")
            path = []
            while current in came_from:
                path.append(current)
                current = came_from[current]
            path.append(start_idx)
            path.reverse()
            return path, g_score[goal_idx]
        for dr, dc in neighbors:
            nr, nc = current[0] + dr, current[1] + dc
            if 0 <= nr < rows and 0 <= nc < cols:
                neighbor = (nr, nc)
                step_cost = cost_grid[neighbor]
                if np.isinf(step_cost):
                    continue
                if dr == 0 or dc == 0:
                    distance = abs(x_met[nc] - x_met[current[1]]) + abs(y_met[nr] - y_met[current[0]])
                else:
                    distance = np.sqrt((x_met[nc] - x_met[current[1]])**2 + (y_met[nr] - y_met[current[0]])**2)
                tentative_g = g_score[current] + distance * step_cost
                if neighbor not in g_score or tentative_g < g_score[neighbor]:
                    came_from[neighbor] = current
                    g_score[neighbor] = tentative_g
                    f = tentative_g + heuristic(neighbor, goal_idx)
                    f_score[neighbor] = f
                    heapq.heappush(open_set, (f, neighbor))
    print(f"[A*] Путь НЕ найден после обработки {closed_count} вершин.")
    return None, float('inf')

# ----------------------------- FLASK -----------------------------
app = Flask(__name__)

@app.route('/')
def index():
    conc_date = None
    thick_date = None
    if current_dataset_date:
        conc_date = f"{current_dataset_date[:4]}-{current_dataset_date[4:6]}-{current_dataset_date[6:8]}"
        thick_date = f"2024-{current_dataset_date[4:6]}-{current_dataset_date[6:8]}"
    return render_template('index.html', conc_date=conc_date, thick_date=thick_date)

@app.route('/static/<path:filename>')
def serve_static(filename):
    return send_from_directory(STATIC_DIR, filename)

@app.route('/api/check_updates')
def check_updates():
    outdated = is_dataset_outdated()
    return jsonify({'outdated': outdated})

@app.route('/api/update_dataset')
def api_update_dataset():
    success = update_dataset()
    return jsonify({'success': success})

@app.route('/api/points')
def api_points():
    geojson = generate_points_geojson()
    return jsonify(geojson)

@app.route('/api/raster_info')
def raster_info():
    global raster_client
    if raster_client is None:
        tif_path, _ = get_latest_file(BASE_URL_TIF, "*.tif")
        if tif_path:
            tif_nolake_path = tif_path.parent / f"{tif_path.stem}_nolake{tif_path.suffix}"
            tif_colored_path = tif_path.parent / f"{tif_path.stem}_colored{tif_path.suffix}"
            if not tif_colored_path.exists():
                if not tif_nolake_path.exists():
                    with rasterio.open(tif_path) as src:
                        profile = src.profile
                        data = src.read(1)
                    data[data == 120] = 0
                    with rasterio.open(tif_nolake_path, 'w', **profile) as dst:
                        dst.write(data, 1)
                create_colored_tif(tif_nolake_path, tif_colored_path, cmap_name='Blues')
            raster_client = TileClient(str(tif_colored_path), host='0.0.0.0', port=8082)
    if raster_client:
        info = raster_client.metadata
        bounds = info['bounds']
        tile_url = raster_client.get_tile_url().replace('0.0.0.0:8082', 'localhost:8082')
        return jsonify({
            'bounds': bounds,
            'tile_url': tile_url
        })
    return jsonify({'error': 'no raster'})

@app.route('/api/ships')
def api_ships():
    with get_db() as conn:
        ships = conn.execute("SELECT id, name, imo, ice_class FROM ships").fetchall()
    return jsonify([dict(row) for row in ships])

@app.route('/api/ships', methods=['POST'])
def add_ship():
    data = request.json
    name = data.get('name')
    imo = data.get('imo')
    ice_class = data.get('ice_class')
    if not name or not imo or not ice_class:
        return jsonify({'error': 'Не все поля заполнены'}), 400
    if not re.fullmatch(r'\d{7}', imo):
        return jsonify({'error': 'IMO должен состоять из 7 цифр'}), 400
    try:
        with get_db() as conn:
            conn.execute("INSERT INTO ships (name, imo, ice_class) VALUES (?, ?, ?)", (name, imo, ice_class))
            conn.commit()
        return jsonify({'success': True})
    except sqlite3.IntegrityError:
        return jsonify({'error': 'Судно с таким IMO уже существует'}), 400

@app.route('/api/ships/<int:ship_id>', methods=['DELETE'])
def delete_ship(ship_id):
    with get_db() as conn:
        routes = conn.execute("SELECT id FROM routes WHERE ship_id = ?", (ship_id,)).fetchall()
        deleted_count = len(routes)
        conn.execute("DELETE FROM ships WHERE id = ?", (ship_id,))
        conn.commit()
    return jsonify({'success': True, 'deleted_routes': deleted_count})

@app.route('/api/points/list')
def api_points_list():
    with get_db() as conn:
        points = conn.execute("SELECT id, name, lon, lat FROM points").fetchall()
    return jsonify([dict(row) for row in points])

@app.route('/api/points', methods=['POST'])
def add_point():
    data = request.json
    name = data.get('name')
    lon = data.get('lon')
    lat = data.get('lat')
    if not name or lon is None or lat is None:
        return jsonify({'error': 'Не все поля заполнены'}), 400
    try:
        with get_db() as conn:
            conn.execute("INSERT INTO points (name, lon, lat) VALUES (?, ?, ?)", (name, lon, lat))
            conn.commit()
        return jsonify({'success': True})
    except sqlite3.IntegrityError:
        return jsonify({'error': 'Пункт с такими координатами уже существует'}), 400

@app.route('/api/points/<int:point_id>', methods=['DELETE'])
def delete_point(point_id):
    with get_db() as conn:
        routes = conn.execute("SELECT id FROM routes WHERE start_point_id = ? OR end_point_id = ?",
                              (point_id, point_id)).fetchall()
        deleted_count = len(routes)
        conn.execute("DELETE FROM points WHERE id = ?", (point_id,))
        conn.commit()
    return jsonify({'success': True, 'deleted_routes': deleted_count})

@app.route('/api/routes', methods=['POST'])
def save_route():
    data = request.json
    with get_db() as conn:
        conn.execute('''
            INSERT INTO routes (name, start_point_id, start_lon, start_lat, end_point_id, end_lon, end_lat, ship_id, geometry, ice_concentrations, ice_thicknesses)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (
            data.get('name'),
            data.get('start_point_id'),
            data.get('start_lon'),
            data.get('start_lat'),
            data.get('end_point_id'),
            data.get('end_lon'),
            data.get('end_lat'),
            data.get('ship_id'),
            json.dumps(data.get('geometry')),
            json.dumps(data.get('points_ice')) if data.get('points_ice') else None,
            json.dumps(data.get('points_thickness')) if data.get('points_thickness') else None
        ))
        conn.commit()
    return jsonify({'success': True})

@app.route('/api/routes')
def get_routes():
    with get_db() as conn:
        routes = conn.execute('''
            SELECT r.id, r.name, r.start_point_id, r.start_lon, r.start_lat, r.end_point_id, r.end_lon, r.end_lat,
                   r.ship_id, r.geometry, r.ice_concentrations, r.ice_thicknesses, r.is_valid, r.created_at, r.updated_at,
                   s.name as ship_name, s.ice_class,
                   p1.name as start_point_name, p2.name as end_point_name
            FROM routes r
            LEFT JOIN ships s ON r.ship_id = s.id
            LEFT JOIN points p1 ON r.start_point_id = p1.id
            LEFT JOIN points p2 ON r.end_point_id = p2.id
        ''').fetchall()
    result = []
    for row in routes:
        d = dict(row)
        d['ice_concentrations'] = json.loads(d['ice_concentrations']) if d['ice_concentrations'] else None
        d['ice_thicknesses'] = json.loads(d['ice_thicknesses']) if d['ice_thicknesses'] else None
        result.append(d)
    return jsonify(result)

@app.route('/api/routes/<int:route_id>', methods=['PUT'])
def update_route(route_id):
    data = request.json
    with get_db() as conn:
        conn.execute("UPDATE routes SET geometry = ?, is_valid = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                     (json.dumps(data.get('geometry')), data.get('is_valid'), route_id))
        conn.commit()
    return jsonify({'success': True})

@app.route('/api/routes/<int:route_id>', methods=['DELETE'])
def delete_route(route_id):
    with get_db() as conn:
        conn.execute("DELETE FROM routes WHERE id = ?", (route_id,))
        conn.commit()
    return jsonify({'success': True})

@app.route('/plan_route', methods=['POST'])
def plan_route():
    global ice_data_percent, ice_data_thickness, x_coords_met, y_coords_met, transformer_inv
    data = request.get_json()
    ice_class = data.get('ice_class')
    start_lon = data.get('start_lon')
    start_lat = data.get('start_lat')
    goal_lon = data.get('goal_lon')
    goal_lat = data.get('goal_lat')

    def resample_cost_grid(cost_full, factor):
        if factor == 1:
            return cost_full, np.array([1.0]), np.array([1.0])
        cost_rs = cost_full[::factor, ::factor]
        return cost_rs, np.array([factor]), np.array([factor])

    def find_water_cell(lon, lat, max_dist_m=100000, resample_factor=1):
        x, y = transformer_inv.transform(lon, lat)
        row0 = np.argmin(np.abs(y_coords_met - y))
        col0 = np.argmin(np.abs(x_coords_met - x))
        row0_rs = row0 // resample_factor
        col0_rs = col0 // resample_factor
        rows_rs = ice_data_percent.shape[0] // resample_factor
        cols_rs = ice_data_percent.shape[1] // resample_factor
        if (0 <= row0_rs < rows_rs and 0 <= col0_rs < cols_rs and
            not np.isnan(ice_data_percent[row0_rs * resample_factor, col0_rs * resample_factor])):
            return (row0_rs, col0_rs)
        step = 3125 * resample_factor
        radius = int(max_dist_m / step) + 1
        best_idx = None
        best_dist = float('inf')
        for dr in range(-radius, radius + 1):
            for dc in range(-radius, radius + 1):
                r = row0_rs + dr
                c = col0_rs + dc
                if 0 <= r < rows_rs and 0 <= c < cols_rs:
                    full_r = r * resample_factor
                    full_c = c * resample_factor
                    if not np.isnan(ice_data_percent[full_r, full_c]):
                        dist = np.sqrt((x_coords_met[full_c] - x)**2 + (y_coords_met[full_r] - y)**2)
                        if dist < best_dist:
                            best_dist = dist
                            best_idx = (r, c)
        return best_idx

    factor = PLANNING_RESAMPLE
    start_idx = find_water_cell(start_lon, start_lat, max_dist_m=100000, resample_factor=factor)
    if start_idx is None:
        return jsonify({'error': 'Стартовая точка на суше, и в радиусе 100 км нет водной поверхности'}), 400
    goal_idx = find_water_cell(goal_lon, goal_lat, max_dist_m=100000, resample_factor=factor)
    if goal_idx is None:
        return jsonify({'error': 'Целевая точка на суше, и в радиусе 100 км нет водной поверхности'}), 400

    cost_full = get_cost_grid(ice_data_percent, ice_data_thickness, ice_class)
    cost_rs, scale_x, scale_y = resample_cost_grid(cost_full, factor)
    x_met_rs = x_coords_met[::factor]
    y_met_rs = y_coords_met[::factor]

    if start_idx and goal_idx:
        r_s, c_s = start_idx
        r_g, c_g = goal_idx
        full_r_s = r_s * factor
        full_c_s = c_s * factor
        full_r_g = r_g * factor
        full_c_g = c_g * factor
        c_start = ice_data_percent[full_r_s, full_c_s]
        c_goal = ice_data_percent[full_r_g, full_c_g]
        t_start = ice_data_thickness[full_r_s, full_c_s] if ice_data_thickness is not None else None
        t_goal = ice_data_thickness[full_r_g, full_c_g] if ice_data_thickness is not None else None
        print(f"[ПЛАН] Старт: idx={start_idx}, ice={c_start}%, thickness={t_start}")
        print(f"[ПЛАН] Цель: idx={goal_idx}, ice={c_goal}%, thickness={t_goal}")

    path_indices_rs, total_cost = a_star_route(cost_rs, start_idx, goal_idx, x_met_rs, y_met_rs)
    if path_indices_rs is None:
        return jsonify({'error': 'Маршрут не найден'}), 404

    crs_proj = CRS.from_epsg(3411)
    crs_geo = CRS.from_epsg(4326)
    transformer_fwd = Transformer.from_crs(crs_proj, crs_geo, always_xy=True)

    route_coords = []
    points_ice = []
    points_thick = [] if ice_data_thickness is not None else None
    for (row_rs, col_rs) in path_indices_rs:
        full_row = row_rs * factor
        full_col = col_rs * factor
        lon, lat = transformer_fwd.transform(x_coords_met[full_col], y_coords_met[full_row])
        route_coords.append([lat, lon])
        ice_val = ice_data_percent[full_row, full_col]
        points_ice.append(float(ice_val) if not np.isnan(ice_val) else None)
        if points_thick is not None:
            t_val = ice_data_thickness[full_row, full_col]
            points_thick.append(float(t_val) if not np.isnan(t_val) else None)

    def normalize_lon(lon):
        return (lon + 180) % 360 - 180

    def split_into_segments(coords):
        if not coords:
            return []
        segments = []
        current = [coords[0]]
        for i in range(1, len(coords)):
            prev_lon = coords[i-1][1]
            curr_lon = coords[i][1]
            if abs(curr_lon - prev_lon) > 180:
                segments.append(current)
                current = [coords[i]]
            else:
                current.append(coords[i])
        segments.append(current)
        return segments

    route_coords_norm = [[lat, normalize_lon(lon)] for lat, lon in route_coords]
    route_segments = split_into_segments(route_coords_norm)
    cost_val = total_cost if not math.isnan(total_cost) else None

    resp = {
        'route_segments': route_segments,
        'total_cost': cost_val,
        'start': [start_lat, start_lon],
        'goal': [goal_lat, goal_lon],
        'points_ice': points_ice
    }
    if points_thick is not None:
        resp['points_thickness'] = points_thick
    return jsonify(resp)

# ----------------------------- ЗАПУСК -----------------------------
if __name__ == '__main__':
    load_ice_data()
    tif_path, _ = get_latest_file(BASE_URL_TIF, "*.tif")
    if tif_path:
        tif_nolake_path = tif_path.parent / f"{tif_path.stem}_nolake{tif_path.suffix}"
        tif_colored_path = tif_path.parent / f"{tif_path.stem}_colored{tif_path.suffix}"
        if not tif_colored_path.exists():
            if not tif_nolake_path.exists():
                with rasterio.open(tif_path) as src:
                    profile = src.profile
                    data = src.read(1)
                data[data == 120] = 0
                with rasterio.open(tif_nolake_path, 'w', **profile) as dst:
                    dst.write(data, 1)
            create_colored_tif(tif_nolake_path, tif_colored_path, cmap_name='Blues')
        raster_client = TileClient(str(tif_colored_path), host='0.0.0.0', port=8082)
    app.run(host='0.0.0.0', port=5000, debug=False)