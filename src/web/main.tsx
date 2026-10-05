import { render } from 'preact';
import { App } from './App';
import { applyTheme, readStorage } from './lib/hooks';
import './styles.css';

// Apply a stored theme choice before the first paint of the app, so a dark-mode user never sees a light flash.
const stored = readStorage('radar.theme');
if (stored === 'light' || stored === 'dark') applyTheme(stored);

render(<App />, document.getElementById('app') as HTMLElement);
