function normalizePhone(value) {
  const digits = String(value || '').replace(/[^\d]/g, '');
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return null;
}
module.exports={normalizePhone};
