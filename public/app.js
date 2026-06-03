const state = {
  timer: null
};

const els = {
  grid: document.getElementById("factoryGrid"),
  template: document.getElementById("factoryTemplate"),
  systemStatus: document.getElementById("systemStatus"),
  lastSuccess: document.getElementById("lastSuccess"),
  alertCount: document.getElementById("alertCount"),
  alertPanel: document.getElementById("alertPanel"),
  refreshBtn: document.getElementById("refreshBtn")
};

function formatDate(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("th-TH", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Bangkok"
  }).format(new Date(value));
}

function freshnessText(factory) {
  if (factory.staleMinutes === null) return "ไม่มีข้อมูล";
  if (factory.staleMinutes < 60) return `${factory.staleMinutes} นาที`;
  const hours = Math.floor(factory.staleMinutes / 60);
  const minutes = factory.staleMinutes % 60;
  return minutes ? `${hours} ชม. ${minutes} นาที` : `${hours} ชม.`;
}

function render(data) {
  els.systemStatus.textContent = data.status || "-";
  els.lastSuccess.textContent = formatDate(data.lastSuccessAt);
  els.alertCount.textContent = String(data.alerts?.length || 0);

  if (data.error) {
    els.alertPanel.classList.remove("hidden");
    els.alertPanel.textContent = `เกิดข้อผิดพลาดในการดึงข้อมูล: ${data.error}`;
  } else if (data.alerts?.length) {
    els.alertPanel.classList.remove("hidden");
    els.alertPanel.innerHTML = `<strong>Alert: ข้อมูลไม่อัปเดตเกิน 3 ชั่วโมง</strong><br>${data.alerts
      .map((alert) => `${alert.factoryName} ล่าสุด ${formatDate(alert.latestRecordedAt)}`)
      .join("<br>")}`;
  } else {
    els.alertPanel.classList.add("hidden");
    els.alertPanel.textContent = "";
  }

  els.grid.innerHTML = "";
  for (const factory of data.factories || []) {
    const node = els.template.content.firstElementChild.cloneNode(true);
    node.classList.toggle("stale", Boolean(factory.stale));
    node.querySelector(".logo").src = factory.logo || "https://poms.diw.go.th/img/department.png";
    node.querySelector(".logo").alt = factory.name;
    node.querySelector("h2").textContent = factory.name;
    node.querySelector(".meta").textContent = factory.no ? `[${factory.no}] ${factory.address}` : factory.address;
    node.querySelector(".freshness").textContent = factory.stale ? `ค้าง ${freshnessText(factory)}` : `ล่าสุด ${freshnessText(factory)}`;
    node.querySelector(".latest").textContent = `เวลาข้อมูลล่าสุดจาก POMS: ${formatDate(factory.latestRecordedAt)}`;

    const chips = node.querySelector(".chips");
    for (const [type, count] of Object.entries(factory.counts || {})) {
      if (!count) continue;
      const chip = document.createElement("span");
      chip.className = `chip ${factory.severity?.[type] || "offline"}`;
      chip.textContent = `${type} ${count}`;
      chips.appendChild(chip);
    }

    const readings = node.querySelector(".readings");
    const groups = groupReadings(factory.readings || []);
    for (const group of groups) {
      const stack = document.createElement("section");
      stack.className = "stack";
      stack.innerHTML = `
        <div class="stack-title">
          <strong>${group.type} ${group.point}</strong>
          <small>${group.recordedDate ? group.recordedDate.slice(11, 16) : "-"}</small>
        </div>
      `;
      for (const row of group.rows) {
        const reading = document.createElement("div");
        reading.className = "reading";
        const value = row.isError ? row.error || "ERR" : row.value ?? "-";
        reading.innerHTML = `
          <span>${row.parameter} ${row.unit ? `(${row.unit})` : ""}</span>
          <strong>${value}</strong>
        `;
        stack.appendChild(reading);
      }
      readings.appendChild(stack);
    }
    els.grid.appendChild(node);
  }
}

function groupReadings(readings) {
  const map = new Map();
  for (const row of readings) {
    const key = `${row.type}-${row.measurementId}`;
    if (!map.has(key)) {
      map.set(key, {
        type: row.type,
        point: row.point || row.code || row.measurementId,
        recordedDate: row.recordedDate,
        rows: []
      });
    }
    map.get(key).rows.push(row);
  }
  return [...map.values()];
}

async function load(endpoint = "/api/status") {
  const res = await fetch(endpoint);
  const data = await res.json();
  render(data);
}

els.refreshBtn.addEventListener("click", () => load("/api/refresh"));
load();
state.timer = setInterval(load, 30000);
