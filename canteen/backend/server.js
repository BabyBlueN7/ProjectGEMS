// --- Utility Functions ---
const {
  normalizeText,
  normalizeDistrict,
  checkWallet
} = require("./utils/helpers");

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
  // Colleges table (✅ FIXED: added college_code)
  db.run(`CREATE TABLE IF NOT EXISTS colleges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    college_code TEXT UNIQUE
  )`);

  // Users table (✅ FIXED: added wallet_balance)
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    admission_no TEXT,
    password TEXT,
    role TEXT CHECK(role IN ('student', 'owner')),
    college_id INTEGER,
    wallet_balance INTEGER DEFAULT 0,
    UNIQUE(admission_no, role)
  )`);

  // Menu table
  db.run(`CREATE TABLE IF NOT EXISTS menu (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item TEXT,
    price INTEGER,
    in_stock INTEGER DEFAULT 1
  )`);

  // Link table: which menu items belong to which colleges
  db.run(`CREATE TABLE IF NOT EXISTS college_menu (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    college_id INTEGER,
    menu_id INTEGER,
    FOREIGN KEY (college_id) REFERENCES colleges(id),
    FOREIGN KEY (menu_id) REFERENCES menu(id)
  )`);

  // Orders table (✅ FIXED: added created_at and college_id)
  db.run(`CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER,
    item_id INTEGER,
    quantity INTEGER,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    college_id INTEGER
  )`);
});

// --- Routes ---

// ✅ Signup route for owner
app.post("/signup-owner", (req, res) => {
  const { name, password, college_id, college_code } = req.body;
  const normalizedCode = college_code?.trim().toLowerCase();

  db.get("SELECT college_code FROM colleges WHERE id=?", [college_id], (err, college) => {
    if (err) return res.status(500).json({ error: "Database error" });
    if (!college) return res.status(400).json({ error: "Invalid college selected" });

    const actualCode = college.college_code?.trim().toLowerCase();
    if (actualCode !== normalizedCode) {
      return res.status(400).json({ error: "Incorrect college code" });
    }

    db.get("SELECT id FROM users WHERE role='owner' AND college_id=?", [college_id], (err2, existingOwner) => {
      if (err2) return res.status(500).json({ error: "Database error" });
      if (existingOwner) {
        return res.status(400).json({ error: "Owner already exists for this college" });
      }

      db.run(
        "INSERT INTO users (name, admission_no, password, role, college_id) VALUES (?,?,?,?,?)",
        [name, college_code, password, "owner", college_id],
        function (err3) {
          if (err3) return res.status(500).json({ error: "Signup failed" });
          res.json({ id: this.lastID, name, role: "owner", college_id });
        }
      );
    });
  });
});

// ✅ Signup route for student
app.post("/signup", (req, res) => {
  const { name, admission_no, password, role, college_id } = req.body;

  if (role !== "student") {
    return res.status(400).json({ error: "Invalid role for this route" });
  }

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

// ✅ Login route for student or owner
app.post("/login", (req, res) => {
  const { admission_no, college_code, password, role, college_id } = req.body;

  if (role === "student") {
    db.get(
      "SELECT * FROM users WHERE admission_no=? AND password=? AND role='student' AND college_id=?",
      [admission_no, password, college_id],
      (err, user) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!user) return res.status(401).json({ error: "Invalid student credentials" });
        res.json(user);
      }
    );
  } else if (role === "owner") {
    db.get(
      `SELECT u.id, u.name, u.role, u.college_id
       FROM users u
       JOIN colleges c ON u.college_id = c.id
       WHERE u.role='owner' AND u.admission_no=? AND u.password=? AND u.college_id=?`,
      [college_code, password, college_id],
      (err, user) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!user) return res.status(401).json({ error: "Invalid owner credentials" });
        res.json(user);
      }
    );
  } else {
    res.status(400).json({ error: "Invalid role" });
  }
});

// ✅ Digi-Canteen Devtool Login
app.post("/devtool/canteen-login", (req, res) => {
  const { code } = req.body;
  if (code === "876543210") {
    return res.json({ ok: true });
  } else {
    return res.status(403).json({ error: "Invalid dev code" });
  }
});

// ✅ Get today's menu for a specific college
app.get("/menu/today/:college_id", (req, res) => {
  const college_id = req.params.college_id;
  db.all(
    `SELECT m.id, m.item, m.price, m.in_stock
     FROM menu m
     JOIN college_menu cm ON m.id = cm.menu_id
     WHERE cm.college_id = ? AND m.in_stock = 1`,
    [college_id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// ✅ Add menu item with normalization and mapping
app.post("/menu", (req, res) => {
  let { item, price, in_stock, college_id } = req.body;
  item = normalizeText(item);

  if (!item || price == null || in_stock == null || !college_id) {
    return res.status(400).json({ error: "Invalid menu payload" });
  }

  db.run(
    "INSERT INTO menu (item, price, in_stock) VALUES (?,?,?)",
    [item, price, in_stock],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });

      const menuId = this.lastID;

      db.run(
        "INSERT INTO college_menu (college_id, menu_id) VALUES (?,?)",
        [college_id, menuId],
        function (err2) {
          if (err2) return res.status(500).json({ error: err2.message });
          res.json({ id: menuId, item, price, in_stock, college_id });
        }
      );
    }
  );
});

// ✅ Get all colleges
app.get("/admin/colleges", (req, res) => {
  db.all("SELECT * FROM colleges", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// ✅ Add a college
app.post("/admin/colleges", (req, res) => {
  const { name, college_code } = req.body;
  db.run(
    "INSERT INTO colleges (name, college_code) VALUES (?, ?)",
    [name, college_code],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID });
    }
  );
});

// ✅ Remove a college
app.delete("/admin/colleges/:id", (req, res) => {
  db.run("DELETE FROM colleges WHERE id = ?", [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

// ✅ All Canteen Orders for devtool
app.get("/admin/orders", (req, res) => {
  db.all(
    `SELECT o.id, o.status, o.quantity, o.created_at,
            u.name AS student_name,
            m.item AS item_name, m.price,
            c.name AS college_name
     FROM orders o
     JOIN users u ON o.customer_id = u.id
     JOIN menu m ON o.item_id = m.id
     JOIN colleges c ON u.college_id = c.id
     ORDER BY o.created_at DESC`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// ✅ Create a new order (student)
app.post("/orders", (req, res) => {
  const { customer_id, item_id, quantity, college_id } = req.body;

  if (!customer_id || !item_id || !quantity || quantity <= 0 || !college_id) {
    return res.status(400).json({ error: "Invalid order payload" });
  }

  db.get("SELECT price FROM menu WHERE id=?", [item_id], (errItem, item) => {
    if (errItem || !item) return res.status(400).json({ error: "Invalid item" });

    const total = item.price * quantity;

    db.get("SELECT wallet_balance FROM users WHERE id=?", [customer_id], (errUser, user) => {
      if (errUser || !user) return res.status(400).json({ error: "Invalid user" });
      if (user.wallet_balance < total) {
        return res.status(400).json({ error: "Insufficient wallet balance" });
      }

      db.run("UPDATE users SET wallet_balance = wallet_balance - ? WHERE id=?", [total, customer_id], (errDeduct) => {
        if (errDeduct) return res.status(500).json({ error: errDeduct.message });

        db.run(
          "INSERT INTO orders (customer_id, item_id, quantity, status, created_at, college_id) VALUES (?,?,?,?,datetime('now'), ?)",
          [customer_id, item_id, quantity, "pending", college_id],
          function (errOrder) {
            if (errOrder) return res.status(500).json({ error: errOrder.message });
            res.json({ id: this.lastID, customer_id, item_id, quantity, total, status: "pending" });
          }
        );
      });
    });
  });
});

// ✅ Get all orders for a student
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

// ✅ Get all colleges (public route)
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
     WHERE o.college_id = ?`,
    [college_id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// ✅ Update order status (delivered or canceled)
// Refunds wallet if canceled and not already canceled
app.put("/orders/:id/status", (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const allowedStatuses = ["pending", "confirmed", "preparing", "ready", "delivered", "canceled"];
  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }

  db.get(
    `SELECT o.id, o.customer_id, o.item_id, o.quantity, o.status, m.price
     FROM orders o JOIN menu m ON o.item_id = m.id WHERE o.id=?`,
    [id],
    (err, row) => {
      if (err || !row) return res.status(404).json({ error: "Order not found" });

      const wasCanceled = row.status === "canceled";
      const willCancel = status === "canceled";
      const total = row.price * row.quantity;

      db.run("UPDATE orders SET status=? WHERE id=?", [status, id], (err2) => {
        if (err2) return res.status(500).json({ error: err2.message });

        if (willCancel && !wasCanceled) {
          db.run(
            "UPDATE users SET wallet_balance = wallet_balance + ? WHERE id=?",
            [total, row.customer_id],
            (err3) => {
              if (err3) return res.status(500).json({ error: err3.message });
              return res.json({
                id: row.id,
                status: "canceled",
                refund: total,
                message: "Order canceled and refunded 💸"
              });
            }
          );
        } else {
          return res.json({
            id: row.id,
            status,
            message: `Order updated to "${status}" ✅`
          });
        }
      });
    }
  );
});

