const areas = ["Balance", "Pacing", "Visuals", "Stability"];
const matrix = document.querySelector("#matrix");
const finding = document.querySelector("#finding");
const resultCount = document.querySelector("#result-count");
let activeCell;

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
  const { scenario, seed, strategy, settings } = report.inputs;
  const details = element("dl", undefined, "run-details");
  const labels = {
    Scenario: scenario,
    Strategy: strategy,
    Seed: String(seed),
    Baseline: report.baseline,
    Candidate: report.candidate,
    ...(report.branch ? { Branch: report.branch } : {}),
    Settings: JSON.stringify(settings),
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

function renderReports(reports) {
  resultCount.textContent = `${reports.length} ${reports.length === 1 ? "report" : "reports"}`;
  finding.hidden = true;
  if (!reports.length) {
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
  for (const report of reports) {
    const row = body.insertRow();
    const label = element("th", undefined, "game");
    label.scope = "row";
    label.append(
      element("strong", report.game),
      element("small", report.inputs.scenario),
    );
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
    renderReports(await response.json());
  } catch {
    resultCount.textContent =
      "Reports could not be loaded. Refresh to try again.";
  }
}

await loadReports();
