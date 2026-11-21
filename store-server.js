const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = __dirname, DB = path.join(ROOT, 'data.json');
const PORT = Number(process.env.PORT || 3000);
const sessions = new Map(), limits = new Map();

function loadEnv() {
  try {
    const raw = require('node:fs').readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim(), i = t.indexOf('=');
      if (!t || t.startsWith('#') || i < 1) continue;
      const k = t.slice(0, i).trim();
      let v = t.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch {}
}
loadEnv();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

async function readDb() {
  let d;
  try { d = JSON.parse(await fs.readFile(DB, 'utf8')); }
  catch { d = { products: [], orders: [] }; }
  if (!Array.isArray(d.products)) d.products = [];
  if (!Array.isArray(d.orders)) d.orders = [];
  let changed = false;
  const imageLinks = new Map([['https://ibb.co/xKnZzq55', 'https://i.ibb.co/vCN9L4zz/photo-2026-11-21-19-43-58.jpg'], ['https://ibb.co/8DYgzhNf', 'https://i.ibb.co/FbH4sPmy/photo-2026-11-21-19-44-04.jpg']]);
  for (const product of d.products) {
    if (product.id === 'uj-first-cotton-blue-3xl' && Array.isArray(product.images)) {
      const next = product.images.map(url => imageLinks.get(url) || url);
      if (JSON.stringify(next) !== JSON.stringify(product.images)) { product.images = next; changed = true; }
    }
  }
  {
    try {
      const seed = JSON.parse(await fs.readFile(path.join(ROOT, 'catalog-seed.json'), 'utf8'));
      for (const p of (Array.isArray(seed.products) ? seed.products : [])) {
        if (!d.products.some(x => x.id === p.id || (p.code && x.code === p.code))) d.products.push(p);
      }
      d.seedVersion = Number(seed.version) || 1;
      changed = true;
    } catch (e) { console.error('Catalog seed unavailable:', e.message); }
  }
  if (changed) await writeDb(d);
  return d;
}
async function writeDb(d) {
  const tmp = DB + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(d, null, 2), 'utf8');
  await fs.rename(tmp, DB);
}
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function plain(res, status, value, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' }); res.end(value);
}
async function readBody(req) {
  let raw = '';
  for await (const c of req) { raw += c; if (raw.length > 1024 * 1024) throw Error('حجم درخواست بیش از حد مجاز است.'); }
  return raw ? JSON.parse(raw) : {};
}
function limited(req, name, max, ms) {
  const key = name + ':' + (req.socket.remoteAddress || 'unknown'), now = Date.now();
  const x = limits.get(key) || { n: 0, until: now + ms };
  if (now > x.until) { x.n = 0; x.until = now + ms; }
  x.n++; limits.set(key, x); return x.n <= max;
}
function isAdmin(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
  const expiry = sessions.get(token);
  if (!expiry || expiry < Date.now()) { sessions.delete(token); return false; }
  return true;
}
function makeProduct(input, old = {}) {
  const p = {
    id: old.id || crypto.randomUUID(), code: String(input.code || '').trim().slice(0, 80),
    name: String(input.name || '').trim().slice(0, 160),
    category: ['زنانه', 'مردانه', 'ست', 'جوراب', 'پاپوش', 'بچگانه'].includes(input.category) ? input.category : 'زنانه',
    price: Math.max(0, Math.round(Number(input.price) || 0)),
    oldPrice: Math.max(0, Math.round(Number(input.oldPrice) || 0)),
    stock: Math.max(0, Math.floor(Number(input.stock) || 0)),
    colors: Array.isArray(input.colors) ? input.colors.map(String).map(x => x.trim()).filter(Boolean).slice(0, 30) : [],
    sizes: Array.isArray(input.sizes) ? input.sizes.map(String).map(x => x.trim()).filter(Boolean).slice(0, 30) : [],
    images: Array.isArray(input.images) ? input.images.map(String).map(x => x.trim()).filter(Boolean).slice(0, 12) : [],
    material: String(input.material || '').trim().slice(0, 120),
    description: String(input.description || '').trim().slice(0, 1500),
    isNew: Boolean(input.isNew), sold: Number(old.sold) || 0,
    createdAt: old.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  if (!p.name || !p.price) throw Error('نام و قیمت معتبر محصول را وارد کنید.');
  return p;
}
async function serveFile(res, pathname) {
  const map = { '/': 'index.html', '/admin': 'admin.html', '/admin.html': 'admin.html', '/pages.html': 'pages.html' };
  const file = path.resolve(ROOT, map[pathname] || pathname.replace(/^\//, ''));
  if (file !== path.join(ROOT, 'index.html') && !file.startsWith(ROOT + path.sep)) return plain(res, 403, 'Forbidden');
  let data; try { data = await fs.readFile(file); } catch { return plain(res, 404, 'Not found'); }
  const ext = path.extname(file).toLowerCase();
  const types = { '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.ico':'image/x-icon','.txt':'text/plain; charset=utf-8' };
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' }); res.end(data);
}

const app = http.createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  try {
    if (req.method === 'GET' && pathname === '/api/health') return json(res, 200, { ok: true, service: 'UNDERWEARjanan' });
    if (req.method === 'GET' && pathname === '/api/products') {
      const d = await readDb(); return json(res, 200, { products: d.products.filter(p => p.active !== false) });
    }
    if (req.method === 'POST' && pathname === '/api/admin/login') {
      if (!limited(req, 'login', 8, 600000)) return json(res, 429, { error: 'تلاش‌های ورود زیاد است. بعداً دوباره امتحان کنید.' });
      if (!ADMIN_PASSWORD || ADMIN_PASSWORD === 'CHANGE_THIS_ADMIN_PASSWORD') return json(res, 503, { error: 'رمز مدیریت روی سرور تنظیم نشده است.' });
      const b = await readBody(req), got = Buffer.from(typeof b.password === 'string' ? b.password : ''), want = Buffer.from(ADMIN_PASSWORD);
      if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return json(res, 401, { error: 'رمز مدیریت اشتباه است.' });
      const token = crypto.randomBytes(32).toString('hex'); sessions.set(token, Date.now() + 8 * 60 * 60 * 1000);
      return json(res, 200, { ok: true, token });
    }
    if (pathname.startsWith('/api/admin/')) {
      if (!isAdmin(req)) return json(res, 401, { error: 'نشست مدیریت معتبر نیست. دوباره وارد شوید.' });
      const d = await readDb();
      if (req.method === 'GET' && pathname === '/api/admin/products') return json(res, 200, { products: d.products });
      if (req.method === 'POST' && pathname === '/api/admin/products') {
        const p = makeProduct(await readBody(req));
        if (p.code && d.products.some(x => x.code === p.code)) return json(res, 409, { error: 'کد محصول تکراری است.' });
        d.products.unshift(p); await writeDb(d); return json(res, 201, { product: p });
      }
      const pm = pathname.match(/^\/api\/admin\/products\/([^/]+)$/);
      if (pm && req.method === 'PUT') {
        const i = d.products.findIndex(p => p.id === pm[1]); if (i < 0) return json(res, 404, { error: 'محصول پیدا نشد.' });
        d.products[i] = makeProduct(await readBody(req), d.products[i]); await writeDb(d); return json(res, 200, { product: d.products[i] });
      }
      if (pm && req.method === 'DELETE') {
        const n = d.products.length; d.products = d.products.filter(p => p.id !== pm[1]);
        if (n === d.products.length) return json(res, 404, { error: 'محصول پیدا نشد.' });
        await writeDb(d); return json(res, 200, { ok: true });
      }
      if (req.method === 'GET' && pathname === '/api/admin/orders') return json(res, 200, { orders: d.orders });
      const om = pathname.match(/^\/api\/admin\/orders\/([^/]+)$/);
      if (om && req.method === 'PATCH') {
        const o = d.orders.find(x => x.id === om[1]); if (!o) return json(res, 404, { error: 'سفارش پیدا نشد.' });
        const b = await readBody(req), statuses = ['در انتظار بررسی','تأیید شده','در حال آماده‌سازی','ارسال شده','تحویل شده','لغو شده'];
        if (!statuses.includes(b.status)) return json(res, 400, { error: 'وضعیت سفارش معتبر نیست.' });
        o.status = b.status; o.updatedAt = new Date().toISOString(); await writeDb(d); return json(res, 200, { order: o });
      }
      return json(res, 404, { error: 'مسیر مدیریت پیدا نشد.' });
    }
    if (req.method === 'POST' && pathname === '/api/orders') {
      if (!limited(req, 'orders', 12, 3600000)) return json(res, 429, { error: 'تعداد درخواست‌ها زیاد است. بعداً تلاش کنید.' });
      const b = await readBody(req), name = String(b.name || '').trim(), phone = String(b.phone || '').trim(), address = String(b.address || '').trim();
      if (!name || !phone || !address) return json(res, 400, { error: 'نام، شماره تماس و نشانی را کامل وارد کنید.' });
      if (!Array.isArray(b.items) || !b.items.length || b.items.length > 50) return json(res, 400, { error: 'سبد خرید خالی یا نامعتبر است.' });
      const d = await readDb(), items = []; let total = 0;
      for (const x of b.items) {
        const p = d.products.find(y => y.id === String(x.productId)), q = Math.floor(Number(x.quantity));
        if (!p || !Number.isFinite(q) || q < 1 || q > 10) return json(res, 400, { error: 'یکی از محصولات سفارش معتبر نیست.' });
        if (p.stock < q) return json(res, 409, { error: 'موجودی محصول ' + p.name + ' کافی نیست.' });
        const color = String(x.color || ''), size = String(x.size || '');
        if (p.colors.length && !p.colors.includes(color)) return json(res, 400, { error: 'رنگ انتخابی معتبر نیست.' });
        if (p.sizes.length && !p.sizes.includes(size)) return json(res, 400, { error: 'سایز انتخابی معتبر نیست.' });
        items.push({ productId:p.id, code:p.code, name:p.name, price:p.price, color, size, quantity:q }); total += p.price * q;
      }
      for (const x of items) { const p = d.products.find(y => y.id === x.productId); p.stock -= x.quantity; p.sold = (p.sold || 0) + x.quantity; }
      const order = { id:'UJ-' + new Date().toISOString().slice(0,10).replace(/-/g,'') + '-' + crypto.randomBytes(3).toString('hex').toUpperCase(),
        customer:{ name:name.slice(0,120), phone:phone.slice(0,40), email:String(b.email||'').slice(0,160), address:address.slice(0,1000), postalCode:String(b.postalCode||'').slice(0,30) },
        items, total, status:'در انتظار بررسی', createdAt:new Date().toISOString() };
      d.orders.unshift(order); await writeDb(d); return json(res, 201, { ok:true, order });
    }
    if (pathname.startsWith('/api/')) return json(res, 404, { error: 'مسیر API پیدا نشد.' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return plain(res, 405, 'Method not allowed');
    return serveFile(res, pathname);
  } catch (e) {
    console.error('Request error:', e);
    if (e instanceof SyntaxError) return json(res, 400, { error: 'داده ارسالی معتبر نیست.' });
    return json(res, 500, { error: e.message || 'خطای داخلی سرور.' });
  }
});
app.listen(PORT, '0.0.0.0', () => console.log('UNDERWEARjanan ready on port ' + PORT));
