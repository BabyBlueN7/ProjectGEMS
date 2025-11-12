// ✅ Text normalization
function normalizeText(str) {
  if (!str) return str;
  const s = str.trim();
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

// ✅ District normalization
function normalizeDistrict(d) {
  if (!d) return d;
  return d.trim().charAt(0).toUpperCase() + d.trim().slice(1).toLowerCase();
}

// ✅ Wallet check
function checkWallet(user, amount) {
  return user.wallet_balance >= amount;
}

// ✅ Refund calculation for stranger play
function calculateRefund(totalPrice, maxPlayers) {
  return Math.floor(totalPrice / maxPlayers);
}

module.exports = {
  normalizeText,
  normalizeDistrict,
  checkWallet,
  calculateRefund
};