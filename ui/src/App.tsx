import { Routes, Route, Navigate, NavLink, useNavigate } from "react-router-dom";
import { isAuthenticated, clearAuth } from "./api";
import { ChatProvider } from "./contexts/ChatContext";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Chat from "./pages/Chat";
import Approvals from "./pages/Approvals";
import Cron from "./pages/Cron";
import Workspace from "./pages/Workspace";
import Incidents from "./pages/Incidents";
import Config from "./pages/Config";
import Trace from "./pages/Trace";

function RequireAuth({ children }: { children: React.ReactNode }) {
  if (!isAuthenticated()) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

function Shell() {
  const navigate = useNavigate();
  const handleLogout = () => {
    clearAuth();
    navigate("/login", { replace: true });
  };
  return (
    <div className="app">
      <ChatProvider>
        <div className="app-shell">
          <nav className="nav">
          <NavLink to="/" end className={({ isActive }) => (isActive ? "active" : "")}>
            Dashboard
          </NavLink>
          <NavLink to="/chat" className={({ isActive }) => (isActive ? "active" : "")}>
            Chat
          </NavLink>
          <NavLink to="/approvals" className={({ isActive }) => (isActive ? "active" : "")}>
            Approvals
          </NavLink>
          <NavLink to="/cron" className={({ isActive }) => (isActive ? "active" : "")}>
            Cron
          </NavLink>
          <NavLink to="/workspace" className={({ isActive }) => (isActive ? "active" : "")}>
            Workspace
          </NavLink>
          <NavLink to="/incidents" className={({ isActive }) => (isActive ? "active" : "")}>
            Incidents
          </NavLink>
          <NavLink to="/config" className={({ isActive }) => (isActive ? "active" : "")}>
            Config
          </NavLink>
          <NavLink to="/trace" className={({ isActive }) => (isActive ? "active" : "")}>
            Trace
          </NavLink>
        </nav>
        <main className="main">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/chat" element={<Chat />} />
            <Route path="/approvals" element={<Approvals />} />
            <Route path="/cron" element={<Cron />} />
            <Route path="/workspace" element={<Workspace />} />
            <Route path="/incidents" element={<Incidents />} />
            <Route path="/config" element={<Config />} />
            <Route path="/trace" element={<Trace />} />
          </Routes>
        </main>
        </div>
      </ChatProvider>
      <footer className="footer">
        <span>CursorClaw</span>
        <button type="button" className="btn" onClick={handleLogout}>
          Logout
        </button>
      </footer>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={isAuthenticated() ? <Navigate to="/" replace /> : <Login />} />
      <Route
        path="/*"
        element={
          <RequireAuth>
            <Shell />
          </RequireAuth>
        }
      />
    </Routes>
  );
}
