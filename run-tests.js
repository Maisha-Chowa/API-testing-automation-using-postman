const newman = require('newman');
const path = require('path');
const fs = require('fs');

const COLLECTION = path.join(__dirname, 'Restful-Booker-API-testing.postman_collection.json');
const ENVIRONMENT = path.join(__dirname, 'Restful-Booker-env.postman_environment.json');
const REPORTS_DIR = path.join(__dirname, 'newman-reports');
const TEMP_ENV = path.join(REPORTS_DIR, '_temp_env.json');

const FOLDER_RUNS = [
  { folder: 'Auth',                   data: 'testData-login.csv' },
  { folder: 'Get All Bookings',       data: null },
  { folder: 'Get Booking by ID',      data: 'testData-bookingID.csv' },
  { folder: 'Create Booking',         data: 'testData-createBooking.csv' },
  { folder: 'UpdateBooking',          data: 'testData-updateBooking.csv' },
  { folder: 'Partial UpdateBooking',  data: 'testData-Partial-UpdateBooking.csv' },
  { folder: 'Delete Booking',         data: 'testData-delete-booking.csv' },
];

function runNewman(options) {
  return new Promise((resolve, reject) => {
    newman.run(options, (err, summary) => {
      if (err) return reject(err);
      resolve(summary);
    });
  });
}

// Directly patch a key/value into the exported environment JSON file.
// More reliable than envVar overrides which can lose priority to the
// environment file's own (possibly empty) values.
function patchEnvFile(filePath, key, value) {
  try {
    const env = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const existing = env.values.find(v => v.key === key);
    if (existing) {
      existing.value = value;
    } else {
      env.values.push({ key, value, type: 'default', enabled: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(env, null, 2));
  } catch (_) { /* ignore if file doesn't exist yet */ }
}

function cleanup() {
  try { if (fs.existsSync(TEMP_ENV)) fs.unlinkSync(TEMP_ENV); } catch (_) { /* ignore */ }
}

async function main() {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });

  const timestamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');
  let environmentPath = ENVIRONMENT;
  let totalPassed = 0;
  let totalFailed = 0;
  let totalRequests = 0;
  const results = [];

  // Accumulated state extracted from HTTP responses to bridge across runs.
  // Newman's exportEnvironment loses values cleared by pm.environment.unset()
  // and exportCollection doesn't persist pm.collectionVariables.set().
  const sharedState = {};

  console.log('\n' + '='.repeat(65));
  console.log('   Restful Booker API — Data-Driven Newman Test Runner');
  console.log('   ' + new Date().toLocaleString());
  console.log('='.repeat(65));

  for (const run of FOLDER_RUNS) {
    const safeName = run.folder.replace(/\s+/g, '-');

    console.log(`\n${'─'.repeat(65)}`);
    console.log(`  ▶  ${run.folder}`);
    if (run.data) console.log(`     Data: ${run.data}`);
    console.log('─'.repeat(65));

    const options = {
      collection: COLLECTION,
      environment: environmentPath,
      folder: run.folder,
      reporters: ['cli', 'htmlextra'],
      reporter: {
        htmlextra: {
          export: path.join(REPORTS_DIR, `${safeName}-${timestamp}.html`),
          title: `Restful Booker — ${run.folder}`,
          browserTitle: `${run.folder} Report`,
        },
      },
      exportEnvironment: TEMP_ENV,
      delayRequest: 200,
    };

    if (run.data) {
      options.iterationData = path.join(__dirname, run.data);
    }

    try {
      const summary = await runNewman(options);

      const { assertions, requests } = summary.run.stats;
      const passed = assertions.total - assertions.failed;

      totalPassed += passed;
      totalFailed += assertions.failed;
      totalRequests += requests.total;

      results.push({
        folder: run.folder,
        requests: requests.total,
        passed,
        failed: assertions.failed,
        status: assertions.failed === 0 ? 'PASS' : 'FAIL',
      });

      // Extract values from HTTP responses that later folders depend on
      for (const exec of summary.run.executions) {
        try {
          const body = JSON.parse(exec.response.stream.toString());
          if (run.folder === 'Auth' && body.token) {
            sharedState.token = body.token;
          }
          if (run.folder === 'Create Booking' && body.bookingid) {
            sharedState.last_booking_id = String(body.bookingid);
          }
        } catch (_) { /* skip non-JSON / failed responses */ }
      }

      // Use exported env as base for next run, then patch in shared state
      if (fs.existsSync(TEMP_ENV)) {
        environmentPath = TEMP_ENV;
        for (const [key, value] of Object.entries(sharedState)) {
          patchEnvFile(TEMP_ENV, key, value);
        }
      }
    } catch (error) {
      console.error(`  ✗ Fatal error in "${run.folder}": ${error.message}`);
      results.push({
        folder: run.folder,
        requests: 0,
        passed: 0,
        failed: 1,
        status: 'ERROR',
      });
      totalFailed++;
    }
  }

  // ── Summary Table ──
  console.log(`\n${'='.repeat(65)}`);
  console.log('   FINAL RESULTS');
  console.log('='.repeat(65));
  console.log('');
  console.log('   Folder                        | Reqs | Pass | Fail | Status');
  console.log('   ' + '─'.repeat(59));

  for (const r of results) {
    const name = r.folder.padEnd(31);
    const reqs = String(r.requests).padStart(4);
    const pass = String(r.passed).padStart(4);
    const fail = String(r.failed).padStart(4);
    const icon = r.status === 'PASS' ? '✓' : '✗';
    console.log(`   ${name} | ${reqs} | ${pass} | ${fail} | ${icon} ${r.status}`);
  }

  console.log('   ' + '─'.repeat(59));
  const rTotal = String(totalRequests).padStart(4);
  const pTotal = String(totalPassed).padStart(4);
  const fTotal = String(totalFailed).padStart(4);
  console.log(`   ${'TOTAL'.padEnd(31)} | ${rTotal} | ${pTotal} | ${fTotal} |`);
  console.log('');
  console.log(`   HTML Reports → ${REPORTS_DIR}`);
  console.log('='.repeat(65) + '\n');

  // Generate an index.html that links to every per-folder report
  generateIndex(results, timestamp);

  cleanup();
  process.exit(totalFailed > 0 ? 1 : 0);
}

