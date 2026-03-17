#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const CONFIG = {
  segmentGapMinutes: 60,
  warmupMinutes: 30,
  hoursPerManDay: 8,
  outputPath: "/tmp/git-stats-report.html",
  autoOpenReport: true,
  gitLogMaxBufferBytes: 50 * 1024 * 1024,
};

function run(command, cwd) {
  return execSync(command, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: CONFIG.gitLogMaxBufferBytes,
  }).trim();
}

function isGitRepo(cwd) {
  try {
    run("git rev-parse --is-inside-work-tree", cwd);
    return true;
  } catch (_) {
    return false;
  }
}

function getRepoRoot(cwd) {
  return run("git rev-parse --show-toplevel", cwd);
}

function getProjectName(repoRoot) {
  const packageJsonPath = path.join(repoRoot, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      if (pkg && typeof pkg.name === "string" && pkg.name.trim().length > 0) {
        return pkg.name.trim();
      }
    } catch (_) {
      // Fallback to directory name if package.json is invalid.
    }
  }

  return path.basename(repoRoot);
}

function getCommits(repoRoot) {
  const raw = run(
    "git log --reverse --pretty=format:'__COMMIT__|%H|%ct|%cI|%an|%ae' --numstat",
    repoRoot
  );

  if (!raw) {
    return [];
  }

  const commits = [];
  let current = null;

  for (const line of raw.split("\n")) {
    if (line.startsWith("__COMMIT__|")) {
      const parts = line.split("|");
      current = {
        hash: parts[1],
        timestamp: Number(parts[2]),
        isoDate: parts[3],
        authorName: parts[4],
        authorEmail: parts[5],
        filesChanged: 0,
        additions: 0,
        deletions: 0,
      };
      commits.push(current);
      continue;
    }

    if (!current || !line.trim()) {
      continue;
    }

    const match = line.match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/);
    if (!match) {
      continue;
    }

    const filePath = match[3];
    if (filePath.includes("node_modules/")) {
      continue;
    }

    const added = match[1] === "-" ? 0 : Number(match[1]);
    const deleted = match[2] === "-" ? 0 : Number(match[2]);

    current.filesChanged += 1;
    current.additions += added;
    current.deletions += deleted;
  }

  return commits;
}

function splitIntoSegments(commits) {
  if (commits.length === 0) {
    return [];
  }

  const segments = [];
  const gapSeconds = CONFIG.segmentGapMinutes * 60;

  let segment = {
    startCommitIndex: 0,
    endCommitIndex: 0,
    firstCommitTime: commits[0].timestamp,
    lastCommitTime: commits[0].timestamp,
  };

  for (let i = 1; i < commits.length; i += 1) {
    const prev = commits[i - 1];
    const curr = commits[i];
    const delta = curr.timestamp - prev.timestamp;

    if (delta > gapSeconds) {
      segments.push(segment);
      segment = {
        startCommitIndex: i,
        endCommitIndex: i,
        firstCommitTime: curr.timestamp,
        lastCommitTime: curr.timestamp,
      };
      continue;
    }

    segment.endCommitIndex = i;
    segment.lastCommitTime = curr.timestamp;
  }

  segments.push(segment);

  return segments.map((s, idx) => {
    const startTime = s.firstCommitTime - CONFIG.warmupMinutes * 60;
    const endTime = s.lastCommitTime;
    const durationHours = Math.max(0, (endTime - startTime) / 3600);

    return {
      id: idx + 1,
      startCommitIndex: s.startCommitIndex,
      endCommitIndex: s.endCommitIndex,
      startTime,
      endTime,
      durationHours,
      durationManDays: durationHours / CONFIG.hoursPerManDay,
    };
  });
}