// ✅ Owner marks item as out of stock and cancels unconfirmed orders
app.put("/menu/:id/outofstock", (req, res) => {
  const itemId = req.params.id;

  // Step 1: Mark item as not in stock
  db.run("UPDATE menu SET in_stock = 0 WHERE id=?", [itemId], (err1) => {
    if (err1) return res.status(500).json({ error: err1.message });

    // Step 2: Get all pending orders for this item
    db.all(
      `SELECT o.id, o.customer_id, o.quantity, o.status, m.price
       FROM orders o JOIN menu m ON o.item_id = m.id
       WHERE o.item_id=? AND o.status = 'pending'`,
      [itemId],
      (err2, orders) => {
        if (err2) return res.status(500).json({ error: err2.message });

        let canceledCount = 0;

        orders.forEach(order => {
          const total = order.price * order.quantity;

          db.run("UPDATE orders SET status='canceled' WHERE id=?", [order.id]);
          db.run("UPDATE users SET wallet_balance = wallet_balance + ? WHERE id=?", [total, order.customer_id]);
          canceledCount++;
        });

        res.json({
          message: "Item marked out of stock. Unconfirmed orders canceled and refunded.",
          canceled: canceledCount
        });
      }
    );
  });
});

// ✅ Owner Analytics Dashboard
app.get("/owner/analytics/:college_id", (req, res) => {
  const { college_id } = req.params;
  const today = new Date().toISOString().split("T")[0];
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const analytics = {};

  // Daily sales
  db.get(
    `SELECT COUNT(*) as orders, SUM(o.quantity * m.price) as revenue
     FROM orders o
     JOIN menu m ON o.item_id = m.id
     WHERE o.college_id=? AND DATE(o.created_at)=? AND o.status='delivered'`,
    [college_id, today],
    (err, row) => {
      analytics.daily = row || { orders: 0, revenue: 0 };

      // Weekly sales
      db.get(
        `SELECT COUNT(*) as orders, SUM(o.quantity * m.price) as revenue
         FROM orders o
         JOIN menu m ON o.item_id = m.id
         WHERE o.college_id=? AND DATE(o.created_at) >= ? AND o.status='delivered'`,
        [college_id, weekAgo],
        (err2, row2) => {
          analytics.weekly = row2 || { orders: 0, revenue: 0 };

          // Collected money
          db.get(
            `SELECT SUM(o.quantity * m.price) as collected
             FROM orders o
             JOIN menu m ON o.item_id = m.id
             WHERE o.college_id=? AND o.status='delivered'`,
            [college_id],
            (err3, row3) => {
              analytics.collected = row3?.collected || 0;

              // Popular items
              db.all(
                `SELECT m.item, SUM(o.quantity) as sold
                 FROM orders o
                 JOIN menu m ON o.item_id = m.id
                 WHERE o.college_id=? AND o.status='delivered'
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

// ✅ Add money to wallet
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

// ✅ Get wallet balance
app.get("/wallet/:user_id", (req, res) => {
  const { user_id } = req.params;
  db.get("SELECT wallet_balance FROM users WHERE id=?", [user_id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: "User not found" });
    res.json({ balance: row.wallet_balance });
  });
});

// ✅ Start the server
app.listen(4002, () => console.log("Canteen backend running on http://localhost:4002"));