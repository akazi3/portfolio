const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, save, slugify, removeUpload, filesOf, UPLOADS } = require('./lib/db');
const auth = require('./lib/auth');
const v = require('./lib/views');

const PORT = +process.env.PORT || 3000;
const MAX_UPLOAD = (+process.env.MAX_UPLOAD_MB || 2048) * 1024 * 1024;
const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
};
const UPLOAD_EXT = new Set(['.mp4', '.m4v', '.mov', '.webm', '.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif']);
const SEC = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
};

const html = (res, code, body, h = {}) => {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', ...SEC, ...h });
  res.end(body);
};
const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json', ...SEC });
  res.end(JSON.stringify(obj));
};
const redirect = (res, to, h = {}) => {
  res.writeHead(303, { Location: to, ...SEC, ...h });
  res.end();
};

function readForm(req, limit = 2e6) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Body too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()))));
    req.on('error', reject);
  });
}

function serveFile(req, res, file, cache) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return html(res, 404, v.notFound());
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const h = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': cache, ...SEC };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range) {
      let start = range[1] === '' ? Math.max(0, st.size - +range[2]) : +range[1];
      let end = range[1] === '' || range[2] === '' ? st.size - 1 : Math.min(+range[2], st.size - 1);
      if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { ...h, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      return req.method === 'HEAD' ? res.end() : fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...h, 'Content-Length': st.size });
    req.method === 'HEAD' ? res.end() : fs.createReadStream(file).pipe(res);
  });
}

function upload(req, res, u) {
  const name = u.searchParams.get('name') || '';
  const ext = path.extname(name).toLowerCase();
  if (!UPLOAD_EXT.has(ext)) return json(res, 400, { error: 'Unsupported file type' });
  if (+req.headers['content-length'] > MAX_UPLOAD) return json(res, 413, { error: 'File too large' });
  const file = crypto.randomBytes(12).toString('hex') + ext;
  const dest = path.join(UPLOADS, file);
  const out = fs.createWriteStream(dest);
  let size = 0, aborted = false;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_UPLOAD && !aborted) {
      aborted = true; out.destroy(); fs.rm(dest, { force: true }, () => {});
      json(res, 413, { error: 'File too large' }); req.destroy();
    }
  });
  req.pipe(out);
  out.on('finish', () => !aborted && json(res, 200, { file }));
  out.on('error', () => { fs.rm(dest, { force: true }, () => {}); if (!res.headersSent) json(res, 500, { error: 'Write failed' }); });
  req.on('aborted', () => { out.destroy(); fs.rm(dest, { force: true }, () => {}); });
}

const FILE_RE = /^[a-f0-9]{24}\.[a-z0-9]+$/;
const validFile = (f) => FILE_RE.test(f) && fs.existsSync(path.join(UPLOADS, f));

function parseProject(f, existing) {
  let media = [];
  try { media = JSON.parse(f.media || '[]'); } catch {}
  media = (Array.isArray(media) ? media : [])
    .filter((m) => m && validFile(m.file))
    .map((m) => ({ file: m.file, caption: String(m.caption || '').slice(0, 300) }));
  const title = String(f.title || '').trim().slice(0, 160);
  if (!title) throw new Error('Title is required');
  let slug = existing?.slug;
  if (!slug || existing.title !== title) {
    const base = slugify(title);
    slug = base;
    for (let i = 2; db.projects.some((p) => p.slug === slug && p.id !== existing?.id); i++) slug = `${base}-${i}`;
  }
  return {
    id: existing?.id || crypto.randomBytes(6).toString('hex'),
    created: existing?.created || Date.now(),
    updated: Date.now(),
    slug, title,
    category: db.categories.some((c) => c.slug === f.category) ? f.category : db.categories[0]?.slug,
    client: String(f.client || '').trim().slice(0, 120),
    year: Math.min(2100, Math.max(1990, parseInt(f.year, 10) || new Date().getFullYear())),
    status: f.status === 'published' ? 'published' : 'draft',
    featured: f.featured === '1',
    summary: String(f.summary || '').trim().slice(0, 240),
    description: String(f.description || '').slice(0, 20000),
    credits: String(f.credits || '').slice(0, 5000),
    tags: String(f.tags || '').split(',').map((t) => t.trim()).filter(Boolean).slice(0, 20),
    cover: validFile(f.cover) ? f.cover : '',
    media,
  };
}

