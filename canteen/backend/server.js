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
      const stmt = db.prepare("INSERT INTO menu (item, price, in_stock) VALUES (?,?,?)");
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
  const { admission_no, college_code, password, role } = req.body;

  if (role === "student") {
    db.get(
      "SELECT * FROM users WHERE admission_no=? AND password=? AND role='student'",
      [admission_no, password],
      (err, user) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!user) return res.status(401).json({ error: "Invalid student credentials" });
        res.json(user);
      }
    );
  } else if (role === "owner") {
    db.get(
      `SELECT u.id, u.name, u.email, u.role, u.college_id
       FROM users u
       JOIN colleges c ON u.college_id = c.id
       WHERE u.role='owner' AND c.college_code=? AND u.password=?`,
      [college_code, password],
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

//Check if an owner already exists for that college
app.post("/signup-owner", (req, res) => {
  const { name, email, password, college_id, college_code } = req.body;

  // Normalize inputs
  const normalizedCode = college_code?.trim().toLowerCase();

  // Step 1: Validate college exists and code matches
  db.get("SELECT college_code FROM colleges WHERE id=?", [college_id], (err, college) => {
    if (err) return res.status(500).json({ error: "Database error" });
    if (!college) return res.status(400).json({ error: "Invalid college selected" });

    const actualCode = college.college_code?.trim().toLowerCase();
    if (actualCode !== normalizedCode) {
      return res.status(400).json({ error: "Incorrect college code" });
    }

    // Step 2: Check if an owner already exists for this college
    db.get("SELECT id FROM users WHERE role='owner' AND college_id=?", [college_id], (err2, existingOwner) => {
      if (err2) return res.status(500).json({ error: "Database error" });
      if (existingOwner) {
        return res.status(400).json({ error: "Owner already exists for this college" });
      }

      // Step 3: Create owner account
      db.run(
        "INSERT INTO users (name, email, password, role, college_id) VALUES (?,?,?,?,?)",
        [name, email, password, "owner", college_id],
        function (err3) {
          if (err3) return res.status(500).json({ error: "Signup failed" });

          console.log(`✅ Owner created for college ${college_id} with email ${email}`);
          res.json({ id: this.lastID, name, email, role: "owner", college_id });
        }
      );
    });
  });
});

// Get today's menu for a specific college
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

// ✅ Add menu item with case normalization and college mapping
app.post("/menu", (req, res) => {
  let { item, price, in_stock, college_id } = req.body;
  item = normalizeText(item); // normalize item name

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

// Create a new order (student)
app.post("/orders", (req, res) => {
  const { customer_id, item_id, quantity } = req.body;

  if (!customer_id || !item_id || !quantity || quantity <= 0) {
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
          "INSERT INTO orders (customer_id, item_id, quantity, status, created_at) VALUES (?,?,?,?,datetime('now'))",
          [customer_id, item_id, quantity, "pending"],
          function (errOrder) {
            if (errOrder) return res.status(500).json({ error: errOrder.message });
            res.json({ id: this.lastID, customer_id, item_id, quantity, total, status: "pending" });
          }
        );
      });
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

// ✅ Update order status (delivered or canceled)
// If status is changed to "canceled", refund the total price to the user's wallet.
// Uses joined query to get item price from menu table.
// Prevents double refund if already canceled.
app.put("/orders/:id/status", (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  // ✅ Add "confirmed" to allowed statuses
  if (!["pending", "confirmed", "canceled", "delivered"].includes(status)) {
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
              return res.json({ id: row.id, status: "canceled", refund: total });
            }
          );
        } else {
          return res.json({ id: row.id, status });
        }
      });
    }
  );
});

// ✅ Owner marks item as out of stock and cancels only unconfirmed orders
app.put("/menu/:id/outofstock", (req, res) => {
  const itemId = req.params.id;

  // Step 1: Mark item as not instock in the menu
  db.run("UPDATE menu SET in_stock = 0 WHERE id=?", [itemId], (err1) => {
    if (err1) return res.status(500).json({ error: err1.message });

    // Step 2: Get all pending or unconfirmed orders for this item
    db.all(
      `SELECT o.id, o.customer_id, o.quantity, o.status, m.price
       FROM orders o JOIN menu m ON o.item_id = m.id
       WHERE o.item_id=? AND o.status IN ('pending')`,
      [itemId],
      (err2, orders) => {
        if (err2) return res.status(500).json({ error: err2.message });

        let canceledCount = 0;

        // Step 3: Cancel only unconfirmed orders and refund
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
    if (!row) return res.status(404).json({ error: "User not found" }); // ✅ Fix
    res.json({ balance: row.wallet_balance });
  });
});



// --- Start server ---
app.listen(4002, () => console.log("Canteen backend running on http://localhost:4002"));