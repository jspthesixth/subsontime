const button = document.querySelector<HTMLButtonElement>(".menu-btn");

const setOpen = (open: boolean) => {
  button?.setAttribute("aria-expanded", String(open));
  button?.setAttribute("aria-label", open ? "Close menu" : "Open menu");
};

button?.addEventListener("click", () => setOpen(button.getAttribute("aria-expanded") !== "true"));

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && button?.getAttribute("aria-expanded") === "true") {
    setOpen(false);
    button.focus();
  }
});
