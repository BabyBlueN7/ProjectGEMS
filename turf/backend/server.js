// --- Utility Functions ---
const {
  normalizeText,
  normalizeDistrict,
  checkWallet,
  calculateRefund
} = require("./utils/helpers");

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

// ✅ Get slots for a turf with Stranger Play progress
app.get("/turfs/:id/slots", (req, res) => {
  const id = req.params.id;

  db.get("SELECT * FROM turfs WHERE id=?", [id], (err, turf) => {
    if (err || !turf) return res.status(404).json({ error: "Turf not found" });

    const slots = [];
    const [sh] = turf.start_time.split(":").map(Number);
    const [eh] = turf.end_time.split(":").map(Number);

    db.all(
      `SELECT b.slot_start, b.slot_end, COUNT(*) as joined
       FROM bookings b
       WHERE b.turf_id=? AND b.mode='stranger' AND b.status='booked'
       GROUP BY b.slot_start, b.slot_end`,
      [id],
      (err2, rows) => {
        if (err2) return res.status(500).json({ error: err2.message });

        const progressMap = {};
        (rows || []).forEach(r => {
          const key = `${r.slot_start}-${r.slot_end}`;
          progressMap[key] = { joined: r.joined };
        });

        for (let h = sh; h < eh; h++) {
          const start = `${String(h).padStart(2, "0")}:00`;
          const end = `${String(h + 1).padStart(2, "0")}:00`;
          const key = `${start}-${end}`;

          const progress = progressMap[key] || { joined: 0 };

          slots.push({
  start,
  end,
  price: turf.price,
  available: true,
  max_stranger_players: turf.max_stranger_players,
  min_players: turf.min_players,
  progress
});
        }

        res.json({ turf, slots }); // ✅ Correctly placed inside db.all callback
      }
    );
  });
});

