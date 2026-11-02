
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
    refreshInterval: 30000,
    uptimeInterval: 1000,
    staleAfter: 90000,
  };

  const RESOURCE_SELECTOR =
    ".information-widget-glances .information-widget-resource";

  const originalDriveValues = new WeakMap();

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
