/**
 * Dropdown menus: a button with data-menu="<id>" opens the element with that
 * id below it. Picking an item, clicking elsewhere or pressing Esc closes it.
 */
export function setupMenus(): void {
  let open: { button: HTMLElement; menu: HTMLElement } | undefined;

  const close = () => {
    if (!open) return;
    open.menu.hidden = true;
    open.button.classList.remove('active');
    open = undefined;
  };

  for (const button of document.querySelectorAll<HTMLElement>('[data-menu]')) {
    const menu = document.getElementById(button.dataset.menu!)!;
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasOpen = open?.menu === menu;
      close();
      if (wasOpen) return;
      const r = button.getBoundingClientRect();
      menu.style.top = `${r.bottom + 4}px`;
      menu.hidden = false;
      // Keep the whole menu on screen, using its real width.
      menu.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - menu.offsetWidth - 4))}px`;
      button.classList.add('active');
      open = { button, menu };
    });
    // Items do their own work; the menu just closes afterwards.
    menu.addEventListener('click', () => close());
  }
  document.addEventListener('pointerdown', (e) => {
    if (open && !open.menu.contains(e.target as Node) && !open.button.contains(e.target as Node)) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
}
