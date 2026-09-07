type Rgb = [number, number, number];
function rgb(value: string): Rgb | null {
  const match = value.match(/^rgba?\(([^)]+)\)$/);
  if (!match) return null;
  const values = match[1]!.split(/[,\s/]+/).map(Number);
  if (values.length > 3 && values[3]! < 0.5) return null;
  return values.slice(0, 3) as Rgb;
}
function luminance(value: Rgb) {
  const linear = value.map(c => c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
}
function contrast(a: Rgb, b: Rgb) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// Shadow DOM isolates mail CSS from Tailwind. Adapt actual computed colors, including
// inline !important styles and legacy bgcolor attributes, without inverting images.
export function applyMailTheme(root: ShadowRoot, theme: string | undefined) {
  if (theme !== 'dark') return;
  const backgrounds = new Map<Element, Rgb>();
  const surface: Rgb = [26, 26, 26];
  for (const element of root.querySelectorAll<HTMLElement>('html, body, body *')) {
    if (['IMG', 'SVG', 'PATH', 'STYLE', 'SCRIPT', 'BR'].includes(element.tagName)) continue;
    const style = getComputedStyle(element);
    let background = rgb(style.backgroundColor);
    if (background && luminance(background) > 0.5 && Math.max(...background) - Math.min(...background) < 60) {
      background = surface;
      element.style.setProperty('background-color', 'rgb(26, 26, 26)', 'important');
    }
    const effective = background || backgrounds.get(element.parentElement!) || surface;
    backgrounds.set(element, effective);
    const foreground = rgb(style.color);
    if (foreground && contrast(foreground, effective) < 4.5) {
      const link: Rgb = [147, 197, 253], light: Rgb = [235, 235, 235], dark: Rgb = [23, 23, 23];
      const color = element.closest('a') && contrast(link, effective) >= 4.5 ? link
        : contrast(light, effective) >= contrast(dark, effective) ? light : dark;
      element.style.setProperty('color', `rgb(${color.join(', ')})`, 'important');
      // WebKit may use this instead of color for some HTML templates.
      element.style.setProperty('-webkit-text-fill-color', 'currentColor', 'important');
    }
  }
}
