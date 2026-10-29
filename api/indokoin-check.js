/**
 * Vercel Serverless Function: cek saldo koin pemain INDOKOIN.
 *
 * Dipakai halaman bongkar polosan SEBELUM layout ringkasan tampil:
 * saldo koin ID pemain (dari hidupcuan personal-info-free) harus >=
 * jumlah koin yang mau dibongkar.
 *
 * POST /api/indokoin-check
 * Body: { royal_id, coin }   // coin = jumlah koin mentah yang dibutuhkan
 *
 * Balasan:
 *   200 { success:true, status:'ok', coin, coin_label, nick, enough }
 *   200 { success:true, status:'invalid' }  // API menjawab tuntas tapi pemain
 *                                           // TIDAK ditemukan: data null, atau
 *                                           // data = {En:9014, Msg:'LoadPlayerDataFailed'}
 *                                           // (terbukti live 2026-10-29). Halaman BLOKIR.
 *   200 { success:true, status:'unknown' }  // hanya gangguan transport/HTTP ->
 *                                           // halaman FAIL-OPEN (tetap lanjut),
 *                                           // sama seperti forwarder KA.
 *   400 { success:false, error }            // royal_id bukan angka / coin tidak valid
 *
 * Env (opsional):
 *   BALANCE_API_URL  override API cek saldo (default hidupcuan personal-info-free)
 */

const ALLOWED_ORIGINS = [
  'https://neoparty.web.id',
  'https://indokoinstore.shop',
  'https://cuan.indokoinstore.shop',
  'https://indokar.vercel.app',
  'http://localhost:3000',
  'http://localhost:5173',
];

function cors(req, res) {
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin',
    ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const BALANCE_API_URL = process.env.BALANCE_API_URL || 'https://api.hidupcuan.org/api/neo/personal-info-free';
const BALANCE_TIMEOUT_MS = 6000;

// Angka koin mentah -> format Indonesia ringkas: 1520000000 -> '1,52B'
function formatCoin(raw) {
  const v = Number(raw);
  if (!isFinite(v)) return '';
  const trim = (num, dec) => {
    let s = num.toFixed(dec);
    if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s.replace('.', ',');
  };
  if (v >= 1e12) return trim(v / 1e12, 2) + 'T';
  if (v >= 1e9) return trim(v / 1e9, 2) + 'B';
  if (v >= 1e6) return trim(v / 1e6, 1) + 'M';
  return String(Math.trunc(v)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

module.exports = async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const royalId = String(body.royal_id || '').trim();
  if (!/^\d+$/.test(royalId)) {
    return res.status(400).json({ success: false, error: 'ID tidak valid' });
  }
  const required = Number(body.coin);
  if (!isFinite(required) || required <= 0) {
    return res.status(400).json({ success: false, error: 'Jumlah koin tidak valid' });
  }

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), BALANCE_TIMEOUT_MS);
    let upstream;
    try {
      upstream = await fetch(BALANCE_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        // Endpoint hanya merespons ID numerik (string -> data null).
        body: JSON.stringify({ id: Number(royalId) }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(t);
    }
    const m = await upstream.json().catch(() => null);
    if (!upstream.ok || !m) {
      // Gangguan transport/HTTP (5xx, body bukan JSON) -> tidak tahu -> fail-open.
      console.log('[indokoin-check] upstream HTTP ' + upstream.status + ' -> fail-open');
      return res.status(200).json({ success: true, status: 'unknown' });
    }
    // API menjawab tuntas (HTTP 200 + JSON). Pemain ditemukan HANYA bila
    // data.Coin ada; selain itu (data null / payload En+Msg) = ID tidak
    // ditemukan -> invalid, BUKAN fail-open.
    const coinRaw = (m.data && typeof m.data.Coin !== 'undefined') ? m.data.Coin : undefined;
    if (typeof coinRaw === 'undefined') {
      return res.status(200).json({ success: true, status: 'invalid' });
    }
    const coin = Number(coinRaw);
    if (!isFinite(coin)) {
      console.log('[indokoin-check] Coin bukan angka -> fail-open');
      return res.status(200).json({ success: true, status: 'unknown' });
    }
    return res.status(200).json({
      success: true,
      status: 'ok',
      coin,
      coin_label: formatCoin(coin),
      nick: m.data.Nick || null,
      enough: coin >= required,
    });
  } catch (e) {
    console.log('[indokoin-check] error:', e.message, '-> fail-open');
    return res.status(200).json({ success: true, status: 'unknown' });
  }
};