function buildDailySeries(commits, segments) {
  const byDay = new Map();

  for (const c of commits) {
    const day = c.isoDate.slice(0, 10);
    const row = byDay.get(day) || {
      day,
      commits: 0,
      additions: 0,
      deletions: 0,
      filesChanged: 0,
    };

    row.commits += 1;
    row.additions += c.additions;
    row.deletions += c.deletions;
    row.filesChanged += c.filesChanged;
    byDay.set(day, row);
  }

  const hoursByDay = new Map();
  for (const s of segments) {
    const day = new Date(s.endTime * 1000).toISOString().slice(0, 10);
    hoursByDay.set(day, (hoursByDay.get(day) || 0) + s.durationHours);
  }

  for (const [day, hours] of hoursByDay.entries()) {
    const row = byDay.get(day) || {
      day,
      commits: 0,
      additions: 0,
      deletions: 0,
      filesChanged: 0,
    };

    row.hours = hours;
    row.manDays = hours / CONFIG.hoursPerManDay;
    byDay.set(day, row);
  }

  for (const row of byDay.values()) {
    if (typeof row.hours !== "number") {
      row.hours = 0;
      row.manDays = 0;
    }
  }

  return Array.from(byDay.values())
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((row) => ({
      ...row,
      dayLabel: formatDayLabel(row.day),
    }));
}