async function admin(req, res, u, p, user) {
  if (req.method === 'POST' && !auth.sameOrigin(req)) return html(res, 403, 'Bad origin');

  if (p === '/admin/api/upload' && req.method === 'PUT') return upload(req, res, u);
  if (p === '/admin' || p === '/admin/') return html(res, 200, v.adminList(user));
  if (p === '/admin/projects/new') return html(res, 200, v.adminForm({ status: 'draft', media: [] }, user));
  if (p === '/admin/projects/save' && req.method === 'POST') {
    const f = await readForm(req);
    const existing = db.projects.find((x) => x.id === f.id);
    try {
      const proj = parseProject(f, existing);
      const before = existing ? filesOf(existing) : [];
      if (existing) Object.assign(existing, proj); else db.projects.push(proj);
      save();
      const keep = new Set(filesOf(proj));
      before.filter((x) => !keep.has(x)).forEach(removeUpload);
      return redirect(res, '/admin');
    } catch (e) {
      return html(res, 400, v.adminForm({ ...f, id: f.id, tags: String(f.tags || '').split(','), media: [] }, user, e.message));
    }
  }
  let m;
  if ((m = /^\/admin\/projects\/([a-f0-9]+)$/.exec(p))) {
    const proj = db.projects.find((x) => x.id === m[1]);
    return proj ? html(res, 200, v.adminForm(proj, user)) : html(res, 404, v.notFound());
  }
  if ((m = /^\/admin\/projects\/([a-f0-9]+)\/delete$/.exec(p)) && req.method === 'POST') {
    const i = db.projects.findIndex((x) => x.id === m[1]);
    if (i >= 0) { const [gone] = db.projects.splice(i, 1); save(); filesOf(gone).forEach(removeUpload); }
    return redirect(res, '/admin');
  }
  if (p === '/admin/settings') {
    if (req.method === 'POST') {
      const f = await readForm(req);
      Object.assign(db.settings, {
        studioName: String(f.studioName || 'Studio').trim().slice(0, 80),
        tagline: String(f.tagline || '').trim().slice(0, 160),
        about: String(f.about || '').slice(0, 10000),
        email: String(f.email || '').trim().slice(0, 120),
      });
      const names = String(f.categories || '').split('\n').map((s) => s.trim()).filter(Boolean);
      if (names.length) db.categories = names.map((name) => ({ name, slug: slugify(name) })).filter((c, i, a) => a.findIndex((x) => x.slug === c.slug) === i);
      save();
      return html(res, 200, v.adminSettings(user, 'Saved.'));
    }
    return html(res, 200, v.adminSettings(user));
  }
  return html(res, 404, v.notFound());
}

http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    const p = decodeURIComponent(u.pathname);
    const user = auth.currentUser(req);

    if (p.startsWith('/static/')) {
      const f = path.normalize(path.join(PUBLIC, p.slice(8)));
      return f.startsWith(PUBLIC + path.sep) ? serveFile(req, res, f, 'public, max-age=300') : html(res, 404, v.notFound());
    }
    if (p.startsWith('/uploads/')) {
      const n = p.slice(9);
      return FILE_RE.test(n) ? serveFile(req, res, path.join(UPLOADS, n), 'public, max-age=86400') : html(res, 404, v.notFound());
    }

    if (p === '/admin/login') {
      if (req.method === 'POST') {
        if (!auth.sameOrigin(req)) return html(res, 403, 'Bad origin');
        const ip = req.socket.remoteAddress;
        if (auth.throttled(ip)) return html(res, 429, v.login('Too many attempts. Try again in a few minutes.'));
        const f = await readForm(req, 10000);
        if (auth.checkLogin(f.user || '', f.pass || '')) return redirect(res, '/admin', { 'Set-Cookie': auth.sessionCookie(f.user) });
        auth.fail(ip);
        return html(res, 401, v.login('Invalid username or password.'));
      }
      return html(res, 200, v.login());
    }
    if (p === '/admin/logout' && req.method === 'POST') return redirect(res, '/admin/login', { 'Set-Cookie': auth.clearCookie() });
    if (p.startsWith('/admin')) {
      if (!user) return p.startsWith('/admin/api/') ? json(res, 401, { error: 'Not signed in' }) : redirect(res, '/admin/login');
      return await admin(req, res, u, p, user);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return html(res, 405, 'Method not allowed');
    if (p === '/') return html(res, 200, v.home(u.searchParams.get('cat') || ''));
    if (p === '/about') return html(res, 200, v.about());
    let m;
    if ((m = /^\/work\/([\w-]+)$/.exec(p))) {
      const proj = db.projects.find((x) => x.slug === m[1] && (x.status === 'published' || user));
      return proj ? html(res, 200, v.project(proj, !!user)) : html(res, 404, v.notFound());
    }
    return html(res, 404, v.notFound());
  } catch (e) {
    console.error(e);
    if (!res.headersSent) html(res, e instanceof URIError ? 400 : 500, 'Request failed');
  }
}).listen(PORT, () => console.log(`Studio CMS running on http://localhost:${PORT}  (admin: /admin)`));
