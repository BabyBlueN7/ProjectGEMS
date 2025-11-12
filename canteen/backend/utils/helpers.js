// ✅ Capitalize first letter and lowercase the rest
function normalizeText(str) {
  if (!str) return str;
  const s = str.trim();
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

// ✅ Normalize district name format
function normalizeDistrict(d) {
  if (!d) return d;
  return d.trim().charAt(0).toUpperCase() + d.trim().slice(1).toLowerCase();
}

// ✅ Check if user has enough wallet balance
function checkWallet(user, amount) {
  return user.wallet_balance >= amount;
}

module.exports = {
  normalizeText,
  normalizeDistrict,
  checkWallet
};