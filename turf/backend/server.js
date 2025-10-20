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

// Get slots for a specific turf (with booking check)
app.get("/turfs/:id/slots", (req, res) => {
  const id = req.params.id;
  db.get("SELECT * FROM turfs WHERE id=?", [id], (err, turf) => {
    if (err || !turf) return res.status(404).json({ error: "Turf not found" });

    const slots = [];
    const [sh] = turf.start_time.split(":").map(Number);
    const [eh] = turf.end_time.split(":").map(Number);

    // Fetch booked slots for this turf
    db.all(
      "SELECT slot_start, slot_end FROM bookings WHERE turf_id=? AND status='booked'",
      [id],
      (err, booked) => {
        if (err) return res.status(500).json({ error: err.message });

        // Guard against empty results
        const bookedSet = new Set((booked || []).map(b => `${b.slot_start}-${b.slot_end}`));

        for (let h = sh; h < eh; h++) {
          const start = `${String(h).padStart(2, "0")}:00`;
          const end = `${String(h + 1).padStart(2, "0")}:00`;
          const key = `${start}-${end}`;
          slots.push({
            start,
            end,
            price: turf.price,
            available: !bookedSet.has(key)
          });
        }

        res.json({ turf, slots });
      }
    );
  });
});
// --- Turf Creation Route (Owner adds new turf) ---
app.post("/turfs", (req, res) => {
  const { name, location, district, sport, price, owner_id, min_target_players, max_stranger_players } = req.body;
  db.run(
    "INSERT INTO turfs (name, location, district, sport, price, owner_id, min_target_players, max_stranger_players) VALUES (?,?,?,?,?,?,?,?)",
    [name, location, district, sport, price, owner_id, min_target_players || 0, max_stranger_players || 0],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, name, location, district, sport, price, owner_id, min_target_players, max_stranger_players });
    }
  );
});

// --- Booking Routes ---

// Create booking (handles auto-cancel for stranger mode)
app.post("/bookings", (req, res) => {
  const { turf_id, slot_start, slot_end, customer_id, mode } = req.body;

  db.run(
    "INSERT INTO bookings (turf_id, slot_start, slot_end, customer_id, mode) VALUES (?,?,?,?,?)",
    [turf_id, slot_start, slot_end, customer_id, mode || "single"],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });

      const bookingId = this.lastID;

      // If this is a single booking, cancel all stranger bookings for same slot
      if (mode === "single") {
        db.get(
          `SELECT COUNT(*) as joined, t.min_target_players 
           FROM bookings b 
           JOIN turfs t ON b.turf_id = t.id 
           WHERE b.turf_id=? AND b.slot_start=? AND b.slot_end=? 
             AND b.mode='stranger' AND b.status='booked'`,
          [turf_id, slot_start, slot_end],
          (err2, row) => {
            if (err2) return res.status(500).json({ error: err2.message });

            if (row.joined < row.min_target_players) {
              // Cancel strangers
              db.run(
                "UPDATE bookings SET status='canceled' WHERE turf_id=? AND slot_start=? AND slot_end=? AND mode='stranger' AND status='booked'",
                [turf_id, slot_start, slot_end]
              );
            } else {
              return res.status(400).json({ error: "Stranger play already locked in" });
            }
          }
        );
      }

      res.json({ id: bookingId, turf_id, slot_start, slot_end, customer_id, mode });
    }
  );
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

// Get stranger play progress for a turf slot
app.get("/turfs/:id/stranger-progress/:slot_start", (req, res) => {
  const { id, slot_start } = req.params;

  // Step 1: Get turf settings (min/max stranger players)
  db.get(
    "SELECT max_stranger_players, min_target_players FROM turfs WHERE id=?",
    [id],
    (err, turf) => {
      if (err || !turf) return res.status(404).json({ error: "Turf not found" });

      // Step 2: Count how many players have already joined this slot in stranger mode
      db.get(
        "SELECT COUNT(*) as joined FROM bookings WHERE turf_id=? AND slot_start=? AND mode='stranger' AND status='booked'",
        [id, slot_start],
        (err2, row) => {
          // Step 3: Return progress data to frontend
          res.json({
            joined: row.joined,                 // how many players joined
            max: turf.max_stranger_players,     // max stranger players allowed
            min: turf.min_target_players        // minimum needed to lock slot
          });
        }
      );
    }
  );
});

// --- Start server ---
app.listen(4001, () => {
  console.log("Turf backend running on http://localhost:4001");
});