function generateIndex(results, timestamp) {
  const rows = results.map(r => {
    const safeName = r.folder.replace(/\s+/g, '-');
    const file = `${safeName}-${timestamp}.html`;
    const badge = r.status === 'PASS'
      ? '<span style="color:#16a34a;font-weight:600">PASS</span>'
      : '<span style="color:#dc2626;font-weight:600">FAIL</span>';
    return `
      <tr>
        <td><a href="${file}">${r.folder}</a></td>
        <td>${r.requests}</td>
        <td>${r.passed}</td>
        <td>${r.failed}</td>
        <td>${badge}</td>
      </tr>`;
  }).join('');

  const totalP = results.reduce((s, r) => s + r.passed, 0);
  const totalF = results.reduce((s, r) => s + r.failed, 0);
  const totalR = results.reduce((s, r) => s + r.requests, 0);
  const allPass = totalF === 0;
  const runDate = new Date().toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' });

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Restful Booker API — Test Reports</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8fafc;color:#1e293b;padding:2rem}
  .container{max-width:900px;margin:0 auto}
  h1{font-size:1.6rem;margin-bottom:.25rem}
  .meta{color:#64748b;font-size:.9rem;margin-bottom:1.5rem}
  .summary{display:flex;gap:1rem;margin-bottom:2rem;flex-wrap:wrap}
  .card{background:#fff;border-radius:10px;padding:1.2rem 1.5rem;flex:1;min-width:140px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
  .card .label{font-size:.75rem;text-transform:uppercase;color:#64748b;letter-spacing:.05em}
  .card .value{font-size:1.8rem;font-weight:700;margin-top:.25rem}
  .pass{color:#16a34a}.fail{color:#dc2626}
  table{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)}
  th{background:#0f172a;color:#fff;text-align:left;padding:.75rem 1rem;font-size:.8rem;text-transform:uppercase;letter-spacing:.05em}
  td{padding:.75rem 1rem;border-bottom:1px solid #e2e8f0;font-size:.9rem}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:#f1f5f9}
  a{color:#2563eb;text-decoration:none;font-weight:500}a:hover{text-decoration:underline}
  .footer{margin-top:2rem;text-align:center;font-size:.8rem;color:#94a3b8}
</style>
</head>
<body>
<div class="container">
  <h1>Restful Booker API — Test Reports</h1>
  <p class="meta">${runDate} &nbsp;|&nbsp; Overall: <strong class="${allPass ? 'pass' : 'fail'}">${allPass ? 'ALL PASSED' : totalF + ' FAILED'}</strong></p>
  <div class="summary">
    <div class="card"><div class="label">Total Requests</div><div class="value">${totalR}</div></div>
    <div class="card"><div class="label">Passed</div><div class="value pass">${totalP}</div></div>
    <div class="card"><div class="label">Failed</div><div class="value ${totalF > 0 ? 'fail' : ''}">${totalF}</div></div>
    <div class="card"><div class="label">Folders</div><div class="value">${results.length}</div></div>
  </div>
  <table>
    <thead><tr><th>Folder</th><th>Requests</th><th>Passed</th><th>Failed</th><th>Status</th></tr></thead>
    <tbody>${rows}
    </tbody>
  </table>
  <p class="footer">Generated by Newman Test Runner</p>
</div>
</body>
</html>`;

  fs.writeFileSync(path.join(REPORTS_DIR, 'index.html'), html);
}

main().catch(err => {
  console.error('Fatal error:', err);
  cleanup();
  process.exit(1);
});
