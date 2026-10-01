import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './app';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, staleTime: 10_000, refetchOnWindowFocus: true },
    mutations: { retry: false },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {/* Directory and filter actions must share the committed URL state. */}
      <BrowserRouter useTransitions={false}>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
