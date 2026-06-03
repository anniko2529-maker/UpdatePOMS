const fs = require("fs");
const http = require("http");
const net = require("net");
const tls = require("tls");
const path = require("path");

const POMS_BASE = "https://poms.diw.go.th/factory-ws";
const CONFIG_PATH = path.join(__dirname, "config.json");

const defaults = {
  port: Number(process.env.PORT || 3000),
  pollIntervalSeconds: Number(process.env.POLL_INTERVAL_SECONDS || 60),
  staleThresholdMinutes: Number(process.env.STALE_THRESHOLD_MINUTES || 180),
  alertCooldownMinutes: Number(process.env.ALERT_COOLDOWN_MINUTES || 120),
  recipients: (process.env.ALERT_EMAIL_TO || "").split(",").map((x) => x.trim()).filter(Boolean),
  smtp: {
    host: process.env.SMTP_HOST || "",
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "false").toLowerCase() === "true",
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
    from: process.env.SMTP_FROM || process.env.SMTP_USER || ""
  }
};

const targetFactories = [
  { id: 54, label: "บริษัท ไทยลู้บเบส จำกัด (มหาชน)", search: "ไทยลู้บเบส", types: [1] },
  { id: 4, label: "บริษัท ไทยออยล์ จำกัด (มหาชน) (49)", search: "ไทยออยล์", types: [1, 2] },
  { id: 428652, label: "บริษัท ไทยออยล์ จำกัด(มหาชน)(101)", search: "ไทยออยล์", types: [2] },
  { id: 50, label: "บริษัท ท็อป เอสพีพี จำกัด", search: "ท็อป เอสพีพี", types: [1] },
  { id: 55, label: "บริษัท ไทยออยล์ จำกัด (มหาชน) (88)", search: "ไทยออยล์", types: [1] },
  { id: 59, label: "บริษัท ลาบิกซ์ จำกัด", search: "ลาบิกซ์", types: [1] },
  { id: 60, label: "บริษัท ไทยพาราไซลีน จำกัด", search: "ไทยพาราไซลีน", types: [1] }
];

const sensorTypes = {
  1: "CEMS",
  2: "WPMS",
  3: "MOBILE",
  4: "STATION"
};

const config = readConfig();
let cache = {
  status: "starting",
  startedAt: new Date().toISOString(),
  lastPollAt: null,
  lastSuccessAt: null,
  error: null,
  factories: [],
  alerts: []
};
let lastAlertKey = "";
let lastAlertAt = 0;

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return defaults;
  const fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  return {
    ...defaults,
    ...fileConfig,
    smtp: { ...defaults.smtp, ...(fileConfig.smtp || {}) },
    recipients: fileConfig.recipients || defaults.recipients
  };
}

async function pomsPost(endpoint, fields) {
  const body = new URLSearchParams();
  Object.entries(fields || {}).forEach(([key, value]) => body.append(key, value ?? ""));
  const res = await fetch(`${POMS_BASE}${endpoint}`, { method: "POST", body });
  if (!res.ok) throw new Error(`POMS HTTP ${res.status} for ${endpoint}`);
  const json = await res.json();
  if (json.code !== "SUCCESS") throw new Error(json.message || `POMS API error for ${endpoint}`);
  return json.data;
}

async function fetchFactorySummary(factory) {
  const data = await pomsPost("/get/factory-list?", {
    keyword: factory.search || factory.label,
    page: 0,
    lat: "13.7563",
    lon: "100.5018"
  });
  return (data.items || []).find((item) => Number(item.id) === Number(factory.id)) || {};
}

function parsePomsDate(value) {
  if (!value || typeof value !== "string") return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match.map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h - 7, mi, s));
}

function pickLatestMeasurement(sensorData) {
  const rows = [];
  const measurements = sensorData?.measurements || {};
  const parameters = sensorData?.parameters || {};
  for (const measurement of Object.values(measurements)) {
    const recordedAt = parsePomsDate(measurement.recordedDate);
    for (const [parameterId, reading] of Object.entries(measurement.parameters || {})) {
      if (reading && reading.isVisible === false) continue;
      rows.push({
        measurementId: measurement.id,
        code: measurement.code,
        point: measurement.measName || measurement.code,
        recordedDate: measurement.recordedDate || "",
        recordedAt: recordedAt ? recordedAt.toISOString() : null,
        parameter: parameters[parameterId]?.name || parameterId,
        unit: parameters[parameterId]?.unit || "",
        value: reading?.value,
        severity: reading?.severity ?? 0,
        isError: Boolean(reading?.isError),
        error: reading?.errMsg || reading?.errorCode || ""
      });
    }
  }
  rows.sort((a, b) => String(b.recordedDate).localeCompare(String(a.recordedDate)));
  return rows;
}

