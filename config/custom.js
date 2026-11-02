(() => {
  const drives = [
    { name: "SD Card", totalBytes: 29222965248 },
    { name: "External Drive", totalBytes: 244995190784 },
  ];

  const formatGB = bytes => (bytes / 1e9).toFixed(1);

  // Preserve Homepage's original values so we don't
  // accidentally interpret our own formatted text.
  const originalValues = new WeakMap();

  function customize() {
    const widgets = document.querySelectorAll(
      ".information-widget-glances .information-widget-resource"
    );

    if (widgets.length < 6) return;

    drives.forEach((drive, index) => {
      const widget = widgets[index + 2];
      const value = widget.querySelector(".resource-value");
      const label = widget.querySelector(".pr-1");
      const icon = widget.querySelector(".resource-icon");

      if (!value || !label) return;

      const current = value.textContent.trim();
      const match = current.match(/^([\d,.]+)\s*(GiB|MiB|GB|MB)$/i);

      if (match) {
        const multipliers = {
          gib: 1024 ** 3,
          mib: 1024 ** 2,
          gb: 1e9,
          mb: 1e6,
        };

        const freeBytes =
          Number(match[1].replace(/,/g, "")) *
          multipliers[match[2].toLowerCase()];

        originalValues.set(widget, freeBytes);
      }

      const freeBytes = originalValues.get(widget);
      if (freeBytes === undefined) return;

      const usedBytes = Math.max(0, drive.totalBytes - freeBytes);

      value.textContent =
        `${formatGB(usedBytes)} / ${formatGB(drive.totalBytes)} GB`;

      label.textContent = drive.name;

      // Identify the widgets for custom styling.
      widget.classList.add("custom-storage-widget");
      widget.classList.toggle("custom-external-drive", index === 1);

      // Change only the external drive icon.
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

  let scheduled = false;

  const observer = new MutationObserver(() => {
    if (scheduled) return;

    scheduled = true;

    requestAnimationFrame(() => {
      observer.disconnect();
      customize();
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      scheduled = false;
    });
  });

  function initialize() {
    customize();
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize);
  } else {
    initialize();
  }
})();
