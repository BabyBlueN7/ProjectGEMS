// --- Utility Functions ---
const {
  normalizeText,
  normalizeDistrict,
  checkWallet,
  calculateRefund
} = require("./utils/helpers");

const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const bodyParser = require("body-parser");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();

const app = express();

// multer setup: store uploads in public/images with original extension
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'public/images')),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, unique + ext);
  }
});
const upload = multer({ storage });

// multer setup for profile photos: store in Profile folder
const profileStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const profileDir = path.join(__dirname, 'Profile');
    // Create Profile directory if it doesn't exist
    if (!fs.existsSync(profileDir)) {
      fs.mkdirSync(profileDir, { recursive: true });
    }
    cb(null, profileDir);
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, unique + ext);
  }
});
const uploadProfile = multer({ storage: profileStorage });

// serve static assets (e.g. turf images) from public/images
app.use('/images', express.static(path.join(__dirname, 'public/images')));

// serve profile photos from Profile folder
app.use('/profile', express.static(path.join(__dirname, 'Profile')));

// serve frontend static files (home page, HTML, CSS, JS)
const frontendPath = path.join(__dirname, '..', 'frontend');
app.use(express.static(frontendPath));

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
    role TEXT CHECK(role IN ('customer', 'owner')),
    contact TEXT,
    wallet_balance INTEGER DEFAULT 0,
    profile_photo TEXT
  )`);
  // ensure profile_photo column exists on older databases
  db.run("ALTER TABLE users ADD COLUMN profile_photo TEXT", function(err) {
    // ignore error if column already exists
  });

  // Turfs table with owner_id and optional image URL
  db.run(`CREATE TABLE IF NOT EXISTS turfs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    location TEXT,
    district TEXT,
    sport TEXT,
    price INTEGER,
    start_time TEXT DEFAULT '05:00',
    end_time TEXT DEFAULT '24:00',
    owner_id INTEGER,
    image_url TEXT
  )`);
  // ensure column exists on older databases
  db.run("ALTER TABLE turfs ADD COLUMN image_url TEXT", function(err) {
    // ignore error if column already exists
  });

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

  // Turf ratings table
  db.run(`CREATE TABLE IF NOT EXISTS turf_ratings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    turf_id INTEGER,
    user_id INTEGER,
    rating INTEGER,
    UNIQUE(turf_id, user_id)
  )`);

  // Pending owner credits table
  db.run(`CREATE TABLE IF NOT EXISTS pending_owner_credits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id INTEGER,
    owner_id INTEGER,
    amount INTEGER,
    status TEXT DEFAULT 'pending'
  )`);
});

// --- Routes ---

// Serve home page
app.get("/", (req, res) => {
  res.sendFile(path.join(frontendPath, 'home.html'));
});

// Signup route
app.post("/signup", (req, res) => {
  const { name, email, password, role, contact } = req.body;

  if (!["customer", "owner"].includes(role)) {
    return res.status(400).json({ error: "Invalid role" });
  }

  const query = role === "customer"
    ? "INSERT INTO users (name, email, contact, password, role) VALUES (?, ?, ?, ?, ?)"
    : "INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)";

  const params = role === "customer"
    ? [name, email, contact, password, role]
    : [name, email, password, role];

  db.run(query, params, function (err) {
    if (err) {
      return res.status(400).json({ error: "Email already used" });
    }

    res.json({ id: this.lastID, name, role });
  });
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

  if (code === "12345678") {
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

// ✅ Add new turf with district normalization, default player ranges, and contact info
// turf creation with optional image upload (field name: image)
app.post("/turfs", upload.single("image"), (req, res) => {
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
    contact,
    image_url // may still be provided as text
  } = req.body;

  // if file was uploaded, override image_url
  if (req.file) {
    image_url = `/images/${req.file.filename}`;
  }

  district = normalizeDistrict(district);

  // coerce numeric values (FormData gives strings)
  price = parseInt(price) || 0;
  min_players = parseInt(min_players) || 0;
  max_stranger_players = parseInt(max_stranger_players) || 0;

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
      owner_id, contact, image_url
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
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
      contact,
      image_url || null
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
  const id = req.params.id;
  db.get("SELECT image_url FROM turfs WHERE id = ?", [id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });

    const deleteFromDb = () => {
      db.run("DELETE FROM turfs WHERE id = ?", [id], function(dbErr) {
        if (dbErr) return res.status(500).json({ error: dbErr.message });
        res.json({ ok: true });
      });
    };

    if (row && row.image_url) {
      const filename = path.basename(row.image_url);
      const filepath = path.join(__dirname, 'public', 'images', filename);
      fs.unlink(filepath, (unlinkErr) => {
        // ignore missing file errors, but log others
        if (unlinkErr && unlinkErr.code !== 'ENOENT') console.warn('Failed to remove image file:', unlinkErr.message);
        deleteFromDb();
      });
    } else {
      deleteFromDb();
    }
  });
});

// POST /bookings
// mode: "normal" or "stranger"
// Supports owner offline booking: mode="normal", owner booking his own turf -> no wallet charge, stranger refunds if not locked in
app.post("/bookings", (req, res) => {
  const { turf_id, slot_date, slot_start, slot_end, customer_id, mode, confirm_offline } = req.body;

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
      const isOwnerBooking = turf.owner_id && customer_id === turf.owner_id && mode === "normal" && confirm_offline === true;

      const priceToCharge = mode === "stranger" ? sharePrice : (isOwnerBooking ? 0 : turf.price);

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

              // Wallet check (skip for owner offline booking)
              const proceedAfterWalletCheck = () => {
                // Insert booking with slot_date
                db.run(
                  `INSERT INTO bookings (turf_id, slot_date, slot_start, slot_end, customer_id, mode, status, price_charged, created_at)
                   VALUES (?,?,?,?,?,?,?,?, datetime('now'))`,
                  [turf_id, slot_date, slot_start, slot_end, customer_id, mode, "booked", priceToCharge],
                  function (err4) {
                    if (err4) return res.status(500).json({ error: err4.message });

                    const bookingId = this.lastID;

                    if (mode === "normal") {
                      // Handle override logic vs stranger bookings
                      db.all(
                        `SELECT id, customer_id, price_charged FROM bookings
                         WHERE turf_id=? AND slot_date=? AND slot_start=? AND slot_end=? AND mode='stranger' AND status='booked'`,
                        [turf_id, slot_date, slot_start, slot_end],
                        (err5, strangers) => {
                          if (err5) return res.status(500).json({ error: err5.message });

                          // If stranger play already locked in (min reached), cancel this normal booking and reject
                          if (strangers.length >= turf.min_players) {
                            db.run("UPDATE bookings SET status='canceled' WHERE id=?", [bookingId]);
                            return res.status(400).json({ error: "Stranger play already locked in" });
                          }

                          // Otherwise refund all stranger bookings and cancel them
                          strangers.forEach(s => {
                            db.run("UPDATE users SET wallet_balance = wallet_balance + ? WHERE id=?", [s.price_charged, s.customer_id]);
                            db.run("UPDATE bookings SET status='canceled' WHERE id=?", [s.id]);
                          });

                          // Owner credit:
                          // - For owner offline booking: do not credit owner (price_charged = 0, offline payment handled outside)
                          // - For regular normal booking: credit owner full turf price
                          if (!isOwnerBooking && turf.owner_id) {
                            db.run("UPDATE users SET wallet_balance = wallet_balance + ? WHERE id=?", [turf.price, turf.owner_id]);
                          }

                          return res.json({
                            id: bookingId,
                            status: "booked",
                            mode,
                            price_charged: priceToCharge,
                            offline: isOwnerBooking ? true : false
                          });
                        }
                      );
                    } else {
                      // Stranger flow unchanged
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
              };

              if (isOwnerBooking) {
                // Skip wallet check for owner offline bookings
                proceedAfterWalletCheck();
              } else {
                // Normal wallet check
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
                        proceedAfterWalletCheck();
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
});

// ✅ Get slots for a turf with Stranger Play progress and booking metadata
app.get("/turfs/:id/slots", (req, res) => {
  const id = req.params.id;
  const date = req.query.date;

  if (!date) return res.status(400).json({ error: "Missing date parameter" });

  db.get("SELECT * FROM turfs WHERE id=?", [id], (err, turf) => {
    if (err || !turf) return res.status(404).json({ error: "Turf not found" });

    if (!turf.start_time || !turf.end_time) {
      return res.status(500).json({ error: "Turf start/end time missing" });
    }

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
          const strangerFull = joined >= turf.max_stranger_players;

          const normalBookingBlocked = hasNormalBooking || strangerLockedIn;
          const strangerBookingAllowed = !strangerFull;

          slots.push({
            start,
            end,
            price: turf.price,
            max_stranger_players: turf.max_stranger_players,
            min_players: turf.min_players,
            progress: { joined },
            bookings: slotBookings.map(b => ({
              mode: b.mode,
              customer_id: b.customer_id
            })),
            normalBookingBlocked,
            strangerBookingAllowed
          });
        }

        res.json({ turf, slots });
      }
    );
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

// see stranger players list
app.get("/slots/players", (req, res) => {
  const { turf_id, slot_date, slot_start, slot_end } = req.query;
  db.all(
    `SELECT b.id AS booking_id, u.name, u.contact
     FROM bookings b
     JOIN users u ON b.customer_id = u.id
     WHERE b.turf_id = ? AND b.slot_date = ? AND b.slot_start = ? AND b.slot_end = ? AND b.mode = 'stranger'`,
    [turf_id, slot_date, slot_start, slot_end],
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

app.get("/owner/bookings/:owner_id", (req, res) => {
  db.all(
    `SELECT 
       b.id AS booking_id,
       u.name AS customer_name,
       u.contact AS customer_contact,
       t.name AS turf_name,
       b.slot_start,
       b.slot_end,
       b.status,
       b.mode
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
  const bookingId = req.params.id;

  db.run(
    "UPDATE bookings SET status=? WHERE id=?",
    [status, bookingId],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });

      if (status === "canceled") {
        console.log(`Refund triggered for booking ${bookingId} 💸`);

        // Update pending_owner_credits status to 'refunded'
        db.run(
          "UPDATE pending_owner_credits SET status='refunded' WHERE booking_id=?",
          [bookingId],
          function (creditErr) {
            if (creditErr) {
              console.error("Failed to update credit status:", creditErr.message);
            } else {
              console.log(`Credit status updated for booking ${bookingId} ✅`);
            }
          }
        );
      }

      res.json({ updated: this.changes });
    }
  );
});
// Update turf details
// turf update now supports optional image upload
app.put("/turfs/:id", upload.single("image"), (req, res) => {
  const id = req.params.id;
  const { location, district, sport, price, min_players, max_stranger_players, image_url } = req.body;

  // find existing image (if any) so we can remove it when replaced
  db.get("SELECT image_url FROM turfs WHERE id = ?", [id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });

    let finalUrl = image_url || null;
    if (req.file) {
      finalUrl = `/images/${req.file.filename}`;
    }

    // coerce numeric values if present as strings
    const parsedPrice = parseInt(price) || 0;
    const parsedMin = parseInt(min_players) || 0;
    const parsedMax = parseInt(max_stranger_players) || 0;

    db.run(
      "UPDATE turfs SET location=?, district=?, sport=?, price=?, min_players=?, max_stranger_players=?, image_url=? WHERE id= ?",
      [location, district, sport, parsedPrice, parsedMin, parsedMax, finalUrl, id],
      function (updateErr) {
        if (updateErr) return res.status(500).json({ error: updateErr.message });

        // if a new file was uploaded and there was an old image, remove the old file
        if (req.file && row && row.image_url) {
          const oldFilename = path.basename(row.image_url);
          const oldPath = path.join(__dirname, 'public', 'images', oldFilename);
          fs.unlink(oldPath, (unlinkErr) => {
            if (unlinkErr && unlinkErr.code !== 'ENOENT') {
              console.warn('Failed to remove old turf image:', unlinkErr.message);
            }
            return res.json({ updated: this.changes, image_url: finalUrl });
          });
        } else {
          return res.json({ updated: this.changes, image_url: finalUrl });
        }
      }
    );
  });
});

