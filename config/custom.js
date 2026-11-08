
(() => {
  "use strict";

  // ==========================================
  // Scott's Pi-Server Dashboard Customizations
  // ==========================================

  const CONFIG = {
    drives: [
      { name: "SD Card", totalBytes: 29222965248 },
      { name: "External Drive", totalBytes: 244995190784 },
    ],
    ramEndpoint: "/glances-memory",
    internetEndpoint: "/internet-status",
    tailscaleEndpoint: "/tailscale/dashboard",
    networkEndpoint: "/network",
    speedtestEndpoint: "/speedtest",
    speedtestRunEndpoint: "/speedtest/run",

    refreshInterval: 30000,
    uptimeInterval: 1000,
    staleAfter: 90000,
  };

  const RESOURCE_SELECTOR =
    ".information-widget-glances .information-widget-resource";

  const originalDriveValues = new WeakMap();

  // Enumerable so tooltips belonging to removed Homepage rows can be cleaned up.
  const tailscaleTooltips = new Map();

  let latestTailscaleDevices = [];
  let activeTailscaleTooltip = null;
  let tailscaleLastSnapshot = null;
  let tailscaleLastRecordedSnapshot = null;
  let tailscaleSessionUpdates = 0;
  let tailscaleLifetimeUpdates = null;
  let tailscaleNextUpdate = null;
  let serverClockOffset = 0;
  let tailscaleRequestInFlight = false;

  let networkRequestInFlight = false;
  let latestNetworkSnapshot = null;

  let latestMemory = null;
  let internetStatus = null;
  let lastSuccessfulInternetFetch = 0;
  let scheduled = false;

  const formatGB = bytes => (bytes / 1e9).toFixed(1);
  const formatGiB = bytes => (bytes / (1024 ** 3)).toFixed(2);

  function getServerTime() {
    return Date.now() + serverClockOffset;
  }

  function setText(element, text) {
    if (element && element.textContent !== text) {
      element.textContent = text;
    }
  }

  function getWidgets() {
    return document.querySelectorAll(RESOURCE_SELECTOR);
  }

  // ==========================================
  // 1. Storage Widgets
  // ==========================================

  function parseStorageValue(text) {
    const match = text.trim().match(
      /^([\d,.]+)\s*(GiB|MiB|GB|MB)$/i
    );

    if (!match) return null;

    const multipliers = {
      gib: 1024 ** 3,
      mib: 1024 ** 2,
      gb: 1e9,
      mb: 1e6,
    };

    const amount = Number(match[1].replace(/,/g, ""));
    const multiplier = multipliers[match[2].toLowerCase()];

    return Number.isFinite(amount)
      ? amount * multiplier
      : null;
  }

  function customizeStorage(widgets) {
    CONFIG.drives.forEach((drive, index) => {
      const widget = widgets[index + 2];
      if (!widget) return;

      const value = widget.querySelector(".resource-value");
      const label = widget.querySelector(".pr-1");
      const icon = widget.querySelector(".resource-icon");

      if (!value || !label) return;

      // Capture fresh free-space readings from Homepage.
      // Our custom used/total text won't match this parser.
      const freeBytes = parseStorageValue(value.textContent);

      if (freeBytes !== null) {
        originalDriveValues.set(widget, freeBytes);
      }

      const cachedFreeBytes = originalDriveValues.get(widget);

      if (cachedFreeBytes !== undefined) {
        const usedBytes = Math.max(
          0,
          drive.totalBytes - cachedFreeBytes
        );

        setText(
          value,
          `${formatGB(usedBytes)} / ${formatGB(drive.totalBytes)} GB`
        );
      }

      setText(label, drive.name);

      widget.classList.add("custom-storage-widget");
      widget.classList.toggle(
        "custom-external-drive",
        index === 1
      );

      if (index === 1 && icon && !icon.dataset.customized) {
        icon.innerHTML = `
          <ellipse cx="12" cy="5" rx="9" ry="3"/>
          <path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/>
          <path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/>
        `;

        icon.setAttribute("viewBox", "0 0 24 24");
        icon.setAttribute("fill", "none");
        icon.setAttribute("stroke", "currentColor");
        icon.setAttribute("stroke-width", "2");
        icon.dataset.customized = "true";
      }
    });
  }

  // ==========================================
  // 2. RAM Widget
  // ==========================================

  function applyRamWidget(widgets = getWidgets()) {
    if (!latestMemory || !widgets[1]) return;

    const widget = widgets[1];
    const value = widget.querySelector(".resource-value");
    const label = widget.querySelector(".pr-1");

    if (!value || !label) return;

    setText(
      value,
      `${formatGiB(latestMemory.used)} / ` +
      `${formatGiB(latestMemory.total)} GiB`
    );

    setText(label, "RAM");
    widget.classList.add("custom-ram-widget");
  }

  async function updateRamWidget() {
    try {
      const response = await fetch(CONFIG.ramEndpoint, {
        cache: "no-store",
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const memory = await response.json();

      if (
        !Number.isFinite(memory.used) ||
        !Number.isFinite(memory.total) ||
        memory.total <= 0
      ) {
        throw new Error("Invalid memory data");
      }

      latestMemory = memory;
      applyRamWidget();

    } catch (error) {
      console.warn("RAM widget update failed:", error);
    }
  }

  // ==========================================
  // 3. Pi Uptime Label
  // ==========================================

  function customizePiUptime(widgets) {
    const widget = widgets[5];
    if (!widget) return;

    setText(
      widget.querySelector(".pr-1"),
      "PI UPTIME"
    );
  }

  // ==========================================
  // 4. Internet Uptime Widget
  // ==========================================

  function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    return `${days}d ${hours}h ${minutes}m`;
  }

  function createInternetWidget() {
    const container = document.querySelector(
      ".information-widget-glances > div:first-child"
    );

    if (!container) return;

    if (container.querySelector("#internet-uptime-widget")) {
      return;
    }

    const widget = document.createElement("div");

    widget.id = "internet-uptime-widget";
    widget.className =
      "flex-none flex flex-row items-center mr-3 py-1.5 " +
      "information-widget-resource";

    widget.innerHTML = `
      <svg class="resource-icon"
           xmlns="http://www.w3.org/2000/svg"
           width="24"
           height="24"
           viewBox="0 0 24 24"
           fill="none"
           stroke="currentColor"
           stroke-width="2"
           stroke-linecap="round"
           stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <path d="M2 12h20"/>
        <path d="M12 2a15.3 15.3 0 0 1 4 10
                 15.3 15.3 0 0 1-4 10
                 15.3 15.3 0 0 1-4-10
                 15.3 15.3 0 0 1 4-10z"/>
      </svg>

      <div class="flex flex-col ml-3 text-left min-w-[85px]">
        <div class="text-theme-800 dark:text-theme-200 text-xs
                    flex flex-row justify-between gap-2">
          <div class="pl-0.5 resource-value">Checking...</div>
          <div class="pr-1">NET UPTIME</div>
        </div>
        <div class="mt-0.5 resource-usage"></div>
      </div>
    `;

    container.appendChild(widget);
    updateInternetWidget();
  }

  async function fetchInternetStatus() {
    try {
      const response = await fetch(CONFIG.internetEndpoint, {
        cache: "no-store",
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const status = await response.json();

      internetStatus = status;
      lastSuccessfulInternetFetch = Date.now();

    } catch (error) {
      console.warn("Internet uptime unavailable:", error);
    }

    updateInternetWidget();
  }

  function updateInternetWidget() {
    const widget = document.querySelector(
      "#internet-uptime-widget"
    );

    if (!widget) return;

    const value = widget.querySelector(".resource-value");
    const icon = widget.querySelector(".resource-icon");

    if (!value || !icon) return;

    const setStatus = (text, offline = false) => {
      setText(value, text);

      if (offline) {
        icon.style.setProperty(
          "color",
          "#ef4444",
          "important"
        );
      } else {
        icon.style.removeProperty("color");
      }
    };

    const stale =
      Date.now() - lastSuccessfulInternetFetch >
      CONFIG.staleAfter;

    if (!internetStatus || stale) {
      setStatus("Unknown");
      return;
    }

    if (!internetStatus.online) {
      setStatus("Offline", true);
      return;
    }

    const lastCheck = Date.parse(internetStatus.last_check);
    const onlineSince = Date.parse(internetStatus.online_since);

    if (
      !Number.isFinite(lastCheck) ||
      !Number.isFinite(onlineSince) ||
      Date.now() - lastCheck > CONFIG.staleAfter
    ) {
      setStatus("Unknown");
      return;
    }

    const seconds = Math.max(
      0,
      Math.floor((Date.now() - onlineSince) / 1000)
    );

    setStatus(formatUptime(seconds));
}
// ==========================================
// 5. Tailscale Connected Devices
// ==========================================

const osIcons = {
  windows: "/icons/custom/windows.svg",
  linux: "/icons/custom/linux.svg",
  ios: "/icons/custom/apple.svg",
  ipados: "/icons/custom/apple.svg",
  macos: "/icons/custom/apple.svg",
  android: "/icons/custom/android.svg",
  raspberrypi: "/icons/custom/raspberrypi.svg",
  unknown: "/icons/custom/unknown.svg",
};

function updateTailscaleStats() {
  const card = [...document.querySelectorAll(".service-container")]
    .find(card => card.querySelector(".font-thin.pl-2"));

  if (!card) return;

  let footer = card.querySelector("#tailscale-stats");

  if (!footer) {
    footer = document.createElement("div");
    footer.id = "tailscale-stats";

    footer.innerHTML = `
      <div class="tailscale-stat">
        <span class="tailscale-stat-value" id="tailscale-lifetime">—</span>
        <span class="tailscale-stat-label">LIFETIME</span>
      </div>
      <div class="tailscale-stat">
        <span class="tailscale-stat-value" id="tailscale-session">0</span>
        <span class="tailscale-stat-label">SESSION</span>
      </div>
      <div class="tailscale-stat">
        <span class="tailscale-stat-value" id="tailscale-next">30s</span>
        <span class="tailscale-stat-label">NEXT UPDATE</span>
      </div>
    `;

    card.appendChild(footer);
  }

  const seconds = tailscaleNextUpdate === null
    ? null
    : Math.ceil(
        (tailscaleNextUpdate - getServerTime()) / 1000
      );

  setText(
    footer.querySelector("#tailscale-lifetime"),
    tailscaleLifetimeUpdates === null
      ? "—"
      : tailscaleLifetimeUpdates.toLocaleString()
  );

  setText(
    footer.querySelector("#tailscale-session"),
    tailscaleSessionUpdates.toLocaleString()
  );

  setText(
    footer.querySelector("#tailscale-next"),
    seconds === null
      ? "—"
      : seconds < 0
        ? "Delayed"
        : seconds === 0
          ? "Checking…"
          : `${seconds}s`
  );
}

function customizeTailscale() {
  const cards = document.querySelectorAll(".service-container");

  for (const card of cards) {
    if (!card.querySelector(".font-thin.pl-2")) continue;

    const rows = card.querySelectorAll(
      "div.bg-theme-200\\/50.rounded-sm"
    );

    for (const row of rows) {
      const name = row.querySelector(".font-thin.pl-2");
      const status = row.querySelector(".font-bold.mr-2");

      if (!name || !status) continue;

      const match = name.textContent.trim().match(/\(([^)]+)\)$/);
      if (!match) continue;

      const os = match[1].toLowerCase();
      const deviceName = name.textContent.trim();

      // Select the appropriate locally hosted SVG.
      const iconUrl = deviceName.includes("Pi Server")
        ? osIcons.raspberrypi
        : (osIcons[os] ?? osIcons.unknown);

      if (iconUrl && !name.querySelector(".tailscale-os-icon")) {
        const icon = document.createElement("img");
        icon.src = iconUrl;
        icon.alt = os;
        icon.className = "tailscale-os-icon";
        name.prepend(icon);
      }

      // Homepage supplies "latency | location" as text.
      const raw = status.textContent.trim();

      const existingLatency = status.querySelector(
        ".tailscale-latency"
      );
      const existingState = status.querySelector(
        ".tailscale-state"
      );

      // Read Homepage's new value, or preserve the
      // previously processed value on subsequent passes.
      const parts = raw.includes("|")
        ? raw.split("|").map(part => part.trim())
        : [
            existingLatency?.textContent ?? "—",
            existingState?.textContent ?? ""
          ];

      const latency = parts[0] || "—";
      const state = parts[1] || "";

      const offline = state.startsWith("Last seen");
      const online = ["Host", "Local", "Remote"].includes(state);

      if (!online && !offline) continue;

      // Build separate elements for latency and location.
      let latencyElement = existingLatency;
      let stateElement = existingState;

      if (!latencyElement || !stateElement) {
        status.replaceChildren();

        latencyElement = document.createElement("span");
        latencyElement.className = "tailscale-latency";

        stateElement = document.createElement("span");
        stateElement.className = "tailscale-state";

        status.append(latencyElement, stateElement);
      }

      setText(latencyElement, latency);
      setText(stateElement, state);

      status.classList.add("tailscale-status");
      status.classList.toggle("is-online", online);
      status.classList.toggle("is-offline", offline);
    }
  }
}

function positionTailscaleTooltip(row, tooltip) {
  const rect = row.getBoundingClientRect();

  const width = tooltip.offsetWidth;
  const height = tooltip.offsetHeight;
  const margin = 12;
  const gap = 8;

  // Position tooltip within the device card, vertically centred on the row.
  let left = rect.left + rect.width * 0.25;
  let top = rect.top + (rect.height - height) / 2;

  if (left + width > window.innerWidth - margin) {
    left = rect.left - width - gap;

    // Neither side fits: use the space below or above the row.
    if (left < margin) {
      left = rect.left + (rect.width - width) / 2;
      top = rect.bottom + gap;
      if (top + height > window.innerHeight - margin) {
        top = rect.top - height - gap;
      }
    }
  }

  left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
  top = Math.max(
    margin,
    Math.min(top, window.innerHeight - height - margin)
  );

  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function hideTailscaleTooltip() {
  activeTailscaleTooltip?.classList.remove("is-visible");
  activeTailscaleTooltip = null;
}

async function updateTailscaleTooltips() {
  if (tailscaleRequestInFlight) return;

  tailscaleRequestInFlight = true;

  try {
    const requestStarted = Date.now();

    const response = await fetch(CONFIG.tailscaleEndpoint, {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();

    const requestFinished = Date.now();
    const serverTime = Date.parse(data.server_time);

    if (Number.isFinite(serverTime)) {
      const browserMidpoint = (requestStarted + requestFinished) / 2;
      serverClockOffset = serverTime - browserMidpoint;
    }

    if (!Array.isArray(data.devices)) {
      throw new Error("Invalid Tailscale device data");
    }
    latestTailscaleDevices = data.devices;

	const nextCheck = Date.parse(data.next_check);

	if (Number.isFinite(nextCheck)) {
	  tailscaleNextUpdate = nextCheck;
	}

   if (tailscaleLastSnapshot === null) {
      // The first snapshot establishes the session baseline.
      tailscaleLastSnapshot = data.last_check;
      tailscaleLastRecordedSnapshot = data.last_check;
    } else {
      if (data.last_check !== tailscaleLastSnapshot) {
        tailscaleLastSnapshot = data.last_check;
        tailscaleSessionUpdates++;
      }

      if (data.last_check !== tailscaleLastRecordedSnapshot) {
        try {
          const statsResponse = await fetch(CONFIG.tailscaleEndpoint, {
            method: "POST",
            signal: AbortSignal.timeout(5000),
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              last_check: data.last_check
            })
          });

          if (!statsResponse.ok) {
            throw new Error(`HTTP ${statsResponse.status}`);
          }

          const stats = await statsResponse.json();

          // Mark the snapshot recorded only after a successful POST.
          tailscaleLastRecordedSnapshot = data.last_check;

          if (Number.isSafeInteger(stats.lifetime_updates)) {
            tailscaleLifetimeUpdates = stats.lifetime_updates;
          }
        } catch (error) {
          console.warn("Failed to record Tailscale update:", error);
        }
      }
    }

    if (Number.isSafeInteger(data.stats?.lifetime_updates)) {
      tailscaleLifetimeUpdates = Math.max(
        data.stats.lifetime_updates,
        tailscaleLifetimeUpdates ?? 0
      );
    }

    applyTailscaleDeviceStatuses();
    applyTailscaleTooltips();
    updateTailscaleStats();

  } catch (error) {
    console.warn("Tailscale tooltip update failed:", error);
  } finally {
    tailscaleRequestInFlight = false;
  }
}

function applyTailscaleDeviceStatuses() {
  const devices = new Map(
    latestTailscaleDevices.map(device => [
      device.display_name,
      device
    ])
  );

  const rows = document.querySelectorAll(
    ".service-container div.bg-theme-200\\/50.rounded-sm"
  );

  for (const row of rows) {
    const name = row.querySelector(".font-thin.pl-2");
    const status = row.querySelector(".font-bold.mr-2");

    if (!name || !status) continue;

    const device = devices.get(name.textContent.trim());
    if (!device) continue;

    const label = device.connection_label ?? "Unknown";
    const [latency, ...stateParts] = label.split("|");
    const state = stateParts.join("|").trim();

    let latencyElement = status.querySelector(".tailscale-latency");
    let stateElement = status.querySelector(".tailscale-state");

    if (!latencyElement || !stateElement) {
      status.replaceChildren();

      latencyElement = document.createElement("span");
      latencyElement.className = "tailscale-latency";

      stateElement = document.createElement("span");
      stateElement.className = "tailscale-state";

      status.append(latencyElement, stateElement);
    }

    setText(latencyElement, latency.trim());
    setText(stateElement, state);

    status.classList.add("tailscale-status");
    status.classList.toggle(
      "is-online",
      ["Host", "Local", "Remote"].includes(state)
    );
    status.classList.toggle(
      "is-offline",
      state.startsWith("Last seen")
    );
  }
}

function createLatencyGraph(history) {
  const ns = "http://www.w3.org/2000/svg";
  const width = 340;
  const height = 120;
  const left = 36;
  const right = 8;
  const top = 10;
  const bottom = 25;

  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("class", "tailscale-latency-graph");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Latency over the last 10 minutes");

  const samples = Array.isArray(history) ? history : [];
  const valid = samples.filter(sample =>
    Number.isFinite(sample.latency_ms) &&
    Number.isFinite(Date.parse(sample.timestamp))
  );

  if (!valid.length) {
    const message = document.createElementNS(ns, "text");
    message.setAttribute("x", width / 2);
    message.setAttribute("y", height / 2);
    message.setAttribute("text-anchor", "middle");
    message.setAttribute("fill", "#94a3b8");
    message.setAttribute("font-size", "12");
    message.textContent = "No latency data available";
    svg.appendChild(message);
    return svg;
  }

  const now = Date.now();
  const start = now - 600000;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;

  const latencies = valid.map(sample => sample.latency_ms);

  const minLatency = Math.min(...latencies);
  const maxLatency = Math.max(...latencies);
  const spread = maxLatency - minLatency;

  // Add padding around the observed measurements.
  const padding = Math.max(1, spread * 0.15);

  const rawMin = Math.max(0, minLatency - padding);
  const rawMax = maxLatency + padding;
  const range = rawMax - rawMin;

  // Choose a readable interval.
  const magnitude = 10 ** Math.floor(Math.log10(range));
  const normalized = range / magnitude;

  const step = (
    normalized <= 2 ? 0.2 :
    normalized <= 5 ? 0.5 : 1
  ) * magnitude;

  const yMin = Math.max(0, Math.floor(rawMin / step) * step);
  const yMax = Math.ceil(rawMax / step) * step;

  const x = timestamp =>
    left + Math.max(0, Math.min(1,
      (Date.parse(timestamp) - start) / 600000
    )) * plotWidth;

  const y = latency =>
    top + plotHeight -
    ((latency - yMin) / (yMax - yMin)) * plotHeight;

  // Gridlines and vertical-axis labels.
  for (let i = 0; i <= 4; i++) {
    const value = yMin + (yMax - yMin) * i / 4;
    const py = y(value);

    const line = document.createElementNS(ns, "line");
    line.setAttribute("x1", left);
    line.setAttribute("x2", width - right);
    line.setAttribute("y1", py);
    line.setAttribute("y2", py);
    line.setAttribute("stroke", "#334155");
    line.setAttribute("stroke-dasharray", "3 4");
    svg.appendChild(line);

    if (i % 2 === 0) {
      const label = document.createElementNS(ns, "text");
      label.setAttribute("x", left - 6);
      label.setAttribute("y", py + 3);
      label.setAttribute("text-anchor", "end");
      label.setAttribute("fill", "#94a3b8");
      label.setAttribute("font-size", "10");
      label.textContent = Number(value.toFixed(1));
      svg.appendChild(label);
    }
  }

  // Draw line segments, breaking at failed measurements.
  let segment = [];

  function drawSegment() {
    if (!segment.length) return;

    const path = document.createElementNS(ns, "path");
    const d = segment.map((sample, i) =>
      `${i === 0 ? "M" : "L"} ${x(sample.timestamp)} ${y(sample.latency_ms)}`
    ).join(" ");

    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "#4ade80");
    path.setAttribute("stroke-width", "2");
    path.setAttribute("stroke-linejoin", "round");
    path.setAttribute("stroke-linecap", "round");
    svg.appendChild(path);

    // Show isolated samples as dots.
    if (segment.length === 1) {
      const dot = document.createElementNS(ns, "circle");
      dot.setAttribute("cx", x(segment[0].timestamp));
      dot.setAttribute("cy", y(segment[0].latency_ms));
      dot.setAttribute("r", "2.5");
      dot.setAttribute("fill", "#4ade80");
      svg.appendChild(dot);
    }

    segment = [];
  }

  for (const sample of samples) {
    if (
      Number.isFinite(sample.latency_ms) &&
      Number.isFinite(Date.parse(sample.timestamp))
    ) {
      segment.push(sample);
    } else {
      drawSegment();
    }
  }

  drawSegment();

  for (const [label, px, anchor] of [
    ["10m ago", left, "start"],
    ["Now", width - right, "end"]
  ]) {
    const text = document.createElementNS(ns, "text");
    text.setAttribute("x", px);
    text.setAttribute("y", height - 5);
    text.setAttribute("text-anchor", anchor);
    text.setAttribute("fill", "#94a3b8");
    text.setAttribute("font-size", "10");
    text.textContent = label;
    svg.appendChild(text);
  }

  return svg;
}


function createNetworkTrafficGraph(history, containerWidth) {
  const ns = "http://www.w3.org/2000/svg";

  const width = containerWidth > 0 ? containerWidth : 700;
  const height = 240;
  const left = 65;
  const right = 12;
  const top = 15;
  const bottom = 25;

  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("class", "network-traffic-graph");
  svg.setAttribute("role", "img");
  svg.setAttribute(
    "aria-label",
    "Received and transmitted Ethernet traffic over the last 120 seconds"
  );

  // Use the existing Tailscale clock offset to align with Pi timestamps.
  const now = getServerTime() / 1000;
  const start = now - 120;

  const samples = (Array.isArray(history) ? history : [])
    .filter(sample =>
      Number.isFinite(sample.timestamp) &&
      sample.timestamp >= start &&
      sample.timestamp <= now &&
      Number.isFinite(sample.rx_bytes_per_sec) &&
      Number.isFinite(sample.tx_bytes_per_sec) &&
      sample.rx_bytes_per_sec >= 0 &&
      sample.tx_bytes_per_sec >= 0
    )
    .sort((a, b) => a.timestamp - b.timestamp);

  if (!samples.length) {
    const message = document.createElementNS(ns, "text");
    message.setAttribute("x", width / 2);
    message.setAttribute("y", height / 2);
    message.setAttribute("text-anchor", "middle");
    message.setAttribute("fill", "#94a3b8");
    message.setAttribute("font-size", "12");
    message.textContent = "No traffic data available";
    svg.appendChild(message);
    return svg;
  }

  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;

  const maximum = Math.max(
    1,
    ...samples.flatMap(sample => [
      sample.rx_bytes_per_sec,
      sample.tx_bytes_per_sec
    ])
  );

  // Choose a shared scale for RX and TX.
  const rawMax = maximum * 1.15;
  const magnitude = 10 ** Math.floor(Math.log10(rawMax));
  const normalized = rawMax / magnitude;

  const step = (
    normalized <= 2 ? 0.2 :
    normalized <= 5 ? 0.5 : 1
  ) * magnitude;

  const yMax = Math.ceil(rawMax / step) * step;

  const x = timestamp =>
    left + Math.max(0, Math.min(1,
      (timestamp - start) / 120
    )) * plotWidth;

  const y = rate =>
    top + plotHeight - (rate / yMax) * plotHeight;

  // Use the same gridline styling as the latency graph.
  for (let i = 0; i <= 4; i++) {
    const value = yMax * i / 4;
    const py = y(value);

    const line = document.createElementNS(ns, "line");
    line.setAttribute("x1", left);
    line.setAttribute("x2", width - right);
    line.setAttribute("y1", py);
    line.setAttribute("y2", py);
    line.setAttribute("stroke", "#64748b");
    line.setAttribute("stroke-opacity", "0.45");
    line.setAttribute("stroke-dasharray", "3 4");
    svg.appendChild(line);

    if (i % 2 === 0) {
      const label = document.createElementNS(ns, "text");
      label.setAttribute("x", left - 6);
      label.setAttribute("y", py + 3);
      label.setAttribute("text-anchor", "end");
      label.setAttribute("fill", "#94a3b8");
      label.setAttribute("font-size", "10");

      label.textContent = formatNetworkRate(value);

      svg.appendChild(label);
    }
  }

  // Draw a separate line for each traffic direction.
  function drawSeries(field, color) {
    const path = document.createElementNS(ns, "path");

    const d = samples.map((sample, index) =>
      `${index === 0 ? "M" : "L"} ` +
      `${x(sample.timestamp)} ${y(sample[field])}`
    ).join(" ");

    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", color);
    path.setAttribute("stroke-width", "2");
    path.setAttribute("stroke-linejoin", "round");
    path.setAttribute("stroke-linecap", "round");

    svg.appendChild(path);

    if (samples.length === 1) {
      const dot = document.createElementNS(ns, "circle");
      dot.setAttribute("cx", x(samples[0].timestamp));
      dot.setAttribute("cy", y(samples[0][field]));
      dot.setAttribute("r", "2.5");
      dot.setAttribute("fill", color);
      svg.appendChild(dot);
    }
  }

  drawSeries("rx_bytes_per_sec", "#4ade80");
  drawSeries("tx_bytes_per_sec", "#60a5fa");

  for (const [label, px, anchor] of [
    ["120 seconds ago", left, "start"],
    ["Now", width - right, "end"]
  ]) {
    const text = document.createElementNS(ns, "text");
    text.setAttribute("x", px);
    text.setAttribute("y", height - 3);
    text.setAttribute("text-anchor", anchor);
    text.setAttribute("fill", "#94a3b8");
    text.setAttribute("font-size", "10");
    text.textContent = label;
    svg.appendChild(text);
  }

  return svg;
}

function applyTailscaleTooltips() {
    for (const [row, tooltip] of tailscaleTooltips) {
      if (!row.isConnected) {
        if (activeTailscaleTooltip === tooltip) hideTailscaleTooltip();
        tooltip.remove();
        tailscaleTooltips.delete(row);
      }
    }

    for (const device of latestTailscaleDevices) {
      const cards = document.querySelectorAll(".service-container");

      for (const card of cards) {
        const rows = card.querySelectorAll(
          "div.bg-theme-200\\/50.rounded-sm"
        );

        for (const row of rows) {
          const name = row.querySelector(".font-thin.pl-2");
          if (!name) continue;

          if (name.textContent.trim() !== device.display_name) {
            continue;
          }

          // Remove the browser's native delayed tooltip.
          row.removeAttribute("title");

          // Store the latest tooltip values on the row.
          row.dataset.tooltipName = device.display_name;
          row.dataset.tooltipIp = device.ip ?? "Unknown";
          row.dataset.tooltipConnection =
            device.connection_method === "Relayed"
              ? `DERP relay (${device.relay ?? "unknown"})`
              : device.connection_method ?? "Unknown";
          row.dataset.tooltipLatency = device.latency_label ?? "—";
          row.dataset.tooltipOs = device.os ?? "Unknown";

          // Build the hover card once per row.
          let tooltip = tailscaleTooltips.get(row);

          if (!tooltip) {
            tooltip = document.createElement("div");
            tooltip.className = "tailscale-tooltip";
            document.body.appendChild(tooltip);
            tailscaleTooltips.set(row, tooltip);
          }

          if (!row.dataset.tooltipPositioning) {
            row.addEventListener("mouseenter", () => {
              // A detached row may be reinserted with a newly created tooltip.
              const tooltip = tailscaleTooltips.get(row);
              if (!tooltip) return;
              hideTailscaleTooltip();
              positionTailscaleTooltip(row, tooltip);
              tooltip.classList.add("is-visible");
              activeTailscaleTooltip = tooltip;
            });

            row.addEventListener("mouseleave", () => {
              if (activeTailscaleTooltip === tailscaleTooltips.get(row)) {
                hideTailscaleTooltip();
              }
            });

            row.dataset.tooltipPositioning = "true";
          }

          const formatLatency = value =>
            Number.isFinite(value) ? `${value} ms` : "—";

          const formatOnlineDuration = seconds => {
            if (!Number.isFinite(seconds)) return "—";

            const days = Math.floor(seconds / 86400);
            const hours = Math.floor((seconds % 86400) / 3600);
            const minutes = Math.floor((seconds % 3600) / 60);

            if (days > 0) return `${days}d ${hours}h ${minutes}m`;
            if (hours > 0) return `${hours}h ${minutes}m`;
            if (minutes > 0) return `${minutes}m`;

            return `${Math.floor(seconds)}s`;
          };

          const latencyRange =
            Number.isFinite(device.latency_min_10m) &&
            Number.isFinite(device.latency_max_10m)
              ? `${device.latency_min_10m}–${device.latency_max_10m} ms`
              : "—";
          const hasLatencyMonitoring =
            device.connection_method !== "Host";

          const tooltipRows = [
            ["Connection method", row.dataset.tooltipConnection],
            ["Network location", device.location ?? "Unknown"],
            ["Tailscale IP", row.dataset.tooltipIp],
          ];

          if (device.lan_ip) {
            tooltipRows.splice(2, 0, ["LAN IP", device.lan_ip]);
          }

          if (hasLatencyMonitoring) {
            tooltipRows.push(
              ["Current latency", row.dataset.tooltipLatency],
              ["Average latency (10 mins)", formatLatency(device.latency_avg_10m)],
              ["Latency range (10 mins)", latencyRange]
            );
          }

          tooltipRows.push(
            ["Online for", formatOnlineDuration(device.online_seconds)],
            ["Operating system", row.dataset.tooltipOs]
          );

          // Rebuild only when the underlying data changes.
          const signature = JSON.stringify([
            device.display_name,
            tooltipRows,
            device.latency_history,
          ]);

          if (tooltip.dataset.signature !== signature) {
            tooltip.replaceChildren();

            const heading = document.createElement("div");
            heading.className = "tailscale-tooltip-heading";
            heading.textContent = device.display_name;
            tooltip.appendChild(heading);

            for (const [label, value] of tooltipRows) {
              const item = document.createElement("div");
              item.className = "tailscale-tooltip-row";

              const labelElement = document.createElement("span");
              labelElement.className = "tailscale-tooltip-label";
              labelElement.textContent = label;

              const valueElement = document.createElement("span");
              valueElement.className = "tailscale-tooltip-value";
              valueElement.textContent = value;

              item.append(labelElement, valueElement);
              tooltip.appendChild(item);
            }

			const graphSection = document.createElement("div");
			graphSection.className = "tailscale-graph-section";

			const graphHeading = document.createElement("div");
			graphHeading.className = "tailscale-graph-heading";

			const graphTitle = document.createElement("span");
			graphTitle.textContent = "Latency history (ms)";

			const graphPeriod = document.createElement("span");
			graphPeriod.textContent = "Last 10 minutes";

			graphHeading.append(graphTitle, graphPeriod);
			graphSection.appendChild(graphHeading);

			graphSection.appendChild(
			  createLatencyGraph(device.latency_history)
			);

			if (hasLatencyMonitoring) {
			  tooltip.appendChild(graphSection);
			}

            tooltip.dataset.signature = signature;
          }
          if (activeTailscaleTooltip === tooltip) {
            positionTailscaleTooltip(row, tooltip);
          } else if (row.matches(":hover") && !row.dataset.tooltipReady) {
            // The initial fetch may finish while the pointer is already on a row.
            positionTailscaleTooltip(row, tooltip);
            hideTailscaleTooltip();
            tooltip.classList.add("is-visible");
            activeTailscaleTooltip = tooltip;
          }
          row.dataset.tooltipReady = "true";
        }
      }
    }
}

  // ==========================================
  // 5. Dashboard Customizations
  // ==========================================

  function disableGlancesLink() {
    const link = document.querySelector(
      "a.information-widget-glances"
    );

    if (!link) return;

    link.removeAttribute("href");
    link.removeAttribute("target");
    link.style.cursor = "default";
  }


  function getNetworkTrafficCard() {
    const titles = document.querySelectorAll(".service-name");

    for (const title of titles) {
      const name = title.firstChild?.textContent.trim();

      if (name === "Network Traffic") {
        return title.closest(".service-card");
      }
    }

    return null;
  }

  function formatNetworkRate(bytesPerSecond) {
    const rate = Number(bytesPerSecond);

    if (!Number.isFinite(rate) || rate < 0) {
      return "—";
    }

    if (rate >= 1_000_000) {
      return `${(rate / 1_000_000).toFixed(2)} MB/s`;
    }

    if (rate >= 1_000) {
      return `${(rate / 1_000).toFixed(1)} KB/s`;
    }

    return `${rate.toFixed(0)} B/s`;
  }

  function customizeNetworkTraffic() {
    const card = getNetworkTrafficCard();
    if (!card) return;

    const blocks = card.querySelectorAll(".service-block");

    for (const block of blocks) {
      const label = block.querySelector(".service-block-label");
      const value = block.querySelector(".service-block-value");

      if (!label || !value) continue;

      const metric = label.textContent.trim();

      const isRx = metric === "RX (B/s)" || metric === "RECEIVE";
      const isTx = metric === "TX (B/s)" || metric === "TRANSMIT";

      if (!isRx && !isTx) continue;

      // Homepage refreshes the raw value every five seconds.
      // Only convert values that have not already been formatted.
      const raw = value.textContent.trim();

      if (!/^\d+(\.\d+)?$/.test(raw)) continue;

      value.textContent = formatNetworkRate(raw);

      label.textContent = isRx ? "RECEIVE" : "TRANSMIT";
    }
  }

  function formatNetworkTotal(bytes) {
    const value = Number(bytes);

    if (!Number.isFinite(value) || value < 0) {
      return "—";
    }

    if (value >= 1_000_000_000) {
      return `${(value / 1_000_000_000).toFixed(2)} GB`;
    }

    return `${(value / 1_000_000).toFixed(2)} MB`;
  }

  function formatLinkSpeed(mbps) {
      const speed = Number(mbps);

      if (!Number.isFinite(speed) || speed <= 0 || mbps == null) {
          return "—";
      }

      if (speed >= 1000) {
          return `${Number((speed / 1000).toFixed(2))} Gbps`;
      }

      return `${speed} Mbps`;
  }

  function formatNetworkUptime(seconds) {
      const uptime = Number(seconds);

      if (!Number.isFinite(uptime) || uptime < 0 || seconds == null) {
          return "—";
      }

      const totalMinutes = Math.floor(uptime / 60);
      const days = Math.floor(totalMinutes / 1440);
      const hours = Math.floor((totalMinutes % 1440) / 60);
      const minutes = totalMinutes % 60;

      if (days > 0) {
          return `${days}d ${hours}h ${minutes}m`;
      }

      if (hours > 0) {
          return `${hours}h ${minutes}m`;
      }

      return `${minutes}m`;
  }

  function renderNetworkTraffic(data) {
      const card = getNetworkTrafficCard();
      if (!card) return;

      let layout = card.querySelector(".network-dashboard");

      if (!layout) {
          layout = document.createElement("div");
          layout.className = "network-dashboard";

          const columns = document.createElement("div");
          columns.className = "network-dashboard-columns";

          const ethernet = document.createElement("section");
          ethernet.className = "network-ethernet";

          const internet = document.createElement("section");
          internet.className = "network-internet";

          columns.append(ethernet, internet);

          const footer = document.createElement("div");
          footer.className = "network-dashboard-footer";

          layout.append(columns, footer);
          card.appendChild(layout);
      }

      const ethernet = layout.querySelector(".network-ethernet");
      const internet = layout.querySelector(".network-internet");
      const footer = layout.querySelector(".network-dashboard-footer");

      // Move Homepage's existing live readings into Ethernet.
      const serviceContainer = card.querySelector(".service-container");

      if (serviceContainer && serviceContainer.parentElement !== ethernet) {
          ethernet.appendChild(serviceContainer);
      }

      // Synchronize digital readings with the graph snapshot.
      if (serviceContainer) {
          const values = serviceContainer.querySelectorAll(
              ".service-block-value"
          );

          if (values.length === 2) {
              values[0].textContent = formatNetworkRate(
                  data.rx_bytes_per_sec
              );

              values[1].textContent = formatNetworkRate(
                  data.tx_bytes_per_sec
              );
          }
      }

      let ethernetHeading = ethernet.querySelector(".network-section-title");

      if (!ethernetHeading) {
          ethernetHeading = document.createElement("div");
          ethernetHeading.className = "network-section-title";
          ethernetHeading.textContent = "Ethernet — eth0";
          ethernet.prepend(ethernetHeading);
      }

      let graphContainer = ethernet.querySelector(".network-graph-container");

      if (!graphContainer) {
          graphContainer = document.createElement("div");
          graphContainer.className = "network-graph-container";
          ethernet.appendChild(graphContainer);
      }

      const heading = document.createElement("div");
      heading.className = "network-graph-heading";

      const title = document.createElement("span");
      title.textContent = "ETHERNET THROUGHPUT";

      const interval = document.createElement("span");
      interval.textContent = "Last 120 seconds";

      heading.append(title, interval);

      const containerWidth = Math.floor(
          graphContainer.getBoundingClientRect().width
      );

      const graph = createNetworkTrafficGraph(
          data.history,
          containerWidth
      );

      const legend = document.createElement("div");
      legend.className = "network-graph-legend";

      const rx = document.createElement("span");
      rx.className = "rx";
      rx.textContent = "● Receive";

      const tx = document.createElement("span");
      tx.className = "tx";
      tx.textContent = "● Transmit";

      legend.append(rx, tx);
      graphContainer.replaceChildren(heading, graph, legend);

      // Internet speed test: layout only, no fabricated results.
      if (!internet.hasChildNodes()) {
          const internetHeading = document.createElement("div");
          internetHeading.className = "network-section-title";
          internetHeading.textContent = "Internet Speed Test";

          const speeds = document.createElement("div");
          speeds.className = "network-speed-results";

          for (const label of ["Download", "Upload"]) {
              const result = document.createElement("div");
              result.className = "network-speed-result";

              const name = document.createElement("span");
              name.textContent = label;

              const value = document.createElement("strong");
              value.textContent = "— Mbps";

              result.append(name, value);
              speeds.appendChild(result);
          }

          const status = document.createElement("div");
          status.className = "network-speed-status";
          status.textContent = "No speed tests recorded";

          const button = document.createElement("button");
          button.className = "network-speed-button";
          button.textContent = "Run Speed Test";
          button.disabled = true;
          button.title = "Available after speed-test backend setup";

          button.addEventListener("click", async () => {
              if (button.disabled) return;

              button.disabled = true;
              button.textContent = "Requesting…";
              button.dataset.requested = "true";

              try {
                  const response = await fetch(CONFIG.speedtestRunEndpoint, {
                      method: "POST",
                      cache: "no-store",
                      signal: AbortSignal.timeout(10000),
                  });

                  if (!response.ok) {
                      throw new Error(`HTTP ${response.status}`);
                  }

                  button.textContent = "Starting…";
                  setTimeout(() => {
                      delete button.dataset.requested;
                      updateSpeedtest();
                  }, 5000);

                  // Refresh the displayed state immediately.
                  await updateSpeedtest();

              } catch (error) {
                  console.error("Speed test request failed:", error);

                  const status = internet.querySelector(".network-speed-status");

                  if (status) {
                      status.textContent = `Unable to start speed test: ${error.message}`;
                  }

                  delete button.dataset.requested;
                  button.textContent = "Run Speed Test";
                  button.disabled = false;
              }
          });

          const progress = document.createElement("div");
          progress.className = "network-speed-progress";

          progress.innerHTML = `
            <div class="speedtest-stages">
              <div class="speedtest-stage" data-stage="connecting">
                <span class="speedtest-stage-icon"></span>
                <span>Connect</span>
              </div>
              <div class="speedtest-stage" data-stage="download">
                <span class="speedtest-stage-icon"></span>
                <span>Download</span>
              </div>
              <div class="speedtest-stage" data-stage="upload">
                <span class="speedtest-stage-icon"></span>
                <span>Upload</span>
              </div>
              <div class="speedtest-stage" data-stage="complete">
                <span class="speedtest-stage-icon"></span>
                <span>Complete</span>
              </div>
            </div>

            <div class="speedtest-live">
              <span class="speedtest-live-label">Waiting for test</span>
              <strong class="speedtest-live-value">—</strong>
            </div>

            <div class="speedtest-progress-track">
              <div class="speedtest-progress-fill"></div>
            </div>

            <div class="speedtest-progress-percent">0%</div>
          `;

          internet.append(
              internetHeading,
              speeds,
              status,
              button,
              progress
          );
      }

      // Shared statistics footer.
      footer.replaceChildren();

      const statistics = [
          ["TOTAL RECEIVED", formatNetworkTotal(data.lifetime_rx_bytes)],
          ["TOTAL TRANSMITTED", formatNetworkTotal(data.lifetime_tx_bytes)],
          ["LINK SPEED", formatLinkSpeed(data.link_speed_mbps)],
          ["UPTIME", formatNetworkUptime(data.uptime_seconds)]
      ];

      for (const [label, value] of statistics) {
          const stat = document.createElement("div");
          stat.className = "network-footer-stat";

          const statValue = document.createElement("strong");
          statValue.textContent = value;

          const statLabel = document.createElement("span");
          statLabel.textContent = label;

          stat.append(statValue, statLabel);
          footer.appendChild(stat);
      }
  }


  async function updateNetworkTraffic() {
    if (networkRequestInFlight) return;

    networkRequestInFlight = true;

    try {
      const response = await fetch(CONFIG.networkEndpoint, {
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      if (!Array.isArray(data.history)) {
        throw new Error("Invalid network history");
      }

      // Reject older snapshots arriving out of order.
      const timestamp = Date.parse(data.last_check);

      if (!Number.isFinite(timestamp)) {
        throw new Error("Invalid network timestamp");
      }

      if (
        latestNetworkSnapshot !== null &&
        timestamp < latestNetworkSnapshot
      ) {
        return;
      }

      latestNetworkSnapshot = timestamp;
      renderNetworkTraffic(data);

    } catch (error) {
      console.warn("Network traffic update failed:", error);
    } finally {
      networkRequestInFlight = false;
    }
  }

    let speedtestRequestInFlight = false;
    let speedtestIsRunning = false;

    async function updateSpeedtest() {
      if (speedtestRequestInFlight) return;

      const card = getNetworkTrafficCard();
      const internet = card?.querySelector(".network-internet");

      if (!internet) return;

      speedtestRequestInFlight = true;

      try {
        const response = await fetch(CONFIG.speedtestEndpoint, {
          cache: "no-store",
          signal: AbortSignal.timeout(5000),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();

        const results = internet.querySelectorAll(
          ".network-speed-result strong"
        );

        const status = internet.querySelector(".network-speed-status");
        const button = internet.querySelector(".network-speed-button");
        const progress = internet.querySelector(".network-speed-progress");

        if (results.length !== 2 || !status || !button || !progress) {
          return;
        }

        // Preserve the last successful measurements while a test runs.
        const download = data.result?.download_mbps;
        const upload = data.result?.upload_mbps;

        results[0].textContent = Number.isFinite(download)
          ? `${download.toFixed(2)} Mbps`
          : "— Mbps";

        results[1].textContent = Number.isFinite(upload)
            ? `${upload.toFixed(2)} Mbps`
            : "— Mbps";

        const running = data.state === "running";
        speedtestIsRunning = running;

        const stages = ["connecting", "download", "upload", "complete"];
        const currentStage = stages.indexOf(data.stage);

        const stageElements = progress.querySelectorAll(".speedtest-stage");
        const liveLabel = progress.querySelector(".speedtest-live-label");
        const liveValue = progress.querySelector(".speedtest-live-value");
        const progressFill = progress.querySelector(".speedtest-progress-fill");
        const progressPercent = progress.querySelector(".speedtest-progress-percent");

        const percentage = Math.round(
            Math.max(0, Math.min(1, Number(data.progress) || 0)) * 100
        );

        stageElements.forEach((element, index) => {
            const completed = (
                data.state === "completed" ||
                (running && currentStage > index)
            );

            const active = running && currentStage === index;

            element.classList.toggle("is-complete", completed);
            element.classList.toggle("is-active", active);
        });

        if (running) {
            const labels = {
                connecting: "Connecting to test server",
                download: "Downloading",
                upload: "Uploading",
            };

            liveLabel.textContent = labels[data.stage] || "Testing";

            liveValue.textContent = Number.isFinite(data.current_mbps)
                ? `${data.current_mbps.toFixed(2)} Mbps`
                : "—";

            progressFill.style.width = `${percentage}%`;
            progressPercent.textContent = `${percentage}%`;
        } else {
            liveLabel.textContent = data.state === "completed"
                ? "Test completed"
                : "Waiting for test";

            liveValue.textContent = "—";
            progressFill.style.width = data.state === "completed" ? "100%" : "0%";
            progressPercent.textContent = data.state === "completed" ? "100%" : "0%";
        }

        // Use the actual backend state, not simulated progress.
        if (running) {
            status.textContent = "Speed test in progress";
        } else if (data.state === "failed") {
            status.textContent = "Last test failed";
        } else if (data.state === "interrupted") {
            status.textContent = "Previous test interrupted";
        } else if (data.result?.timestamp) {
            const completed = new Date(data.result.timestamp);

            status.textContent = Number.isNaN(completed.getTime())
                ? "Last test completed"
                : `Last tested ${completed.toLocaleString()}`;
        } else {
            status.textContent = "No speed tests recorded";
        }

        const finished = Date.parse(data.finished_at);
        const cooldownEnds = finished + 10 * 60 * 1000;
        const remainingMs = cooldownEnds - Date.now();

		speedtestCooldownEnds = Number.isFinite(finished)
		    ? cooldownEnds
		    : null;

        const cooldownActive = (
            Number.isFinite(finished) &&
            remainingMs > 0
        );

        const remainingSeconds = Math.ceil(
            Math.max(0, remainingMs) / 1000
        );

        const minutes = Math.floor(remainingSeconds / 60);
        const seconds = remainingSeconds % 60;

        const cooldownText = cooldownActive
            ? `Available in ${minutes}:${String(seconds).padStart(2, "0")}`
            : "Ready now";

        if (!running && data.result?.timestamp) {
            status.dataset.lastTested = status.textContent;
            updateSpeedtestCountdown();
        } else {
            delete status.dataset.lastTested;
        }

        const requested = button.dataset.requested === "true";

        button.disabled = running || cooldownActive || requested;

        button.textContent = running
            ? "Testing…"
            : cooldownActive
                ? "Cooldown Active"
                : requested
                    ? "Starting…"
                    : "Run Speed Test";

        button.title = running
            ? "Speed test already running"
            : cooldownActive
                ? "Available 10 minutes after the previous test"
                : "Run an internet speed test";

      } catch (error) {
        console.warn("Speed test status update failed:", error);
      } finally {
        speedtestRequestInFlight = false;
      }
    }

  let speedtestCooldownEnds = null;

  function updateSpeedtestCountdown() {
      if (!Number.isFinite(speedtestCooldownEnds)) return;

      const card = getNetworkTrafficCard();
      const status = card?.querySelector(".network-speed-status");

      if (!status) return;

      const remainingSeconds = Math.ceil(
          Math.max(0, speedtestCooldownEnds - Date.now()) / 1000
      );

      const minutes = Math.floor(remainingSeconds / 60);
      const seconds = remainingSeconds % 60;

      const countdown = remainingSeconds > 0
          ? `Available in ${minutes}:${String(seconds).padStart(2, "0")}`
          : "Ready now";

      const lastTested = status.dataset.lastTested;

      if (lastTested) {
          status.textContent = `${lastTested} · ${countdown}`;
      }
  }

  let speedtestPollTimer = null;

  async function pollSpeedtest() {
      const card = getNetworkTrafficCard();
      const internet = card?.querySelector(".network-internet");

      if (!internet) {
          speedtestPollTimer = setTimeout(pollSpeedtest, 250);
          return;
      }

      await updateSpeedtest();

      const interval = speedtestIsRunning ? 500 : 5000;

      speedtestPollTimer = setTimeout(pollSpeedtest, interval);
  }

  function customize() {
    customizeTailscale();
    customizeNetworkTraffic();
    applyTailscaleTooltips();
    updateTailscaleStats();

    const widgets = getWidgets();

    // Six built-in resources are required.
    if (widgets.length < 6) return;

    customizeStorage(widgets);
    applyRamWidget(widgets);
    customizePiUptime(widgets);
    createInternetWidget();
    disableGlancesLink();
  }

  // ==========================================
  // 6. DOM Observer
  // ==========================================

  const observerOptions = {
    childList: true,
    subtree: true,
    characterData: true,
  };

  const observer = new MutationObserver(() => {
    if (scheduled) return;

    scheduled = true;

    requestAnimationFrame(() => {
      observer.disconnect();

      try {
        customize();
      } finally {
        observer.observe(document.body, observerOptions);
        scheduled = false;
      }
    });
  });

  // ==========================================
  // 7. Initialization
  // ==========================================

  function initialize() {
    document.addEventListener("scroll", hideTailscaleTooltip, true);
    window.addEventListener("resize", hideTailscaleTooltip);
    customize();

    observer.observe(document.body, observerOptions);

    fetchInternetStatus();
    updateRamWidget();

	updateTailscaleTooltips();

	updateNetworkTraffic();
	pollSpeedtest();

  setInterval(
    updateTailscaleTooltips,
    2000
  );

  setInterval(
    updateNetworkTraffic,
    2000
  );

  setInterval(
    updateTailscaleStats,
    100
  );

    setInterval(
        updateSpeedtestCountdown,
        1000
    );

    setInterval(
      fetchInternetStatus,
      CONFIG.refreshInterval
    );

    setInterval(
      updateRamWidget,
      CONFIG.refreshInterval
    );

    setInterval(
      updateInternetWidget,
      CONFIG.uptimeInterval
    );
  }

  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      initialize,
      { once: true }
    );
  } else {
    initialize();
  }
})();
