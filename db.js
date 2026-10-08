// Base de datos sencilla (SQLite integrado en Node, sin dependencias)
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(__dirname + '/huerto.db');

db.exec(`
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,                 -- salt:hash (scrypt)
  rol TEXT NOT NULL CHECK (rol IN ('comprador','vendedor')),
  creado TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS sesiones (
  token TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  creada TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS productos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  descripcion TEXT,
  precio REAL NOT NULL,
  stock INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pedidos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente TEXT NOT NULL,
  email TEXT NOT NULL,
  direccion TEXT NOT NULL,
  total REAL NOT NULL,
  estado TEXT NOT NULL DEFAULT 'pendiente',
  fecha TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS pedido_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pedido_id INTEGER NOT NULL REFERENCES pedidos(id),
  producto_id INTEGER NOT NULL REFERENCES productos(id),
  cantidad INTEGER NOT NULL,
  precio_unitario REAL NOT NULL
);
`);

// Migracion: agrega columnas nuevas a bases de datos creadas en el sprint anterior
function agregarColumna(tabla, columna, definicion) {
  const existe = db.prepare(`PRAGMA table_info(${tabla})`).all().some(c => c.name === columna);
  if (!existe) db.exec(`ALTER TABLE ${tabla} ADD COLUMN ${columna} ${definicion}`);
}
agregarColumna('productos', 'vendedor_id', 'INTEGER REFERENCES usuarios(id)'); // NULL = tienda oficial
agregarColumna('productos', 'imagen', 'TEXT');                                 // ruta, ej. /uploads/abc.png
agregarColumna('productos', 'activo', 'INTEGER NOT NULL DEFAULT 1');
agregarColumna('pedidos', 'comprador_id', 'INTEGER REFERENCES usuarios(id)');

// Datos iniciales
if (db.prepare('SELECT COUNT(*) AS n FROM productos').get().n === 0) {
  const ins = db.prepare('INSERT INTO productos (nombre, descripcion, precio, stock) VALUES (?,?,?,?)');
  ins.run('Kit Albahaca', 'Semillas de albahaca, tierra preparada, maceta biodegradable y guia impresa paso a paso.', 189, 50);
  ins.run('Kit Menta', 'Semillas de menta, tierra preparada, maceta biodegradable y guia impresa paso a paso.', 189, 50);
  ins.run('Kit Cilantro', 'Semillas de cilantro, tierra preparada, maceta biodegradable y guia impresa paso a paso.', 179, 50);
  ins.run('Kit Perejil', 'Semillas de perejil, tierra preparada, maceta biodegradable y guia impresa paso a paso.', 179, 50);
  ins.run('Kit Combo 3 Hierbas', 'Albahaca, menta y cilantro: 3 macetas, 3 sobres de semillas, tierra y guia.', 489, 30);
}

module.exports = db;
