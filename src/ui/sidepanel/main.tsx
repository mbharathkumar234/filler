import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { LocaleProvider } from '@/ui/lib/LocaleProvider';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('side panel root element missing');

createRoot(container).render(
  <StrictMode>
    <LocaleProvider>
      <App />
    </LocaleProvider>
  </StrictMode>,
);
