function normalizeDistrict(d) {
  if (!d) return d;
  return d.charAt(0).toUpperCase() + d.slice(1).toLowerCase();
}

const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();

const app = express();
app.use(cors());
app.use(bodyParser.json());

// --- Database setup ---
const db = new sqlite3.Database("./turf.db");

db.serialize(() => {
  // Users table
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    email TEXT UNIQUE,
    password TEXT,
    role TEXT CHECK(role IN ('customer', 'owner'))
  )`);

  // Turfs table with owner_id
  db.run(`CREATE TABLE IF NOT EXISTS turfs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    location TEXT,
    district TEXT,
    sport TEXT,
    price INTEGER,
    start_time TEXT DEFAULT '05:00',
    end_time TEXT DEFAULT '24:00',
    owner_id INTEGER
  )`);

  // Bookings table with mode column
  db.run(`CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    turf_id INTEGER,
    slot_start TEXT,
    slot_end TEXT,
    customer_id INTEGER,
    status TEXT DEFAULT 'booked',
    mode TEXT DEFAULT 'single' -- "single" or "stranger"
  )`);

  // Auto-insert sample turfs if empty
  db.get("SELECT COUNT(*) as count FROM turfs", (err, row) => {
    if (row.count === 0) {
      const stmt = db.prepare("INSERT INTO turfs (name, location, district, sport, price) VALUES (?,?,?,?,?)");
      stmt.run("Bypass Arcana", "Malappuram Town", "Malappuram", "Football 7s", 1000);
      stmt.run("Check Point", "Chemmanckadav", "Malappuram", "Football 7s", 1200);
      stmt.run("Base Turf", "Kunnummal", "Malappuram", "Football 10s", 1500);
      stmt.run("TurfZone", "Thalassery", "Kannur", "Football 7s", 1100);
      stmt.run("GreenPlay", "Kozhikode City", "Kozhikode", "Football 5s", 900);
      stmt.finalize();
      console.log("Sample turfs inserted ✅");
    }
  });
});

// --- Routes ---

// Root test
app.get("/", (req, res) => res.send("Turf backend running!"));

// Signup route
app.post("/signup", (req, res) => {
  const { name, email, password, role } = req.body;

  if (!["customer", "owner"].includes(role)) {
    return res.status(400).json({ error: "Invalid role" });
  }

  db.run(
    "INSERT INTO users (name,email,password,role) VALUES (?,?,?,?)",
    [name, email, password, role],
    function (err) {
      if (err) {
        return res.status(400).json({ error: "Email already used" });
      }
      res.json({ id: this.lastID, name, role });
    }
  );
});

// Login route (works for both customer & owner)
app.post("/login", (req, res) => {
  const { email, password } = req.body;

  db.get(
    "SELECT * FROM users WHERE email=? AND password=?",
    [email, password],
    (err, row) => {
      if (!row) {
        return res.status(400).json({ error: "Invalid login" });
      }
      res.json({ id: row.id, name: row.name, role: row.role });
    }
  );
});

// Get all turfs
app.get("/turfs", (req, res) => {
  db.all("SELECT * FROM turfs", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});


// Get turfs by district
app.get("/turfs/by-district/:district", (req, res) => {
  const district = req.params.district;
  db.all("SELECT * FROM turfs WHERE LOWER(district) = LOWER(?)", [district], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Get slots for a turf with Stranger Play progress
app.get("/turfs/:id/slots", (req, res) => {
  const id = req.params.id;

  db.get("SELECT * FROM turfs WHERE id=?", [id], (err, turf) => {
    if (err || !turf) return res.status(404).json({ error: "Turf not found" });

    const slots = [];
    const [sh] = turf.start_time.split(":").map(Number);
    const [eh] = turf.end_time.split(":").map(Number);

    // Fetch booked slots and stranger play counts
    db.all(
      `SELECT b.slot_start, b.slot_end, 
              SUM(CASE WHEN b.mode='stranger' AND b.status='booked' THEN 1 ELSE 0 END) as joined
       FROM bookings b
       WHERE b.turf_id=? 
       GROUP BY b.slot_start, b.slot_end`,
      [id],
      (err2, rows) => {
        if (err2) return res.status(500).json({ error: err2.message });

        // Map slot progress
        const progressMap = {};
        (rows || []).forEach(r => {
          progressMap[`${r.slot_start}-${r.slot_end}`] = {
            joined: r.joined || 0,
            target: turf.min_target_players
          };
        });

        for (let h = sh; h < eh; h++) {
          const start = `${String(h).padStart(2, "0")}:00`;
          const end = `${String(h + 1).padStart(2, "0")}:00`;
          const key = `${start}-${end}`;

          const progress = progressMap[key] || { joined: 0, target: turf.min_target_players };

          slots.push({
            start,
            end,
            price: turf.price,
            available: true, // still available unless fully locked
            progress
          });
        }

        res.json({ turf, slots });
      }
    );
  });
});

// ✅ Add new turf with district normalization and default player ranges
app.post("/turfs", (req, res) => {
  let { location, district, sport, price, start_time, end_time, min_range_players, max_range_players } = req.body;

  district = normalizeDistrict(district); // normalize district name

  // Set default player ranges based on sport
  if (!min_range_players || !max_range_players) {
    if (sport === "Football 5s") {
      min_range_players = 5;
      max_range_players = 5;
    } else if (sport === "Football 7s") {
      min_range_players = 7;
      max_range_players = 7;
    } else if (sport === "Football 10s") {
      min_range_players = 10;
      max_range_players = 10;
    } else if (sport === "Cricket") {
      min_range_players = 11;
      max_range_players = 11;
    } else {
      min_range_players = 0;
      max_range_players = 10; // fallback
    }
  }

  db.run(
    `INSERT INTO turfs (location, district, sport, price, start_time, end_time, min_range_players, max_range_players) 
     VALUES (?,?,?,?,?,?,?,?)`,
    [location, district, sport, price, start_time, end_time, min_range_players, max_range_players],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, message: "Turf added successfully" });
    }
  );
});

// --- Booking Routes ---

// Create booking (handles wallet + auto-cancel/refund for stranger mode)
app.post("/bookings", (req, res) => {
  const { turf_id, slot_start, slot_end, customer_id, mode } = req.body;

  db.get("SELECT price, min_target_players, max_stranger_players FROM turfs WHERE id=?", [turf_id], (err, turf) => {
    if (err || !turf) return res.status(400).json({ error: "Invalid turf" });

    // Check wallet balance
    db.get("SELECT wallet_balance FROM users WHERE id=?", [customer_id], (err2, user) => {
      if (err2 || !user) return res.status(400).json({ error: "Invalid user" });
      if (user.wallet_balance < turf.price) {
        return res.status(400).json({ error: "Insufficient wallet balance" });
      }

      // Deduct wallet for this booking
      db.run("UPDATE users SET wallet_balance = wallet_balance - ? WHERE id=?", [turf.price, customer_id], (err3) => {
        if (err3) return res.status(500).json({ error: err3.message });

        // Insert booking
        db.run(
          "INSERT INTO bookings (turf_id, slot_start, slot_end, customer_id, mode, status) VALUES (?,?,?,?,?,?)",
          [turf_id, slot_start, slot_end, customer_id, mode || "single", "booked"],
          function (err4) {
            if (err4) return res.status(500).json({ error: err4.message });

            const bookingId = this.lastID;

            // If this is a single booking, cancel all stranger bookings for same slot
            if (mode === "single") {
              db.all(
                `SELECT b.id, b.customer_id
                 FROM bookings b
                 WHERE b.turf_id=? AND b.slot_start=? AND b.slot_end=? 
                   AND b.mode='stranger' AND b.status='booked'`,
                [turf_id, slot_start, slot_end],
                (err5, strangers) => {
                  if (err5) return res.status(500).json({ error: err5.message });

                  const joined = strangers.length;

                  if (joined < turf.min_target_players) {
                    // Refund each stranger booking
                    const refundAmount = Math.floor(turf.price / turf.max_stranger_players);

                    strangers.forEach(s => {
                      db.run("UPDATE users SET wallet_balance = wallet_balance + ? WHERE id=?", [refundAmount, s.customer_id]);
                      db.run("UPDATE bookings SET status='canceled' WHERE id=?", [s.id]);
                    });
                  } else {
                    // Stranger play already locked in, reject single booking
                    db.run("UPDATE bookings SET status='canceled' WHERE id=?", [bookingId]);
                    return res.status(400).json({ error: "Stranger play already locked in" });
                  }

                  return res.json({ id: bookingId, turf_id, slot_start, slot_end, customer_id, mode, price: turf.price });
                }
              );
            } else {
              // Stranger booking just succeeds
              res.json({ id: bookingId, turf_id, slot_start, slot_end, customer_id, mode, price: turf.price });
            }
          }
        );
      });
    });
  });
});

// Get bookings for a specific customer (My Bookings page)
app.get("/bookings/:customer_id", (req, res) => {
  const { customer_id } = req.params;

  db.all(
    `SELECT b.id, 
            t.name AS turf_name, 
            t.location, 
            t.sport, 
            t.price,
            b.slot_start, 
            b.slot_end, 
            b.status, 
            b.mode
     FROM bookings b
     JOIN turfs t ON b.turf_id = t.id
     WHERE b.customer_id = ?`,
    [customer_id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// --- Owner Routes ---

// Get turfs owned by an owner
app.get("/turfs/owner/:owner_id", (req, res) => {
  db.all("SELECT * FROM turfs WHERE owner_id=?", [req.params.owner_id], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Get bookings for all turfs owned by an owner
app.get("/owner/bookings/:owner_id", (req, res) => {
  db.all(
    `SELECT b.id, u.name as customer_name, t.name as turf_name, 
            b.slot_start, b.slot_end, b.status, b.mode
     FROM bookings b
     JOIN users u ON b.customer_id = u.id
     JOIN turfs t ON b.turf_id = t.id
     WHERE t.owner_id = ?`,
    [req.params.owner_id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// --- Booking Status Update (Owner action) ---
app.put("/bookings/:id/status", (req, res) => {
  const { status } = req.body; // expected: "confirmed" or "canceled"
  db.run(
    "UPDATE bookings SET status=? WHERE id=?",
    [status, req.params.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });

      if (status === "canceled") {
        console.log(`Refund triggered for booking ${req.params.id} 💸`);
      }

      res.json({ updated: this.changes });
    }
  );
});

// Update turf details
app.put("/turfs/:id", (req, res) => {
  const { location, district, sport, price, min_target_players, max_stranger_players } = req.body;
  db.run(
    "UPDATE turfs SET location=?, district=?, sport=?, price=?, min_target_players=?, max_stranger_players=? WHERE id=?",
    [location, district, sport, price, min_target_players, max_stranger_players, req.params.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ updated: this.changes });
    }
  );
});

// Delete a turf
app.delete("/turfs/:id", (req, res) => {
  db.run("DELETE FROM turfs WHERE id=?", [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ deleted: this.changes });
  });
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
app.listen(4001, () => {
  console.log("Turf backend running on http://localhost:4001");
});