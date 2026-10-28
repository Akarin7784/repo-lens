export type Theme = 'light' | 'dark';
export const THEME_KEY = 'repolens-theme';

/** 内联到 <head>,在首帧前设定 data-theme,避免闪烁;?theme=dark|light 用于截图与分享 */
export const THEME_BOOT_SCRIPT = `(function(){try{var q=new URLSearchParams(location.search).get('theme');var t=q==='dark'||q==='light'?q:localStorage.getItem('${THEME_KEY}');document.documentElement.dataset.theme=t==='dark'?'dark':'light';}catch(e){document.documentElement.dataset.theme='light';}})();`;
