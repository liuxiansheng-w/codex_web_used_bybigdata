// JSON allows leading whitespace. Sending it while a SQL job is pending keeps
// the proxy connection alive without imposing a total query deadline.
export async function sendSqlResponse(res, execute, { heartbeatMs = 15_000 } = {}) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Accel-Buffering', 'no');
  const timer = setInterval(() => {
    if (!res.destroyed && !res.writableEnded && !res.writableNeedDrain) res.write(' \n');
  }, heartbeatMs);
  timer.unref?.();
  const stopHeartbeat = () => clearInterval(timer);
  res.once('close', stopHeartbeat);
  try {
    const result = await execute();
    if (!res.destroyed) res.end(JSON.stringify(result));
  } catch (error) {
    if (!res.destroyed) {
      const status = error.status || 500;
      if (!res.headersSent) res.statusCode = status;
      // After a heartbeat, HTTP status is already 200; retain the actual
      // failure in the JSON envelope for both current and older query views.
      res.end(JSON.stringify({ ok: false, error: error.message, status }));
    }
  } finally {
    stopHeartbeat();
    res.off('close', stopHeartbeat);
  }
}