// ✅ Add new turf with district normalization and default player ranges
app.post("/turfs", (req, res) => {
  let {
    name,
    location,
    district,
    sport,
    price,
    start_time,
    end_time,
    min_players,
    max_stranger_players,
    owner_id
  } = req.body;

  district = normalizeDistrict(district);

  // Set default player ranges if missing
  if (!min_players || !max_stranger_players) {
    if (sport === "Football 5s") {
      min_players = 5;
      max_stranger_players = 5;
    } else if (sport === "Football 7s") {
      min_players = 7;
      max_stranger_players = 7;
    } else if (sport === "Football 10s") {
      min_players = 10;
      max_stranger_players = 10;
    } else if (sport === "Cricket") {
      min_players = 11;
      max_stranger_players = 11;
    } else {
      min_players = 0;
      max_stranger_players = 10;
    }
  }

  db.run(
    `INSERT INTO turfs (name, location, district, sport, price, start_time, end_time, min_players, max_stranger_players, owner_id)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [name, location, district, sport, price, start_time, end_time, min_players, max_stranger_players, owner_id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, message: "Turf added successfully" });
    }
  );
});

// ✅ Create booking (wallet deduction, refund, owner credit)
app.post("/bookings", (req, res) => {
  const { turf_id, slot_start, slot_end, customer_id, mode } = req.body;

  db.get("SELECT price, min_players, max_stranger_players, owner_id FROM turfs WHERE id=?", [turf_id], (err, turf) => {
    if (err || !turf) return res.status(400).json({ error: "Invalid turf" });

    const priceToCharge = mode === "stranger"
      ? Math.ceil(turf.price / turf.max_stranger_players)
      : turf.price;

    db.get("SELECT wallet_balance FROM users WHERE id=?", [customer_id], (err2, user) => {
      if (err2 || !user) return res.status(400).json({ error: "Invalid user" });
      if (user.wallet_balance < priceToCharge) {
        return res.status(400).json({ error: "Insufficient wallet balance" });
      }

      db.run("UPDATE users SET wallet_balance = wallet_balance - ? WHERE id=?", [priceToCharge, customer_id], (err3) => {
        if (err3) return res.status(500).json({ error: err3.message });

        db.run(
          "INSERT INTO bookings (turf_id, slot_start, slot_end, customer_id, mode, status, created_at) VALUES (?,?,?,?,?,?,datetime('now'))",
          [turf_id, slot_start, slot_end, customer_id, mode || "single", "booked"],
          function (err4) {
            if (err4) return res.status(500).json({ error: err4.message });

            const bookingId = this.lastID;

            if (mode === "single") {
              db.all(
                `SELECT id, customer_id FROM bookings 
                 WHERE turf_id=? AND slot_start=? AND slot_end=? AND mode='stranger' AND status='booked'`,
                [turf_id, slot_start, slot_end],
                (err5, strangers) => {
                  if (err5) return res.status(500).json({ error: err5.message });

                  if (strangers.length < turf.min_players) {
                    const refundAmount = Math.floor(turf.price / turf.max_stranger_players);
                    strangers.forEach(s => {
                      db.run("UPDATE users SET wallet_balance = wallet_balance + ? WHERE id=?", [refundAmount, s.customer_id]);
                      db.run("UPDATE bookings SET status='canceled' WHERE id=?", [s.id]);
                    });

                    if (turf.owner_id) {
                      db.run("UPDATE users SET wallet_balance = wallet_balance + ? WHERE id=?", [turf.price, turf.owner_id]);
                    }

                    return res.json({ id: bookingId, status: "booked", mode, price: priceToCharge });
                  } else {
                    db.run("UPDATE bookings SET status='canceled' WHERE id=?", [bookingId]);
                    return res.status(400).json({ error: "Stranger play already locked in" });
                  }
                }
              );
            } else {
  // Insert pending credit immediately after booking
  db.run(
    "INSERT INTO pending_owner_credits (booking_id, owner_id, amount) VALUES (?,?,?)",
    [bookingId, turf.owner_id, priceToCharge]
  );

  // Check how many players have joined this slot
  db.all(
    `SELECT COUNT(*) as joined FROM bookings 
     WHERE turf_id=? AND slot_start=? AND slot_end=? AND mode='stranger' AND status='booked'`,
    [turf_id, slot_start, slot_end],
    (err6, result) => {
      const joined = result?.[0]?.joined || 0;

      if (joined >= turf.min_players && turf.owner_id) {
        const share = Math.floor(turf.price / turf.max_stranger_players);
        const totalAmount = share * joined;

        // Credit owner and mark pending credit as fulfilled
        db.run("UPDATE users SET wallet_balance = wallet_balance + ? WHERE id=?", [totalAmount, turf.owner_id]);
        db.run("UPDATE pending_owner_credits SET status='credited' WHERE booking_id=?", [bookingId]);
      }

      res.json({ id: bookingId, status: "booked", mode, price: priceToCharge });
    }
  );
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
  const { location, district, sport, price, min_players, max_stranger_players } = req.body;
  db.run(
    "UPDATE turfs SET location=?, district=?, sport=?, price=?, min_players=?, max_stranger_players=? WHERE id=?",
    [location, district, sport, price, min_players, max_stranger_players, req.params.id],
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

// ✅ Create a new slot
app.post("/slots", (req, res) => {
  const { turf_id, date, time, booked_by } = req.body;

  db.run(
    `INSERT INTO slots (turf_id, date, time, booked_by, status, players)
     VALUES (?,?,?,?,?,?)`,
    [turf_id, date, time, booked_by, "open", String(booked_by)],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, turf_id, date, time, booked_by });
    }
  );
});

// ✅ Auto-cancel stranger bookings if not enough players joined
app.post("/bookings/:id/autocancel", (req, res) => {
  const { id } = req.params;

  db.get("SELECT * FROM bookings WHERE id=?", [id], (err, booking) => {
    if (err || !booking) return res.status(404).json({ error: "Booking not found" });

    if (booking.mode !== "stranger" || booking.status !== "booked") {
      return res.json({ status: booking.status, message: "Not a pending stranger booking" });
    }

    db.get("SELECT min_players, price, max_stranger_players FROM turfs WHERE id=?", [booking.turf_id], (err2, turf) => {
      if (err2 || !turf) return res.status(400).json({ error: "Turf not found" });

      db.all(
        `SELECT id, customer_id FROM bookings 
         WHERE turf_id=? AND slot_start=? AND slot_end=? AND mode='stranger' AND status='booked'`,
        [booking.turf_id, booking.slot_start, booking.slot_end],
        (err3, bookings) => {
          if (err3) return res.status(500).json({ error: err3.message });

          if (bookings.length < turf.min_players) {
            const refundAmount = Math.floor(turf.price / turf.max_stranger_players);
            bookings.forEach(b => {
              db.run("UPDATE users SET wallet_balance = wallet_balance + ? WHERE id=?", [refundAmount, b.customer_id]);
              db.run("UPDATE bookings SET status='canceled' WHERE id=?", [b.id]);
            });
            return res.json({ canceled: bookings.length, refund: refundAmount });
          } else {
            return res.json({ message: "Stranger play locked in" });
          }
        }
      );
    });
  });
});

// ✅ Get pending credits for an owner
app.get("/owner/pending-credits/:owner_id", (req, res) => {
  db.all(
    `SELECT p.booking_id, p.amount, b.slot_start, b.slot_end, t.location, t.sport
     FROM pending_owner_credits p
     JOIN bookings b ON p.booking_id = b.id
     JOIN turfs t ON b.turf_id = t.id
     WHERE p.owner_id = ? AND p.status = 'pending'`,
    [req.params.owner_id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// --- Start server ---
app.listen(4001, () => {
  console.log("Turf backend running on http://localhost:4001");
});