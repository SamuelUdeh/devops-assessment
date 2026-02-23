/**
 * ════════════════════════════════════════════════════════════════════════════
 *  DevOps Assessment — Stress Test
 *  Tool: k6 (https://k6.io)
 *
 *  This script simulates 5,000 concurrent virtual users hammering the
 *  /api/data endpoint. The test is structured in three phases:
 *
 *  Phase 1 — Ramp-Up    : 0 → 5,000 VUs over 2 minutes
 *  Phase 2 — Sustained  : hold 5,000 VUs for 5 minutes
 *  Phase 3 — Ramp-Down  : 5,000 → 0 VUs over 1 minute
 *
 *  Pass criteria (thresholds):
 *    ✓ p95 response time  < 2 000 ms
 *    ✓ p99 response time  < 5 000 ms
 *    ✓ error rate         < 1%
 *    ✓ request rate       ≥ 500 req/s at peak (derived from pass/fail)
 *
 *  Usage:
 *    # Install k6: https://k6.io/docs/get-started/installation/
 *    # Run against a locally exposed endpoint:
 *    k6 run stress-test/stress-test.js
 *
 *    # Override base URL:
 *    BASE_URL=http://my-other-host k6 run stress-test/stress-test.js
 *
 *    # Output metrics to InfluxDB/Grafana (optional):
 *    k6 run --out influxdb=http://localhost:8086/k6 stress-test/stress-test.js
 * ════════════════════════════════════════════════════════════════════════════
 */

import http    from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

// ── Custom Metrics ────────────────────────────────────────────────────────────
const errorRate     = new Rate('error_rate');
const responseTrend = new Trend('response_time_ms', true);
const successCount  = new Counter('successful_requests');
const failCount     = new Counter('failed_requests');

// ── Configuration ─────────────────────────────────────────────────────────────
const BASE_URL = __ENV.BASE_URL || 'http://assessment.local';

// ── Load Profile ──────────────────────────────────────────────────────────────
export const options = {
  stages: [
    { duration: '1m',  target: 1000  },   // warm-up: ramp to 1k VUs
    { duration: '1m',  target: 5000  },   // ramp to 5k VUs (peak)
    { duration: '5m',  target: 5000  },   // sustain 5k VUs
    { duration: '1m',  target: 0     },   // ramp down
  ],

  thresholds: {
    // ── Pass/Fail criteria ───────────────────────────────────────────────
    http_req_duration:          ['p(95)<2000', 'p(99)<5000'],
    error_rate:                 ['rate<0.01'],   // <1% errors
    http_req_failed:            ['rate<0.01'],
  },

  // Graceful stop: wait up to 30 s for in-flight requests before killing VUs.
  gracefulStop: '30s',
};

// ── Scenario ──────────────────────────────────────────────────────────────────
export default function () {
  const params = {
    headers: { 'Accept': 'application/json' },
    timeout: '10s',
  };

  // ── Primary endpoint under test ───────────────────────────────────────────
  const res = http.get(`${BASE_URL}/api/data`, params);

  const ok = check(res, {
    'status is 200':              (r) => r.status === 200,
    'response has status field':  (r) => {
      try { return JSON.parse(r.body).status === 'success'; }
      catch { return false; }
    },
    'response time < 2s':         (r) => r.timings.duration < 2000,
  });

  responseTrend.add(res.timings.duration);

  if (ok) {
    successCount.add(1);
    errorRate.add(0);
  } else {
    failCount.add(1);
    errorRate.add(1);

    // Print details for failed requests to aid debugging
    if (__ENV.VERBOSE === 'true') {
      console.error(`FAIL | status=${res.status} | duration=${res.timings.duration}ms | body=${res.body?.slice(0, 200)}`);
    }
  }

  // No sleep — we want maximum pressure on the system.
  // If you want to simulate realistic user think-time, uncomment:
  // sleep(Math.random() * 0.5);
}

// ── Setup (runs once before load) ────────────────────────────────────────────
export function setup() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  DevOps Assessment Stress Test');
  console.log(`  Target URL : ${BASE_URL}`);
  console.log('  Peak VUs   : 5,000');
  console.log('  Duration   : ~8 minutes total');
  console.log('═══════════════════════════════════════════════════');

  // Verify the target is up before unleashing load
  const res = http.get(`${BASE_URL}/readyz`);
  if (res.status !== 200) {
    throw new Error(`Target not ready (status=${res.status}). Aborting.`);
  }
  console.log('✓ Target is ready — starting load test');
}

// ── Teardown (runs once after load) ──────────────────────────────────────────
export function teardown(data) {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Load test complete. Check thresholds above.');
  console.log('  Useful next steps:');
  console.log('    • kubectl top pods -n assessment');
  console.log('    • kubectl logs -n assessment deploy/app-python');
  console.log('    • kubectl logs -n assessment deploy/mongo');
  console.log('═══════════════════════════════════════════════════');
}
