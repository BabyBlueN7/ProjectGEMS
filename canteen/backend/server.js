const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const cors = require("cors");

const app = express();
app.use(cors());
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
    UNIQUE(admission_no, role)
  )`);

  // Menu table (no college_id here anymore)
  db.run(`CREATE TABLE IF NOT EXISTS menu (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item TEXT,
    price INTEGER,
    available INTEGER DEFAULT 1
  )`);

  // Link table: which menu items belong to which colleges
  db.run(`CREATE TABLE IF NOT EXISTS college_menu (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    college_id INTEGER,
    menu_id INTEGER,
    FOREIGN KEY (college_id) REFERENCES colleges(id),
    FOREIGN KEY (menu_id) REFERENCES menu(id)
  )`);

  // Orders table
  db.run(`CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER,
    item_id INTEGER,
    quantity INTEGER,
    status TEXT DEFAULT 'pending'
  )`);

  // Auto-insert sample college + menu if empty
  db.get("SELECT COUNT(*) as count FROM colleges", (err, row) => {
    if (row.count === 0) {
      db.run("INSERT INTO colleges (name) VALUES (?)", ["My College"]);
      console.log("Sample college inserted ✅");
    }
  });

  db.get("SELECT COUNT(*) as count FROM menu", (err, row) => {
    if (row.count === 0) {
      const stmt = db.prepare("INSERT INTO menu (item, price, available) VALUES (?,?,?)");
      stmt.run("Masala Dosa", 40, 1);
      stmt.run("Veg Biriyani", 60, 1);
      stmt.run("Tea", 10, 1);
      stmt.run("Coffee", 15, 0);
      stmt.finalize();
      console.log("Sample menu inserted ✅");

      // Link all items to college_id = 1
      db.all("SELECT id FROM menu", [], (err, rows) => {
        rows.forEach(r => {
          db.run("INSERT INTO college_menu (college_id, menu_id) VALUES (?,?)", [1, r.id]);
        });
        console.log("Linked sample menu to college 1 ✅");
      });
    }
  });
});

// --- Routes ---

// ✅ Signup route for student or owner
app.post("/signup", (req, res) => {
  const { name, admission_no, password, role, college_id } = req.body;

  db.run(
    "INSERT INTO users (name, admission_no, password, role, college_id) VALUES (?,?,?,?,?)",
    [name, admission_no, password, role, college_id],
    function (err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({
        id: this.lastID,
        name,
        admission_no,
        role,
        college_id
      });
    }
  );
});

// Login route for student or owner
app.post("/login", (req, res) => {
  const { admission_no, password, role } = req.body;
  console.log("Login attempt:", admission_no, password, role); // 👈 debug
  db.get(
    "SELECT * FROM users WHERE admission_no=? AND password=? AND role=?",
    [admission_no, password, role],
    (err, user) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!user) return res.status(401).json({ error: "Invalid credentials" });
      res.json(user);
    }
  );
});

// Get today's menu for a specific college
app.get("/menu/today/:college_id", (req, res) => {
  const college_id = req.params.college_id;
  db.all(
    `SELECT m.id, m.item, m.price, m.available
     FROM menu m
     JOIN college_menu cm ON m.id = cm.menu_id
     WHERE cm.college_id = ? AND m.available = 1`,
    [college_id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// Add new menu item and link it to a college
app.post("/menu", (req, res) => {
  const { item, price, available, college_id } = req.body;

  db.run(
    "INSERT INTO menu (item, price, available) VALUES (?,?,?)",
    [item, price, available],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });

      const menuId = this.lastID;

      db.run(
        "INSERT INTO college_menu (college_id, menu_id) VALUES (?,?)",
        [college_id, menuId],
        function (err2) {
          if (err2) return res.status(500).json({ error: err2.message });
          res.json({ id: menuId, item, price, available, college_id });
        }
      );
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

// Get all orders for a student with item details
app.get("/orders/:customer_id", (req, res) => {
  const customer_id = req.params.customer_id;
  db.all(
    `SELECT o.id, m.item, m.price, o.quantity, o.status
     FROM orders o
     JOIN menu m ON o.item_id = m.id
     WHERE o.customer_id = ?`,
    [customer_id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// Get all colleges
app.get("/colleges", (req, res) => {
  db.all("SELECT * FROM colleges", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// --- Start server ---
app.listen(4002, () => console.log("Canteen backend running on http://localhost:4002"));