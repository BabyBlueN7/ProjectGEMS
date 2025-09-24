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

  // Turfs table with district
  db.run(`CREATE TABLE IF NOT EXISTS turfs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    location TEXT,
    district TEXT,
    sport TEXT,
    price INTEGER,
    start_time TEXT DEFAULT '05:00',
    end_time TEXT DEFAULT '24:00'
  )`);

  // Bookings table
  db.run(`CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    turf_id INTEGER,
    slot_start TEXT,
    slot_end TEXT,
    customer_id INTEGER,
    status TEXT DEFAULT 'booked'
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

// Login route
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
    db.all("SELECT slot_start, slot_end FROM bookings WHERE turf_id=?", [id], (err, booked) => {
      const bookedSet = new Set(booked.map(b => `${b.slot_start}-${b.slot_end}`));

      for (let h = sh; h < eh; h++) {
        const start = `${h}:00`;
        const end = `${h + 1}:00`;
        const key = `${start}-${end}`;
        slots.push({
          start,
          end,
          price: turf.price,
          available: !bookedSet.has(key)
        });
      }

      res.json({ turf, slots });
    });
  });
});

// --- Turf Creation Route (Owner adds new turf) ---
app.post("/turfs", (req, res) => {
  const { name, location, district, sport, price } = req.body;
  db.run(
    "INSERT INTO turfs (name, location, district, sport, price) VALUES (?,?,?,?,?)",
    [name, location, district, sport, price],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, name, location, district, sport, price });
    }
  );
});

// --- Booking Routes ---
app.post("/bookings", (req, res) => {
  const { turf_id, slot_start, slot_end, customer_id } = req.body;
  db.run(
    "INSERT INTO bookings (turf_id, slot_start, slot_end, customer_id) VALUES (?,?,?,?)",
    [turf_id, slot_start, slot_end, customer_id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, turf_id, slot_start, slot_end, customer_id });
    }
  );
});

app.get("/bookings/:customer_id", (req, res) => {
  const customer_id = req.params.customer_id;
  db.all("SELECT * FROM bookings WHERE customer_id=?", [customer_id], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// --- Start server ---
app.listen(4001, () =>
  console.log("Turf backend running on http://localhost:4001")
);