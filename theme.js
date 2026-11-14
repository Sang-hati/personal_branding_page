// Runs before first paint so a saved light or dark choice does not flash the wrong theme.
try {
  const saved = localStorage.getItem('theme');
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
} catch {
  /* storage can be blocked; the page then follows the system setting */
}
