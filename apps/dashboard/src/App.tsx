import type { ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AuthProvider } from "./auth/AuthContext";
import { useAuth } from "./hooks/useAuth";
import { Layout } from "./components/Layout";
import { LoadingBlock } from "./components/ui";
import { ConfigurationPage } from "./pages/ConfigurationPage";
import { EventsPage } from "./pages/EventsPage";
import { LoginPage } from "./pages/LoginPage";
import { OverviewPage } from "./pages/OverviewPage";
import { TrafficPage } from "./pages/TrafficPage";

function Protected({ children }: { children: ReactNode }) {
  const { user, initializing } = useAuth();
  const location = useLocation();
  if (initializing) {
    return (
      <div className="boot-screen">
        <LoadingBlock label="Restoring session" />
      </div>
    );
  }
  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            element={
              <Protected>
                <Layout />
              </Protected>
            }
          >
            <Route path="/" element={<OverviewPage />} />
            <Route path="/traffic" element={<TrafficPage />} />
            <Route path="/events" element={<EventsPage />} />
            <Route path="/configuration" element={<ConfigurationPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
