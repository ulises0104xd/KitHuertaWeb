// Servidor sencillo sin dependencias: node server.js
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'admin123'; // solo para el prototipo
const PUBLIC = path.join(__dirname, 'public');
const UPLOADS = path.join(PUBLIC, 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });

const TIPOS = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp'
};
const MAX_BODY = 3e6;   // ~3 MB (la imagen viaja en base64)
const MAX_IMAGEN = 1.5e6;

class ErrorHttp extends Error {
  constructor(code, msg) { super(msg); this.code = code; }
}

function json(res, code, data, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(data));
}

function leerBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', c => {
      s += c;
      if (s.length > MAX_BODY) { reject(new ErrorHttp(413, 'Archivo demasiado grande')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { reject(new ErrorHttp(400, 'JSON invalido')); } });
  });
}

// ---------- Usuarios y sesiones ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function verificarPassword(pw, guardado) {
  const [salt, hash] = guardado.split(':');
  const intento = crypto.scryptSync(pw, salt, 64);
  return crypto.timingSafeEqual(intento, Buffer.from(hash, 'hex'));
}
function cookieSid(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)sid=([a-f0-9]+)/);
  return m && m[1];
}
function usuarioActual(req) {
  const sid = cookieSid(req);
  if (!sid) return null;
  return db.prepare(`SELECT u.id, u.nombre, u.email, u.rol FROM sesiones s
    JOIN usuarios u ON u.id = s.usuario_id WHERE s.token = ?`).get(sid) || null;
}
function iniciarSesion(res, usuario, code = 200) {
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sesiones (token, usuario_id) VALUES (?,?)').run(token, usuario.id);
  json(res, code, usuario, { 'Set-Cookie': `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800` });
}
function requerirRol(req, rol) {
  const u = usuarioActual(req);
  if (!u) throw new ErrorHttp(401, 'Inicia sesion primero');
  if (u.rol !== rol) throw new ErrorHttp(403, `Solo para cuentas de ${rol}`);
  return u;
}

function registrar(b) {
  const nombre = String(b.nombre || '').trim();
  const email = String(b.email || '').trim().toLowerCase();
  const password = String(b.password || '');
  if (!nombre || nombre.length > 80) throw new ErrorHttp(400, 'Nombre invalido');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ErrorHttp(400, 'Correo invalido');
  if (password.length < 6) throw new ErrorHttp(400, 'La contrasena debe tener al menos 6 caracteres');
  if (!['comprador', 'vendedor'].includes(b.rol)) throw new ErrorHttp(400, 'Elige comprador o vendedor');
  if (db.prepare('SELECT 1 FROM usuarios WHERE email = ?').get(email)) throw new ErrorHttp(400, 'Ese correo ya esta registrado');
  const r = db.prepare('INSERT INTO usuarios (nombre, email, password, rol) VALUES (?,?,?,?)')
    .run(nombre, email, hashPassword(password), b.rol);
  return { id: Number(r.lastInsertRowid), nombre, email, rol: b.rol };
}

// ---------- Productos ----------
function guardarImagen(dataUrl) {
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) throw new ErrorHttp(400, 'La imagen debe ser PNG, JPG o WEBP');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_IMAGEN) throw new ErrorHttp(400, 'La imagen pesa mas de 1.5 MB');
  const nombre = crypto.randomBytes(12).toString('hex') + (m[1] === 'jpeg' ? '.jpg' : '.' + m[1]);
  fs.writeFileSync(path.join(UPLOADS, nombre), buf);
  return '/uploads/' + nombre;
}

function validarProducto(b) {
  const nombre = String(b.nombre || '').trim();
  const descripcion = String(b.descripcion || '').trim();
  const precio = Number(b.precio);
  const stock = Number(b.stock);
  if (!nombre || nombre.length > 100) throw new ErrorHttp(400, 'Nombre invalido (max. 100 caracteres)');
  if (descripcion.length > 600) throw new ErrorHttp(400, 'Descripcion demasiado larga (max. 600)');
  if (!(precio > 0) || precio > 1e6) throw new ErrorHttp(400, 'Precio invalido');
  if (!Number.isInteger(stock) || stock < 0) throw new ErrorHttp(400, 'Stock invalido');
  return { nombre, descripcion, precio, stock };
}

