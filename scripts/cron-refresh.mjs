#!/usr/bin/env node
/**
 * Scheduled maintenance runner.
 *
 * Invoked by the Coolify scheduled task, inside the running app container, so
 * it calls the app over loopback rather than through the public URL — no TLS,
 * no proxy, and it keeps working if the domain ever changes.
 *
 * Lives in a file rather than a `node -e` one-liner because the Coolify task
 * API rejects commands containing nested quotes.
 */

const PORT = process.env.PORT || "3000";
const URL = `http://127.0.0.1:${PORT}/api/cron/instagram-refresh`;
const SECRET = process.env.CRON_SECRET;

if (!SECRET || SECRET.startsWith("CHANGEME")) {
  console.error("CRON_SECRET is not set — refusing to run.");
  process.exit(1);
}

try {
  const response = await fetch(URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${SECRET}` },
  });

  const body = await response.text();
  console.log(`${response.status} ${body}`);

  if (!response.ok) process.exit(1);
} catch (error) {
  console.error(`Cron request failed: ${error.message}`);
  process.exit(1);
}
