import { XMLParser } from 'fast-xml-parser';

let cache = { ts: 0, data: null };

function pickFirst(val) {
  if (val == null) return null;
  if (Array.isArray(val)) return val[0] ?? null;
  return val;
}

function toInt(val) {
  if (val == null) return null;
  const n = Number(String(val).replace(/[^0-9]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function fmtNumber(n) {
  if (n == null) return '';
  return new Intl.NumberFormat('nb-NO').format(n);
}


function upgradeFinnImageUrl(url) {
  if (!url) return null;
  const s = String(url);

  // FINN images can be resized by swapping the /dynamic/<width>w.../ part of the URL.
  // We prefer a larger size for TV-skjerm.
  const upgraded = s.replace(/\/dynamic\/\d+w(_webp)?\//, '/dynamic/1600w_webp/');
  return upgraded;
}

function parseFinnAtom(xmlText) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true
  });

  const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

  const getNodeValue = (node) =>
    node?.['@_value'] ?? node?.['#text'] ?? node?.text ?? node?._ ?? null;

  const getAdataValue = (adata, name) => {
    if (!adata) return null;

    // 1) finn:field -> field (etter removeNSPrefix)
    const fields = asArray(adata.field);
    const hitField = fields.find((f) => (f?.['@_name'] || f?.name) === name);
    const fieldVal = getNodeValue(hitField);
    if (fieldVal != null) return fieldVal;

    // 2) property (fallback)
    const props = asArray(adata.property);
    const hitProp = props.find((p) => (p?.['@_name'] || p?.name) === name);
    const propVal = getNodeValue(hitProp);
    if (propVal != null) return propVal;

    return null;
  };

  const getAdataPrice = (adata) => {
    if (!adata) return null;

    // finn:price -> price
    const prices = asArray(adata.price);
    const pick =
      prices.find((p) => (p?.['@_name'] || p?.name) === 'main') ||
      prices.find((p) => (p?.['@_name'] || p?.name) === 'net') ||
      prices[0];

    const priceVal = getNodeValue(pick);
    if (priceVal != null) return priceVal;

    // fallback
    return getAdataValue(adata, 'price');
  };

  const getImageUrl = (entry) => {
    // media:content / media:thumbnail blir ofte content/thumbnail med @_url
    const contentNodes = asArray(entry?.content).filter((c) => c?.['@_url']);
    const thumbNodes = asArray(entry?.thumbnail).filter((t) => t?.['@_url']);

    const url = contentNodes[0]?.['@_url'] || thumbNodes[0]?.['@_url'] || null;
    if (url) return url.startsWith('http://') ? url.replace('http://', 'https://') : url;

    // fallback til link enclosure
    const links = asArray(entry?.link);
    const img =
      links.find((l) => String(l?.['@_type'] || '').startsWith('image/')) ||
      links.find((l) => (l?.['@_rel'] || '') === 'enclosure');

    const href = img?.['@_href'] ?? null;
    return href?.startsWith('http://') ? href.replace('http://', 'https://') : href;
  };

  const obj = parser.parse(xmlText);
  const feed = obj?.feed;
  const entries = feed?.entry ? (Array.isArray(feed.entry) ? feed.entry : [feed.entry]) : [];

  const cars = entries.map((e) => {
    const title = pickFirst(e?.title) ?? '';

    const adata = e?.adata;

    const modelYearRaw = getAdataValue(adata, 'modelYear') ?? getAdataValue(adata, 'year');
    const mileageRaw = getAdataValue(adata, 'mileage') ?? getAdataValue(adata, 'kilometers');
    const priceRaw = getAdataPrice(adata);

    const modelYear = toInt(modelYearRaw);
    const mileage = toInt(mileageRaw);
    const price = toInt(priceRaw);

    const imageUrl = getImageUrl(e);

    const links = asArray(e?.link);
    const adUrl = links.find((l) => (l?.['@_rel'] || '') === 'alternate')?.['@_href'] ?? null;

    return {
      title,

      // behold dine feltnavn, men legg også inn alias (gjør frontend robust)
      modelYear,
      year: modelYear,

      mileage,
      kilometers: mileage,

      price,
      priceText: price != null ? `${fmtNumber(price)} kr` : '',
      mileageText: mileage != null ? `${fmtNumber(mileage)} km` : '',

      imageUrl,
      adUrl
    };
  });

  return cars;
}


export default async function handler(req, res) {
  try {
    const apiKey = process.env.FINN_API_KEY;
    const orgId = process.env.FINN_ORG_ID;
    const accessToken = process.env.ACCESS_TOKEN || '';
    const cacheSeconds = Number(process.env.CACHE_SECONDS || '120');
    const maxAds = Number(process.env.MAX_ADS || '30');

    if (!apiKey) {
      res.status(500).json({ error: 'Missing FINN_API_KEY env var' });
      return;
    }
    if (!orgId) {
      res.status(500).json({ error: 'Missing FINN_ORG_ID env var' });
      return;
    }

    if (accessToken) {
      const token = req.query?.token;
      if (token !== accessToken) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
    }

    const now = Date.now();
    if (cache.data && now - cache.ts < cacheSeconds * 1000) {
      res.setHeader('Cache-Control', `public, max-age=${cacheSeconds}`);
      res.json(cache.data);
      return;
    }

    // FINN search endpoint is an Atom feed.
    // We'll query car-norway with the orgId, sorted by published desc.
    const url = new URL('https://cache.api.finn.no/iad/search/car-norway');
    url.searchParams.set('orgId', String(orgId));
    url.searchParams.set('sort', 'PUBLISHED_DESC');
    url.searchParams.set('rows', String(Math.min(Math.max(maxAds, 1), 200)));

    const resp = await fetch(url.toString(), {
      headers: {
        'x-FINN-apikey': apiKey,
        'accept': 'application/atom+xml, application/xml;q=0.9, */*;q=0.1'
      }
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      res.status(resp.status).json({
        error: 'FINN API error',
        status: resp.status,
        statusText: resp.statusText,
        body: text.slice(0, 500)
      });
      return;
    }

    const xml = await resp.text();
    const cars = parseFinnAtom(xml).slice(0, Math.min(Math.max(maxAds, 1), 200));

    const payload = {
      updatedAt: new Date().toISOString(),
      count: cars.length,
      cars
    };

    cache = { ts: now, data: payload };

    // If you embed via iframe, CORS isn't needed.
    // If you ever fetch directly from JS on another domain, enable CORS here.
    res.setHeader('Cache-Control', `public, max-age=${cacheSeconds}`);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: 'Server error', message: String(err?.message || err) });
  }
}