// Delete a turf
app.delete("/turfs/:id", (req, res) => {
  const id = req.params.id;
  db.get("SELECT image_url FROM turfs WHERE id = ?", [id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });

    const deleteFromDb = () => {
      db.run("DELETE FROM turfs WHERE id=?", [id], function (dbErr) {
        if (dbErr) return res.status(500).json({ error: dbErr.message });
        res.json({ deleted: this.changes });
      });
    };

    if (row && row.image_url) {
      const filename = path.basename(row.image_url);
      const filepath = path.join(__dirname, 'public', 'images', filename);
      fs.unlink(filepath, (unlinkErr) => {
        if (unlinkErr && unlinkErr.code !== 'ENOENT') console.warn('Failed to remove image file:', unlinkErr.message);
        deleteFromDb();
      });
    } else {
      deleteFromDb();
    }
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

// Get user profile
app.get("/user/:id", (req, res) => {
  const { id } = req.params;
  db.get("SELECT id, name, email, contact, role, profile_photo FROM users WHERE id=?", [id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: "User not found" });
    res.json(row);
  });
});

// Update user profile
app.put("/user/:id", (req, res) => {
  const { id } = req.params;
  const { name, email, contact, profile_photo } = req.body;

  db.run(
    "UPDATE users SET name=?, email=?, contact=?, profile_photo=? WHERE id=?",
    [name, email, contact, profile_photo, id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      if (this.changes === 0) return res.status(404).json({ error: "User not found" });
      res.json({ message: "Profile updated successfully" });
    }
  );
});

