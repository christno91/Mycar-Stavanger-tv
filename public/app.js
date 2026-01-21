const qs = new URLSearchParams(location.search);
const slideSeconds = Number(qs.get('slide') || '10');
const refreshSeconds = Number(qs.get('refresh') || '120');
const token = qs.get('token') || ''; // optional; only needed if you set ACCESS_TOKEN on the server

const els = {
  img: document.getElementById('carImage'),
  title: document.getElementById('carTitle'),
  year: document.getElementById('carYear'),
  km: document.getElementById('carKm'),
  price: document.getElementById('carPrice'),
  url: document.getElementById('carUrl'),
  status: document.getElementById('status'),
  updated: document.getElementById('updated'),
  clock: document.getElementById('clock')
};

let cars = [];
let idx = 0;
let slideTimer = null;
let refreshTimer = null;
let imgLoadToken = 0;

function setStatus(msg) {
  els.status.textContent = msg;
}

function tickClock() {
  const d = new Date();
  els.clock.textContent = d.toLocaleTimeString('nb-NO', { hour: '2-digit', minute: '2-digit' });
}

function normalizeUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.host + u.pathname;
  } catch {
    return url;
  }
}

function setImage(url) {
  imgLoadToken += 1;
  const t = imgLoadToken;

  els.img.classList.remove('is-visible');

  if (!url) {
    els.img.removeAttribute('src');
    return;
  }

  const onLoad = () => {
    if (t !== imgLoadToken) return;
    els.img.classList.add('is-visible');
  };

  // Safari/Chrome trigger load differently depending on cache state
  els.img.onload = onLoad;
  els.img.onerror = () => {
    if (t !== imgLoadToken) return;
    els.img.classList.remove('is-visible');
  };

  els.img.src = url;
}

function showCar(car) {
  if (!car) return;

  els.title.textContent = car.title || '';
  els.year.textContent = car.modelYear ?? '';
  els.km.textContent = car.mileageText || '';
  els.price.textContent = car.priceText || '';
  els.url.textContent = normalizeUrl(car.adUrl || '');

  setImage(car.imageUrl);

  // Preload next image for smoother bytte
  const next = cars[(idx + 1) % cars.length];
  if (next?.imageUrl) {
    const img = new Image();
    img.decoding = 'async';
    img.src = next.imageUrl;
  }
}

async function fetchCars() {
  const url = new URL('/api/ads', location.origin);
  if (token) url.searchParams.set('token', token);

  setStatus('Oppdaterer bilutvalg…');
  const r = await fetch(url.toString(), { cache: 'no-store' });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err?.error || `HTTP ${r.status}`);
  }

  const data = await r.json();
  cars = Array.isArray(data.cars) ? data.cars : [];
  idx = 0;

  const updatedAt = data.updatedAt ? new Date(data.updatedAt) : null;
  els.updated.textContent = updatedAt
    ? `Oppdatert ${updatedAt.toLocaleTimeString('nb-NO', { hour: '2-digit', minute: '2-digit' })}`
    : '';

  if (!cars.length) {
    setStatus('Ingen biler funnet.');
    return;
  }

  setStatus(`${cars.length} biler i rotasjon.`);
  showCar(cars[idx]);
}

function startRotation() {
  if (slideTimer) clearInterval(slideTimer);
  slideTimer = setInterval(() => {
    if (!cars.length) return;
    idx = (idx + 1) % cars.length;
    showCar(cars[idx]);
  }, Math.max(3, slideSeconds) * 1000);
}

function startRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(async () => {
    try {
      await fetchCars();
    } catch (e) {
      setStatus(`Feil ved oppdatering: ${e.message || e}`);
    }
  }, Math.max(10, refreshSeconds) * 1000);
}

(async function init() {
  tickClock();
  setInterval(tickClock, 1000);

  try {
    await fetchCars();
    startRotation();
    startRefresh();
  } catch (e) {
    setStatus(`Klarte ikke hente biler: ${e.message || e}`);
  }
})();
