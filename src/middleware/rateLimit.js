const buckets = new Map();

function rateLimit({ windowMs = 60_000, max = 10, key = (request) => request.ip } = {}) {
  return (request, response, next) => {
    const now = Date.now();
    const id = `${request.baseUrl}${request.path}:${key(request)}`;
    const current = buckets.get(id);
    const bucket = !current || current.until <= now ? { count: 0, until: now + windowMs } : current;
    bucket.count += 1;
    buckets.set(id, bucket);
    if (buckets.size > 5000) {
      for (const [bucketId, value] of buckets) if (value.until <= now) buckets.delete(bucketId);
    }
    response.set('RateLimit-Limit', String(max));
    response.set('RateLimit-Remaining', String(Math.max(0, max - bucket.count)));
    if (bucket.count > max) return response.status(429).json({ success: false, message: 'Too many attempts. Please try again shortly.' });
    next();
  };
}

module.exports = rateLimit;
