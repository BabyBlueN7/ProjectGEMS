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

// Kick-Hub Devtool Login
app.post("/devtool/turf-login", (req, res) => {
  const { code } = req.body;

  if (code === "4815162342") {
    return res.json({ ok: true });
  } else {
    return res.status(403).json({ error: "Invalid dev code" });
  }
});

// ✅ Get all verified turfs (for user.html)
app.get("/turfs", (req, res) => {
  db.all("SELECT * FROM turfs WHERE is_verified = 1", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});


// ✅ Get verified turfs by district (for user.html filters)
app.get("/turfs/by-district/:district", (req, res) => {
  const district = req.params.district;
  db.all(
    "SELECT * FROM turfs WHERE LOWER(district) = LOWER(?) AND is_verified = 1",
    [district],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// ✅ Get slots for a turf with Stranger Play progress and booking metadata
app.get("/turfs/:id/slots", (req, res) => {
  const id = req.params.id;
  const date = req.query.date;

  db.get("SELECT * FROM turfs WHERE id=?", [id], (err, turf) => {
    if (err || !turf) return res.status(404).json({ error: "Turf not found" });

    const slots = [];
    const [sh] = turf.start_time.split(":").map(Number);
    const [eh] = turf.end_time.split(":").map(Number);

    db.all(
      `SELECT slot_start, slot_end, mode, customer_id
       FROM bookings
       WHERE turf_id=? AND slot_date=? AND status='booked'`,
      [id, date],
      (err2, bookings) => {
        if (err2) return res.status(500).json({ error: err2.message });

        for (let h = sh; h < eh; h++) {
          const start = `${String(h).padStart(2, "0")}:00`;
          const end = `${String(h + 1).padStart(2, "0")}:00`;

          const slotBookings = bookings.filter(
  b => b.slot_start === start && b.slot_end === end
);

const joined = slotBookings.filter(b => b.mode === "stranger").length;
const hasNormalBooking = slotBookings.some(b => b.mode === "normal");
const strangerLockedIn = joined >= turf.min_players;

const isAvailable = !hasNormalBooking && !strangerLockedIn;

slots.push({
  start,
  end,
  price: turf.price,
  available: isAvailable,
  max_stranger_players: turf.max_stranger_players,
  min_players: turf.min_players,
  progress: { joined },
  bookings: slotBookings.map(b => ({
    mode: b.mode,
    customer_id: b.customer_id
  }))
});
        }

        res.json({ turf, slots });
      }
    );
  });
});

// ✅ Add new turf with district normalization, default player ranges, and contact info
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
    owner_id,
    contact
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
    `INSERT INTO turfs (
      name, location, district, sport, price,
      start_time, end_time, min_players, max_stranger_players,
      owner_id, contact
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      name,
      location,
      district,
      sport,
      price,
      start_time,
      end_time,
      min_players,
      max_stranger_players,
      owner_id,
      contact
    ],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, message: "Turf added successfully" });
    }
  );
});

// Get unverified turfs
app.get("/admin/turfs/unverified", (req, res) => {
  db.all("SELECT * FROM turfs WHERE is_verified = 0", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// GET average rating and count for a turf
app.get("/ratings/turf/:id", (req, res) => {
  const turfId = req.params.id;
  db.get(
    `SELECT ROUND(AVG(rating), 1) AS average, COUNT(*) AS count FROM turf_ratings WHERE turf_id=?`,
    [turfId],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(row || { average: null, count: 0 });
    }
  );
});

// POST a new rating
app.post("/ratings/turf", (req, res) => {
  const { turf_id, user_id, rating } = req.body;
  if (!turf_id || !user_id || !rating) return res.status(400).json({ error: "Missing fields" });

  db.run(
    `INSERT OR REPLACE INTO turf_ratings (turf_id, user_id, rating) VALUES (?, ?, ?)`,
    [turf_id, user_id, rating],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, rating });
    }
  );
});

// Get verified turfs
app.get("/admin/turfs/verified", (req, res) => {
  db.all("SELECT * FROM turfs WHERE is_verified = 1", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

//Add turf approval route:

app.post("/admin/turfs/:id/verify", (req, res) => {
  db.run("UPDATE turfs SET is_verified = 1 WHERE id = ?", [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});


//- Add turf reject route
app.delete("/admin/turfs/:id/remove", (req, res) => {
  db.run("DELETE FROM turfs WHERE id = ?", [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

// POST /bookings
// mode: "normal" or "stranger"
app.post("/bookings", (req, res) => {
  const { turf_id, slot_date, slot_start, slot_end, customer_id, mode } = req.body;

  if (!["normal", "stranger"].includes(mode)) {
    return res.status(400).json({ error: "Invalid mode" });
  }
  if (!slot_date) {
    return res.status(400).json({ error: "Missing slot_date" });
  }

  db.get(
    "SELECT price, min_players, max_stranger_players, owner_id FROM turfs WHERE id=?",
    [turf_id],
    (err, turf) => {
      if (err || !turf) return res.status(400).json({ error: "Invalid turf" });

      const sharePrice = Math.ceil(turf.price / turf.max_stranger_players);
      const priceToCharge = mode === "stranger" ? sharePrice : turf.price;

      // Prevent duplicate booking by same user (same slot/date/time)
      db.get(
        `SELECT COUNT(*) as count FROM bookings
         WHERE turf_id=? AND slot_date=? AND slot_start=? AND slot_end=? AND customer_id=? AND status='booked'`,
        [turf_id, slot_date, slot_start, slot_end, customer_id],
        (errCheck, resultCheck) => {
          if (errCheck) return res.status(500).json({ error: errCheck.message });
          if (resultCheck.count > 0) {
            return res.status(400).json({ error: "You already booked this slot" });
          }

          // Prevent booking if slot already taken (for normal bookings)
          db.get(
            `SELECT COUNT(*) as count FROM bookings
             WHERE turf_id=? AND slot_date=? AND slot_start=? AND slot_end=? AND status='booked' AND mode='normal'`,
            [turf_id, slot_date, slot_start, slot_end],
            (errSlot, resultSlot) => {
              if (errSlot) return res.status(500).json({ error: errSlot.message });
              if (mode === "normal" && resultSlot.count > 0) {
                return res.status(400).json({ error: "Slot already booked" });
              }

              // Wallet check
              db.get(
                "SELECT wallet_balance FROM users WHERE id=?",
                [customer_id],
                (err2, user) => {
                  if (err2 || !user) return res.status(400).json({ error: "Invalid user" });
                  if (user.wallet_balance < priceToCharge) {
                    return res.status(400).json({ error: "Insufficient wallet balance" });
                  }

                  // Deduct from customer wallet
                  db.run(
                    "UPDATE users SET wallet_balance = wallet_balance - ? WHERE id=?",
                    [priceToCharge, customer_id],
                    (err3) => {
                      if (err3) return res.status(500).json({ error: err3.message });

                      // Insert booking with slot_date
                      db.run(
                        `INSERT INTO bookings (turf_id, slot_date, slot_start, slot_end, customer_id, mode, status, price_charged, created_at)
                         VALUES (?,?,?,?,?,?,?,?, datetime('now'))`,
                        [turf_id, slot_date, slot_start, slot_end, customer_id, mode, "booked", priceToCharge],
                        function (err4) {
                          if (err4) return res.status(500).json({ error: err4.message });

                          const bookingId = this.lastID;

                          if (mode === "normal") {
                            db.all(
                              `SELECT id, customer_id, price_charged FROM bookings
                               WHERE turf_id=? AND slot_date=? AND slot_start=? AND slot_end=? AND mode='stranger' AND status='booked'`,
                              [turf_id, slot_date, slot_start, slot_end],
                              (err5, strangers) => {
                                if (err5) return res.status(500).json({ error: err5.message });

                                if (strangers.length >= turf.min_players) {
                                  db.run("UPDATE bookings SET status='canceled' WHERE id=?", [bookingId]);
                                  return res.status(400).json({ error: "Stranger play already locked in" });
                                }

                                strangers.forEach(s => {
                                  db.run("UPDATE users SET wallet_balance = wallet_balance + ? WHERE id=?", [s.price_charged, s.customer_id]);
                                  db.run("UPDATE bookings SET status='canceled' WHERE id=?", [s.id]);
                                });

                                if (turf.owner_id) {
                                  db.run("UPDATE users SET wallet_balance = wallet_balance + ? WHERE id=?", [turf.price, turf.owner_id]);
                                }

                                return res.json({ id: bookingId, status: "booked", mode, price_charged: priceToCharge });
                              }
                            );
                          } else {
                            db.run(
                              "INSERT INTO pending_owner_credits (booking_id, owner_id, amount, status) VALUES (?,?,?, 'pending')",
                              [bookingId, turf.owner_id, priceToCharge],
                              (errPOC) => {
                                if (errPOC) return res.status(500).json({ error: errPOC.message });

                                db.all(
                                  `SELECT id, price_charged FROM bookings
                                   WHERE turf_id=? AND slot_date=? AND slot_start=? AND slot_end=? AND mode='stranger' AND status='booked'`,
                                  [turf_id, slot_date, slot_start, slot_end],
                                  (err6, strangersNow) => {
                                    if (err6) return res.status(500).json({ error: err6.message });

                                    const joined = strangersNow.length;

                                    if (joined >= turf.min_players && turf.owner_id) {
                                      const totalAmount = strangersNow.reduce((sum, b) => sum + (b.price_charged || 0), 0);
                                      db.run("UPDATE users SET wallet_balance = wallet_balance + ? WHERE id=?", [totalAmount, turf.owner_id]);
                                      db.run(
                                        `UPDATE pending_owner_credits
                                         SET status='credited'
                                         WHERE booking_id IN (${strangersNow.map(() => "?").join(",")})`,
                                        strangersNow.map(b => b.id)
                                      );
                                    }

                                    return res.json({ id: bookingId, status: "booked", mode, price_charged: priceToCharge });
                                  }
                                );
                              }
                            );
                          }
                        }
                      );
                    }
                  );
                }
              );
            }
          );
        }
      );
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
            b.slot_date,
            b.slot_start, 
            b.slot_end, 
            b.status, 
            b.mode,
            b.price_charged
     FROM bookings b
     JOIN turfs t ON b.turf_id = t.id
     WHERE b.customer_id = ?
     ORDER BY b.slot_date DESC, b.slot_start ASC`,
    [customer_id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
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
         WHERE turf_id=? AND slot_date=? AND slot_start=? AND slot_end=? AND mode='stranger' AND status='booked'`,
        [booking.turf_id, booking.slot_date, booking.slot_start, booking.slot_end],
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

// ✅ Get pending credits for an owner
app.get("/owner/pending-credits/:owner_id", (req, res) => {
  db.all(
    `SELECT p.booking_id, p.amount, b.slot_date, b.slot_start, b.slot_end, t.location, t.sport
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