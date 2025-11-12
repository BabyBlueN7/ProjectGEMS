// ✅ Text normalization
function normalizeText(str) {
  if (!str) return str;
  const s = str.trim();
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}


// ✅ Wallet check
function checkWallet(user, amount) {
  return user.wallet_balance >= amount;
}

module.exports = {
  normalizeText,
  normalizeDistrict,
  checkWallet,
  calculateRefund
};