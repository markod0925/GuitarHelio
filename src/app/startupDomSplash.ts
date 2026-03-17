const STARTUP_DOM_SPLASH_ID = 'startup-dom-splash';
const HIDE_CLASS = 'startup-dom-splash--hidden';
let hideTriggered = false;

function getSplashElement(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  return document.getElementById(STARTUP_DOM_SPLASH_ID);
}

export function hideStartupDomSplash(fadeMs: number): void {
  if (hideTriggered) return;
  hideTriggered = true;

  const element = getSplashElement();
  if (!element) return;

  const safeFadeMs = Math.max(0, Math.round(fadeMs));
  if (safeFadeMs === 0) {
    element.remove();
    return;
  }

  element.style.transitionDuration = `${safeFadeMs}ms`;
  element.classList.add(HIDE_CLASS);
  window.setTimeout(() => {
    if (element.isConnected) {
      element.remove();
    }
  }, safeFadeMs + 120);
}
