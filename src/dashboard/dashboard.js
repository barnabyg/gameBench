const areas = ["Balance", "Pacing", "Visuals", "Stability"];
const matrix = document.querySelector("#matrix");
const finding = document.querySelector("#finding");
const resultCount = document.querySelector("#result-count");
let activeCell;
let shownReports;
let reportData = [];
const chosenReports = new Map();

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function evidenceLink(evidence) {
  const link = element("a", evidence.image ? undefined : evidence.label);
  link.href = evidence.url;
  link.target = "_blank";
  link.rel = "noopener";
  if (evidence.image) {
    const image = element("img");
    image.src = evidence.url;
    image.alt = evidence.label;
    image.loading = "lazy";
    link.append(image, element("span", evidence.label));
  }
  return link;
}

function viewFinding(report, area, button) {
  activeCell?.setAttribute("aria-expanded", "false");
  activeCell = button;
  activeCell.setAttribute("aria-expanded", "true");
  const check = report.checks[area];
  const title = element("h2", `${report.game} · ${area}`);
  const close = element("button", "Close", "plain-button");
  close.type = "button";
  close.addEventListener("click", () => {
    finding.hidden = true;
    activeCell?.setAttribute("aria-expanded", "false");
    activeCell?.focus();
    activeCell = undefined;
  });
  const heading = element("div", undefined, "section-heading");
  heading.append(title, close);
  const { scenario, seed, seeds, strategy, settings } = report.inputs;
  const details = element("dl", undefined, "run-details");
  const labels = {
    Scenario: scenario,
    Strategy: strategy,
    ...(seeds ? { Seeds: seeds.join(", ") } : { Seed: String(seed) }),
    Baseline: report.baseline,
    Candidate: report.candidate,
    ...(report.branch ? { Branch: report.branch } : {}),
    ...(settings ? { Settings: JSON.stringify(settings) } : {}),
  };
  for (const [label, value] of Object.entries(labels)) {
    const pair = element("div");
    pair.append(element("dt", label), element("dd", value));
    details.append(pair);
  }
  finding.replaceChildren(heading, details);
  if (!check.findings.length)
    finding.append(element("p", "This report did not measure this area."));
  for (const item of check.findings) {
    const section = element("article", undefined, "finding");
    section.append(element("p", item.summary));
    if (item.question) section.append(element("p", item.question, "playtest"));
    const previews = item.evidence.filter((evidence) => evidence.image);
    const files = item.evidence.filter((evidence) => !evidence.image);
    if (previews.length) {
      const images = element("div", undefined, "previews");
      images.append(...previews.map(evidenceLink));
      section.append(images);
    }
    if (files.length) {
      const links = element("div", undefined, "evidence-links");
      links.append(...files.map(evidenceLink));
      section.append(links);
    }
    finding.append(section);
  }
  finding.hidden = false;
  finding.focus();
}

function priority(report) {
  const checks = Object.values(report.checks);
  const failed = checks.some((check) => check.status === "Failed");
  const review = checks.some((check) => check.status === "Review");
  const regression = checks.some((check) => check.regression);
  return Number(regression) * 4 + (failed ? 2 : Number(review));
}

function renderReports() {
  const games = new Map();
  for (const report of reportData) {
    if (!games.has(report.game)) games.set(report.game, []);
    games.get(report.game).push(report);
  }
  const rows = [...games].map(([game, history]) => ({
    report:
      history.find((item) => item.id === chosenReports.get(game)) ??
      history.at(-1),
    history,
  }));
  rows.sort((a, b) => priority(b.report) - priority(a.report));
  resultCount.textContent = `${rows.length} ${rows.length === 1 ? "game" : "games"} · ${reportData.length} ${reportData.length === 1 ? "report" : "reports"}`;
  finding.hidden = true;
  if (!rows.length) {
    matrix.replaceChildren(
      element("p", "No saved reports are loaded.", "empty"),
    );
    return;
  }
  const table = element("table");
  table.setAttribute("aria-label", "Benchmark results by game and area");
  const head = table.createTHead().insertRow();
  for (const name of ["Game", ...areas]) {
    const cell = element("th", name);
    cell.scope = "col";
    head.append(cell);
  }
  const body = table.createTBody();
  for (const { report, history } of rows) {
    const row = body.insertRow();
    row.id = `report-${report.id}`;
    const label = element("th", undefined, "game");
    label.scope = "row";
    label.append(element("strong", report.game));
    if (history.length > 1) {
      const historyPicker = element("select", undefined, "history");
      historyPicker.setAttribute(
        "aria-label",
        `Saved reports for ${report.game}`,
      );
      for (const previous of history.toReversed()) {
        const branch = previous.branch ? ` · ${previous.branch}` : "";
        const option = element(
          "option",
          `${previous.inputs.scenario}${branch} · ${previous.candidate.slice(0, 8)}`,
        );
        option.value = previous.id;
        historyPicker.append(option);
      }
      historyPicker.value = report.id;
      historyPicker.addEventListener("change", () => {
        const id = historyPicker.value;
        chosenReports.set(report.game, id);
        renderReports();
        document
          .getElementById(`report-${id}`)
          ?.querySelector(".history")
          ?.focus();
      });
      label.append(historyPicker);
    } else label.append(element("small", report.inputs.scenario));
    row.append(label);
    for (const area of areas) {
      const check = report.checks[area];
      const button = element("button", undefined, "check");
      button.type = "button";
      button.setAttribute("aria-label", `${area}: ${check.status}`);
      button.setAttribute("aria-controls", "finding");
      button.setAttribute("aria-expanded", "false");
      button.dataset.status = check.status;
      button.append(element("span", check.status, "status"));
      if (check.status === "Review" || check.status === "Failed")
        button.append(
          element("span", check.findings[0]?.summary, "check-summary"),
        );
      button.addEventListener("click", () => viewFinding(report, area, button));
      row.insertCell().append(button);
    }
  }
  matrix.replaceChildren(table);
}