function formatDateTimeFromSec(epochSec) {
  return new Date(epochSec * 1000).toLocaleString("it-IT", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatDateFromSec(epochSec) {
  return new Date(epochSec * 1000).toLocaleDateString("it-IT", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function toFixed2(n) {
  return (Math.round(n * 100) / 100).toFixed(2);
}

function formatInt(n) {
  return new Intl.NumberFormat("it-IT", {
    maximumFractionDigits: 0,
  }).format(n);
}

function formatDecimal(n, fractionDigits = 2) {
  return new Intl.NumberFormat("it-IT", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(n);
}

function formatDayLabel(dayIso) {
  const [year, month, day] = dayIso.split("-").map(Number);
  const weekdays = ["Dom", "Lun", "Mar", "Mer", "Gio", "Ven", "Sab"];
  const months = ["Gen", "Feb", "Mar", "Apr", "Mag", "Giu", "Lug", "Ago", "Set", "Ott", "Nov", "Dic"];
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const yearShort = String(year).slice(2);

  return `${weekdays[weekday]} ${day} ${months[month - 1]} '${yearShort}`;
}

function buildReportHtml(report) {
  const safeDataJson = JSON.stringify(report).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Git Stats - ${report.projectName}</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    :root {
      --bg: #f4efe8;
      --panel: #fffaf4;
      --ink: #1f1b18;
      --muted: #6c5d53;
      --accent: #c24b2f;
      --accent-2: #2f6a8e;
      --accent-3: #3f7d4c;
      --line: #e5d8ca;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      font-family: "Avenir Next", "Segoe UI", sans-serif;
      background:
        radial-gradient(circle at 20% 20%, #fff7e8 0, #f4efe8 45%),
        linear-gradient(135deg, #f4efe8 0%, #f0e6dc 100%);
      min-height: 100vh;
    }
    .wrap {
      max-width: 1100px;
      margin: 0 auto;
      padding: 24px;
    }
    h1 {
      margin: 0;
      font-size: clamp(1.8rem, 3.2vw, 2.8rem);
      letter-spacing: 0.02em;
    }
    .subtitle {
      margin-top: 6px;
      color: var(--muted);
    }
    .grid {
      margin-top: 20px;
      display: grid;
      gap: 14px;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 16px;
      box-shadow: 0 5px 18px rgba(31, 27, 24, 0.05);
    }
    .kpi-label {
      font-size: 0.82rem;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .kpi-value {
      margin-top: 6px;
      font-size: 1.55rem;
      font-weight: 700;
    }
    .panel {
      margin-top: 18px;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 16px;
    }
    .panel h2 {
      margin: 0 0 12px;
      font-size: 1.1rem;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.93rem;
    }
    th, td {
      text-align: left;
      padding: 9px 7px;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
    }
    th {
      color: var(--muted);
      font-weight: 600;
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .chart-wrap {
      height: 360px;
    }
    .footer {
      margin-top: 14px;
      color: var(--muted);
      font-size: 0.86rem;
    }
    @media (max-width: 640px) {
      .wrap { padding: 14px; }
      .panel { padding: 12px; }
      .chart-wrap { height: 300px; }
      table { font-size: 0.86rem; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>${report.projectName}</h1>
    <div class="subtitle">Analisi repository: ${report.repoRoot}</div>
    <div class="grid">
      <div class="card"><div class="kpi-label">Commit</div><div class="kpi-value">${formatInt(report.totals.commits)}</div></div>
      <div class="card"><div class="kpi-label">Primo Commit</div><div class="kpi-value">${report.totals.firstCommitDate}</div></div>
      <div class="card"><div class="kpi-label">Ultimo Commit</div><div class="kpi-value">${report.totals.lastCommitDate}</div></div>
      <div class="card"><div class="kpi-label">Giorni Attivi</div><div class="kpi-value">${formatInt(report.daily.length)}</div></div>
      <div class="card"><div class="kpi-label">File Modificati</div><div class="kpi-value">${formatInt(report.totals.filesChanged)}</div></div>
      <div class="card"><div class="kpi-label">Righe Scritte</div><div class="kpi-value">${formatInt(report.totals.additions)}</div></div>
      <div class="card"><div class="kpi-label">Righe Cancellate</div><div class="kpi-value">${formatInt(report.totals.deletions)}</div></div>
      <div class="card"><div class="kpi-label">Ore Uomo</div><div class="kpi-value">${formatDecimal(report.totals.hours)}</div></div>
      <div class="card"><div class="kpi-label">Giorni Uomo</div><div class="kpi-value">${formatDecimal(report.totals.manDays)}</div></div>
      <div class="card"><div class="kpi-label">Elapsed Totale (gg)</div><div class="kpi-value">${formatDecimal(report.totals.elapsedDays)}</div></div>
    </div>

    <div class="panel">
      <h2>Grafico nel Tempo</h2>
      <div class="chart-wrap"><canvas id="timelineChart"></canvas></div>
    </div>

    <div class="panel">
      <h2>Ore Aggregate per Giorno</h2>
      <table>
        <thead>
          <tr>
            <th>Giorno</th>
            <th>Commit</th>
            <th>File Toccati</th>
            <th>Ore</th>
            <th>Giorni Uomo</th>
          </tr>
        </thead>
        <tbody>
          ${report.daily
            .map(
              (d) => `<tr>
                <td>${d.dayLabel}</td>
                <td>${formatInt(d.commits)}</td>
                <td>${formatInt(d.filesChanged)}</td>
                <td>${formatDecimal(d.hours)}</td>
                <td>${formatDecimal(d.manDays)}</td>
              </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>

    <div class="footer">
      Generato il ${new Date().toLocaleString("it-IT")}. Parametri: gap=${CONFIG.segmentGapMinutes}m, warmup=${CONFIG.warmupMinutes}m, ore/giorno=${CONFIG.hoursPerManDay}.
    </div>
  </div>

  <script id="report-data" type="application/json">${safeDataJson}</script>
  <script>
    const report = JSON.parse(document.getElementById("report-data").textContent);

    const labels = report.daily.map((d) => d.dayLabel);
    const additions = report.daily.map((d) => d.additions);
    const deletions = report.daily.map((d) => d.deletions);

    const hoursByDay = report.daily.map((d) => Number(d.hours.toFixed(2)));

    const ctx = document.getElementById("timelineChart");
    new Chart(ctx, {
      data: {
        labels,
        datasets: [
          {
            type: "bar",
            label: "Righe Scritte",
            data: additions,
            yAxisID: "y",
            backgroundColor: "rgba(47, 106, 142, 0.55)",
            borderColor: "rgba(47, 106, 142, 1)",
            borderWidth: 1,
          },
          {
            type: "bar",
            label: "Righe Cancellate",
            data: deletions,
            yAxisID: "y",
            backgroundColor: "rgba(194, 75, 47, 0.45)",
            borderColor: "rgba(194, 75, 47, 1)",
            borderWidth: 1,
          },
          {
            type: "line",
            label: "Ore Uomo / Giorno",
            data: hoursByDay,
            yAxisID: "y1",
            borderColor: "rgba(63, 125, 76, 1)",
            backgroundColor: "rgba(63, 125, 76, 0.2)",
            borderWidth: 3,
            tension: 0.25,
            fill: false,
            pointRadius: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: {
          duration: 900,
          easing: "easeOutQuart",
        },
        interaction: {
          mode: "index",
          intersect: false,
        },
        plugins: {
          legend: {
            position: "bottom",
          },
          tooltip: {
            callbacks: {
              label(context) {
                const isHours = context.dataset.label === "Ore Uomo / Giorno";
                const value = context.parsed.y;
                const formatted = isHours
                  ? new Intl.NumberFormat("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)
                  : new Intl.NumberFormat("it-IT", { maximumFractionDigits: 0 }).format(value);
                return context.dataset.label + ": " + formatted;
              },
            },
          },
        },
        scales: {
          y: {
            beginAtZero: true,
            title: { display: true, text: "Righe" },
            ticks: {
              callback(value) {
                return new Intl.NumberFormat("it-IT", { maximumFractionDigits: 0 }).format(value);
              },
            },
          },
          y1: {
            beginAtZero: true,
            position: "right",
            grid: { drawOnChartArea: false },
            title: { display: true, text: "Ore Uomo" },
            ticks: {
              callback(value) {
                return new Intl.NumberFormat("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
              },
            },
          },
        },
      },
    });
  </script>
</body>
</html>`;
}

function openFile(filePath) {
  const escaped = JSON.stringify(filePath);
  const platform = process.platform;

  try {
    if (platform === "darwin") {
      execSync(`open ${escaped}`);
      return;
    }

    if (platform === "win32") {
      execSync(`start "" ${escaped}`, { shell: "cmd.exe" });
      return;
    }

    execSync(`xdg-open ${escaped}`);
  } catch (err) {
    console.error("Impossibile aprire automaticamente il browser:", err.message);
  }
}

function main() {
  const cwd = process.cwd();

  if (!isGitRepo(cwd)) {
    console.error("Errore: esegui il comando all'interno di un repository Git.");
    process.exit(1);
  }

  const repoRoot = getRepoRoot(cwd);
  const projectName = getProjectName(repoRoot);
  const commits = getCommits(repoRoot);

  if (commits.length === 0) {
    console.error("Nessun commit trovato nel repository.");
    process.exit(1);
  }

  const segmentsRaw = splitIntoSegments(commits);
  const segments = segmentsRaw.map((s) => ({
    ...s,
    commitCount: s.endCommitIndex - s.startCommitIndex + 1,
  }));

  const totals = {
    commits: commits.length,
    firstCommitDate: formatDateFromSec(commits[0].timestamp),
    lastCommitDate: formatDateFromSec(commits[commits.length - 1].timestamp),
    segments: segments.length,
    filesChanged: commits.reduce((acc, c) => acc + c.filesChanged, 0),
    additions: commits.reduce((acc, c) => acc + c.additions, 0),
    deletions: commits.reduce((acc, c) => acc + c.deletions, 0),
    hours: segments.reduce((acc, s) => acc + s.durationHours, 0),
    manDays: segments.reduce((acc, s) => acc + s.durationManDays, 0),
    elapsedDays: (commits[commits.length - 1].timestamp - commits[0].timestamp) / 86400,
  };

  const daily = buildDailySeries(commits, segments);

  const report = {
    projectName,
    repoRoot,
    generatedAt: new Date().toISOString(),
    config: CONFIG,
    totals,
    daily,
    segments,
  };

  const html = buildReportHtml(report);
  fs.writeFileSync(CONFIG.outputPath, html, "utf8");

  console.log(`Report creato: ${CONFIG.outputPath}`);
  console.log(`Progetto: ${projectName}`);
  console.log(`Commit: ${totals.commits}`);
  console.log(`Ore uomo: ${toFixed2(totals.hours)} - Giorni uomo: ${toFixed2(totals.manDays)}`);

  if (CONFIG.autoOpenReport) {
    openFile(CONFIG.outputPath);
  }
}

main();