function crearProducto(u, b) {
  const p = validarProducto(b);
  const imagen = b.imagen ? guardarImagen(b.imagen) : null;
  const r = db.prepare('INSERT INTO productos (nombre, descripcion, precio, stock, imagen, vendedor_id) VALUES (?,?,?,?,?,?)')
    .run(p.nombre, p.descripcion, p.precio, p.stock, imagen, u.id);
  return { id: Number(r.lastInsertRowid) };
}

function propio(u, id) {
  const p = db.prepare('SELECT * FROM productos WHERE id = ? AND vendedor_id = ?').get(id, u.id);
  if (!p) throw new ErrorHttp(404, 'Kit no encontrado');
  return p;
}

function editarProducto(u, id, b) {
  const actual = propio(u, id);
  const p = validarProducto(b);
  const imagen = b.imagen ? guardarImagen(b.imagen) : actual.imagen;
  db.prepare('UPDATE productos SET nombre=?, descripcion=?, precio=?, stock=?, imagen=? WHERE id=?')
    .run(p.nombre, p.descripcion, p.precio, p.stock, imagen, id);
  return { ok: true };
}

// ---------- Pedidos ----------
function crearPedido(u, b) {
  const cliente = String(b.cliente || '').trim();
  const direccion = String(b.direccion || '').trim();
  if (!cliente || !direccion) throw new ErrorHttp(400, 'Faltan datos de entrega');
  if (!Array.isArray(b.items) || b.items.length === 0) throw new ErrorHttp(400, 'El carrito esta vacio');

  db.exec('BEGIN');
  try {
    let total = 0;
    const lineas = [];
    for (const it of b.items) {
      const cant = parseInt(it.cantidad, 10);
      const p = db.prepare('SELECT * FROM productos WHERE id = ? AND activo = 1').get(it.producto_id);
      if (!p || !(cant > 0)) throw new ErrorHttp(400, 'Hay un kit que ya no esta disponible');
      if (p.stock < cant) throw new ErrorHttp(400, `Sin stock suficiente de ${p.nombre}`);
      total += p.precio * cant;
      lineas.push({ p, cant });
    }
    const r = db.prepare('INSERT INTO pedidos (cliente, email, direccion, total, comprador_id) VALUES (?,?,?,?,?)')
      .run(cliente, u.email, direccion, total, u.id);
    const id = Number(r.lastInsertRowid);
    for (const { p, cant } of lineas) {
      db.prepare('INSERT INTO pedido_items (pedido_id, producto_id, cantidad, precio_unitario) VALUES (?,?,?,?)')
        .run(id, p.id, cant, p.precio);
      db.prepare('UPDATE productos SET stock = stock - ? WHERE id = ?').run(cant, p.id);
    }
    db.exec('COMMIT');
    return { id, total };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ---------- Rutas ----------
async function api(req, res, url) {
  const { pathname: ruta } = url;
  const metodo = req.method;
  let m;

  if (ruta === '/api/registro' && metodo === 'POST') {
    return iniciarSesion(res, registrar(await leerBody(req)), 201);
  }
  if (ruta === '/api/login' && metodo === 'POST') {
    const b = await leerBody(req);
    const u = db.prepare('SELECT * FROM usuarios WHERE email = ?').get(String(b.email || '').trim().toLowerCase());
    if (!u || !verificarPassword(String(b.password || ''), u.password)) throw new ErrorHttp(401, 'Correo o contrasena incorrectos');
    return iniciarSesion(res, { id: u.id, nombre: u.nombre, email: u.email, rol: u.rol });
  }
  if (ruta === '/api/logout' && metodo === 'POST') {
    const sid = cookieSid(req);
    if (sid) db.prepare('DELETE FROM sesiones WHERE token = ?').run(sid);
    return json(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; Path=/; Max-Age=0' });
  }
  if (ruta === '/api/yo' && metodo === 'GET') {
    return json(res, 200, usuarioActual(req)); // null si no hay sesion
  }

  if (ruta === '/api/productos' && metodo === 'GET') {
    return json(res, 200, db.prepare(`SELECT p.id, p.nombre, p.descripcion, p.precio, p.stock, p.imagen,
      COALESCE(u.nombre, 'Tienda oficial') AS vendedor
      FROM productos p LEFT JOIN usuarios u ON u.id = p.vendedor_id
      WHERE p.activo = 1 ORDER BY p.id DESC`).all());
  }
  if (ruta === '/api/productos' && metodo === 'POST') {
    const u = requerirRol(req, 'vendedor');
    return json(res, 201, crearProducto(u, await leerBody(req)));
  }
  if (ruta === '/api/mis-productos' && metodo === 'GET') {
    const u = requerirRol(req, 'vendedor');
    return json(res, 200, db.prepare('SELECT * FROM productos WHERE vendedor_id = ? AND activo = 1 ORDER BY id DESC').all(u.id));
  }
  if ((m = ruta.match(/^\/api\/productos\/(\d+)$/))) {
    const u = requerirRol(req, 'vendedor');
    if (metodo === 'PUT') return json(res, 200, editarProducto(u, m[1], await leerBody(req)));
    if (metodo === 'DELETE') { // se oculta (no se borra) para conservar el historial de pedidos
      propio(u, m[1]);
      db.prepare('UPDATE productos SET activo = 0 WHERE id = ?').run(m[1]);
      return json(res, 200, { ok: true });
    }
  }
  if (ruta === '/api/mis-ventas' && metodo === 'GET') {
    const u = requerirRol(req, 'vendedor');
    return json(res, 200, db.prepare(`SELECT ped.id AS pedido, ped.fecha, ped.cliente, ped.email, ped.direccion, ped.estado,
      p.nombre, i.cantidad, i.precio_unitario
      FROM pedido_items i
      JOIN productos p ON p.id = i.producto_id
      JOIN pedidos ped ON ped.id = i.pedido_id
      WHERE p.vendedor_id = ? ORDER BY ped.id DESC`).all(u.id));
  }

  if (ruta === '/api/pedidos' && metodo === 'POST') {
    const u = requerirRol(req, 'comprador');
    return json(res, 201, crearPedido(u, await leerBody(req)));
  }

  // Panel admin general (clave simple, solo prototipo)
  if (ruta.startsWith('/api/admin/')) {
    if (url.searchParams.get('key') !== ADMIN_KEY) throw new ErrorHttp(401, 'Clave incorrecta');
    if (ruta === '/api/admin/pedidos' && metodo === 'GET') {
      const pedidos = db.prepare('SELECT * FROM pedidos ORDER BY id DESC').all();
      const items = db.prepare(`SELECT i.cantidad, p.nombre FROM pedido_items i
        JOIN productos p ON p.id = i.producto_id WHERE i.pedido_id = ?`);
      return json(res, 200, pedidos.map(p => ({ ...p, items: items.all(p.id) })));
    }
    if ((m = ruta.match(/^\/api\/admin\/pedidos\/(\d+)$/)) && metodo === 'PUT') {
      const { estado } = await leerBody(req);
      if (!['pendiente', 'enviado', 'entregado'].includes(estado)) throw new ErrorHttp(400, 'Estado invalido');
      db.prepare('UPDATE pedidos SET estado = ? WHERE id = ?').run(estado, m[1]);
      return json(res, 200, { ok: true });
    }
  }
  throw new ErrorHttp(404, 'Ruta no encontrada');
}

function estatico(res, url) {
  const archivo = url.pathname === '/' ? '/acceso.html' : url.pathname;
  const ruta = path.join(PUBLIC, path.normalize(archivo));
  if (!ruta.startsWith(PUBLIC) || !fs.existsSync(ruta) || fs.statSync(ruta).isDirectory()) {
    res.writeHead(404); return res.end('No encontrado');
  }
  res.writeHead(200, {
    'Content-Type': (TIPOS[path.extname(ruta)] || 'application/octet-stream') + (path.extname(ruta).match(/png|jpg|webp/) ? '' : '; charset=utf-8'),
    'X-Content-Type-Options': 'nosniff'
  });
  fs.createReadStream(ruta).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else estatico(res, url);
  } catch (e) {
    if (e instanceof ErrorHttp) return json(res, e.code, { error: e.message });
    console.error(e);
    json(res, 500, { error: 'Error del servidor' });
  }
});

server.listen(PORT, () => console.log(`Tienda en http://localhost:${PORT}  |  Admin: /admin.html (clave: ${ADMIN_KEY})`));
