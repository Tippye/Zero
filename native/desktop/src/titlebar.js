const menu = document.querySelector('#app-menu');
menu.addEventListener('click', async () => {
  menu.setAttribute('aria-expanded', 'true');
  try {
    await window.zeroTitlebar.openMenu();
  } finally {
    menu.setAttribute('aria-expanded', 'false');
  }
});
