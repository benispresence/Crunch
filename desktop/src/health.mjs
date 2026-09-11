/** Wait for the service itself, not just an HTTP listener or error page. */
export async function waitForHttp(url, timeoutMs, { healthy = () => true, failure = () => null } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const failed = failure();
    if (failed) throw failed;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(Math.min(1500, Math.max(1, deadline - Date.now()))) });
      if (response.ok && healthy(await response.json())) {
        const failedAfterResponse = failure();
        if (failedAfterResponse) throw failedAfterResponse;
        return;
      }
    } catch { /* Retry until ready, or until a child reports failure. */ }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw failure() ?? new Error(`Timed out waiting for ${url}`);
}