// Upload profile photo
app.post("/user/:id/profile-photo", uploadProfile.single('profilePhoto'), (req, res) => {
  const { id } = req.params;

  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  // Get current profile photo to delete old one
  db.get("SELECT profile_photo FROM users WHERE id=?", [id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: "User not found" });

    // Delete old profile photo if it exists
    if (row.profile_photo) {
      const oldPhotoPath = path.join(__dirname, 'Profile', row.profile_photo);
      if (fs.existsSync(oldPhotoPath)) {
        fs.unlinkSync(oldPhotoPath);
      }
    }

    // Update database with new photo filename
    const photoFilename = req.file.filename;
    db.run(
      "UPDATE users SET profile_photo=? WHERE id=?",
      [photoFilename, id],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ 
          message: "Profile photo uploaded successfully",
          photoUrl: `/profile/${photoFilename}`
        });
      }
    );
  });
});

// Delete profile photo
app.delete("/user/:id/profile-photo", (req, res) => {
  const { id } = req.params;

  db.get("SELECT profile_photo FROM users WHERE id=?", [id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: "User not found" });

    if (!row.profile_photo) {
      return res.status(400).json({ error: "No profile photo to delete" });
    }

    // Delete photo file
    const photoPath = path.join(__dirname, 'Profile', row.profile_photo);
    if (fs.existsSync(photoPath)) {
      fs.unlinkSync(photoPath);
    }

    // Update database
    db.run(
      "UPDATE users SET profile_photo=NULL WHERE id=?",
      [id],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "Profile photo deleted successfully" });
      }
    );
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