const express = require("express");
const sqlite3 = require("sqlite3").verbose();

const app = express();
app.use(express.json());

// Root test
app.get("/", (req, res) => res.send("Canteen backend running!"));

// --- Database setup ---
const db = new sqlite3.Database("./canteen.db");

db.serialize(() => {
  // Colleges table
  db.run(`CREATE TABLE IF NOT EXISTS colleges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE
  )`);

  // Users table
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    admission_no TEXT,
    password TEXT,
    role TEXT CHECK(role IN ('student', 'owner')),
    college_id INTEGER,
    UNIQUE(college_id, role)
  )`);

  // Menu table (supports college_id)
  db.run(`CREATE TABLE IF NOT EXISTS menu (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item TEXT,
    price INTEGER,
    available INTEGER DEFAULT 1,
    college_id INTEGER
  )`);

  // Orders table
  db.run(`CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER,
    item_id INTEGER,
    quantity INTEGER,
    status TEXT DEFAULT 'pending'
  )`);

  // Auto-insert sample menu if empty
  db.get("SELECT COUNT(*) as count FROM menu", (err, row) => {
    if (row.count === 0) {
      const stmt = db.prepare("INSERT INTO menu (item, price, available, college_id) VALUES (?,?,?,?)");
      stmt.run("Masala Dosa", 40, 1, 1);
      stmt.run("Veg Biriyani", 60, 1, 1);
      stmt.run("Tea", 10, 1, 1);
      stmt.run("Coffee", 15, 0, 1); // unavailable
      stmt.finalize();
      console.log("Sample menu inserted ✅");
    }
  });
});

// --- Routes ---

// Get today's menu for a specific college
app.get("/menu/today/:college_id", (req, res) => {
  const college_id = req.params.college_id;
  db.all(
    "SELECT * FROM menu WHERE available=1 AND college_id=?",
    [college_id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// Add new menu item (owner)
app.post("/menu", (req, res) => {
  const { item, price, available, college_id } = req.body;
  db.run(
    "INSERT INTO menu (item, price, available, college_id) VALUES (?,?,?,?)",
    [item, price, available, college_id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, item, price, available, college_id });
    }
  );
});

// Create a new order (student)
app.post("/orders", (req, res) => {
  const { customer_id, item_id, quantity } = req.body;
  db.run(
    "INSERT INTO orders (customer_id, item_id, quantity) VALUES (?,?,?)",
    [customer_id, item_id, quantity],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, customer_id, item_id, quantity });
    }
  );
});

// Get all orders for a student
app.get("/orders/:customer_id", (req, res) => {
  const customer_id = req.params.customer_id;
  db.all("SELECT * FROM orders WHERE customer_id=?", [customer_id], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// --- Start server ---
app.listen(4002, () => console.log("Canteen backend running on http://localhost:4002"));