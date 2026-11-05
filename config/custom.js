
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
    tailscaleEndpoint: "/tailscale",
    refreshInterval: 30000,
    uptimeInterval: 1000,
    staleAfter: 90000,
  };

  const RESOURCE_SELECTOR =
    ".information-widget-glances .information-widget-resource";

  const originalDriveValues = new WeakMap();
  const tailscaleTooltips = new WeakMap();

  let latestMemory = null;
  let internetStatus = null;
  let lastSuccessfulInternetFetch = 0;
  let scheduled = false;

  const formatGB = bytes => (bytes / 1e9).toFixed(1);
  const formatGiB = bytes => (bytes / (1024 ** 3)).toFixed(2);

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

  // Center the tooltip over the left half of the row.
  const targetX = rect.left + rect.width * 0.40;

  const left = Math.max(
    margin,
    Math.min(
      targetX - width / 2,
      window.innerWidth - width - margin
    )
  );

  // Prefer below the row, but flip above if necessary.
  let top = rect.bottom + 8;

  if (top + height > window.innerHeight - margin) {
    top = rect.top - height - 8;
  }

  top = Math.max(
    margin,
    Math.min(top, window.innerHeight - height - margin)
  );

  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

async function updateTailscaleTooltips() {
  try {
    const response = await fetch(CONFIG.tailscaleEndpoint, {
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();

    for (const device of data.devices) {
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

          const details = [
            device.display_name,
            `Tailscale IP: ${device.ip ?? "Unknown"}`,
            `Connection: ${device.connection_method ?? "Unknown"}`,
            `Latency: ${device.latency_label ?? "—"}`,
            `OS: ${device.os ?? "Unknown"}`,
          ];

          if (device.endpoint) {
            details.push(`Endpoint: ${device.endpoint}`);
          }

          if (
            device.connection_method === "Relayed" &&
            device.relay
          ) {
            details.push(`DERP region: ${device.relay}`);
          }

          // Remove the browser's native delayed tooltip.
          row.removeAttribute("title");
          
          // Store tooltip data on the row for CSS.
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
              positionTailscaleTooltip(row, tooltip);
              tooltip.classList.add("is-visible");
            });
          
            row.addEventListener("mouseleave", () => {
              tooltip.classList.remove("is-visible");
            });
          
            row.dataset.tooltipPositioning = "true";
          }
          
          const tooltipRows = [
            ["Tailscale IP", row.dataset.tooltipIp],
            ["Connection", row.dataset.tooltipConnection],
            ["Latency", row.dataset.tooltipLatency],
            ["Operating system", row.dataset.tooltipOs],
          ];
          
          // Rebuild only when the underlying data changes.
          const signature = JSON.stringify([
            device.display_name,
            tooltipRows,
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
          
            tooltip.dataset.signature = signature;
          }
        }
      }
    }
  } catch (error) {
    console.warn("Tailscale tooltip update failed:", error);
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

  function customize() {
    customizeTailscale();

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
    customize();

    observer.observe(document.body, observerOptions);

    fetchInternetStatus();
    updateRamWidget();
    
	updateTailscaleTooltips();
	
	setInterval(
	  updateTailscaleTooltips,
	  CONFIG.refreshInterval
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
