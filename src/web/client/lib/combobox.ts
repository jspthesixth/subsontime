export const combobox = (
  input: HTMLInputElement,
  listbox: HTMLElement,
  pick: (option: HTMLElement) => void,
) => {
  let active: HTMLElement | undefined;

  const options = () => [...listbox.querySelectorAll<HTMLElement>("[role=option]")];

  const visible = () => options().filter((option) => !option.hidden);

  const setActive = (option: HTMLElement | undefined) => {
    active = option;
    options().forEach((each) => each.setAttribute("aria-selected", String(each === option)));

    if (option === undefined) {
      input.removeAttribute("aria-activedescendant");
    } else {
      input.setAttribute("aria-activedescendant", option.id);
    }

    option?.scrollIntoView({ block: "nearest" });
  };

  const setOpen = (open: boolean) => {
    const shown = open && visible().length > 0;

    listbox.hidden = !shown;
    input.setAttribute("aria-expanded", String(shown));
    setActive(shown ? visible()[0] : undefined);
  };

  const move = (step: number) => {
    const shown = visible();
    const index = active === undefined ? -1 : shown.indexOf(active);

    setActive(shown[(index + step + shown.length) % shown.length]);
  };

  input.addEventListener("click", () => setOpen(true));

  input.addEventListener("blur", () => setOpen(false));

  input.addEventListener("keydown", (event) => {
    const open = !listbox.hidden;

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();

      if (open) {
        move(event.key === "ArrowDown" ? 1 : -1);
      } else {
        setOpen(true);
      }
    }

    if (event.key === "Enter" && open) {
      event.preventDefault();

      if (active !== undefined) {
        pick(active);
      }
    }

    if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
    }
  });

  listbox.addEventListener("mousedown", (event) => event.preventDefault());

  listbox.addEventListener("click", (event) => {
    const option =
      event.target instanceof Element ? event.target.closest<HTMLElement>("[role=option]") : null;

    if (option !== null) {
      pick(option);
    }
  });

  return { setOpen };
};
