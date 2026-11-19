const copiedMs = 1600;

document.querySelectorAll<HTMLPreElement>("pre[data-copy]").forEach((pre) => {
  const button = document.createElement("button");

  button.type = "button";
  button.className = "copy-btn";
  button.textContent = "Copy";
  button.addEventListener("click", async () => {
    await navigator.clipboard.writeText(pre.textContent ?? "");
    button.textContent = "Copied";
    setTimeout(() => {
      button.textContent = "Copy";
    }, copiedMs);
  });
  pre.parentElement?.querySelector(".doc-code-bar")?.append(button);
});

const tocLinks = [...document.querySelectorAll<HTMLAnchorElement>(".docs-toc-in a")];

const markCurrent = (id: string) =>
  tocLinks.forEach((link) =>
    link.setAttribute("aria-current", link.hash === `#${id}` ? "true" : "false"),
  );

const observer = new IntersectionObserver(
  (entries) => {
    const visible = entries.find((entry) => entry.isIntersecting);

    if (visible !== undefined) {
      markCurrent(visible.target.id);
    }
  },
  { rootMargin: "-80px 0px -70% 0px" },
);

document.querySelectorAll(".docs-section[id]").forEach((section) => observer.observe(section));
