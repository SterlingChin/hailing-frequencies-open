import './style.css';

if (new URLSearchParams(location.search).get('mode') === 'real') await import('./real.js');
else await import('./main.js');