function severityText(value) {
  if (value === 1) return "normal";
  if (value === 2) return "warning";
  if (value === 3) return "critical";
  return "offline";
}

function expectedCountForType(detail, type) {
  if (type === 1) return Number(detail.countCems || 0);
  if (type === 2) return Number(detail.countOpms || 0);
  if (type === 3) return Number(detail.countMobile || 0);
  if (type === 4) return Number(detail.countStation || 0);
  return 0;
}

async function fetchFactory(factory) {
  let detail = {};
  try {
    detail = await pomsPost(`/get/factory/${factory.id}`, { uuid: "" });
  } catch (error) {
    detail = await fetchFactorySummary(factory);
    detail.detailError = error.message;
  }
  const typeResults = [];
  const readings = [];
  let latestAt = null;

  for (const type of factory.types) {
    const sensorData = await pomsPost(`/get/measurement-list/${factory.id}`, { uuid: "", date: "", type });
    const typeReadings = pickLatestMeasurement(sensorData);
    typeReadings.forEach((row) => readings.push({ ...row, type: sensorTypes[type] || String(type) }));
    const actualCount = Object.keys(sensorData?.measurements || {}).length;
    const expectedCount = expectedCountForType(detail, type);
    for (let index = actualCount; index < expectedCount; index += 1) {
      readings.push({
        measurementId: `${type}-missing-${index + 1}`,
        code: "",
        point: `จุดที่ ${index + 1}`,
        recordedDate: "",
        recordedAt: null,
        parameter: "ไม่มีข้อมูลจาก POMS",
        unit: "",
        value: null,
        severity: 0,
        isError: true,
        error: "NO DATA",
        type: sensorTypes[type] || String(type),
        isPlaceholder: true
      });
    }
    const newest = typeReadings.find((row) => row.recordedAt);
    if (newest) {
      const at = new Date(newest.recordedAt);
      if (!latestAt || at > latestAt) latestAt = at;
    }
    typeResults.push({
      type: sensorTypes[type] || String(type),
      count: Math.max(actualCount, expectedCount),
      actualCount,
      expectedCount,
      latestRecordedDate: newest?.recordedDate || "",
      status: newest ? "online" : "no-data"
    });
  }

  const staleMinutes = latestAt ? Math.floor((Date.now() - latestAt.getTime()) / 60000) : null;
  const stale = staleMinutes === null || staleMinutes >= config.staleThresholdMinutes;

  return {
    id: factory.id,
    name: detail.name || factory.label,
    label: factory.label,
    no: detail.noNew || detail.no || "",
    address: detail.address || "",
    logo: detail.logo || "",
    distance: detail.distance ?? null,
    severity: {
      CEMS: severityText(detail.severityCems),
      WPMS: severityText(detail.severityOpms),
      MOBILE: severityText(detail.severityMobile),
      STATION: severityText(detail.severityStation)
    },
    counts: {
      CEMS: detail.countCems || 0,
      WPMS: detail.countOpms || 0,
      MOBILE: detail.countMobile || 0,
      STATION: detail.countStation || 0
    },
    sensorTypes: typeResults,
    latestRecordedAt: latestAt ? latestAt.toISOString() : null,
    staleMinutes,
    stale,
    readings
  };
}

async function poll() {
  cache = { ...cache, status: "polling", lastPollAt: new Date().toISOString(), error: null };
  try {
    const results = await Promise.allSettled(targetFactories.map(fetchFactory));
    const factories = results
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value);
    const failures = results
      .map((result, index) => ({ result, target: targetFactories[index] }))
      .filter((entry) => entry.result.status === "rejected")
      .map((entry) => `${entry.target.label}: ${entry.result.reason.message}`);
    const alerts = factories
      .filter((factory) => factory.stale)
      .map((factory) => ({
        factoryId: factory.id,
        factoryName: factory.name,
        latestRecordedAt: factory.latestRecordedAt,
        staleMinutes: factory.staleMinutes
      }));
    cache = {
      ...cache,
      status: "ok",
      lastSuccessAt: new Date().toISOString(),
      factories,
      alerts,
      error: failures.length ? failures.join("; ") : null
    };
    await maybeSendAlert(alerts);
  } catch (error) {
    cache = { ...cache, status: "error", error: error.message };
    console.error(error);
  }
}

