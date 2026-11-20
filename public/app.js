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
  const mesCorto = new Intl.DateTimeFormat('es-CO', { month: 'short' });

  const RING_CIRCUNFERENCIA = 2 * Math.PI * 88;

  const state = {
    data: null,
    config: null,
    view: 'dashboard',
    map: null,
    carMarker: null,
    tripLayer: null,
    userMarker: null,
    userLocation: null,
    mapCentered: false,
    mapReady: false,
    stations: [],
    station: null,
    radioLoaded: false,
    audio: new Audio(),
    playing: false,
    toastTimer: null,
    tripsTab: 'trips',
    commandLang: 'en',
    commandWake: true,
    commandSearch: '',
    music: {
      tracks: [],
      index: -1,
      audio: new Audio(),
      playing: false,
      loaded: false,
      loading: false,
    },
  };

  state.audio.preload = 'none';
  state.audio.volume = 0.8;
  state.music.audio.preload = 'metadata';
  state.music.audio.volume = 0.8;

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
    if (name === 'multimedia' && !state.music.loaded) loadMusic();
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
    if (state.view === 'commands') updateCommandsStatus();
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
      ['rangeValue', 'odoValue', 'consumptionValue', 'powerValue', 'speedValue', 'batteryTempValue', 'batteryTempRow', 'cabinTempValue', 'outsideTempValue', 'energyValue', 'capacityValue', 'hvVoltageValue', 'v12Value', 'hvCurrentValue', 'hvacValue', 'chargingRow', 'tireFl', 'tireFr', 'tireRl', 'tireRr', 'sohValue'].forEach((id) => setText(id, '—'));
      setText('sohChip', 'Sin datos');
      setText('cockpitModel', 'EV · — kWh');
      const emptyOrb = $('sohOrb');
      if (emptyOrb) emptyOrb.style.setProperty('--soh', '0');
      const emptySocOrb = document.querySelector('.soc-orb');
      if (emptySocOrb) emptySocOrb.style.setProperty('--soc', '0');
      const emptySocArc = document.querySelector('.soc-arc');
      if (emptySocArc) emptySocArc.style.background = 'none';
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
    const socOrb = ring.closest('.soc-orb') || document.querySelector('.soc-orb');
    if (socOrb) socOrb.style.setProperty('--soc', String(soc));
    const socArc = document.querySelector('.soc-arc');
    if (socArc) {
      socArc.style.background = `conic-gradient(from -90deg, var(--accent) 0 ${soc}%, rgba(110, 231, 255, 0.07) ${soc}% 100%)`;
    }
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
    setText('hvVoltageValue', v.hvVoltage != null ? `${fmt1(v.hvVoltage)} V` : '—');
    setText('v12Value', v.voltage12v != null ? `${fmt1(v.voltage12v)} V` : '—');
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
    const soh = Number(v.soh);
    if (Number.isFinite(soh)) {
      setText('sohValue', fmt1(soh));
      const orb = $('sohOrb');
      if (orb) orb.style.setProperty('--soh', String(Math.max(0, Math.min(100, soh))));
    } else {
      setText('sohValue', '—');
      const orb = $('sohOrb');
      if (orb) orb.style.setProperty('--soh', '0');
    }
    const capacity = v.capacity != null ? Number(v.capacity) : state.config && Number(state.config.capacityKwh) ? Number(state.config.capacityKwh) : 60.5;
    setText('energyValue', `${fmt1((soc / 100) * capacity)} kWh`);
    setText('capacityValue', `${fmt1(capacity)} kWh`);
    setText('cockpitModel', `${v.carModel ? String(v.carModel).toUpperCase() : 'YUAN PLUS'} · ${fmt1(capacity)} kWh`);

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

    if (state.view === 'dashboard') {
      drawSpark();
      drawPowerChart();
    }
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
    const height = canvas.clientHeight || 150;
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
    gradient.addColorStop(0, 'rgba(0, 240, 255, 0.3)');
    gradient.addColorStop(1, 'rgba(0, 240, 255, 0)');

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
    ctx.strokeStyle = '#00f0ff';
    ctx.lineWidth = 2.2;
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(0, 240, 255, 0.65)';
    ctx.shadowBlur = 10;
    ctx.stroke();
    ctx.shadowBlur = 0;

    const lastX = padX + (points.length - 1) * stepX;
    const lastY = yFor(points[points.length - 1]);
    ctx.beginPath();
    ctx.arc(lastX, lastY, 3.6, 0, Math.PI * 2);
    ctx.fillStyle = '#00f0ff';
    ctx.fill();

    ctx.fillStyle = 'rgba(223, 251, 255, 0.95)';
    ctx.font = '600 13px "Bahnschrift", "Segoe UI", system-ui, sans-serif';
    ctx.fillText(`${nf1.format(points[points.length - 1])} kWh/100 km`, padX, 12);
  }

  function drawPowerChart() {
    const canvas = $('powerCanvas');
    if (!canvas) return;
    const width = canvas.clientWidth || 600;
    const height = canvas.clientHeight || 200;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const history = ((state.data && state.data.history) || []).slice(-90);
    const points = history.map((sample) => ({
      power: Number.isFinite(Number(sample.powerKw)) ? Number(sample.powerKw) : null,
      speed: Number.isFinite(Number(sample.speedKmh)) ? Number(sample.speedKmh) : null,
    }));

    if (points.length < 2) {
      ctx.fillStyle = 'rgba(127, 155, 181, 0.75)';
      ctx.font = '13px "Bahnschrift", "Segoe UI", system-ui, sans-serif';
      ctx.fillText('Sin datos suficientes todavía…', 8, height / 2);
      return;
    }

    const powerValues = points.map((point) => point.power).filter((value) => value !== null);
    const speedValues = points.map((point) => point.speed).filter((value) => value !== null);
    const maxPower = Math.max(5, ...powerValues.map((value) => Math.abs(value)));
    const maxSpeed = Math.max(10, ...speedValues);
    const padX = 8;
    const padY = 20;
    const stepX = (width - padX * 2) / Math.max(1, points.length - 1);
    const zeroY = height / 2;
    const powerY = (value) => zeroY - (value / maxPower) * (height / 2 - padY);
    const speedY = (value) => height - padY - (value / maxSpeed) * (height - padY * 2);

    ctx.strokeStyle = 'rgba(110, 231, 255, 0.1)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 4; i += 1) {
      const y = padY + ((height - padY * 2) / 3) * i;
      ctx.beginPath();
      ctx.moveTo(padX, y);
      ctx.lineTo(width - padX, y);
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(110, 231, 255, 0.2)';
    ctx.setLineDash([4, 6]);
    ctx.beginPath();
    ctx.moveTo(padX, zeroY);
    ctx.lineTo(width - padX, zeroY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Área de potencia
    ctx.beginPath();
    let started = false;
    points.forEach((point, index) => {
      if (point.power === null) return;
      const x = padX + index * stepX;
      const y = powerY(point.power);
      if (!started) {
        ctx.moveTo(x, zeroY);
        ctx.lineTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    });
    if (started) {
      const lastIndex = points.reduce((acc, point, index) => (point.power !== null ? index : acc), 0);
      ctx.lineTo(padX + lastIndex * stepX, zeroY);
      ctx.closePath();
      const powerFill = ctx.createLinearGradient(0, padY, 0, height - padY);
      powerFill.addColorStop(0, 'rgba(0, 240, 255, 0.34)');
      powerFill.addColorStop(0.55, 'rgba(0, 240, 255, 0.08)');
      powerFill.addColorStop(1, 'rgba(0, 240, 255, 0)');
      ctx.fillStyle = powerFill;
      ctx.fill();
    }

    // Línea de potencia
    ctx.beginPath();
    started = false;
    points.forEach((point, index) => {
      if (point.power === null) return;
      const x = padX + index * stepX;
      const y = powerY(point.power);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.strokeStyle = '#00f0ff';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(0, 240, 255, 0.55)';
    ctx.shadowBlur = 10;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Línea de velocidad
    ctx.beginPath();
    started = false;
    points.forEach((point, index) => {
      if (point.speed === null) return;
      const x = padX + index * stepX;
      const y = speedY(point.speed);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.strokeStyle = '#8b5cf6';
    ctx.lineWidth = 1.8;
    ctx.setLineDash([7, 5]);
    ctx.stroke();
    ctx.setLineDash([]);

    const lastPower = [...powerValues].pop();
    const lastSpeed = [...speedValues].pop();
    ctx.font = '600 11px "Bahnschrift", "Segoe UI", system-ui, sans-serif';
    if (lastPower !== undefined) {
      ctx.fillStyle = '#80f7ff';
      ctx.fillText(`${nf1.format(lastPower)} kW`, padX, 12);
    }
    if (lastSpeed !== undefined) {
      ctx.fillStyle = '#c4b5fd';
      ctx.textAlign = 'right';
      ctx.fillText(`${nf0.format(lastSpeed)} km/h`, width - padX, 12);
      ctx.textAlign = 'left';
    }
  }

  window.addEventListener('resize', () => {
    if (state.view === 'dashboard') {
      drawSpark();
      drawPowerChart();
    }
    if (state.map) state.map.invalidateSize();
  });

  /* ------------------------------------------------------------------ */
  /* Viajes                                                             */
  /* ------------------------------------------------------------------ */

  function renderTrips() {
    const data = state.data;
    if (!data) return;
    const trips = data.trips || [];
    const charges = data.charges || [];
    const current = $('currentTripCard');
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
    }

    const imported = Boolean(data.importedAt) && trips.some((trip) => trip.source === 'bydmate');
    setText(
      'tripsSource',
      imported
        ? `Importado de BYDMate${data.importedAt ? ` · ${fecha.format(new Date(data.importedAt))}` : ''}`
        : data.mode === 'demo'
          ? 'Datos de ejemplo · importa tu backup para ver los reales'
          : 'Sin viajes registrados'
    );
    setText(
      'importedNote',
      data.importedAt ? `Actualizado ${fecha.format(new Date(data.importedAt))} · ${hora.format(new Date(data.importedAt))}` : ''
    );
    setText('tripCount', trips.length);
    setText('chargeCount', charges.length);

    renderTripsSummary(trips, charges);
    renderTripsTimeline(trips);
    renderChargesList(charges);
    applyTripsTab();
  }

  function tripStat(label, value) {
    const box = el('div', 'trip-stat');
    box.appendChild(el('span', '', label));
    box.appendChild(el('strong', '', value));
    return box;
  }

  function tripKwh(trip) {
    if (trip.kwh != null) return Number(trip.kwh);
    if (Number(trip.distanceKm) > 0 && trip.consumption != null) {
      return (Number(trip.distanceKm) * Number(trip.consumption)) / 100;
    }
    return null;
  }

  function tripDuration(trip) {
    if (trip.durationMin != null) return Number(trip.durationMin);
    if (trip.start && trip.end) {
      const minutes = (new Date(trip.end).getTime() - new Date(trip.start).getTime()) / 60000;
      return Number.isFinite(minutes) && minutes >= 0 ? Math.round(minutes) : null;
    }
    return null;
  }

  function renderTripsSummary(trips, charges) {
    const km = trips.reduce((sum, trip) => sum + Number(trip.distanceKm || 0), 0);
    const kwh = trips.reduce((sum, trip) => sum + Number(tripKwh(trip) || 0), 0);
    const cost = trips.reduce((sum, trip) => sum + Number(trip.costCop || 0), 0);
    let consumption = km > 0 ? (kwh / km) * 100 : null;
    if (consumption == null) {
      const values = trips.map((trip) => Number(trip.consumption)).filter((value) => Number.isFinite(value) && value > 0);
      if (values.length) consumption = values.reduce((a, b) => a + b, 0) / values.length;
    }

    setText('sumKm', fmt0(km));
    setText('sumKwh', fmt1(kwh));
    setText('sumCons', consumption != null ? fmt1(consumption) : '—');
    setText('sumCost', money.format(cost));
    setText('orbValue', consumption != null ? fmt1(consumption) : '—');

    const orb = $('consOrb');
    if (orb) {
      const pct = consumption != null ? Math.max(4, Math.min(100, (consumption / 30) * 100)) : 0;
      orb.style.setProperty('--pct', `${pct}%`);
    }

    renderMonthBars(trips);
  }

  function renderMonthBars(trips) {
    const wrap = $('monthBars');
    if (!wrap) return;
    wrap.innerHTML = '';
    const now = new Date();
    const months = [];
    for (let i = 5; i >= 0; i -= 1) {
      const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({ key: `${date.getFullYear()}-${date.getMonth()}`, label: mesCorto.format(date) });
    }
    const totals = new Map(months.map((month) => [month.key, 0]));
    for (const trip of trips) {
      if (!trip.start) continue;
      const date = new Date(trip.start);
      if (Number.isNaN(date.getTime())) continue;
      const key = `${date.getFullYear()}-${date.getMonth()}`;
      if (totals.has(key)) totals.set(key, totals.get(key) + Number(trip.distanceKm || 0));
    }
    const max = Math.max(1, ...totals.values());
    for (const month of months) {
      const value = totals.get(month.key);
      const bar = el('div', 'month-bar');
      bar.appendChild(el('span', 'month-bar-value', value > 0 ? fmt0(value) : ''));
      const track = el('div', 'month-bar-track');
      const fill = el('div', 'month-bar-fill');
      fill.style.height = `${Math.max(4, (value / max) * 100)}%`;
      track.appendChild(fill);
      bar.appendChild(track);
      bar.appendChild(el('span', 'month-bar-label', month.label));
      wrap.appendChild(bar);
    }
  }

  function renderTripsTimeline(trips) {
    const panel = $('tripsPanel');
    if (!panel) return;
    panel.innerHTML = '';
    if (!trips.length) {
      panel.appendChild(
        emptyState(
          'Todavía no hay viajes',
          'Importa el backup de BYDMate para llenar esta línea de tiempo con tus recorridos reales.',
          'Importar backup'
        )
      );
      return;
    }
    for (const trip of trips) panel.appendChild(tripTimelineItem(trip));
  }

  function tripTimelineItem(trip) {
    const item = el('div', 'timeline-item');
    item.appendChild(el('span', 'timeline-dot'));
    const card = el('article', 'trip-card futuristic');

    const head = el('div', 'trip-card-head');
    const left = el('div', 'trip-card-title');
    left.appendChild(el('span', 'eyebrow', trip.source === 'bydmate' ? 'BYDMate' : trip.from ? 'Viaje' : 'Registro'));
    const date = trip.start ? `${fecha.format(new Date(trip.start))} · ${hora.format(new Date(trip.start))}` : 'Sin fecha';
    left.appendChild(el('strong', 'trip-date', date));
    head.appendChild(left);
    head.appendChild(el('span', 'trip-km', `${fmt1(trip.distanceKm)} km`));
    card.appendChild(head);

    if (trip.from || trip.to) {
      card.appendChild(el('p', 'trip-route-text', `${trip.from || 'Origen'} → ${trip.to || 'Destino'}`));
    }

    const grid = el('div', 'trip-metrics');
    const kwh = tripKwh(trip);
    grid.appendChild(metric('Consumo', Number(trip.distanceKm) > 0 && trip.consumption != null ? `${fmt1(trip.consumption)} kWh/100` : '—'));
    grid.appendChild(metric('Energía', kwh != null ? `${fmt1(kwh)} kWh` : '—'));
    grid.appendChild(metric('Costo', trip.costCop != null ? money.format(trip.costCop) : '—'));
    if (trip.socStart != null && trip.socEnd != null) {
      grid.appendChild(metric('SOC', `${trip.socStart}% → ${trip.socEnd}%`));
    }
    if (trip.avgSpeedKmh != null) grid.appendChild(metric('Vel. media', `${fmt0(trip.avgSpeedKmh)} km/h`));
    if (trip.batteryTempC != null) grid.appendChild(metric('Temp. batería', `${fmt1(trip.batteryTempC)} °C`));
    const duration = tripDuration(trip);
    if (duration != null) grid.appendChild(metric('Duración', `${fmt0(duration)} min`));
    card.appendChild(grid);

    if (trip.points && trip.points.length > 1) {
      const button = el('button', 'trip-map-btn', 'Ver recorrido');
      button.type = 'button';
      button.addEventListener('click', () => showTripOnMap(trip));
      card.appendChild(button);
    }

    item.appendChild(card);
    return item;
  }

  function metric(label, value) {
    const box = el('div', 'metric');
    box.appendChild(el('span', '', label));
    box.appendChild(el('strong', '', value));
    return box;
  }

  function renderChargesList(charges) {
    const panel = $('chargesPanel');
    if (!panel) return;
    panel.innerHTML = '';
    if (!charges.length) {
      panel.appendChild(
        emptyState('No hay cargas todavía', 'El backup de BYDMate también trae las sesiones de carga AC y DC.', 'Importar backup')
      );
      return;
    }
    for (const charge of charges) panel.appendChild(chargeCard(charge));
  }

  function chargeCard(charge) {
    const card = el('article', 'charge-card futuristic');
    const head = el('div', 'trip-card-head');
    const left = el('div', 'trip-card-title');
    left.appendChild(el('span', 'eyebrow', charge.type ? `Carga ${charge.type}` : 'Carga'));
    left.appendChild(
      el('strong', 'trip-date', charge.start ? `${fecha.format(new Date(charge.start))} · ${hora.format(new Date(charge.start))}` : 'Sin fecha')
    );
    head.appendChild(left);
    head.appendChild(el('span', 'charge-badge', charge.type || '—'));
    card.appendChild(head);

    const start = Math.max(0, Math.min(100, Number(charge.socStart ?? 0)));
    const end = Math.max(start, Math.min(100, Number(charge.socEnd ?? start)));
    const bar = el('div', 'charge-bar');
    const fill = el('div', 'charge-bar-fill');
    fill.style.left = `${start}%`;
    fill.style.width = `${Math.max(2, end - start)}%`;
    bar.appendChild(fill);
    card.appendChild(bar);
    card.appendChild(el('div', 'charge-soc', `${charge.socStart ?? '—'}% → ${charge.socEnd ?? '—'}%`));

    const grid = el('div', 'trip-metrics');
    grid.appendChild(metric('Energía', charge.kwh != null ? `${fmt1(charge.kwh)} kWh` : '—'));
    grid.appendChild(metric('Potencia máx.', charge.maxPowerKw != null ? `${fmt1(charge.maxPowerKw)} kW` : '—'));
    grid.appendChild(metric('Costo', charge.costCop != null ? money.format(charge.costCop) : '—'));
    if (charge.batteryTempC != null) grid.appendChild(metric('Temp. batería', `${fmt1(charge.batteryTempC)} °C`));
    card.appendChild(grid);
    return card;
  }

  function emptyState(title, text, cta) {
    const box = el('div', 'futuristic-empty');
    box.appendChild(el('strong', '', title));
    box.appendChild(el('p', '', text));
    if (cta) {
      const button = el('button', 'import-btn', cta);
      button.type = 'button';
      button.dataset.import = '1';
      box.appendChild(button);
    }
    return box;
  }

  function applyTripsTab() {
    const tab = state.tripsTab || 'trips';
    document.querySelectorAll('[data-trips-tab]').forEach((button) => {
      button.classList.toggle('is-active', button.dataset.tripsTab === tab);
    });
    const tripsPanel = $('tripsPanel');
    const chargesPanel = $('chargesPanel');
    if (tripsPanel) tripsPanel.hidden = tab !== 'trips';
    if (chargesPanel) chargesPanel.hidden = tab !== 'charges';
  }

  function setupTripsUI() {
    document.querySelectorAll('[data-trips-tab]').forEach((button) => {
      button.addEventListener('click', () => {
        state.tripsTab = button.dataset.tripsTab;
        applyTripsTab();
      });
    });

    const modal = $('importModal');
    const open = () => {
      modal.hidden = false;
      setText('importStatus', '');
    };
    const close = () => {
      modal.hidden = true;
    };

    document.addEventListener('click', (event) => {
      const trigger = event.target.closest('[data-import]');
      if (trigger) {
        event.preventDefault();
        open();
      }
    });
    $('importClose').addEventListener('click', close);
    modal.addEventListener('click', (event) => {
      if (event.target === modal) close();
    });

    const drop = $('importDrop');
    const fileInput = $('importFile');
    drop.addEventListener('click', () => fileInput.click());
    drop.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        fileInput.click();
      }
    });
    ['dragenter', 'dragover'].forEach((name) => {
      drop.addEventListener(name, (event) => {
        event.preventDefault();
        drop.classList.add('is-dragover');
      });
    });
    ['dragleave', 'drop'].forEach((name) => {
      drop.addEventListener(name, (event) => {
        event.preventDefault();
        drop.classList.remove('is-dragover');
      });
    });
    drop.addEventListener('drop', (event) => {
      const file = event.dataTransfer.files[0];
      if (file) uploadBackup(file);
    });
    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      if (file) uploadBackup(file);
      fileInput.value = '';
    });
  }

  async function uploadBackup(file) {
    if (!file) return;
    if (!/\.zip$/i.test(file.name)) {
      setText('importStatus', 'Selecciona el archivo .zip del backup de BYDMate.');
      return;
    }
    setText('importStatus', 'Subiendo backup…');
    try {
      const response = await fetch('/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/zip' },
        body: file,
      });
      const result = await response.json().catch(() => ({}));
      if (response.status === 401) {
        setText('importStatus', 'La sesión venció. Recarga la página y vuelve a entrar.');
        return;
      }
      if (!response.ok) throw new Error(result.error || 'No se pudo importar.');
      setText('importStatus', `Listo: ${result.trips} viajes y ${result.charges} cargas importadas.`);
      toast(`Importados ${result.trips} viajes y ${result.charges} cargas.`);
      await refresh();
      state.tripsTab = 'trips';
      applyTripsTab();
      setTimeout(() => {
        $('importModal').hidden = true;
      }, 1400);
    } catch (err) {
      setText('importStatus', `Error: ${err.message}`);
    }
  }

  setupTripsUI();

  /* ------------------------------------------------------------------ */
  /* Mapa                                                               */
  /* ------------------------------------------------------------------ */

  const MAP_DEFAULT = [6.2442, -75.5812];

  function ensureMap() {
    if (state.mapReady) return;
    if (typeof L === 'undefined') {
      setText('mapStatus', 'No se pudo cargar el mapa (revisa la conexión).');
      return;
    }
    const map = L.map('map', { zoomControl: false, attributionControl: true }).setView(MAP_DEFAULT, 12);
    const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    });
    const carto = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap &copy; CARTO',
      subdomains: 'abcd',
      maxZoom: 20,
    });
    osm.addTo(map);
    L.control.layers({ Mapa: osm, Oscuro: carto }, null, { position: 'topright' }).addTo(map);
    L.control.zoom({ position: 'bottomleft' }).addTo(map);

    const icon = L.divIcon({
      className: 'car-marker',
      html: '<div class="car-dot"></div>',
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    });

    state.map = map;
    state.carMarker = L.marker(MAP_DEFAULT, { icon }).addTo(map);
    state.tripLayer = L.layerGroup().addTo(map);
    state.mapReady = true;

    $('centerBtn').addEventListener('click', () => {
      const v = state.data && state.data.vehicle;
      if (v && v.lat != null && v.lon != null) map.setView([v.lat, v.lon], 15);
      else if (state.userLocation) map.setView([state.userLocation.lat, state.userLocation.lon], 15);
      else map.setView(MAP_DEFAULT, 12);
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
      if (state.userLocation) status.textContent = 'Tu ubicación (celular)';
      else if (data && data.mode === 'live') status.textContent = 'Sin coordenadas: actívalas en BYDMate';
      else status.textContent = 'Sin datos del carro todavía';
      return;
    }

    const latlng = [Number(v.lat), Number(v.lon)];
    if (Number.isFinite(latlng[0]) && Number.isFinite(latlng[1])) {
      state.carMarker.setLatLng(latlng);
      if (data.mode === 'live' && !state.mapCentered) {
        state.map.setView(latlng, 15);
        state.mapCentered = true;
      }
      status.textContent = data.mode === 'live' ? 'En vivo' : 'Demostración';
    }
  }

  function locateUser() {
    if (!navigator.geolocation) {
      toast('Este navegador no tiene GPS disponible.');
      setText('mapStatus', 'Sin GPS disponible');
      return;
    }
    ensureMap();
    if (!state.mapReady) return;
    setText('mapStatus', 'Buscando tu ubicación…');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const lat = position.coords.latitude;
        const lon = position.coords.longitude;
        state.userLocation = { lat, lon };
        const latlng = [lat, lon];
        if (state.userMarker) state.userMarker.setLatLng(latlng);
        else {
          state.userMarker = L.circleMarker(latlng, {
            radius: 8,
            color: '#3b82f6',
            fillColor: '#3b82f6',
            fillOpacity: 1,
            weight: 3,
          }).addTo(state.map);
        }
        state.map.setView(latlng, 15);
        setText('mapStatus', `Tu ubicación: ${lat.toFixed(4)}, ${lon.toFixed(4)}`);
        toast('Mapa centrado en tu ubicación.');
      },
      (error) => {
        const message =
          error && error.code === 1
            ? 'Permiso de ubicación denegado. Actívalo en Chrome.'
            : 'No se pudo obtener tu ubicación.';
        setText('mapStatus', message);
        toast(message);
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
    );
  }

  const geoBtn = $('geoBtn');
  if (geoBtn) geoBtn.addEventListener('click', locateUser);

  const gmapsBtn = $('gmapsBtn');
  if (gmapsBtn) {
    gmapsBtn.addEventListener('click', () => {
      const vehicle = state.data && state.data.vehicle;
      let point = null;
      if (vehicle && vehicle.lat != null && vehicle.lon != null) point = [vehicle.lat, vehicle.lon];
      else if (state.userLocation) point = [state.userLocation.lat, state.userLocation.lon];
      if (point) {
        window.open(`https://www.google.com/maps?q=${point[0]},${point[1]}`, '_blank', 'noopener');
      } else {
        toast('Todavía no tengo una ubicación. Toca “Mi ubicación”.');
      }
    });
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

  function stationParts(name) {
    const raw = String(name || '').trim();
    let brand = raw.split(/[\(,\-–|]/)[0].trim().replace(/\s+/g, ' ');
    if (!brand) brand = raw;
    let city = '';
    const match = raw.match(/\(([^)]+)\)/);
    if (match) {
      const first = match[1].split(',')[0].trim();
      const looksLikeCity =
        first &&
        first.length <= 24 &&
        !/\d|fm|am|mhz|khz|hz|señal|senal|emisora/i.test(first) &&
        !/^[A-Z]{3,5}$/.test(first);
      if (looksLikeCity) city = first;
    }
    return { brand, city };
  }

  function stationInitials(brand) {
    const words = String(brand || '').split(/\s+/).filter(Boolean);
    if (words.length >= 2) return `${words[0][0]}${words[1][0]}`.toUpperCase();
    return String(brand || '?').slice(0, 2).toUpperCase();
  }

  function stationHue(name) {
    let hash = 0;
    for (const char of String(name || '')) hash = (hash * 31 + char.charCodeAt(0)) % 360;
    return hash;
  }

  function stationGradient(brand) {
    const hue = stationHue(brand);
    return `linear-gradient(135deg, hsl(${hue} 72% 42%), hsl(${(hue + 45) % 360} 70% 26%))`;
  }

  function renderRadioList(filter) {
    const list = $('radioList');
    list.innerHTML = '';
    const needle = filter.trim().toLowerCase();
    const items = state.stations.filter(
      (station) =>
        !needle ||
        station.name.toLowerCase().includes(needle) ||
        (station.tags || '').toLowerCase().includes(needle)
    );

    if (!items.length) {
      list.appendChild(el('div', 'empty', 'No hay emisoras que coincidan.'));
      return;
    }

    items.forEach((station) => {
      const { brand, city } = stationParts(station.name);
      const playing = Boolean(state.station && state.station.id === station.id);
      const card = el('button', 'station');
      card.type = 'button';
      if (playing) card.classList.add('is-playing');

      const logo = el('div', 'station-logo');
      const fallback = el('span', 'station-fallback', stationInitials(brand));
      fallback.style.background = stationGradient(brand);
      logo.appendChild(fallback);

      if (station.favicon) {
        const img = el('img', 'station-logo-img');
        img.alt = '';
        img.loading = 'lazy';
        img.referrerPolicy = 'no-referrer';
        img.addEventListener('load', () => {
          fallback.hidden = true;
        });
        img.addEventListener('error', () => img.remove());
        img.src = station.favicon.replace(/^http:/i, 'https:');
        if (img.complete && img.naturalWidth > 0) fallback.hidden = true;
        logo.appendChild(img);
      }

      const body = el('div', 'station-body');
      body.appendChild(el('strong', 'station-name', brand));
      if (city) body.appendChild(el('span', 'station-city', city));

      const indicator = el('span', 'station-play');
      if (playing) {
        const eq = el('span', 'eq');
        eq.appendChild(el('i'));
        eq.appendChild(el('i'));
        eq.appendChild(el('i'));
        indicator.appendChild(eq);
      } else {
        indicator.textContent = '▶';
      }

      card.appendChild(logo);
      card.appendChild(body);
      card.appendChild(indicator);
      card.setAttribute('aria-label', `Reproducir ${brand}${city ? ` ${city}` : ''}`);
      card.addEventListener('click', () => playStation(station));
      list.appendChild(card);
    });
  }

  function playStation(station) {
    if (state.music.audio && !state.music.audio.paused) {
      state.music.audio.pause();
      state.music.playing = false;
      updateMusicUI();
      renderMusic();
    }
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
    const parts = station ? stationParts(station.name) : null;
    const name = station ? (parts.city ? `${parts.brand} · ${parts.city}` : parts.brand) : 'Selecciona una emisora';
    setText('playerName', name);
    setText(
      'playerMeta',
      station ? [station.tags, station.bitrate ? `${station.bitrate} kbps` : ''].filter(Boolean).join(' · ') || 'Colombia' : '—'
    );

    const logo = $('playerLogo');
    if (logo) {
      logo.innerHTML = '';
      const fallback = el('span', 'player-initials', station ? stationInitials(parts.brand) : '♪');
      fallback.style.background = station ? stationGradient(parts.brand) : 'linear-gradient(135deg, #1e2a3a, #0e1520)';
      logo.appendChild(fallback);
      if (station && station.favicon) {
        const img = el('img', 'player-logo-img');
        img.alt = '';
        img.referrerPolicy = 'no-referrer';
        img.addEventListener('load', () => {
          fallback.hidden = true;
        });
        img.addEventListener('error', () => img.remove());
        img.src = station.favicon.replace(/^http:/i, 'https:');
        if (img.complete && img.naturalWidth > 0) fallback.hidden = true;
        logo.appendChild(img);
      }
    }

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
      if (state.music.audio && !state.music.audio.paused) {
        state.music.audio.pause();
        state.music.playing = false;
        updateMusicUI();
        renderMusic();
      }
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
  /* Música local                                                       */
  /* ------------------------------------------------------------------ */

  function musicTime(value) {
    const seconds = Math.max(0, Math.floor(Number(value) || 0));
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
  }

  function musicBytes(value) {
    const bytes = Number(value) || 0;
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${bytes} B`;
  }

  function updateMusicUI() {
    const track = state.music.tracks[state.music.index];
    const audio = state.music.audio;
    setText('musicTitle', track ? track.title : 'Sin canción');
    setText('musicArtist', track ? track.artist : 'Biblioteca local');
    const cover = $('musicCover');
    if (cover) cover.textContent = track ? track.title.slice(0, 1).toUpperCase() : '♪';
    const play = $('musicPlay');
    if (play) {
      play.textContent = state.music.playing ? '❚❚' : '▶';
      play.setAttribute('aria-label', state.music.playing ? 'Pausar' : 'Reproducir');
    }
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    const current = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    setText('musicCurrent', musicTime(current));
    setText('musicDuration', musicTime(duration));
    const progress = $('musicProgress');
    if (progress) {
      progress.max = duration || 0;
      progress.value = current;
    }
  }

  function renderMusic() {
    const list = $('musicList');
    if (!list) return;
    list.innerHTML = '';
    const tracks = state.music.tracks || [];
    setText('musicCount', `${tracks.length} ${tracks.length === 1 ? 'canción' : 'canciones'}`);
    if (!tracks.length) {
      const empty = el('div', 'futuristic-empty music-empty');
      empty.appendChild(el('strong', '', 'La biblioteca está vacía'));
      empty.appendChild(el('p', '', 'Sube tus propios MP3 o descarga música libre de los catálogos legales.'));
      list.appendChild(empty);
      return;
    }

    tracks.forEach((track, index) => {
      const row = el('div', 'music-track');
      if (index === state.music.index) row.classList.add('is-active');
      row.appendChild(el('span', 'track-number', String(index + 1).padStart(2, '0')));
      const info = el('div', 'track-info');
      info.appendChild(el('strong', 'track-title', track.title));
      info.appendChild(el('span', 'track-meta', `${track.artist} · ${musicBytes(track.size)}`));
      row.appendChild(info);
      const play = el('button', 'track-play', index === state.music.index && state.music.playing ? '❚❚' : '▶');
      play.type = 'button';
      play.setAttribute('aria-label', `Reproducir ${track.title}`);
      play.addEventListener('click', () => {
        if (index === state.music.index) toggleMusic();
        else playMusic(index);
      });
      row.appendChild(play);
      const remove = el('button', 'track-delete', '×');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Eliminar ${track.title}`);
      remove.addEventListener('click', () => deleteMusic(track));
      row.appendChild(remove);
      list.appendChild(row);
    });
  }

  async function loadMusic(force = false) {
    if (state.music.loading && !force) return;
    state.music.loading = true;
    try {
      const data = await api('/api/music');
      state.music.tracks = Array.isArray(data.tracks) ? data.tracks : [];
      state.music.loaded = true;
      renderMusic();
      updateMusicUI();
    } catch {
      setText('musicStatus', 'No se pudo cargar la biblioteca. Revisa la sesión e inténtalo otra vez.');
    } finally {
      state.music.loading = false;
    }
  }

  async function playMusic(index) {
    const track = state.music.tracks[index];
    if (!track) return;
    if (state.playing) {
      state.audio.pause();
      state.playing = false;
      updatePlayer();
    }
    state.music.index = index;
    state.music.audio.src = track.url;
    try {
      await state.music.audio.play();
      state.music.playing = true;
      setText('musicStatus', `Reproduciendo ${track.title}.`);
      updateMusicUI();
      renderMusic();
    } catch {
      state.music.playing = false;
      setText('musicStatus', 'No se pudo reproducir. Revisa que el archivo sea de audio válido.');
      updateMusicUI();
    }
  }

  function nextMusic() {
    if (!state.music.tracks.length) return;
    const index = state.music.index < 0 ? 0 : (state.music.index + 1) % state.music.tracks.length;
    playMusic(index);
  }

  function previousMusic() {
    if (!state.music.tracks.length) return;
    const index = state.music.index <= 0 ? state.music.tracks.length - 1 : state.music.index - 1;
    playMusic(index);
  }

  function toggleMusic() {
    if (state.music.index < 0) {
      playMusic(0);
      return;
    }
    if (state.music.audio.paused) {
      state.music.audio.play().then(() => {
        state.music.playing = true;
        updateMusicUI();
        renderMusic();
      }).catch(() => setText('musicStatus', 'No se pudo reanudar la canción.'));
    } else {
      state.music.audio.pause();
      state.music.playing = false;
      updateMusicUI();
      renderMusic();
    }
  }

  async function uploadMusic(fileList) {
    const files = Array.from(fileList || []).filter((file) => file && file.size > 0);
    if (!files.length) {
      setText('musicUploadStatus', 'No se recibieron archivos. Usa “Elegir archivos MP3”.');
      return;
    }
    let latestTracks = null;
    let uploaded = 0;
    const failed = [];
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      setText('musicUploadStatus', `Subiendo ${i + 1} de ${files.length}: ${file.name}…`);
      if (file.size > 60 * 1024 * 1024) {
        failed.push(`${file.name}: supera 60 MB`);
        continue;
      }
      const extension = (file.name.split('.').pop() || '').toLowerCase();
      if (['webm', 'mp4', 'mkv', 'mov', 'avi'].includes(extension)) {
        failed.push(`${file.name}: es WebM/video, conviértelo a MP3`);
        continue;
      }
      try {
        const response = await fetch(`/api/music/upload?name=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          body: file,
        });
        const result = await response.json().catch(() => ({}));
        if (response.status === 401) {
          setText('musicUploadStatus', 'La sesión venció. Recarga la página y entra otra vez.');
          return;
        }
        if (!response.ok) throw new Error(result.error || 'No se pudo subir.');
        uploaded += 1;
        if (Array.isArray(result.tracks)) latestTracks = result.tracks;
      } catch (err) {
        failed.push(`${file.name}: ${err.message}`);
      }
    }
    if (latestTracks) {
      state.music.tracks = latestTracks;
      state.music.loaded = true;
      state.music.loading = false;
      renderMusic();
      updateMusicUI();
    } else if (uploaded === 0) {
      await loadMusic(true);
    }
    if (failed.length) {
      const detail = failed.slice(0, 3).join(' · ');
      setText('musicUploadStatus', `Subidas: ${uploaded}. Con error: ${failed.length} (${detail})${failed.length > 3 ? '…' : ''}`);
    } else {
      setText('musicUploadStatus', `Listo: ${state.music.tracks.length} canciones en la biblioteca.`);
    }
  }

  async function deleteMusic(track) {
    if (!track || !window.confirm(`¿Eliminar “${track.title}” del servidor?`)) return;
    try {
      const response = await fetch(`/api/music?name=${encodeURIComponent(track.name)}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('No se pudo eliminar.');
      if (state.music.index >= 0 && state.music.tracks[state.music.index]?.name === track.name) {
        state.music.audio.pause();
        state.music.audio.removeAttribute('src');
        state.music.index = -1;
        state.music.playing = false;
        updateMusicUI();
      }
      await loadMusic();
      setText('musicStatus', 'Canción eliminada.');
    } catch (err) {
      setText('musicStatus', err.message);
    }
  }

  function setupMusicUI() {
    const audio = state.music.audio;
    const play = $('musicPlay');
    if (play) play.addEventListener('click', toggleMusic);
    const prev = $('musicPrev');
    if (prev) prev.addEventListener('click', previousMusic);
    const next = $('musicNext');
    if (next) next.addEventListener('click', nextMusic);

    const progress = $('musicProgress');
    if (progress) {
      progress.addEventListener('input', () => {
        if (Number.isFinite(audio.duration)) audio.currentTime = Number(progress.value);
      });
    }
    const volume = $('musicVolume');
    if (volume) {
      volume.addEventListener('input', () => {
        audio.volume = Number(volume.value);
      });
    }

    const fileInput = $('musicFile');
    const drop = $('musicDrop');
    const pick = $('musicPickBtn');
    if (pick && fileInput) {
      pick.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          fileInput.click();
        }
      });
    }
    if (drop && fileInput) {
      drop.addEventListener('click', () => fileInput.click());
      drop.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          fileInput.click();
        }
      });
      ['dragenter', 'dragover'].forEach((name) => {
        drop.addEventListener(name, (event) => {
          event.preventDefault();
          drop.classList.add('is-dragover');
        });
      });
      ['dragleave', 'drop'].forEach((name) => {
        drop.addEventListener(name, (event) => {
          event.preventDefault();
          drop.classList.remove('is-dragover');
        });
      });
      drop.addEventListener('drop', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const files = event.dataTransfer && event.dataTransfer.files;
        if (!files || !files.length) {
          setText('musicUploadStatus', 'El navegador no entregó archivos. Usa “Elegir archivos MP3”.');
          return;
        }
        uploadMusic(files);
      });
      fileInput.addEventListener('change', () => {
        uploadMusic(fileInput.files);
        fileInput.value = '';
      });
    }

    // Evita que el navegador abra el archivo si se suelta fuera de la zona.
    window.addEventListener('dragover', (event) => event.preventDefault());
    window.addEventListener('drop', (event) => {
      if (event.target && event.target.closest && event.target.closest('#view-multimedia')) {
        event.preventDefault();
      }
    });

    audio.addEventListener('play', () => {
      state.music.playing = true;
      updateMusicUI();
    });
    audio.addEventListener('pause', () => {
      state.music.playing = false;
      updateMusicUI();
    });
    audio.addEventListener('ended', nextMusic);
    audio.addEventListener('loadedmetadata', updateMusicUI);
    audio.addEventListener('timeupdate', updateMusicUI);
    audio.addEventListener('error', () => {
      state.music.playing = false;
      updateMusicUI();
      setText('musicStatus', 'No se pudo reproducir este archivo.');
    });
  }

  setupMusicUI();

  /* ------------------------------------------------------------------ */
  /* Ajustes                                                            */
  /* ------------------------------------------------------------------ */

  function renderSettings() {
    const config = state.config || (state.data && state.data.config);
    if (!config) return;
    $('capacityInput').value = config.capacityKwh ?? 60.5;
    $('tariffInput').value = config.tariffCop ?? 750;
    $('consumptionInput').value = config.avgConsumption ?? 23.9;
    $('demoToggle').checked = Boolean(config.demo);
    const webhookPath = (state.data && state.data.webhookUrl) || '/api/webhook';
    const url = new URL(webhookPath, location.origin).href;
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
      avgConsumption: Number($('consumptionInput').value),
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
  /* Comandos por voz (experimental)                                     */
  /* ------------------------------------------------------------------ */

  const CAR_COMMANDS = [];
  function addCarCommands(category, items) {
    for (const [id, label, en, zh, icon] of items) {
      CAR_COMMANDS.push({ id, category, label, en, zh, icon });
    }
  }

  addCarCommands('Ventanas', [
    ['windows-open', 'Bajar todas', 'open all windows', '车窗全开', '⇅'],
    ['windows-close', 'Subir todas', 'close all windows', '车窗关闭', '⇵'],
    ['windows-half', 'Media altura', 'open the windows halfway', '车窗半开', '⇕'],
    ['windows-vent', 'Ventilar', 'ventilate the windows', '车窗通风', '≈'],
    ['windows-front-open', 'Delanteras abajo', 'open the front windows', '前排车窗全开', '⇈'],
    ['windows-front-close', 'Delanteras arriba', 'close the front windows', '前排车窗关闭', '⇊'],
    ['windows-front-half', 'Delanteras media', 'open the front windows halfway', '前排车窗半开', '⇕'],
    ['windows-front-vent', 'Delanteras ventiladas', 'ventilate the front windows', '前排车窗通风', '≈'],
    ['windows-rear-open', 'Traseras abajo', 'open the rear windows', '后排车窗全开', '⇊'],
    ['windows-rear-close', 'Traseras arriba', 'close the rear windows', '后排车窗关闭', '⇈'],
    ['windows-rear-half', 'Traseras media', 'open the rear windows halfway', '后排车窗半开', '⇕'],
    ['windows-rear-vent', 'Traseras ventiladas', 'ventilate the rear windows', '后排车窗通风', '≈'],
    ['windows-driver-open', 'Conductor abajo', 'open the driver window', '主驾打开100', '⇊'],
    ['windows-driver-close', 'Conductor arriba', 'close the driver window', '主驾打开0', '⇈'],
    ['windows-driver-vent', 'Conductor ventilado', 'vent the driver window', '主驾通风', '≈'],
    ['windows-driver-half', 'Conductor media', 'open the driver window halfway', '主驾半开', '⇕'],
    ['windows-passenger-open', 'Copiloto abajo', 'open the passenger window', '副驾打开100', '⇊'],
    ['windows-passenger-close', 'Copiloto arriba', 'close the passenger window', '副驾打开0', '⇈'],
    ['windows-passenger-vent', 'Copiloto ventilado', 'vent the passenger window', '副驾通风', '≈'],
    ['windows-passenger-half', 'Copiloto media', 'open the passenger window halfway', '副驾半开', '⇕'],
    ['windows-rear-left-open', 'Trasera izquierda abajo', 'open the rear left window', '后左打开100', '⇊'],
    ['windows-rear-left-close', 'Trasera izquierda arriba', 'close the rear left window', '后左打开0', '⇈'],
    ['windows-rear-left-vent', 'Trasera izquierda ventilada', 'vent the rear left window', '后左通风', '≈'],
    ['windows-rear-left-half', 'Trasera izquierda media', 'open the rear left window halfway', '后左半开', '⇕'],
    ['windows-rear-right-open', 'Trasera derecha abajo', 'open the rear right window', '后右打开100', '⇊'],
    ['windows-rear-right-close', 'Trasera derecha arriba', 'close the rear right window', '后右打开0', '⇈'],
    ['windows-rear-right-vent', 'Trasera derecha ventilada', 'vent the rear right window', '后右通风', '≈'],
    ['windows-rear-right-half', 'Trasera derecha media', 'open the rear right window halfway', '后右半开', '⇕'],
  ]);

  addCarCommands('Clima', [
    ['ac-on', 'Aire automático', 'turn on the air conditioning', '自动空调', '❄'],
    ['ac-off', 'Apagar aire', 'turn off the air conditioning', '关闭空调', '⏻'],
    ['ac-auto-mode', 'Modo automático', 'set the air conditioning to auto', '空调自动', 'A'],
    ['ac-flow', 'Solo ventilación', 'turn on air ventilation', '打开空调通风', '≋'],
    ['fan-1', 'Ventilador 1', 'set the fan to level 1', '风量1', '1'],
    ['fan-3', 'Ventilador 3', 'set the fan to level 3', '风量3', '3'],
    ['fan-5', 'Ventilador 5', 'set the fan to level 5', '风量5', '5'],
    ['fan-7', 'Ventilador 7', 'set the fan to level 7', '风量7', '7'],
    ['temp-18', 'Temperatura 18°', 'set the temperature to 18 degrees', '设置温度18', '18'],
    ['temp-20', 'Temperatura 20°', 'set the temperature to 20 degrees', '设置温度20', '20'],
    ['temp-22', 'Temperatura 22°', 'set the temperature to 22 degrees', '设置温度22', '22'],
    ['temp-24', 'Temperatura 24°', 'set the temperature to 24 degrees', '设置温度24', '24'],
    ['temp-26', 'Temperatura 26°', 'set the temperature to 26 degrees', '设置温度26', '26'],
    ['temp-28', 'Temperatura 28°', 'set the temperature to 28 degrees', '设置温度28', '28'],
    ['recirc-inner', 'Recirculación', 'turn on inner recirculation', '内循环', '↻'],
    ['recirc-outer', 'Aire exterior', 'turn on outside air', '外循环', '↺'],
    ['defrost-on', 'Desempañar', 'defrost the windshield', '吹前挡', '♨'],
    ['defrost-off', 'Quitar desempañado', 'turn off windshield defrost', '关闭吹前挡', '○'],
    ['wind-face', 'Viento a la cara', 'blow air to the face', '吹面', '☝'],
    ['wind-face-feet', 'Cara y pies', 'blow air to face and feet', '吹面吹脚', '⇅'],
    ['wind-feet', 'Viento a los pies', 'blow air to the feet', '吹脚', '☟'],
    ['wind-feet-windshield', 'Pies y parabrisas', 'blow air to feet and windshield', '吹脚除霜', '≋'],
    ['wind-windshield', 'Solo parabrisas', 'blow air to the windshield', '除霜', '◇'],
  ]);

  addCarCommands('Asientos', [
    ['seat-driver-heat-1', 'Conductor calor 1', 'driver seat heat level 1', '主驾座椅加热1档', '♨'],
    ['seat-driver-heat-2', 'Conductor calor 2', 'driver seat heat level 2', '主驾座椅加热2档', '♨'],
    ['seat-driver-heat-3', 'Conductor calor 3', 'driver seat heat level 3', '主驾座椅加热3档', '♨'],
    ['seat-driver-heat-off', 'Conductor calor off', 'turn off driver seat heat', '主驾座椅加热关闭', '○'],
    ['seat-passenger-heat-1', 'Copiloto calor 1', 'passenger seat heat level 1', '副驾座椅加热1档', '♨'],
    ['seat-passenger-heat-2', 'Copiloto calor 2', 'passenger seat heat level 2', '副驾座椅加热2档', '♨'],
    ['seat-passenger-heat-3', 'Copiloto calor 3', 'passenger seat heat level 3', '副驾座椅加热3档', '♨'],
    ['seat-passenger-heat-off', 'Copiloto calor off', 'turn off passenger seat heat', '副驾座椅加热关闭', '○'],
    ['seat-driver-vent-1', 'Conductor ventilación 1', 'driver seat vent level 1', '主驾座椅通风1档', '≋'],
    ['seat-driver-vent-2', 'Conductor ventilación 2', 'driver seat vent level 2', '主驾座椅通风2档', '≋'],
    ['seat-driver-vent-3', 'Conductor ventilación 3', 'driver seat vent level 3', '主驾座椅通风3档', '≋'],
    ['seat-driver-vent-off', 'Conductor ventilación off', 'turn off driver seat vent', '主驾座椅通风关闭', '○'],
    ['seat-passenger-vent-1', 'Copiloto ventilación 1', 'passenger seat vent level 1', '副驾座椅通风1档', '≋'],
    ['seat-passenger-vent-2', 'Copiloto ventilación 2', 'passenger seat vent level 2', '副驾座椅通风2档', '≋'],
    ['seat-passenger-vent-3', 'Copiloto ventilación 3', 'passenger seat vent level 3', '副驾座椅通风3档', '≋'],
    ['seat-passenger-vent-off', 'Copiloto ventilación off', 'turn off passenger seat vent', '副驾座椅通风关闭', '○'],
  ]);

  addCarCommands('Luces y HUD', [
    ['ambient-on', 'Luz ambiental on', 'turn on ambient light', '氛围灯打开', '◐'],
    ['ambient-off', 'Luz ambiental off', 'turn off ambient light', '氛围灯关闭', '○'],
    ['drl-on', 'Luces diurnas on', 'turn on daytime lights', '打开日行灯', '☀'],
    ['drl-off', 'Luces diurnas off', 'turn off daytime lights', '关闭日行灯', '○'],
    ['interior-on', 'Luz interior on', 'turn on interior light', '打开车内灯', '💡'],
    ['interior-off', 'Luz interior off', 'turn off interior light', '关闭车内灯', '○'],
    ['hud-on', 'HUD on', 'turn on the head-up display', '打开抬头显示', 'H'],
    ['hud-off', 'HUD off', 'turn off the head-up display', '关闭抬头显示', '○'],
  ]);

  addCarCommands('Acceso', [
    ['lock', 'Bloquear puertas', 'lock the doors', '车门上锁', '🔒'],
    ['unlock', 'Desbloquear puertas', 'unlock the doors', '车门解锁', '🔓'],
    ['trunk-open', 'Abrir baúl', 'open the trunk', '开后备箱', '▤'],
    ['trunk-close', 'Cerrar baúl', 'close the trunk', '关后备箱', '▥'],
  ]);

  addCarCommands('Techo', [
    ['sunroof-open', 'Abrir techo', 'open the sunroof', '天窗打开100', '☀'],
    ['sunroof-half', 'Techo a la mitad', 'open the sunroof halfway', '天窗打开50', '◐'],
    ['sunroof-vent', 'Techo ventilación', 'tilt the sunroof for ventilation', '天窗通风', '≈'],
    ['sunroof-close', 'Cerrar techo', 'close the sunroof', '天窗打开0', '☁'],
    ['sunshade-open', 'Abrir cortina', 'open the sunshade', '遮阳帘打开', '▤'],
    ['sunshade-close', 'Cerrar cortina', 'close the sunshade', '遮阳帘关闭', '▥'],
  ]);

  addCarCommands('Espejos y volante', [
    ['mirror-heat-on', 'Calefacción espejos on', 'turn on mirror heating', '后视镜加热', '♨'],
    ['mirror-heat-off', 'Calefacción espejos off', 'turn off mirror heating', '关闭后视镜加热', '○'],
    ['steering-heat-on', 'Volante caliente on', 'turn on steering wheel heat', '方向盘加热', '♨'],
    ['steering-heat-off', 'Volante caliente off', 'turn off steering wheel heat', '关闭方向盘加热', '○'],
  ]);

  addCarCommands('Conducción', [
    ['drive-eco', 'Modo ECO', 'set ECO mode', 'ECO模式', 'E'],
    ['drive-normal', 'Modo normal', 'set normal mode', '普通模式', 'N'],
    ['drive-sport', 'Modo sport', 'set sport mode', '运动模式', 'S'],
    ['drive-snow', 'Modo nieve', 'set snow mode', '雪地模式', '❄'],
    ['drive-sand', 'Modo arena', 'set sand mode', '沙地模式', '≈'],
    ['drive-mud', 'Modo barro', 'set mud mode', '泥地模式', '◍'],
    ['drive-mountain', 'Modo montaña', 'set mountain mode', '山地模式', '△'],
    ['drive-smart', 'Modo inteligente', 'set smart mode', '智能模式', '✦'],
  ]);

  function commandSpeed() {
    const vehicle = state.data && state.data.vehicle;
    const raw = vehicle ? vehicle.speedKmh : null;
    if (raw === null || raw === undefined || raw === '') return null;
    const speed = Number(raw);
    return Number.isFinite(speed) ? speed : null;
  }

  function updateCommandsStatus() {
    const speed = commandSpeed();
    const moving = speed !== null && speed > 5;
    setText('commandsSpeed', `Velocidad: ${speed !== null ? fmt0(speed) : '—'} km/h`);
    const badge = $('commandsBlocked');
    if (badge) {
      badge.textContent = moving ? 'Bloqueado en movimiento' : 'Solo parqueado';
      badge.className = `badge ${moving ? 'badge-driving' : 'badge-charging'}`;
    }
    const list = $('commandsList');
    if (list) list.classList.toggle('is-blocked', moving);
  }

  function renderCommands() {
    const list = $('commandsList');
    if (!list) return;
    list.innerHTML = '';
    const needle = String(state.commandSearch || '').trim().toLowerCase();
    const items = CAR_COMMANDS.filter(
      (item) =>
        !needle ||
        item.label.toLowerCase().includes(needle) ||
        item.en.toLowerCase().includes(needle) ||
        item.zh.includes(needle) ||
        item.category.toLowerCase().includes(needle)
    );

    if (!items.length) {
      list.appendChild(el('div', 'futuristic-empty', 'No hay comandos que coincidan con la búsqueda.'));
      return;
    }

    const categories = [...new Set(items.map((item) => item.category))];
    for (const category of categories) {
      const group = el('div', 'commands-group');
      group.appendChild(el('h3', 'commands-group-title', category));
      const grid = el('div', 'commands-grid');
      for (const command of items.filter((item) => item.category === category)) {
        const card = el('button', 'command-card');
        card.type = 'button';
        card.dataset.command = command.id;
        card.appendChild(el('span', 'command-icon', command.icon));
        const body = el('span', 'command-body');
        body.appendChild(el('strong', '', command.label));
        body.appendChild(el('small', '', state.commandLang === 'zh' ? command.zh : command.en));
        card.appendChild(body);
        card.appendChild(el('span', 'command-play', '▶'));
        grid.appendChild(card);
      }
      group.appendChild(grid);
      list.appendChild(group);
    }
    updateCommandsStatus();
  }

  function voiceForCommand(lang) {
    if (!('speechSynthesis' in window)) return null;
    const prefix = lang === 'zh' ? 'zh' : 'en';
    return window.speechSynthesis.getVoices().find((voice) => voice.lang.toLowerCase().startsWith(prefix)) || null;
  }

  function makeCommandUtterance(text, lang) {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang === 'zh' ? 'zh-CN' : 'en-US';
    utterance.rate = 0.9;
    utterance.volume = 1;
    const voice = voiceForCommand(lang);
    if (voice) utterance.voice = voice;
    return { utterance, voice };
  }

  function speakCarPhrase(text, lang) {
    if (!('speechSynthesis' in window)) {
      setText('commandStatus', 'Este navegador no tiene voz. Prueba en Chrome.');
      return;
    }
    setText('commandPhrase', text);
    try {
      window.speechSynthesis.cancel();
      const { utterance, voice } = makeCommandUtterance(text, lang);
      utterance.onstart = () => setText('commandStatus', 'Reproduciendo la frase…');
      utterance.onend = () =>
        setText('commandStatus', 'Frase enviada. Si el asistente no responde, revisa que esté activo y escuchando.');
      utterance.onerror = () =>
        setText('commandStatus', 'No se pudo reproducir. Instala la voz del idioma en Android o usa English.');
      window.speechSynthesis.speak(utterance);
      if (!voice) {
        setText(
          'commandStatus',
          lang === 'zh'
            ? 'No hay voz china instalada; se intentará con la voz por defecto.'
            : 'No hay voz inglesa instalada; se intentará con la voz por defecto.'
        );
      }
    } catch {
      setText('commandStatus', 'No se pudo iniciar la voz.');
    }
  }

  function speakWakeThenCommand(wake, command, lang) {
    if (!('speechSynthesis' in window)) {
      setText('commandStatus', 'Este navegador no tiene voz. Prueba en Chrome.');
      return;
    }
    setText('commandPhrase', `${wake} ${command}`);
    setText('commandStatus', 'Despertando al asistente…');
    try {
      window.speechSynthesis.cancel();
      const { utterance: wakeUtterance } = makeCommandUtterance(wake, lang);
      wakeUtterance.onend = () => {
        setText('commandStatus', 'Esperando que el asistente escuche…');
        setTimeout(() => {
          const { utterance: commandUtterance } = makeCommandUtterance(command, lang);
          commandUtterance.onstart = () => setText('commandStatus', 'Enviando el comando…');
          commandUtterance.onend = () =>
            setText('commandStatus', 'Comando enviado. Si no responde, el asistente no está escuchando el audio.');
          commandUtterance.onerror = () => setText('commandStatus', 'No se pudo reproducir el comando.');
          window.speechSynthesis.speak(commandUtterance);
        }, 1600);
      };
      wakeUtterance.onerror = () => setText('commandStatus', 'No se pudo reproducir el wake word.');
      window.speechSynthesis.speak(wakeUtterance);
    } catch {
      setText('commandStatus', 'No se pudo iniciar la voz.');
    }
  }

  function runCommand(id) {
    const command = CAR_COMMANDS.find((item) => item.id === id);
    if (!command) return;
    const speed = commandSpeed();
    if (speed !== null && speed > 5) {
      toast('Detén el carro para usar los comandos.');
      updateCommandsStatus();
      return;
    }
    const lang = state.commandLang;
    const phrase = lang === 'zh' ? command.zh : command.en;
    const wake = state.commandWake ? (lang === 'zh' ? '你好小迪' : 'Hi BYD') : '';
    if (wake) speakWakeThenCommand(wake, phrase, lang);
    else speakCarPhrase(phrase, lang);
  }

  function setupCommandsUI() {
    const search = $('commandSearch');
    if (search) {
      search.addEventListener('input', () => {
        state.commandSearch = search.value;
        renderCommands();
      });
    }

    document.querySelectorAll('#commandLang [data-lang]').forEach((button) => {
      button.addEventListener('click', () => {
        state.commandLang = button.dataset.lang;
        document.querySelectorAll('#commandLang .seg').forEach((item) => item.classList.toggle('is-active', item === button));
        renderCommands();
      });
    });

    const wake = $('commandWake');
    if (wake) {
      wake.addEventListener('change', () => {
        state.commandWake = wake.checked;
      });
    }

    const stop = $('commandStop');
    if (stop) {
      stop.addEventListener('click', () => {
        if ('speechSynthesis' in window) window.speechSynthesis.cancel();
        setText('commandStatus', 'Voz detenida.');
      });
    }

    const test = $('commandTest');
    if (test) {
      test.addEventListener('click', () => {
        const lang = state.commandLang;
        speakCarPhrase(lang === 'zh' ? '你好小迪' : 'Hi BYD', lang);
      });
    }

    const custom = $('commandCustom');
    const customPlay = $('commandCustomPlay');
    if (custom && customPlay) {
      const playCustom = () => {
        const text = custom.value.trim();
        if (!text) {
          toast('Escribe una frase para reproducir.');
          return;
        }
        speakCarPhrase(text, state.commandLang);
      };
      customPlay.addEventListener('click', playCustom);
      custom.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          playCustom();
        }
      });
    }

    const list = $('commandsList');
    if (list) {
      list.addEventListener('click', (event) => {
        const card = event.target.closest('[data-command]');
        if (card) runCommand(card.dataset.command);
      });
    }
  }

  renderCommands();
  setupCommandsUI();

  /* ------------------------------------------------------------------ */
  /* Instalación de la PWA (Android)                                     */
  /* ------------------------------------------------------------------ */

  let deferredInstallPrompt = null;

  function isStandaloneApp() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }

  function updateInstallUI() {
    const button = $('installBtn');
    if (!button) return;
    if (isStandaloneApp()) {
      button.hidden = true;
      setText('installStatus', 'Ya está instalada en este dispositivo. Se abre como app.');
      return;
    }
    if (deferredInstallPrompt) {
      button.hidden = false;
      setText('installStatus', 'Toca el botón para instalarla en tu celular.');
    } else {
      button.hidden = true;
      setText('installStatus', 'Cuando Chrome la tenga lista, aquí aparecerá el botón. Si no, usa el menú ⋮ → Instalar aplicación.');
    }
  }

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    updateInstallUI();
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    updateInstallUI();
    toast('Aplicación instalada en el celular.');
  });

  $('installBtn').addEventListener('click', async () => {
    if (!deferredInstallPrompt) {
      setText('installStatus', 'Usa el menú de Chrome: ⋮ → Instalar aplicación.');
      return;
    }
    deferredInstallPrompt.prompt();
    const choice = await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    if (choice.outcome === 'accepted') {
      setText('installStatus', 'Instalando…');
      toast('Instalando la app…');
    } else {
      setText('installStatus', 'Instalación cancelada. Puedes intentarlo otra vez desde el menú de Chrome.');
    }
    updateInstallUI();
  });

  updateInstallUI();

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

  function currentMonthItems() {
    const now = new Date();
    const inMonth = (value) => {
      if (!value) return false;
      const date = new Date(value);
      return !Number.isNaN(date.getTime()) && date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
    };
    const trips = ((state.data && state.data.trips) || []).filter((trip) => inMonth(trip.start));
    const charges = ((state.data && state.data.charges) || []).filter((charge) => inMonth(charge.start));
    return { trips, charges };
  }

  function sayTrips(prefix) {
    const { trips } = currentMonthItems();
    if (!trips.length) return `${prefix}No tengo viajes registrados este mes.`;
    const km = trips.reduce((sum, trip) => sum + Number(trip.distanceKm || 0), 0);
    const kwh = trips.reduce((sum, trip) => sum + Number(tripKwh(trip) || 0), 0);
    const cost = trips.reduce((sum, trip) => sum + Number(trip.costCop || 0), 0);
    const avg = km > 0 ? (kwh / km) * 100 : null;
    return `${prefix}Este mes tienes ${trips.length} viajes, ${fmt0(km)} kilómetros, ${fmt1(kwh)} kilovatios hora y un costo estimado de ${money.format(cost)}${avg != null ? `, con un consumo medio de ${fmt1(avg)} kilovatios hora por cada 100 kilómetros` : ''}.`;
  }

  function sayCharges(prefix) {
    const { charges } = currentMonthItems();
    if (!charges.length) return `${prefix}No tengo cargas registradas este mes.`;
    const kwh = charges.reduce((sum, charge) => sum + Number(charge.kwh || 0), 0);
    const cost = charges.reduce((sum, charge) => sum + Number(charge.costCop || 0), 0);
    const dc = charges.filter((charge) => String(charge.type || '').toUpperCase() === 'DC').length;
    return `${prefix}Este mes tienes ${charges.length} cargas, ${fmt1(kwh)} kilovatios hora, ${dc} en corriente directa y un costo estimado de ${money.format(cost)}.`;
  }

  function sayCosts(prefix) {
    const { trips, charges } = currentMonthItems();
    const cost = trips.reduce((sum, trip) => sum + Number(trip.costCop || 0), 0) +
      charges.reduce((sum, charge) => sum + Number(charge.costCop || 0), 0);
    const km = trips.reduce((sum, trip) => sum + Number(trip.distanceKm || 0), 0);
    if (!trips.length && !charges.length) return `${prefix}No tengo viajes ni cargas este mes para calcular el gasto.`;
    return `${prefix}Este mes llevas ${fmt0(km)} kilómetros y un gasto estimado de ${money.format(cost)} entre viajes y cargas.`;
  }

  function sayLastCharge(prefix) {
    const charges = ((state.data && state.data.charges) || [])
      .filter((charge) => charge.start)
      .slice()
      .sort((a, b) => new Date(b.start) - new Date(a.start));
    if (!charges.length) return `${prefix}No tengo cargas registradas.`;
    const charge = charges[0];
    const when = `${fecha.format(new Date(charge.start))} a las ${hora.format(new Date(charge.start))}`;
    const kwh = charge.kwh != null ? `${fmt1(charge.kwh)} kilovatios hora` : 'energía no registrada';
    return `${prefix}La última carga fue el ${when}, ${kwh}${charge.costCop != null ? `, por ${money.format(charge.costCop)}` : ''}.`;
  }

  function resolveCarCommand(t) {
    const find = (id) => CAR_COMMANDS.find((item) => item.id === id);
    const windowIntent = t.includes('ventana') || t.includes('ventanilla');
    if (windowIntent) {
      const closing = /(cierra|cierre|sube|subir|arriba)/.test(t);
      const opening = /(abre|abrir|baja|bajar|abajo)/.test(t);
      const vent = /(ventila|ventilar|ventilacion)/.test(t);
      const half = /(media|mitad|50)/.test(t);
      const front = /(delantera|delantero)/.test(t);
      const rear = /(trasera|trasero)/.test(t);
      const driver = /(conductor|chofer)/.test(t);
      const passenger = /(copiloto|pasajero)/.test(t);
      const left = /(izquierda|izq)/.test(t);
      const right = /(derecha|der)/.test(t);
      if (driver) return { command: find(closing ? 'windows-driver-close' : vent ? 'windows-driver-vent' : half ? 'windows-driver-half' : 'windows-driver-open') };
      if (passenger) return { command: find(closing ? 'windows-passenger-close' : vent ? 'windows-passenger-vent' : half ? 'windows-passenger-half' : 'windows-passenger-open') };
      if (rear && left) return { command: find(closing ? 'windows-rear-left-close' : vent ? 'windows-rear-left-vent' : half ? 'windows-rear-left-half' : 'windows-rear-left-open') };
      if (rear && right) return { command: find(closing ? 'windows-rear-right-close' : vent ? 'windows-rear-right-vent' : half ? 'windows-rear-right-half' : 'windows-rear-right-open') };
      if (front) return { command: find(closing ? 'windows-front-close' : vent ? 'windows-front-vent' : half ? 'windows-front-half' : 'windows-front-open') };
      if (rear) return { command: find(closing ? 'windows-rear-close' : vent ? 'windows-rear-vent' : half ? 'windows-rear-half' : 'windows-rear-open') };
      return { command: find(closing ? 'windows-close' : vent ? 'windows-vent' : half ? 'windows-half' : opening ? 'windows-open' : 'windows-open') };
    }

    if (t.includes('baul') || t.includes('maletero')) {
      return { command: find(/(cierra|cierre)/.test(t) ? 'trunk-close' : 'trunk-open') };
    }
    if (t.includes('puerta') || t.includes('seguro') || t.includes('cerradura')) {
      if (/(desbloquea|abre|abrir)/.test(t)) return { command: find('unlock') };
      if (/(bloquea|cierra|cierre)/.test(t)) return { command: find('lock') };
    }
    if (t.includes('asiento')) {
      const driver = /(conductor|chofer)/.test(t);
      const heat = /(calor|calefaccion|calienta)/.test(t);
      const vent = /(ventila|ventilacion)/.test(t);
      const off = /(apaga|quita|off)/.test(t);
      const level = (t.match(/[1-3]/) || ['1'])[0];
      const prefix = driver ? 'seat-driver' : 'seat-passenger';
      const kind = heat ? 'heat' : vent ? 'vent' : 'heat';
      return { command: find(`${prefix}-${kind}-${off ? 'off' : level}`) };
    }
    if (t.includes('espejo')) {
      return { command: find(/(apaga|quita|off)/.test(t) ? 'mirror-heat-off' : 'mirror-heat-on') };
    }
    if (t.includes('volante')) {
      return { command: find(/(apaga|quita|off)/.test(t) ? 'steering-heat-off' : 'steering-heat-on') };
    }
    if (t.includes('techo') || t.includes('sunroof')) {
      if (/(cortina|sunshade)/.test(t)) return { command: find(/(cierra|cierre)/.test(t) ? 'sunshade-close' : 'sunshade-open') };
      if (/(cierra|cierre)/.test(t)) return { command: find('sunroof-close') };
      if (/(ventila|ventilacion)/.test(t)) return { command: find('sunroof-vent') };
      if (/(media|mitad|50)/.test(t)) return { command: find('sunroof-half') };
      return { command: find('sunroof-open') };
    }
    if (t.includes('cortina')) {
      return { command: find(/(cierra|cierre)/.test(t) ? 'sunshade-close' : 'sunshade-open') };
    }
    if (t.includes('aire') || t.includes('clima')) {
      if (/(desempaña|desempanar|defrost)/.test(t)) return { command: find(/(quita|apaga|off)/.test(t) ? 'defrost-off' : 'defrost-on') };
      if (/(apaga|quita|off)/.test(t)) return { command: find('ac-off') };
      const temp = t.match(/(\d{2})/);
      if (temp) {
        const degrees = Number(temp[1]);
        if (degrees >= 16 && degrees <= 33) {
          return {
            custom: `设置温度${degrees}`,
            en: `set the temperature to ${degrees} degrees`,
            zh: `设置温度${degrees}`,
          };
        }
      }
      if (/(prende|enciende|on|auto|pon|poner)/.test(t) || t.includes('aire acondicionado')) return { command: find('ac-on') };
    }
    if (t.includes('ventilador')) {
      const level = (t.match(/[1-7]/) || ['3'])[0];
      const id = ['1', '3', '5', '7'].includes(level) ? `fan-${level}` : null;
      if (id) return { command: find(id) };
      return { custom: `风量${level}`, en: `set the fan to level ${level}`, zh: `风量${level}` };
    }
    if (t.includes('recirculacion') || t.includes('aire exterior')) {
      return { command: find(t.includes('exterior') ? 'recirc-outer' : 'recirc-inner') };
    }
    if (t.includes('luz') || t.includes('luces')) {
      if (/(interior|cabina)/.test(t)) return { command: find(/(apaga|quita|off)/.test(t) ? 'interior-off' : 'interior-on') };
      if (/(ambiente|ambiental)/.test(t)) return { command: find(/(apaga|quita|off)/.test(t) ? 'ambient-off' : 'ambient-on') };
      if (/(dia|diurna|drl)/.test(t)) return { command: find(/(apaga|quita|off)/.test(t) ? 'drl-off' : 'drl-on') };
    }
    if (t.includes('hud') || t.includes('parabrisas')) {
      return { command: find(/(apaga|quita|off)/.test(t) ? 'hud-off' : 'hud-on') };
    }
    const modes = {
      eco: 'drive-eco', normal: 'drive-normal', sport: 'drive-sport', deportivo: 'drive-sport',
      nieve: 'drive-snow', arena: 'drive-sand', barro: 'drive-mud', montana: 'drive-mountain',
      montaña: 'drive-mountain', inteligente: 'drive-smart', smart: 'drive-smart',
    };
    if (t.includes('modo')) {
      for (const [word, id] of Object.entries(modes)) {
        if (t.includes(word)) return { command: find(id) };
      }
    }
    return null;
  }

  async function respondToCommand(raw) {
    const t = normalizeText(raw);
    const v = state.data && state.data.vehicle;
    const demo = state.data && state.data.mode === 'demo';
    const prefix = demo ? 'En demostración: ' : '';

    if (!t) return 'No entendí. Intenta de nuevo.';

    if (/(ayuda|que puedes|que sabes)/.test(t)) {
      return 'Puedes preguntar por batería, autonomía, llantas, temperatura, carga, velocidad, odómetro, salud de la batería, viajes, cargas o gastos del mes. También puedes decir: abre el mapa, abre la radio, pon La Mega, sube el volumen, sube las ventanas o abre el baúl.';
    }

    if (t.includes('comando')) {
      setView('commands');
      return 'Abriendo el catálogo de comandos.';
    }

    if (/(cuanto|cuanta|cuantos|cuantas).*(gaste|gastado|gasto)/.test(t) || t.includes('costo total')) {
      return sayCosts(prefix);
    }
    if (/(cuanto|cuanta|cuantos|cuantas|resumen|estadistica)/.test(t) && t.includes('viaje')) {
      return sayTrips(prefix);
    }
    if (t.includes('ultima carga') || t.includes('ultimo cargo')) {
      return sayLastCharge(prefix);
    }
    if (/(cuanto|cuanta|cuantos|cuantas|resumen|estadistica)/.test(t) && /(cargas|cargos)/.test(t)) {
      return sayCharges(prefix);
    }
    if (t.includes('promedio') || t.includes('consumo medio')) {
      const trips = (state.data && state.data.trips) || [];
      const km = trips.reduce((sum, trip) => sum + Number(trip.distanceKm || 0), 0);
      const kwh = trips.reduce((sum, trip) => sum + Number(tripKwh(trip) || 0), 0);
      return km > 0
        ? `${prefix}El consumo medio registrado es ${fmt1((kwh / km) * 100)} kilovatios hora por cada 100 kilómetros.`
        : `${prefix}No tengo suficientes viajes para calcular el consumo medio.`;
    }
    if (t.includes('capacidad')) {
      const capacity = state.config && Number(state.config.capacityKwh) ? Number(state.config.capacityKwh) : 60.5;
      return `${prefix}La capacidad configurada de la batería es ${fmt1(capacity)} kilovatios hora.`;
    }
    if (t.includes('energia disponible') || t.includes('kwh disponible')) {
      const capacity = state.config && Number(state.config.capacityKwh) ? Number(state.config.capacityKwh) : 60.5;
      if (!v || v.soc == null) return `${prefix}No tengo el estado de carga.`;
      return `${prefix}Quedan aproximadamente ${fmt1((Number(v.soc) / 100) * capacity)} kilovatios hora disponibles.`;
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

    const carCommand = resolveCarCommand(t);
    if (carCommand) {
      const speed = commandSpeed();
      if (speed !== null && speed > 5) {
        return 'Detén el carro para usar los comandos del vehículo.';
      }
      const lang = state.commandLang;
      if (carCommand.command) {
        runCommand(carCommand.command.id);
        return '';
      }
      if (carCommand.custom) {
        const phrase = lang === 'zh' ? carCommand.zh : carCommand.en;
        const wake = state.commandWake ? (lang === 'zh' ? '你好小迪' : 'Hi BYD') : '';
        if (wake) speakWakeThenCommand(wake, phrase, lang);
        else speakCarPhrase(phrase, lang);
        return '';
      }
      return 'No encontré ese comando en el catálogo.';
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
  /* Enlace directo a una pestaña                                       */
  /* ------------------------------------------------------------------ */

  const initialView = new URLSearchParams(location.search).get('view');
  if (initialView && document.getElementById(`view-${initialView}`)) {
    setView(initialView);
  }

  /* ------------------------------------------------------------------ */
  /* PWA                                                                */
  /* ------------------------------------------------------------------ */

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }
})();
