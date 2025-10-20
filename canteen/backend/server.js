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

  // Menu table
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

  db.get("SELECT price FROM menu WHERE id=?", [item_id], (err, item) => {
    if (err || !item) return res.status(400).json({ error: "Invalid item" });

    const total = item.price * quantity;

    // Check wallet balance
    db.get("SELECT wallet_balance FROM users WHERE id=?", [customer_id], (err2, user) => {
      if (err2 || !user) return res.status(400).json({ error: "Invalid user" });
      if (user.wallet_balance < total) {
        return res.status(400).json({ error: "Insufficient wallet balance" });
      }

      // Deduct wallet
      db.run("UPDATE users SET wallet_balance = wallet_balance - ? WHERE id=?", [total, customer_id]);

      // Insert order
      db.run(
        "INSERT INTO orders (customer_id, item_id, quantity, status) VALUES (?,?,?,?)",
        [customer_id, item_id, quantity, "pending"],
        function (err3) {
          if (err3) return res.status(500).json({ error: err3.message });
          res.json({ id: this.lastID, customer_id, item_id, quantity, total, status: "pending" });
        }
      );
    });
  });
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

// ✅ Owner: Get all orders for their college
app.get("/owner/orders/:college_id", (req, res) => {
  const college_id = req.params.college_id;
  db.all(
    `SELECT o.id, u.name as student_name, m.item, o.quantity, o.status
     FROM orders o
     JOIN users u ON o.customer_id = u.id
     JOIN menu m ON o.item_id = m.id
     JOIN college_menu cm ON m.id = cm.menu_id
     WHERE cm.college_id = ?`,
    [college_id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// ✅ Owner: Update order status (delivered / canceled)
app.put("/orders/:id/status", (req, res) => {
  const { status } = req.body; // "delivered" or "canceled"
  db.run(
    "UPDATE orders SET status=? WHERE id=?",
    [status, req.params.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ updated: this.changes });
    }
  );
});

// Update order status (student cancel or owner update)
app.put("/orders/:id/status", (req, res) => {
  const { status } = req.body; // pending, preparing, ready, delivered, canceled
  db.run("UPDATE orders SET status=? WHERE id=?", [status, req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ updated: this.changes });
  });
});

// Analytics for owner
app.get("/owner/analytics/:college_id", (req, res) => {
  const { college_id } = req.params;
  const today = new Date().toISOString().split("T")[0];
  const weekAgo = new Date(Date.now() - 7*24*60*60*1000).toISOString().split("T")[0];
  const analytics = {};

  // Daily sales
  db.get(
    `SELECT COUNT(*) as orders, SUM(o.quantity * m.price) as revenue
     FROM orders o
     JOIN menu m ON o.item_id = m.id
     JOIN college_menu cm ON m.id = cm.menu_id
     WHERE cm.college_id=? AND DATE(o.created_at)=? AND o.status='delivered'`,
    [college_id, today],
    (err, row) => {
      analytics.daily = row || { orders: 0, revenue: 0 };

      // Weekly sales
      db.get(
        `SELECT COUNT(*) as orders, SUM(o.quantity * m.price) as revenue
         FROM orders o
         JOIN menu m ON o.item_id = m.id
         JOIN college_menu cm ON m.id = cm.menu_id
         WHERE cm.college_id=? AND DATE(o.created_at) >= ? AND o.status='delivered'`,
        [college_id, weekAgo],
        (err2, row2) => {
          analytics.weekly = row2 || { orders: 0, revenue: 0 };

          // Collected money
          db.get(
            `SELECT SUM(o.quantity * m.price) as collected
             FROM orders o
             JOIN menu m ON o.item_id = m.id
             JOIN college_menu cm ON m.id = cm.menu_id
             WHERE cm.college_id=? AND o.status='delivered'`,
            [college_id],
            (err3, row3) => {
              analytics.collected = row3?.collected || 0;

              // Popular items
              db.all(
                `SELECT m.item, SUM(o.quantity) as sold
                 FROM orders o
                 JOIN menu m ON o.item_id = m.id
                 JOIN college_menu cm ON m.id = cm.menu_id
                 WHERE cm.college_id=? AND o.status='delivered'
                 GROUP BY m.item
                 ORDER BY sold DESC
                 LIMIT 5`,
                [college_id],
                (err4, rows4) => {
                  analytics.popular = rows4 || [];
                  res.json(analytics);
                }
              );
            }
          );
        }
      );
    }
  );
});

// Add money to wallet
app.post("/wallet/add", (req, res) => {
  const { user_id, amount } = req.body;
  db.run(
    "UPDATE users SET wallet_balance = wallet_balance + ? WHERE id=?",
    [amount, user_id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      db.get("SELECT wallet_balance FROM users WHERE id=?", [user_id], (err2, row) => {
        if (err2) return res.status(500).json({ error: err2.message });
        res.json({ balance: row.wallet_balance });
      });
    }
  );
});

// Get wallet balance
app.get("/wallet/:user_id", (req, res) => {
  const { user_id } = req.params;
  db.get("SELECT wallet_balance FROM users WHERE id=?", [user_id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ balance: row.wallet_balance });
  });
});

// --- Start server ---
app.listen(4002, () => console.log("Canteen backend running on http://localhost:4002"));