async function loadReports() {
  try {
    const response = await fetch("/api/reports");
    if (!response.ok) throw new Error("Reports could not be loaded.");
    const reports = await response.json();
    const ids = reports.map((report) => report.id).join(",");
    if (ids !== shownReports) {
      shownReports = ids;
      reportData = reports;
      renderReports();
    }
  } catch {
    resultCount.textContent =
      "Reports could not be loaded. Refresh to try again.";
  }
}

function openReport(id) {
  const report = reportData.find((item) => item.id === id);
  if (!report) return;
  if (!document.getElementById(`report-${id}`)) {
    chosenReports.set(report.game, id);
    renderReports();
  }
  const row = document.getElementById(`report-${id}`);
  const relevant = row?.querySelector(
    '.check[data-status="Failed"], .check[data-status="Review"]',
  );
  (relevant ?? row?.querySelector('.check[data-status="Passed"]'))?.click();
}

const repositoryPanel = document.querySelector("#repositories");
const repositorySearch = document.querySelector("#repository-search");
const repositoryStatus = document.querySelector("#repository-status");
const repositoryList = document.querySelector("#repository-list");
const runSelected = document.querySelector("#run-selected");
const runSection = document.querySelector("#runs");
const runList = document.querySelector("#run-list");
const selectionKey = "gamebench.selected";
let repositories;
const selected = new Set();
let running = false;
let shownRuns;

async function api(route, options) {
  const response = await fetch(route, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}

function renderRepositories() {
  const term = repositorySearch.value.trim().toLowerCase();
  const matches = repositories.filter((repo) =>
    repo.fullName.toLowerCase().includes(term),
  );
  repositoryStatus.textContent = matches.length
    ? `${matches.length} repositories`
    : "No matching repositories.";
  repositoryList.replaceChildren(
    ...matches.map((repo) => {
      const checkbox = element("input");
      checkbox.type = "checkbox";
      checkbox.disabled = !repo.ready;
      checkbox.checked = selected.has(repo.fullName) && repo.ready;
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selected.add(repo.fullName);
        else selected.delete(repo.fullName);
        localStorage.setItem(selectionKey, JSON.stringify([...selected]));
        enableRun();
      });
      checkbox.value = repo.fullName;
      const label = element("label");
      label.append(checkbox, element("span", repo.fullName));
      const status = element(
        "span",
        repo.ready ? "Ready" : "Needs setup",
        "repo-status",
      );
      const row = element("li");
      row.append(label, status);
      return row;
    }),
  );
  enableRun();
}

function readySelection() {
  return (
    repositories?.filter((repo) => repo.ready && selected.has(repo.fullName)) ??
    []
  );
}

function enableRun() {
  runSelected.disabled = running || !readySelection().length;
}

repositoryPanel.addEventListener("toggle", async () => {
  if (!repositoryPanel.open || repositories) return;
  repositoryStatus.textContent = "Loading GitHub repositories…";
  try {
    repositories = await api("/api/repositories");
    const saved = localStorage.getItem(selectionKey);
    if (saved) {
      let names;
      try {
        names = JSON.parse(saved);
      } catch {
        names = [saved];
      }
      if (Array.isArray(names)) {
        for (const name of names) selected.add(name);
      }
    }
    renderRepositories();
  } catch (error) {
    repositoryStatus.textContent = `${error.message} Close and reopen the picker to retry.`;
  }
});
repositorySearch.addEventListener(
  "input",
  () => repositories && renderRepositories(),
);
document.querySelector("#choose-repos").addEventListener("click", () => {
  repositoryPanel.open = true;
});

function renderRuns(jobs) {
  const snapshot = JSON.stringify(jobs);
  if (snapshot === shownRuns) return;
  shownRuns = snapshot;
  runSection.hidden = !jobs.length;
  runList.replaceChildren(
    ...jobs.map((job) => {
      const entry = element("li");
      const labels = element("div");
      labels.append(
        element("strong", job.repository),
        element("p", job.message),
      );
      const badge = element("span", job.status, "status");
      const controls = element("div", undefined, "run-controls");
      controls.dataset.status = job.status;
      controls.append(badge);
      for (const id of job.reportIds) {
        const link = element("a", "Open report");
        link.href = `#report-${id}`;
        link.addEventListener("click", () => openReport(id));
        controls.append(link);
      }
      entry.append(labels, controls);
      return entry;
    }),
  );
}

async function checkRuns() {
  const jobs = await api("/api/runs");
  await loadReports();
  renderRuns(jobs);
  running = jobs.some((job) => job.status === "Running");
  enableRun();
  if (running) setTimeout(() => void checkRuns().catch(showRunError), 700);
}

function showRunError(error) {
  repositoryStatus.textContent = error.message;
  running = false;
  enableRun();
}

runSelected.addEventListener("click", async () => {
  running = true;
  enableRun();
  try {
    await api("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repositories: readySelection().map((repo) => repo.fullName),
      }),
    });
    await checkRuns();
  } catch (error) {
    showRunError(error);
  }
});

await checkRuns().catch(showRunError);