async function maybeSendAlert(alerts) {
  if (!alerts.length) {
    lastAlertKey = "";
    return;
  }
  const key = alerts.map((alert) => `${alert.factoryId}:${alert.latestRecordedAt || "none"}`).join("|");
  const cooldownMs = config.alertCooldownMinutes * 60000;
  if (key === lastAlertKey && Date.now() - lastAlertAt < cooldownMs) return;
  lastAlertKey = key;
  lastAlertAt = Date.now();

  if (!config.recipients.length || !config.smtp.host) {
    console.warn("Email alert skipped because SMTP or recipients are not configured.");
    return;
  }

  const lines = alerts.map((alert) => {
    const age = alert.staleMinutes === null ? "ไม่พบเวลาอัปเดตล่าสุด" : `${alert.staleMinutes} นาที`;
    return `- ${alert.factoryName}: ${age}, ล่าสุด ${alert.latestRecordedAt || "-"}`;
  });
  await sendMail({
    to: config.recipients,
    subject: `[POMS Alert] ข้อมูลไม่อัปเดตเกิน ${config.staleThresholdMinutes} นาที`,
    text: `พบข้อมูล POMS ไม่อัปเดตตามเกณฑ์\n\n${lines.join("\n")}\n\nเวลาแจ้งเตือน: ${new Date().toLocaleString("th-TH", { timeZone: "Asia/Bangkok" })}`
  });
}

async function sendMail({ to, subject, text }) {
  const smtp = config.smtp;
  let socket = smtp.secure
    ? tls.connect(smtp.port, smtp.host, { servername: smtp.host })
    : net.connect(smtp.port, smtp.host);

  let buffer = "";
  const read = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("SMTP timeout")), 15000);
    const onData = (data) => {
      buffer += data.toString("utf8");
      if (/\r?\n$/.test(buffer)) {
        clearTimeout(timer);
        socket.off("data", onData);
        const out = buffer;
        buffer = "";
        resolve(out);
      }
    };
    socket.on("data", onData);
  });
  const write = async (command) => {
    socket.write(`${command}\r\n`);
    return read();
  };

  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  await read();
  await write(`EHLO ${smtp.host}`);
  if (!smtp.secure) {
    await write("STARTTLS");
    socket = tls.connect({ socket, servername: smtp.host });
    await new Promise((resolve, reject) => {
      socket.once("secureConnect", resolve);
      socket.once("error", reject);
    });
    await write(`EHLO ${smtp.host}`);
  }
  if (smtp.user && smtp.pass) {
    await write(`AUTH PLAIN ${Buffer.from(`\0${smtp.user}\0${smtp.pass}`).toString("base64")}`);
  }
  await write(`MAIL FROM:<${smtp.from}>`);
  for (const recipient of to) await write(`RCPT TO:<${recipient}>`);
  await write("DATA");
  const message = [
    `From: ${smtp.from}`,
    `To: ${to.join(", ")}`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    text,
    "."
  ].join("\r\n");
  await write(message);
  await write("QUIT");
  socket.end();
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/api/status") {
    sendJson(res, cache);
    return;
  }
  if (url.pathname === "/api/refresh") {
    poll().then(() => sendJson(res, cache)).catch((error) => sendJson(res, { error: error.message }, 500));
    return;
  }

  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const publicDir = path.join(__dirname, "public");
  const filePath = path.normalize(path.join(publicDir, requested));
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": mimeType(filePath) });
    res.end(data);
  });
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function mimeType(filePath) {
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) return "image/jpeg";
  return "text/html; charset=utf-8";
}

poll();
setInterval(poll, config.pollIntervalSeconds * 1000);

http.createServer(serveStatic).listen(config.port, () => {
  console.log(`POMS dashboard running at http://localhost:${config.port}`);
});
