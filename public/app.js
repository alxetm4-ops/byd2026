(() => {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Utilidades                                                          */
  /* ------------------------------------------------------------------ */

  const $ = (id) => document.getElementById(id);
  const nf1 = new Intl.NumberFormat('es-CO', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const nf0 = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });
  const money = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
  const hora = new Intl.DateTimeFormat('es-CO', { hour: '2-digit', minute: '2-digit' });
  const fecha = new Intl.DateTimeFormat('es-CO', { weekday: 'short', day: 'numeric', month: 'short' });

  const RING_CIRCUNFERENCIA = 2 * Math.PI * 88;

  const state = {
    data: null,
    config: null,
    view: 'dashboard',
    map: null,
    carMarker: null,
    tripLayer: null,
    mapReady: false,
    stations: [],
    station: null,
    radioLoaded: false,
    audio: new Audio(),
    playing: false,
    toastTimer: null,
  };

  state.audio.preload = 'none';
  state.audio.volume = 0.8;

  const fmt1 = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? '—' : nf1.format(Number(v)));
  const fmt0 = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? '—' : nf0.format(Number(v)));

  function setText(id, text) {
    const node = $(id);
    if (node) node.textContent = text;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function toast(message) {
    const node = $('toast');
    node.textContent = message;
    node.classList.add('is-visible');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => node.classList.remove('is-visible'), 3200);
  }

  async function api(path, options = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    if (res.status === 401) {
      window.location.href = '/login';
      throw new Error('no autenticado');
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  /* ------------------------------------------------------------------ */
  /* Navegación                                                          */
  /* ------------------------------------------------------------------ */

  function setView(name) {
    state.view = name;
    document.querySelectorAll('.view').forEach((view) => {
      view.classList.toggle('is-active', view.id === `view-${name}`);
    });
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.classList.toggle('is-active', tab.dataset.view === name);
    });

    if (name === 'map') {
      ensureMap();
      setTimeout(() => {
        if (state.map) state.map.invalidateSize();
        renderMap();
      }, 80);
    }
    if (name === 'radio' && !state.radioLoaded) loadRadio();
    if (name === 'settings') renderSettings();
    if (name === 'trips') renderTrips();

    window.scrollTo({ top: 0, behavior: 'smooth' });
    render();
  }

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => setView(tab.dataset.view));
  });

  /* ------------------------------------------------------------------ */
  /* Reloj                                                               */
  /* ------------------------------------------------------------------ */

  function tickClock() {
    setText('clock', hora.format(new Date()));
  }
  tickClock();
  setInterval(tickClock, 1000);

  /* ------------------------------------------------------------------ */
  /* Conexión                                                           */
  /* ------------------------------------------------------------------ */

  function renderConnection(mode) {
    const dot = $('connDot');
    const label = $('connLabel');
    dot.className = 'dot';
    if (mode === 'live') {
      dot.classList.add('dot-live');
      label.textContent = 'En vivo';
    } else if (mode === 'demo') {
      dot.classList.add('dot-demo');
      label.textContent = 'Demo';
    } else {
      dot.classList.add('dot-stale');
      label.textContent = 'Sin datos';
    }
  }

  /* ------------------------------------------------------------------ */
  /* Render principal                                                    */
  /* ------------------------------------------------------------------ */

  function render() {
    const data = state.data;
    if (!data) return;
    state.config = data.config || state.config;
    renderConnection(data.mode);
    renderDashboard(data.vehicle, data.mode);
    if (state.view === 'trips') renderTrips();
    if (state.view === 'map') renderMap();
    // No re-renderizar los ajustes mientras el usuario escribe en un campo.
    if (state.view === 'settings') {
      const editing = document.activeElement && document.activeElement.closest && document.activeElement.closest('#view-settings input');
      if (!editing) renderSettings();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Tablero                                                            */
  /* ------------------------------------------------------------------ */

  function renderDashboard(v, mode) {
    const ring = $('socRing');
    const banner = $('dashboardBanner');

    if (!v) {
      ring.style.strokeDashoffset = RING_CIRCUNFERENCIA;
      ring.style.stroke = 'var(--muted)';
      $('socValue').innerHTML = '—';
      ['rangeValue', 'odoValue', 'consumptionValue', 'powerValue', 'speedValue', 'batteryTempValue', 'batteryTempRow', 'cabinTempValue', 'outsideTempValue', 'v12Value', 'hvCurrentValue', 'hvacValue', 'chargingRow', 'tireFl', 'tireFr', 'tireRl', 'tireRr'].forEach((id) => setText(id, '—'));
      setText('sohChip', 'Sin datos');
      setText('chargeBadge', 'Sin datos');
      $('chargeBadge').className = 'badge';
      setText('modeNote', 'Conecta BYDMate para ver datos reales');
      setText('updatedValue', '—');
      banner.hidden = false;
      banner.className = 'banner';
      banner.textContent = 'No hay telemetría. Activa el webhook de BYDMate o el modo demostración en Ajustes.';
      return;
    }

    const soc = Math.max(0, Math.min(100, Number(v.soc ?? 0)));
    const offset = RING_CIRCUNFERENCIA * (1 - soc / 100);
    ring.style.strokeDashoffset = offset;
    ring.style.stroke = soc <= 20 ? 'var(--danger)' : soc <= 40 ? 'var(--warn)' : 'var(--accent)';
    $('socValue').innerHTML = `${Math.round(soc)}<span>%</span>`;

    setText('rangeValue', fmt0(v.rangeKm));
    setText('odoValue', `${fmt0(v.odometerKm)} km`);
    setText('consumptionValue', fmt1(v.consumption));
    setText('powerValue', fmt1(v.powerKw));
    setText('speedValue', fmt0(v.speedKmh));
    setText('batteryTempValue', fmt1(v.batteryTempC));
    setText('batteryTempRow', `${fmt1(v.batteryTempC)} °C`);
    setText('cabinTempValue', `${fmt1(v.cabinTempC)} °C`);
    setText('outsideTempValue', `${fmt1(v.outsideTempC)} °C`);
    setText('v12Value', v.hvVoltage != null ? `${fmt1(v.hvVoltage)} V` : v.voltage12v != null ? `${fmt1(v.voltage12v)} V` : '—');
    setText('hvCurrentValue', v.hvCurrent != null ? `${fmt1(v.hvCurrent)} A` : '—');
    setText('hvacValue', v.hvacSetpoint != null ? `${fmt1(v.hvacSetpoint)} °C` : '—');

    const charging = Boolean(v.charging);
    const moving = v.isParked === true ? false : Number(v.speedKmh || 0) > 1;
    const badge = $('chargeBadge');
    badge.className = 'badge';
    if (charging) {
      badge.classList.add('badge-charging');
      badge.textContent = v.isDcfc ? 'Carga DC' : 'Cargando';
    } else if (moving) {
      badge.classList.add('badge-driving');
      badge.textContent = 'En marcha';
    } else {
      badge.textContent = 'En reposo';
    }

    let chargeText = 'Parqueado';
    if (charging) {
      chargeText = v.isDcfc ? 'Carga DC' : 'Carga AC';
      if (v.kwhCharged != null) chargeText += ` · ${fmt1(v.kwhCharged)} kWh`;
    } else if (moving) {
      chargeText = 'En marcha';
    }
    setText('chargingRow', chargeText);

    setText('sohChip', v.soh != null ? `SoH ${fmt1(v.soh)} %` : 'SoH —');

    setTire('tireFl', v.tireFl);
    setTire('tireFr', v.tireFr);
    setTire('tireRl', v.tireRl);
    setTire('tireRr', v.tireRr);

    const updated = v && mode !== 'stale' ? new Date(state.data.updatedAt) : null;
    setText('updatedValue', updated ? hora.format(updated) : '—');
    setText('modeNote', mode === 'live' ? 'Datos en vivo desde BYDMate' : mode === 'demo' ? 'Datos de demostración' : 'Sin datos recientes');

    const subtitle = document.querySelector('.brand-text p');
    if (subtitle) subtitle.textContent = v.carModel ? `${v.carModel} · Colombia` : 'Panel de monitoreo · Colombia';

    if (mode === 'live') {
      banner.hidden = false;
      banner.className = 'banner is-live';
      banner.textContent = 'Telemetría en vivo. Los valores se actualizan con el webhook de BYDMate.';
    } else if (mode === 'stale') {
      banner.hidden = false;
      banner.className = 'banner';
      banner.textContent = 'Sin datos recientes. Revisa que BYDMate esté enviando el webhook y que el carro tenga Wi-Fi.';
    } else {
      banner.hidden = true;
    }

    if (state.view === 'dashboard') drawSpark();
  }

  function setTire(id, value) {
    const node = $(id);
    if (!node) return;
    node.textContent = fmt1(value);
    const parent = node.closest('.tire');
    if (!parent) return;
    parent.classList.remove('is-low', 'is-high');
    const n = Number(value);
    if (!Number.isFinite(n)) return;
    if (n < 2.2) parent.classList.add('is-low');
    if (n > 2.8) parent.classList.add('is-high');
  }

  /* ------------------------------------------------------------------ */
  /* Gráfico de consumo                                                  */
  /* ------------------------------------------------------------------ */

  function drawSpark() {
    const canvas = $('sparkCanvas');
    if (!canvas) return;
    const width = canvas.clientWidth || 600;
    const height = 120;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const history = (state.data && state.data.history) || [];
    const points = history.filter((p) => p.consumption != null).map((p) => Number(p.consumption));
    if (points.length < 2) {
      ctx.fillStyle = 'rgba(143, 163, 189, 0.7)';
      ctx.font = '13px "Segoe UI", system-ui, sans-serif';
      ctx.fillText('Sin datos suficientes todavía…', 4, height / 2);
      return;
    }

    const min = Math.min(...points) - 0.6;
    const max = Math.max(...points) + 0.6;
    const range = Math.max(0.8, max - min);
    const padX = 6;
    const padY = 14;
    const stepX = (width - padX * 2) / (points.length - 1);
    const yFor = (value) => padY + (1 - (value - min) / range) * (height - padY * 2);

    ctx.strokeStyle = 'rgba(143, 163, 189, 0.12)';
    ctx.lineWidth = 1;
    for (let i = 1; i <= 3; i += 1) {
      const y = padY + ((height - padY * 2) / 4) * i;
      ctx.beginPath();
      ctx.moveTo(padX, y);
      ctx.lineTo(width - padX, y);
      ctx.stroke();
    }

    ctx.beginPath();
    points.forEach((value, index) => {
      const x = padX + index * stepX;
      const y = yFor(value);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });

    const gradient = ctx.createLinearGradient(0, padY, 0, height);
    gradient.addColorStop(0, 'rgba(0, 209, 178, 0.28)');
    gradient.addColorStop(1, 'rgba(0, 209, 178, 0)');

    ctx.lineTo(width - padX, height - padY);
    ctx.lineTo(padX, height - padY);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.beginPath();
    points.forEach((value, index) => {
      const x = padX + index * stepX;
      const y = yFor(value);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#00d1b2';
    ctx.lineWidth = 2.2;
    ctx.lineJoin = 'round';
    ctx.stroke();

    const lastX = padX + (points.length - 1) * stepX;
    const lastY = yFor(points[points.length - 1]);
    ctx.beginPath();
    ctx.arc(lastX, lastY, 3.6, 0, Math.PI * 2);
    ctx.fillStyle = '#00d1b2';
    ctx.fill();

    ctx.fillStyle = 'rgba(232, 238, 247, 0.92)';
    ctx.font = '600 13px "Segoe UI", system-ui, sans-serif';
    ctx.fillText(`${nf1.format(points[points.length - 1])} kWh/100 km`, padX, 12);
  }

  window.addEventListener('resize', () => {
    if (state.view === 'dashboard') drawSpark();
    if (state.map) state.map.invalidateSize();
  });

  /* ------------------------------------------------------------------ */
  /* Viajes                                                             */
  /* ------------------------------------------------------------------ */

  function renderTrips() {
    const data = state.data;
    if (!data) return;
    const current = $('currentTripCard');
    const list = $('tripsList');
    list.innerHTML = '';
    current.innerHTML = '';
    current.hidden = true;

    if (data.currentTrip) {
      const t = data.currentTrip;
      current.hidden = false;
      current.appendChild(el('h3', '', 'Viaje en curso'));
      const stats = el('div', 'trip-stats');
      stats.appendChild(tripStat('Distancia', `${fmt1(t.distanceKm)} km`));
      stats.appendChild(tripStat('Consumo', `${fmt1(t.consumption)} kWh/100`));
      stats.appendChild(tripStat('Costo', money.format(t.costCop || 0)));
      current.appendChild(stats);
      if (t.points && t.points.length > 1) {
        const actions = el('div', 'trip-actions');
        const btn = el('button', '', 'Ver en mapa');
        btn.type = 'button';
        btn.addEventListener('click', () => showTripOnMap({ points: t.points, from: 'Origen', to: 'Ahora' }));
        actions.appendChild(btn);
        current.appendChild(actions);
      }
    }

    const trips = data.trips || [];
    if (!trips.length) {
      const empty = el('div', 'empty');
      empty.textContent =
        data.mode === 'live'
          ? 'Aún no hay viajes cerrados. El viaje en curso aparece arriba cuando el carro se mueve.'
          : 'No hay viajes registrados. Activa el modo demostración en Ajustes para ver ejemplos.';
      list.appendChild(empty);
      return;
    }

    trips.forEach((trip) => list.appendChild(tripCard(trip)));
  }

  function tripStat(label, value) {
    const box = el('div', 'trip-stat');
    box.appendChild(el('span', '', label));
    box.appendChild(el('strong', '', value));
    return box;
  }

  function tripCard(trip) {
    const card = el('article', 'card trip');
    const head = el('div', 'trip-head');
    const route = el('div', 'trip-route');
    route.appendChild(el('strong', '', `${trip.from || 'Origen'} → ${trip.to || 'Destino'}`));
    route.appendChild(el('span', '', `${fecha.format(new Date(trip.start))} · ${hora.format(new Date(trip.start))}`));
    head.appendChild(route);
    head.appendChild(el('span', 'chip', `${fmt0(trip.distanceKm)} km`));
    card.appendChild(head);

    const stats = el('div', 'trip-stats');
    stats.appendChild(tripStat('Distancia', `${fmt1(trip.distanceKm)} km`));
    stats.appendChild(tripStat('Consumo', `${fmt1(trip.consumption)} kWh/100`));
    stats.appendChild(tripStat('Costo', money.format(trip.costCop || 0)));
    card.appendChild(stats);

    const actions = el('div', 'trip-actions');
    const btn = el('button', '', 'Ver en mapa');
    btn.type = 'button';
    btn.addEventListener('click', () => showTripOnMap(trip));
    actions.appendChild(btn);
    card.appendChild(actions);

    return card;
  }

  /* ------------------------------------------------------------------ */
  /* Mapa                                                               */
  /* ------------------------------------------------------------------ */

  function ensureMap() {
    if (state.mapReady) return;
    if (typeof L === 'undefined') {
      setText('mapStatus', 'No se pudo cargar el mapa (revisa la conexión).');
      return;
    }
    const map = L.map('map', { zoomControl: false, attributionControl: true }).setView([4.6486, -74.0624], 12);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap &copy; CARTO',
      subdomains: 'abcd',
      maxZoom: 20,
    }).addTo(map);
    L.control.zoom({ position: 'bottomleft' }).addTo(map);

    const icon = L.divIcon({
      className: 'car-marker',
      html: '<div class="car-dot"></div>',
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    });

    state.map = map;
    state.carMarker = L.marker([4.6486, -74.0624], { icon }).addTo(map);
    state.tripLayer = L.layerGroup().addTo(map);
    state.mapReady = true;

    $('centerBtn').addEventListener('click', () => {
      const v = state.data && state.data.vehicle;
      if (v && v.lat != null && v.lon != null) map.setView([v.lat, v.lon], 14);
      else map.setView([4.6486, -74.0624], 12);
    });

    setTimeout(() => map.invalidateSize(), 60);
  }

  function renderMap() {
    ensureMap();
    if (!state.mapReady) return;
    const data = state.data;
    const v = data && data.vehicle;
    const status = $('mapStatus');

    if (!v || v.lat == null || v.lon == null) {
      status.textContent = data && data.mode === 'live' ? 'Sin coordenadas: actívalas en BYDMate' : 'Ubicación de demostración';
      return;
    }

    const latlng = [Number(v.lat), Number(v.lon)];
    if (Number.isFinite(latlng[0]) && Number.isFinite(latlng[1])) {
      state.carMarker.setLatLng(latlng);
      status.textContent = data.mode === 'live' ? 'En vivo' : 'Demostración';
    }
  }

  function showTripOnMap(trip) {
    setView('map');
    setTimeout(() => {
      ensureMap();
      if (!state.mapReady || !trip || !trip.points || trip.points.length < 2) return;
      state.tripLayer.clearLayers();
      const latlngs = trip.points.map((p) => [Number(p[0]), Number(p[1])]).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
      if (latlngs.length < 2) return;
      const line = L.polyline(latlngs, { color: '#3b82f6', weight: 5, opacity: 0.9 }).addTo(state.tripLayer);
      L.circleMarker(latlngs[0], { radius: 6, color: '#00d1b2', fillColor: '#00d1b2', fillOpacity: 1 }).addTo(state.tripLayer);
      L.circleMarker(latlngs[latlngs.length - 1], { radius: 6, color: '#ffb020', fillColor: '#ffb020', fillOpacity: 1 }).addTo(state.tripLayer);
      state.map.fitBounds(line.getBounds(), { padding: [40, 40] });
      setText('mapStatus', `${trip.from || 'Origen'} → ${trip.to || 'Destino'}`);
    }, 120);
  }

  /* ------------------------------------------------------------------ */
  /* Radio                                                              */
  /* ------------------------------------------------------------------ */

  async function loadRadio() {
    state.radioLoaded = true;
    setText('radioStatus', 'Cargando emisoras…');
    try {
      const data = await api('/api/radio');
      state.stations = data.stations || [];
      renderRadioList('');
      setText(
        'radioStatus',
        state.stations.length ? `${state.stations.length} emisoras disponibles` : 'No se encontraron emisoras.'
      );
      $('radioRetry').hidden = true;
    } catch (err) {
      state.radioLoaded = false;
      setText('radioStatus', 'No se pudo cargar la lista de emisoras. Revisa la conexión y toca Reintentar.');
      $('radioRetry').hidden = false;
    }
  }

  function renderRadioList(filter) {
    const list = $('radioList');
    list.innerHTML = '';
    const needle = filter.trim().toLowerCase();
    const items = state.stations.filter((s) => !needle || s.name.toLowerCase().includes(needle) || (s.tags || '').toLowerCase().includes(needle));

    if (!items.length) {
      list.appendChild(el('div', 'empty', 'No hay emisoras que coincidan.'));
      return;
    }

    items.forEach((station) => {
      const btn = el('button', 'station');
      btn.type = 'button';
      if (state.station && state.station.id === station.id) btn.classList.add('is-playing');

      const img = el('img', 'station-favicon');
      img.alt = '';
      img.loading = 'lazy';
      if (station.favicon) img.src = station.favicon;
      img.addEventListener('error', () => {
        img.remove();
      });

      const body = el('div', 'station-body');
      body.appendChild(el('strong', '', station.name));
      body.appendChild(el('span', '', [station.tags, station.bitrate ? `${station.bitrate} kbps` : ''].filter(Boolean).join(' · ') || 'Colombia'));

      btn.appendChild(img);
      btn.appendChild(body);
      if (station.codec) btn.appendChild(el('span', 'station-badge', station.codec));
      btn.addEventListener('click', () => playStation(station));
      list.appendChild(btn);
    });
  }

  function playStation(station) {
    state.station = station;
    state.audio.src = station.url;
    state.audio.play().then(() => {
      state.playing = true;
      updatePlayer();
      setText('radioStatus', 'Reproduciendo…');
      renderRadioList($('radioSearch').value);
    }).catch(() => {
      state.playing = false;
      updatePlayer();
      setText('radioStatus', 'No se pudo reproducir esta emisora. Prueba otra.');
    });
  }

  function updatePlayer() {
    const station = state.station;
    setText('playerName', station ? station.name : 'Selecciona una emisora');
    setText('playerMeta', station ? [station.tags, station.bitrate ? `${station.bitrate} kbps` : ''].filter(Boolean).join(' · ') || 'Colombia' : '—');
    $('playBtn').textContent = state.playing ? '❚❚' : '▶';
    $('playBtn').setAttribute('aria-label', state.playing ? 'Pausar' : 'Reproducir');
  }

  function togglePlay() {
    if (!state.station) {
      toast('Selecciona una emisora primero.');
      return;
    }
    if (state.playing) {
      state.audio.pause();
      state.playing = false;
    } else {
      state.audio.play().then(() => {
        state.playing = true;
        updatePlayer();
      }).catch(() => {
        setText('radioStatus', 'No se pudo reanudar. Prueba otra emisora.');
      });
    }
    updatePlayer();
  }

  $('playBtn').addEventListener('click', togglePlay);

  $('volSlider').addEventListener('input', (event) => {
    state.audio.volume = Number(event.target.value);
  });

  $('radioSearch').addEventListener('input', (event) => renderRadioList(event.target.value));

  $('radioRetry').addEventListener('click', () => {
    $('radioRetry').hidden = true;
    loadRadio();
  });

  state.audio.addEventListener('playing', () => {
    state.playing = true;
    updatePlayer();
  });

  state.audio.addEventListener('pause', () => {
    state.playing = false;
    updatePlayer();
  });

  state.audio.addEventListener('error', () => {
    state.playing = false;
    updatePlayer();
    setText('radioStatus', 'La emisora no responde. Prueba otra.');
  });

  /* ------------------------------------------------------------------ */
  /* Ajustes                                                            */
  /* ------------------------------------------------------------------ */

  function renderSettings() {
    const config = state.config || (state.data && state.data.config);
    if (!config) return;
    $('capacityInput').value = config.capacityKwh ?? 60.5;
    $('tariffInput').value = config.tariffCop ?? 750;
    $('demoToggle').checked = Boolean(config.demo);
    const url = `${location.origin}/api/webhook`;
    setText('webhookUrl', url);

    const webhook = state.data && state.data.webhook;
    let statusText =
      webhook && webhook.count
        ? `Recibidos ${webhook.count} envíos. Último: ${webhook.lastAt ? hora.format(new Date(webhook.lastAt)) : '—'}`
        : 'Todavía no se ha recibido telemetría.';
    if (['localhost', '127.0.0.1'].includes(location.hostname)) {
      statusText += ' Abre esta página con la IP de la red (192.168.x.x) para que el carro pueda enviar el webhook.';
    }
    setText('webhookStatus', statusText);
  }

  $('saveSettings').addEventListener('click', async () => {
    const payload = {
      capacityKwh: Number($('capacityInput').value),
      tariffCop: Number($('tariffInput').value),
      demo: $('demoToggle').checked,
    };
    try {
      await api('/api/config', { method: 'PUT', body: JSON.stringify(payload) });
      toast('Ajustes guardados.');
      await refresh();
    } catch (err) {
      toast('No se pudieron guardar los ajustes.');
    }
  });

  $('copyWebhook').addEventListener('click', async () => {
    const text = `${location.origin}/api/webhook`;
    try {
      await navigator.clipboard.writeText(text);
      toast('URL copiada.');
    } catch {
      const input = document.createElement('input');
      input.value = text;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      input.remove();
      toast('URL copiada.');
    }
  });

  /* ------------------------------------------------------------------ */
  /* Ciclo de datos                                                     */
  /* ------------------------------------------------------------------ */

  async function refresh() {
    try {
      const data = await api('/api/state');
      state.data = data;
      render();
    } catch (err) {
      renderConnection('stale');
      setText('connLabel', 'Sin conexión');
      const banner = $('dashboardBanner');
      if (banner) {
        banner.hidden = false;
        banner.className = 'banner';
        banner.textContent =
          'Sin conexión con el servidor. Estás viendo una copia guardada; la radio y los viajes no van a cargar hasta que entres desde una dirección que funcione.';
      }
    }
  }

  refresh();
  setInterval(refresh, 3000);

  /* ------------------------------------------------------------------ */
  /* Asistente de voz                                                   */
  /* ------------------------------------------------------------------ */

  const voice = {
    supported: Boolean(window.SpeechRecognition || window.webkitSpeechRecognition),
    recognition: null,
    listening: false,
    gotResult: false,
    panelOpen: false,
    voice: null,
  };

  function normalizeText(value) {
    return String(value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[¿?¡!.,;:]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function secureVoiceContext() {
    return window.isSecureContext || ['localhost', '127.0.0.1'].includes(location.hostname);
  }

  function loadSpanishVoice() {
    if (!('speechSynthesis' in window)) return;
    const voices = window.speechSynthesis.getVoices();
    voice.voice =
      voices.find((item) => /^es[-_]CO/i.test(item.lang)) ||
      voices.find((item) => /^es/i.test(item.lang)) ||
      null;
  }

  loadSpanishVoice();
  if ('speechSynthesis' in window) window.speechSynthesis.onvoiceschanged = loadSpanishVoice;

  function speak(text) {
    if (!text || !('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'es-CO';
      utterance.rate = 1.02;
      utterance.pitch = 1;
      if (voice.voice) utterance.voice = voice.voice;
      window.speechSynthesis.speak(utterance);
    } catch (err) {
      /* sin voz disponible */
    }
  }

  function setVoiceStatus(text) {
    setText('voiceStatus', text);
  }

  function setVoiceResponse(text) {
    setText('voiceResponse', text);
  }

  function showTranscript(text) {
    setText('voiceTranscript', text ? `“${text}”` : '');
  }

  function openVoicePanel() {
    $('voicePanel').classList.add('is-open');
    $('voiceBtn').setAttribute('aria-expanded', 'true');
    voice.panelOpen = true;
    if (!voice.supported) {
      setVoiceStatus('Este navegador no soporta voz. Escribe el comando abajo.');
    } else if (!secureVoiceContext()) {
      setVoiceStatus('El micrófono necesita HTTPS. Escribe el comando abajo o abre la versión publicada.');
    } else {
      setVoiceStatus('Toca el micrófono y habla en español.');
    }
  }

  function closeVoicePanel() {
    $('voicePanel').classList.remove('is-open');
    $('voiceBtn').setAttribute('aria-expanded', 'false');
    voice.panelOpen = false;
    try {
      if (voice.recognition) voice.recognition.abort();
    } catch (err) {
      /* ignore */
    }
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  }

  async function startListening() {
    if (!voice.supported) {
      setVoiceStatus('Este navegador no soporta voz. Escribe el comando abajo.');
      $('voiceInput').focus();
      return;
    }
    if (!secureVoiceContext()) {
      setVoiceStatus('El micrófono necesita HTTPS. Escribe el comando abajo o abre la versión publicada.');
      $('voiceInput').focus();
      return;
    }
    if (voice.listening) return;

    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((track) => track.stop());
      } catch (err) {
        setVoiceStatus('Permiso de micrófono denegado. Actívalo en el candado de la barra de direcciones.');
        return;
      }
    }

    try {
      voice.gotResult = false;
      voice.recognition.lang = 'es-CO';
      voice.recognition.start();
    } catch (err) {
      setVoiceStatus('No se pudo iniciar el micrófono. Intenta otra vez.');
    }
  }

  function buildRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    const recognition = new SpeechRecognition();
    recognition.lang = 'es-CO';
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      voice.listening = true;
      $('voiceBtn').classList.add('is-listening');
      setVoiceStatus('Escuchando…');
      setVoiceResponse('');
    };

    recognition.onresult = (event) => {
      let finalText = '';
      let interimText = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const piece = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalText += piece;
        else interimText += piece;
      }
      if (interimText) setVoiceStatus(`Escuchando: “${interimText.trim()}”`);
      if (finalText) {
        voice.gotResult = true;
        recognition.stop();
        handleVoiceCommand(finalText);
      }
    };

    recognition.onerror = (event) => {
      voice.gotResult = true;
      const messages = {
        'not-allowed': 'Permiso de micrófono denegado. Actívalo en el candado de la barra de direcciones.',
        'service-not-allowed': 'El navegador bloqueó el micrófono. Usa Chrome o la versión HTTPS.',
        'no-speech': 'No escuché nada. Intenta de nuevo.',
        'audio-capture': 'No encontré micrófono en este dispositivo.',
        network: 'Sin internet para reconocer la voz.',
        aborted: '',
      };
      if (event.error !== 'aborted') {
        setVoiceStatus(messages[event.error] || 'No pude escuchar. Intenta de nuevo.');
      }
    };

    recognition.onend = () => {
      voice.listening = false;
      $('voiceBtn').classList.remove('is-listening');
      if (!voice.gotResult) setVoiceStatus('No escuché nada. Toca el micrófono e intenta otra vez.');
    };

    voice.recognition = recognition;
  }

  buildRecognition();

  async function playStationByName(query) {
    if (!state.stations.length) await loadRadio();
    const wanted = normalizeText(query);
    if (!wanted) return null;
    const station =
      state.stations.find((item) => normalizeText(item.name) === wanted) ||
      state.stations.find((item) => normalizeText(item.name).includes(wanted)) ||
      state.stations.find((item) => wanted.split(' ').every((word) => normalizeText(item.name).includes(word)));
    if (!station) return null;
    setView('radio');
    playStation(station);
    return station.name;
  }

  function sayBattery(v, prefix) {
    const parts = [];
    if (v.soc != null) parts.push(`tienes ${Math.round(Number(v.soc))} por ciento de carga`);
    if (v.rangeKm != null) parts.push(`autonomía ${fmt0(v.rangeKm)} kilómetros`);
    if (v.charging) parts.push(v.isDcfc ? 'está cargando en corriente directa' : 'está cargando');
    if (!parts.length) return 'No tengo el estado de la batería todavía.';
    const sentence = `${parts.join(', ')}.`;
    return prefix + sentence.charAt(0).toUpperCase() + sentence.slice(1);
  }

  function sayTires(v, prefix) {
    const items = [
      ['delantera izquierda', v.tireFl],
      ['delantera derecha', v.tireFr],
      ['trasera izquierda', v.tireRl],
      ['trasera derecha', v.tireRr],
    ].filter(([, value]) => value != null);
    if (!items.length) return 'No tengo la presión de las llantas todavía.';
    return `${prefix}${items.map(([name, value]) => `${name} ${fmt1(value)}`).join(', ')} bar.`;
  }

  function sayTemps(v, prefix) {
    const parts = [];
    if (v.batteryTempC != null) parts.push(`batería ${fmt1(v.batteryTempC)}`);
    if (v.cabinTempC != null) parts.push(`cabina ${fmt1(v.cabinTempC)}`);
    if (v.outsideTempC != null) parts.push(`exterior ${fmt1(v.outsideTempC)}`);
    if (!parts.length) return 'No tengo temperaturas todavía.';
    return `${prefix}${parts.join(', ')} grados.`;
  }

  function saySummary(v, prefix) {
    const parts = [];
    if (v.soc != null) parts.push(`${Math.round(Number(v.soc))} por ciento de carga`);
    if (v.rangeKm != null) parts.push(`${fmt0(v.rangeKm)} kilómetros de autonomía`);
    if (v.batteryTempC != null) parts.push(`batería a ${fmt1(v.batteryTempC)} grados`);
    const tires = [v.tireFl, v.tireFr, v.tireRl, v.tireRr].filter((value) => value != null);
    if (tires.length) parts.push(`llantas entre ${fmt1(Math.min(...tires))} y ${fmt1(Math.max(...tires))} bar`);
    parts.push(v.charging ? (v.isDcfc ? 'está cargando en corriente directa' : 'está cargando') : 'está parqueado');
    return `${prefix}${parts.join(', ')}.`;
  }

  async function respondToCommand(raw) {
    const t = normalizeText(raw);
    const v = state.data && state.data.vehicle;
    const demo = state.data && state.data.mode === 'demo';
    const prefix = demo ? 'En demostración: ' : '';

    if (!t) return 'No entendí. Intenta de nuevo.';

    if (/(ayuda|comandos|que puedes|que sabes)/.test(t)) {
      return 'Puedes preguntar por batería, autonomía, llantas, temperatura, carga, velocidad, odómetro o salud de la batería. También puedes decir: abre el mapa, abre la radio, pon La Mega, sube el volumen o lee todo.';
    }

    if (t.includes('mapa')) {
      setView('map');
      return 'Abriendo el mapa.';
    }
    if (t.includes('donde') || t.includes('ubicacion')) {
      setView('map');
      return 'Te muestro la ubicación en el mapa.';
    }
    if (t.includes('viaje')) {
      setView('trips');
      return 'Abriendo viajes.';
    }
    if (t.includes('ajuste') || t.includes('configuracion')) {
      setView('settings');
      return 'Abriendo ajustes.';
    }
    if (t.includes('tablero') || t.includes('inicio') || t.includes('principal')) {
      setView('dashboard');
      return 'Volviendo al tablero.';
    }

    if (/(ventana|seguro|puerta|baul|maletero|espejo)/.test(t)) {
      return 'Todavía no puedo controlar eso desde la app. Hazlo desde BYDMate o con los botones del carro.';
    }
    if (t.includes('aire acondicionado') || t.includes('prende el aire') || t.includes('pon el aire')) {
      return v && v.hvacSetpoint != null
        ? `Todavía no puedo controlar el clima desde aquí. El clima está en ${fmt1(v.hvacSetpoint)} grados.`
        : 'Todavía no puedo controlar el clima desde aquí.';
    }

    const stationMatch = t.match(/(?:pon|reproduce|busca|sintoniza)\s+(?:la\s+|el\s+)?(.+)/);
    if (stationMatch) {
      const query = stationMatch[1].trim();
      if (query && query !== 'radio') {
        const name = await playStationByName(query);
        if (name) return `Reproduciendo ${name.split('(')[0].trim()}.`;
        return `No encontré la emisora ${query}. Di abre la radio para ver la lista.`;
      }
    }

    if (t.includes('radio')) {
      setView('radio');
      if (!state.radioLoaded) loadRadio();
      return 'Abriendo la radio.';
    }
    if (t.includes('pausa') || t.includes('deten la musica') || t.includes('para la musica')) {
      state.audio.pause();
      state.playing = false;
      updatePlayer();
      return 'Música en pausa.';
    }
    if (t.includes('reanuda') || t.includes('sigue la musica') || t.includes('play')) {
      state.audio
        .play()
        .then(() => {
          state.playing = true;
          updatePlayer();
        })
        .catch(() => {});
      return 'Reanudando la música.';
    }
    if (t.includes('volumen')) {
      const up = t.includes('sube') || t.includes('aumenta') || t.includes('mas');
      const down = t.includes('baja') || t.includes('disminuye') || t.includes('menos');
      if (up || down) {
        state.audio.volume = Math.max(0, Math.min(1, state.audio.volume + (up ? 0.15 : -0.15)));
        const slider = $('volSlider');
        if (slider) slider.value = state.audio.volume;
        return up ? 'Subí el volumen.' : 'Bajé el volumen.';
      }
      return `El volumen está en ${Math.round(state.audio.volume * 100)} por ciento.`;
    }
    if (t.includes('silencio') || t.includes('callate') || t.includes('calla')) {
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
      return '';
    }
    if (t.includes('cierra sesion') || t.includes('cerrar sesion')) {
      location.href = '/logout';
      return 'Cerrando sesión.';
    }
    if (t.includes('actualiza') || t.includes('recarga')) {
      await refresh();
      return 'Información actualizada.';
    }

    if (!v) return 'Todavía no tengo datos del carro. Revisa que BYDMate esté enviando el webhook.';

    if (t.includes('cargando') || t.includes('cargar') || t.includes('cargador')) {
      if (!v.charging) return 'No, no está cargando.';
      let message = `Sí, está cargando${v.isDcfc ? ' en corriente directa' : ''}`;
      if (v.kwhCharged != null) message += `, lleva ${fmt1(v.kwhCharged)} kilovatios hora`;
      return message + '.';
    }
    if (t.includes('bateria') || t.includes('carga') || t.includes('soc')) return sayBattery(v, prefix);
    if (t.includes('autonomia') || t.includes('rango') || t.includes('alcance')) {
      return `${prefix}La autonomía estimada es ${fmt0(v.rangeKm)} kilómetros.`;
    }
    if (t.includes('consumo')) {
      return `${prefix}El consumo es ${fmt1(v.consumption)} kilovatios hora por cada 100 kilómetros.`;
    }
    if (t.includes('llanta') || t.includes('presion') || t.includes('neumatico')) return sayTires(v, prefix);
    if (t.includes('temperatura') || t.includes('grados') || t.includes('calor')) return sayTemps(v, prefix);
    if (t.includes('velocidad') || t.includes('rapido')) {
      return Number(v.speedKmh) > 1
        ? `${prefix}Vas a ${fmt0(v.speedKmh)} kilómetros por hora.`
        : 'El carro está parqueado.';
    }
    if (t.includes('odometro') || t.includes('kilometraje') || t.includes('kilometros')) {
      return `${prefix}El odómetro marca ${fmt0(v.odometerKm)} kilómetros.`;
    }
    if (t.includes('salud') || t.includes('soh')) {
      return `${prefix}La salud de la batería es ${fmt1(v.soh)} por ciento.`;
    }
    if (t.includes('voltaje') || t.includes('corriente')) {
      return `${prefix}Voltaje ${fmt1(v.hvVoltage)} voltios, corriente ${fmt1(v.hvCurrent)} amperios.`;
    }
    if (t.includes('clima') || t.includes('aire') || t.includes('setpoint')) {
      return `${prefix}El clima está en ${fmt1(v.hvacSetpoint)} grados.`;
    }
    if (t.includes('modelo') || t.includes('que carro')) {
      return `Es un ${v.carModel || 'BYD Yuan Plus'}.`;
    }
    if (t.includes('hora')) return `Son las ${hora.format(new Date())}.`;
    if (t.includes('resumen') || t.includes('lee todo') || t.includes('estado') || t.includes('como esta')) {
      return saySummary(v, prefix);
    }

    return 'No entendí. Puedes decir: batería, autonomía, llantas, temperatura, abre el mapa, abre la radio o pon La Mega.';
  }

  async function handleVoiceCommand(raw) {
    const text = String(raw || '').trim();
    if (!text) return;
    showTranscript(text);
    setVoiceStatus('Procesando…');
    try {
      const reply = await respondToCommand(text);
      if (reply) {
        setVoiceResponse(reply);
        setVoiceStatus('Listo. Puedes hablar otra vez.');
        speak(reply);
      } else {
        setVoiceResponse('');
        setVoiceStatus('Listo.');
      }
    } catch (err) {
      setVoiceResponse('No pude procesar el comando.');
      setVoiceStatus('Ocurrió un error.');
    }
  }

  $('voiceBtn').addEventListener('click', () => {
    if (!voice.panelOpen) openVoicePanel();
    if (!voice.supported || !secureVoiceContext()) {
      $('voiceInput').focus();
      return;
    }
    if (voice.listening) {
      try {
        voice.recognition.stop();
      } catch (err) {
        /* ignore */
      }
      return;
    }
    startListening();
  });

  $('voiceClose').addEventListener('click', closeVoicePanel);

  $('voiceForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const value = $('voiceInput').value.trim();
    if (!value) return;
    $('voiceInput').value = '';
    handleVoiceCommand(value);
  });

  document.querySelectorAll('.voice-examples [data-cmd]').forEach((button) => {
    button.addEventListener('click', () => handleVoiceCommand(button.dataset.cmd));
  });

  /* ------------------------------------------------------------------ */
  /* PWA                                                                */
  /* ------------------------------------------------------------------ */

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }
})();
