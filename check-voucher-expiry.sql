SELECT
  status,
  COUNT(*) AS jumlah
FROM vouchers
GROUP BY status
ORDER BY status;